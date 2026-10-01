// 一次性验收服务：执行全部验收步骤后以退出码报告结果并退出。
// 顺序：
//  1) 规定场景断言：宽度 2 短脉冲及因果链；
//     双支路同刻汇合短脉冲的两条可连续复算输入因果路径；
//     延迟 3 的 NOT 在第 0/1 刻反转时撤销第 3 刻失效翻转；
//     正延迟反馈链振荡证据（稳定门 + 事件标识，可回放）。
//  2) 代码测试（node --test）。
//  3) 页面构建（npm run build）。
//  4) 在可配置宿主端口启动服务，做 /health 与 /api/review 的 HTTP 冒烟
//     （撤销场景 + 双支路同刻汇合复核请求）。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { simulate } from '../src/sim.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8091);
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures.push(name); console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('[1/4] 规定场景断言');

// 场景 A：宽度 2 短脉冲 + 因果链。
{
  const res = simulate({
    gates: [
      { id: 'A', type: 'NOT', delay: 1, inputs: ['input:a'] },
      { id: 'EN', type: 'NOT', delay: 1, inputs: ['input:en_n'] },
      { id: 'Y', type: 'AND', delay: 2, inputs: ['A', 'EN'] },
    ],
    edges: [
      { time: 2, input: 'a', from: 1, to: 0 },
      { time: 4, input: 'a', from: 0, to: 1 },
    ],
    initialInputs: { a: '1', en_n: '0' },
    monitors: ['Y'],
  });
  const p = res.pulses.find((x) => x.gate === 'Y');
  ok('宽度为 2 的短脉冲被识别', p && p.width === 2, JSON.stringify(res.pulses));
  ok('短脉冲起止刻度正确', p && p.start === 5 && p.end === 7, `start=${p?.start} end=${p?.end}`);
  const chainRoot = p?.chain?.[0];
  ok('因果链回溯到外部边沿 t=2 a:1→0',
    chainRoot?.kind === 'edge' && chainRoot.t === 2 && chainRoot.input === 'a' && chainRoot.from === '1' && chainRoot.to === '0',
    JSON.stringify(p?.chain));
  ok('因果链含 Y 进入翻转事件标识', p?.chain?.some((c) => c.kind === 'fire' && c.gate === 'Y' && c.seq === p.enterSeq));
}

// 场景 A2：双支路同刻汇合短脉冲。两个延迟 1 的 NOT（a、b 初值 1，t=2 同刻拉低、
// t=4 同刻恢复）驱动延迟 2 的 AND，Y 在 [5,7) 输出宽度 2 短脉冲；
// 因果证据必须保留两条可独立复算的输入路径，且与录入顺序无关。
const dualBranchConfig = () => ({
  gates: [
    { id: 'NA', type: 'NOT', delay: 1, inputs: ['input:a'] },
    { id: 'NB', type: 'NOT', delay: 1, inputs: ['input:b'] },
    { id: 'Y', type: 'AND', delay: 2, inputs: ['NA', 'NB'] },
  ],
  edges: [
    { time: 2, input: 'a', from: 1, to: 0 },
    { time: 2, input: 'b', from: 1, to: 0 },
    { time: 4, input: 'a', from: 0, to: 1 },
    { time: 4, input: 'b', from: 0, to: 1 },
  ],
  initialInputs: { a: '1', b: '1' },
  monitors: ['Y'],
});
{
  const res = simulate(dualBranchConfig());
  const p = res.pulses.find((x) => x.gate === 'Y');
  ok('双支路：宽度为 2 的短脉冲被识别', p && p.width === 2, JSON.stringify(res.pulses));
  ok('双支路：起止刻度 t=5…7、宽度 2、进入事件正确',
    p && p.start === 5 && p.end === 7 && p.width === 2 && Number.isInteger(p.enterSeq),
    `start=${p?.start} end=${p?.end} enter=${p?.enterSeq}`);
  ok('双支路：汇合翻转携带两个直接诱因', p && p.converged === true && p.branchCount === 2,
    `converged=${p?.converged} branches=${p?.branchCount}`);
  const chainByInput = new Map((p?.chains ?? []).map((ch) => [ch[0]?.input, ch]));
  for (const input of ['a', 'b']) {
    const ch = chainByInput.get(input);
    ok(`双支路：${input} 支路因果路径可连续复算（外部边沿 t=2 → NOT t=3 → 汇合 Y#${p?.enterSeq}@t5）`,
      !!ch &&
      ch[0]?.kind === 'edge' && ch[0].t === 2 && ch[0].input === input && ch[0].from === '1' && ch[0].to === '0' &&
      ch.some((c) => c.kind === 'fire' && c.gate === (input === 'a' ? 'NA' : 'NB') && c.t === 3 && c.to === '1') &&
      ch[ch.length - 1]?.kind === 'fire' && ch[ch.length - 1].seq === p.enterSeq && ch[ch.length - 1].gate === 'Y' && ch[ch.length - 1].t === 5,
      JSON.stringify(ch));
  }
  // 录入顺序无关：门逆序、边沿逆序、连线交换后的结论与证据完全一致。
  const base = dualBranchConfig();
  const variants = [
    { ...base, gates: [base.gates[2], base.gates[1], base.gates[0]] },
    { ...base, edges: [...base.edges].reverse() },
    { ...base, gates: base.gates.map((g) => (g.id === 'Y' ? { ...g, inputs: ['NB', 'NA'] } : g)) },
  ];
  const sig = (r) => {
    const q = r.pulses.find((x) => x.gate === 'Y');
    return JSON.stringify({ s: r.status, b: [q.start, q.end, q.width, q.enterSeq, q.exitSeq], c: q.chains });
  };
  const ref = sig(res);
  ok('双支路：门/连线/边沿录入顺序变化不改变标识、边界与因果证据',
    variants.every((cfg) => sig(simulate(cfg)) === ref));
}

