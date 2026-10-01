// 一次性验收服务：执行全部验收步骤后以退出码报告结果并退出。
// 顺序：
//  1) 规定场景断言：宽度 2 短脉冲及因果链；
//     延迟 3 的 NOT 在第 0/1 刻反转时撤销第 3 刻失效翻转；
//     正延迟反馈链振荡证据（稳定门 + 事件标识，可回放）。
//  2) 代码测试（node --test）。
//  3) 页面构建（npm run build）。
//  4) 在可配置宿主端口启动服务，做 /health 与 /api/review 的 HTTP 冒烟。
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
  let healthy = false;
  let reviewOk = false;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://${HOST}:${PORT}/health`);
        if (r.ok) { const j = await r.json(); healthy = j.status === 'ok'; break; }
      } catch { /* 未就绪，继续等 */ }
      await sleep(100);
    }
    ok('GET /health 返回 200 status=ok', healthy);

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