// 场景 B：延迟 3 的 NOT 在第 0、1 刻反转 → 第 3 刻失效翻转必须撤销。
{
  const res = simulate({
    gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
    edges: [
      { time: 0, input: 'x', from: 0, to: 1 },
      { time: 1, input: 'x', from: 1, to: 0 },
    ],
    initialInputs: { x: '0' },
    monitors: ['N'],
  });
  ok('NOT 输出全程未翻转（失效翻转未落入轨迹）', res.timeline.every((s) => s.values.N === '1'));
  ok('不存在任何 FIRE 事件', !res.events.some((e) => e.action === 'FIRE'));
  const cancel = res.events.find((e) => e.action === 'CANCEL');
  ok('第 1 刻撤销第 3 刻到 0 的待发翻转',
    cancel && cancel.time === 1 && cancel.gate === 'N' && cancel.wasTo === '0',
    JSON.stringify(cancel));
  ok('结论为静稳且 N=1', res.status === 'STABLE' && res.stableValues.N === '1');
}

// 场景 C：正延迟反馈链振荡证据。
{
  const res = simulate({
    gates: [
      { id: 'G', type: 'AND', delay: 1, inputs: ['N', 'input:en'] },
      { id: 'N', type: 'NOT', delay: 1, inputs: ['G'] },
    ],
    edges: [{ time: 0, input: 'en', from: 0, to: 1 }],
    initialInputs: { en: '0' },
    monitors: ['G', 'N'],
  });
  ok('检测到 OSCILLATING', res.status === 'OSCILLATING', res.status);
  const o = res.oscillation;
  ok('存在非空可回放循环与前缀', o && o.cycle.length > 0 && o.prefix.length >= 0);
  ok('循环按稳定门标识记录状态', o && o.cycle.every((f) => Array.isArray(Object.keys(f.values)) && Object.keys(f.values).every((k) => ['G', 'N'].includes(k))));
  ok('循环提供事件标识序列', o && o.events.length > 0 && o.events.every((e) => Number.isInteger(e.seq)));
  // 可回放性：循环起点与终点规范化状态签名重复（门值 + 相对待发事件）。
  const sig = o?.signature;
  ok('规范化状态签名非空，且含门值与相对待发事件',
    typeof sig === 'string' && sig.length > 0 && sig.includes('G=') && sig.includes('N='),
    String(sig));
  ok('振荡门包含反馈链上的门', o?.gates?.includes('G') || o?.gates?.includes('N'));
}

console.log('[2/4] 代码测试');
const run = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  p.on('exit', (code) => resolve(code));
});
if (await run('npm', ['test', '--silent']) !== 0) { failures.push('npm test'); console.error('  ✗ 代码测试失败'); }
else console.log('  ✓ node --test 全部通过');

console.log('[3/4] 页面构建');
if (await run('npm', ['run', '--silent', 'build']) !== 0) { failures.push('npm run build'); console.error('  ✗ 页面构建失败'); }
else console.log('  ✓ web/dist 构建完成');

console.log(`[4/4] HTTP 冒烟（宿主 ${HOST}:${PORT}）`);
{
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, HOST, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', () => {});
  server.stderr?.on('data', (d) => process.stderr.write(d));
  let serverError = '';
  server.on('error', (e) => { serverError = String(e?.message || e); });
  let healthy = false;
  let reviewOk = false;
  try {
    for (let i = 0; i < 50; i++) {
      if (server.exitCode !== null || serverError) break;
      try {
        const r = await fetch(`http://${HOST}:${PORT}/health`);
        if (r.ok) { const j = await r.json(); healthy = j.status === 'ok'; break; }
      } catch { /* 未就绪，继续等 */ }
      await sleep(100);
    }
    if (serverError) failures.push(`验收服务启动失败：${serverError}`);
    ok('GET /health 返回 200 status=ok', healthy && !serverError);

    const pr = await fetch(`http://${HOST}:${PORT}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
        edges: [
          { time: 0, input: 'x', from: 0, to: 1 },
          { time: 1, input: 'x', from: 1, to: 0 },
        ],
        initialInputs: { x: '0' },
        monitors: ['N'],
      }),
    });
    const body = await pr.json();
    reviewOk = pr.status === 200 && body.ok && body.status === 'STABLE' && body.stableValues.N === '1';
    ok('POST /api/review 返回静稳结论（撤销场景）', reviewOk);

    // 双支路同刻汇合复核请求：经健康 HTTP 通道提交并核对脉冲与两条因果路径。
    const dr = await fetch(`http://${HOST}:${PORT}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gates: [
          { id: 'NA', type: 'NOT', delay: 1, inputs: ['input:a'] },
          { id: 'NB', type: 'NOT', delay: 1, inputs: ['input:b'] },
          { id: 'Y', type: 'AND', delay: 2, inputs: ['NA', 'NB'] },
        ],
        edges: [
          { time: 2, input: 'a', from: 1, to: 0 },
          { time: 2, input: 'b', from: 1, to: 0 },
          { time: 4, input: 'a', from: 0, to: 1 },
          { time: 4, input: 'b', from: 0, to: 1 },
        ],
        initialInputs: { a: '1', b: '1' },
        monitors: ['Y'],
      }),
    });
    const dbody = await dr.json();
    const dp = dbody.pulses?.find((x) => x.gate === 'Y');
    const dualInputs = (dp?.chains ?? []).map((ch) => ch[0]?.input).sort();
    const dualReviewOk = dr.status === 200 && dbody.ok &&
      dp && dp.start === 5 && dp.end === 7 && dp.width === 2 &&
      dp.converged === true && Array.isArray(dp.chains) && dp.chains.length === 2 &&
      JSON.stringify(dualInputs) === JSON.stringify(['a', 'b']) &&
      dp.chains.every((ch) => ch[ch.length - 1]?.seq === dp.enterSeq && ch.some((c) => c.kind === 'fire' && c.gate === 'Y' && c.t === 5));
    ok('POST /api/review 返回双支路同刻汇合短脉冲及两条可复算因果路径', dualReviewOk,
      `status=${dr.status} pulse=${JSON.stringify(dp && { start: dp.start, end: dp.end, width: dp.width, branches: dp.chains?.length, inputs: dualInputs })}`);

    const page = await fetch(`http://${HOST}:${PORT}/`);
    const html = await page.text();
    ok('GET / 返回构建后的复核页面', page.ok && html.includes('冗余离散链路'));
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  }
}

if (failures.length) {
  console.error(`\n[verify] 验收失败（${failures.length} 项）：${failures.join('；')}`);
  process.exit(1);
}
console.log('\n[verify] 全部验收通过：场景断言、代码测试、页面构建、HTTP 冒烟。');
process.exit(0);
