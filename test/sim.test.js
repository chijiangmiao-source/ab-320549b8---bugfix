import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, simulate, normalizeConfig } from '../src/sim.js';

// 场景一：宽度为 2 的短脉冲及因果链。
// 信号源 A（NOT input，延迟 1）在第 2 刻变 1、第 4 刻变 0；
// 使能 EN 为高时，AND 门 Y（惯性延迟 2）在 [4,6) 输出宽度 2 的窄脉冲。
function pulseConfig() {
  return {
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
  };
}

test('宽度为 2 的短脉冲：起止刻度、宽度与因果事件链', () => {
  const res = simulate(pulseConfig());
  assert.equal(res.ok, true);
  const p = res.pulses.find((x) => x.gate === 'Y');
  assert.ok(p, '应检测到受监控输出 Y 上的短脉冲');
  assert.equal(p.start, 5);
  assert.equal(p.end, 7);
  assert.equal(p.width, 2);
  assert.equal(p.short, true);
  // 因果链终点是外部边沿 t=2 a:1->0
  const root = p.chain[0];
  assert.equal(root.kind, 'edge');
  assert.equal(root.t, 2);
  assert.equal(root.input, 'a');
  assert.equal(root.to, '0');
  // 链上包含 Y 的进入翻转事件标识
  assert.ok(p.chain.some((c) => c.kind === 'fire' && c.gate === 'Y' && c.seq === p.enterSeq));
});

test('脉冲宽度 3 不判为短脉冲（宽于惯性延迟 2）', () => {
  const cfg = pulseConfig();
  cfg.edges = [
    { time: 2, input: 'a', from: 1, to: 0 },
    { time: 5, input: 'a', from: 0, to: 1 },
  ];
  const res = simulate(cfg);
  const wide = res.pulses.find((x) => x.gate === 'Y');
  // 宽度 = 7-4 = 3 > delay 2，不属于短脉冲
  assert.ok(!wide || wide.short === false);
});

// 场景二：延迟为 3 的 NOT 门在第 0、1 刻反转时，第 3 刻失效翻转必须被撤销、不得落入轨迹。
test('NOT 延迟 3：t=0 与 t=1 连续反转，t=3 失效翻转被撤销', () => {
  const cfg = {
    gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
    edges: [
      { time: 0, input: 'x', from: 0, to: 1 },
      { time: 1, input: 'x', from: 1, to: 0 },
    ],
    initialInputs: { x: '0' },
    monitors: ['N'],
  };
  const res = simulate(cfg);
  assert.equal(res.ok, true);
  // 轨迹中 N 从未实际翻转
  assert.ok(res.timeline.every((s) => s.values.N === '1'), 'NOT 初值为 1 且全程保持 1');
  assert.ok(!res.events.some((e) => e.action === 'FIRE'), '不得有任何生效翻转事件');
  const cancel = res.events.find((e) => e.action === 'CANCEL');
  assert.ok(cancel, '应存在撤销记录');
  assert.equal(cancel.gate, 'N');
  assert.equal(cancel.time, 1);
  // 被撤销的是原定 t=3 落到 0 的失效翻转
  const sched = res.events.find((e) => e.action === 'SCHEDULE');
  assert.equal(sched.at, 3);
  assert.equal(sched.to, '0');
  assert.equal(res.status, 'STABLE');
  assert.equal(res.stableValues.N, '1');
});

test('NOT 延迟 3：输入保持满 3 刻则翻转正常生效', () => {
  const cfg = {
    gates: [{ id: 'N', type: 'NOT', delay: 3, inputs: ['input:x'] }],
    edges: [
      { time: 0, input: 'x', from: 0, to: 1 },
      { time: 3, input: 'x', from: 1, to: 0 },
    ],
    initialInputs: { x: '0' },
    monitors: ['N'],
  };
  const res = simulate(cfg);
  const fires = res.events.filter((e) => e.action === 'FIRE');
  assert.ok(fires.length >= 1);
  assert.equal(fires[0].time, 3);
  assert.equal(fires[0].to, '0');
  // 输入在第 3 刻回归后，输出经完整延迟于第 6 刻回到 1
  assert.equal(fires[1].time, 6);
  assert.equal(fires[1].to, '1');
});

// 场景三：正延迟反馈链振荡。
// N(NOT,延迟1) 输出接 AND 门 G(延迟1) 的一个输入，G 输出反馈接 N 输入链：
// N = NOT(G)，延迟均为 1，构成周期 2 的持续振荡（与外激励无关，由初值失配启动）。
test('正延迟反馈链：检测到振荡前缀与可回放循环', () => {
  const cfg = {
    gates: [
      { id: 'G', type: 'AND', delay: 1, inputs: ['N', 'input:en'] },
      { id: 'N', type: 'NOT', delay: 1, inputs: ['G'] },
    ],
    edges: [{ time: 0, input: 'en', from: 0, to: 1 }],
    initialInputs: { en: '0' },
    monitors: ['G', 'N'],
  };
  const res = simulate(cfg);
  assert.equal(res.status, 'OSCILLATING');
  assert.ok(res.oscillation.period >= 2);
  assert.ok(res.oscillation.cycle.length === res.oscillation.period);
  // 循环内存在可回放的门翻转事件标识
  assert.ok(res.oscillation.events.length > 0);
  assert.ok(res.oscillation.gates.includes('G') || res.oscillation.gates.includes('N'));
  // 前缀 + 循环构成可回放轨迹：循环相邻刻度值确实变化
  const cyc = res.oscillation.cycle;
  const changed = cyc.some((f, i) => {
    const next = cyc[(i + 1) % cyc.length];
    return JSON.stringify(f.values) !== JSON.stringify(next.values);
  });
  assert.ok(changed);
  // 循环结束时刻的状态与循环起点规范化一致（再仿真一段必然重复）
  const endFrame = res.timeline.find((s) => s.t === res.oscillation.cycleEnd);
  const startFrame = res.timeline.find((s) => s.t === res.oscillation.cycleStart);
  assert.ok(endFrame && startFrame);
});

test('校验：悬空连线逐项报错', () => {
  const r = validate({
    gates: [{ id: 'A', type: 'AND', delay: 1, inputs: ['B', ''] }],
    edges: [],
    monitors: ['A'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'WIRE_DANGLING'));
  assert.ok(r.errors.some((e) => e.code === 'WIRE_EMPTY'));
});

test('校验：重复驱动 / 非法边沿 / 环内零延迟', () => {
  const r = validate({
    gates: [
      { id: 'A', type: 'AND', delay: 1, inputs: ['B', 'B'] },
      { id: 'B', type: 'NOT', delay: 0, inputs: ['A'] },
    ],
    edges: [
      { time: -1, input: 'x', from: 0, to: 1 },
      { time: 0, input: 'x', from: 1, to: 1 },
    ],
    monitors: ['A'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'WIRE_DUP_DRIVER'));
  assert.ok(r.errors.some((e) => e.code === 'ZERO_DELAY_CYCLE'));
  assert.ok(r.errors.filter((e) => e.code === 'EDGE_BAD').length >= 2);
});

test('校验：边沿方向矛盾与超过 12 个门', () => {
  const gates = Array.from({ length: 13 }, (_, i) => ({
    id: `G${i}`, type: 'NOT', delay: 1, inputs: ['input:x'],
  }));
  const r1 = validate({ gates, edges: [], monitors: [] });
  assert.ok(r1.errors.some((e) => e.code === 'TOO_MANY_GATES'));

  const r2 = validate({
    gates: [{ id: 'A', type: 'NOT', delay: 1, inputs: ['input:x'] }],
    edges: [
      { time: 0, input: 'x', from: 0, to: 1 },
      { time: 2, input: 'x', from: 0, to: 1 },
    ],
    monitors: ['A'],
  });
  assert.ok(r2.errors.some((e) => e.code === 'EDGE_INCONSISTENT'));
});

test('规范化配置：相同结构不同录入顺序得到同一哈希', () => {
  const a = normalizeConfig({
    gates: [{ id: 'A', type: 'NOT', delay: 2, inputs: ['input:x'] }],
    edges: [{ time: 1, input: 'x', from: 0, to: 1 }],
    monitors: ['A'],
  });
  const b = normalizeConfig({
    gates: [{ delay: 2, type: 'NOT', id: 'A', inputs: ['input:x'] }],
    edges: [{ from: 0, to: 1, time: 1, input: 'x' }],
    monitors: ['A'],
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.hash, b.hash);
});

// 双支路同刻汇合：两条延迟 1 的 NOT 分别接外部输入 a、b，延迟 2 的 AND 汇合两输出。
// a、b 初始高，第 2 刻同时转低、第 4 刻同时恢复高 → AND 输出在 [5,7) 出现宽度 2 短脉冲。
// rev=true 时反转门、连线与边沿的录入顺序，用于核对事件标识与证据完整性不受影响。
function dualBranchConfig(rev = false) {
  return {
    gates: rev
      ? [
        { id: 'Y', type: 'AND', delay: 2, inputs: ['B', 'A'] },
        { id: 'B', type: 'NOT', delay: 1, inputs: ['input:b'] },
        { id: 'A', type: 'NOT', delay: 1, inputs: ['input:a'] },
      ]
      : [
        { id: 'A', type: 'NOT', delay: 1, inputs: ['input:a'] },
        { id: 'B', type: 'NOT', delay: 1, inputs: ['input:b'] },
        { id: 'Y', type: 'AND', delay: 2, inputs: ['A', 'B'] },
      ],
    edges: rev
      ? [
        { time: 4, input: 'b', from: 0, to: 1 },
        { time: 4, input: 'a', from: 0, to: 1 },
        { time: 2, input: 'b', from: 1, to: 0 },
        { time: 2, input: 'a', from: 1, to: 0 },
      ]
      : [
        { time: 2, input: 'a', from: 1, to: 0 },
        { time: 2, input: 'b', from: 1, to: 0 },
        { time: 4, input: 'a', from: 0, to: 1 },
        { time: 4, input: 'b', from: 0, to: 1 },
      ],
    initialInputs: { a: '1', b: '1' },
    monitors: ['Y'],
  };
}

// 连续复算一条因果路径：逐跳核对事件流水里记录的直接诱因确实包含上一跳，
// 且时间严格向前（外部边沿 → 支路门翻转 → … → 汇合输出事件）。
function replayChain(res, path, finalSeq) {
  assert.ok(path.length >= 2, '因果路径至少含外部边沿与一个门翻转');
  assert.equal(path[0].kind, 'edge', '路径起点必须是外部边沿');
  assert.equal(path[path.length - 1].kind, 'fire');
  assert.equal(path[path.length - 1].seq, finalSeq, '路径终点必须汇合到指定输出事件');
  const fires = res.events.filter((e) => e.action === 'FIRE');
  for (let i = 1; i < path.length; i++) {
    const node = path[i];
    assert.equal(node.kind, 'fire');
    assert.ok(node.t > path[i - 1].t, `第 ${i} 跳时间必须向前`);
    const ev = fires.find((e) => e.seq === node.seq);
    assert.ok(ev, `事件 #${node.seq} 必须存在于事件流水`);
    assert.equal(ev.gate, node.gate);
    assert.equal(ev.time, node.t);
    const prev = path[i - 1];
    const expectedCause = prev.kind === 'edge' ? `edge:${prev.t}:${prev.input}` : prev.seq;
    assert.ok(ev.causes.includes(expectedCause),
      `#${node.seq} 的直接诱因应包含上一跳 ${JSON.stringify(expectedCause)}，实际 ${JSON.stringify(ev.causes)}`);
  }
}

test('双支路同刻汇合：短脉冲起止/宽度/进入事件与两条可连续复算的输入因果路径', () => {
  const res = simulate(dualBranchConfig());
  assert.equal(res.ok, true);
  assert.equal(res.status, 'STABLE');
  const p = res.pulses.find((x) => x.gate === 'Y');
  assert.ok(p, '应识别 AND 输出 Y 上的短脉冲');
  assert.equal(p.start, 5);
  assert.equal(p.end, 7);
  assert.equal(p.width, 2);
  assert.equal(p.short, true);
  assert.ok(Number.isInteger(p.enterSeq) && Number.isInteger(p.exitSeq));
  assert.notEqual(p.enterSeq, p.exitSeq);

  // 进入翻转必须由两条同刻支路共同建立，各保留一条完整因果路径。
  assert.ok(Array.isArray(p.chains));
  assert.equal(p.chains.length, 2, '进入翻转应保留两条支路，不得压缩为任意一条');
  const roots = p.chains.map((c) => c[0]).sort((x, y) => x.input.localeCompare(y.input));
  assert.deepEqual(roots.map((r) => [r.kind, r.t, r.input, r.from, r.to]),
    [['edge', 2, 'a', '1', '0'], ['edge', 2, 'b', '1', '0']]);
  const branchGates = p.chains.map((c) => c.slice(1, -1).map((n) => n.gate));
  assert.deepEqual(branchGates.sort((x, y) => String(x).localeCompare(String(y))), [['A'], ['B']]);
  for (const path of p.chains) {
    assert.equal(path[path.length - 1].seq, p.enterSeq, '两条路径必须汇合到同一进入事件');
    replayChain(res, path, p.enterSeq);
  }

  // 退出翻转同样由两条同刻恢复支路共同撤除。
  assert.equal(p.exitChains.length, 2);
  const exitRoots = p.exitChains.map((c) => c[0]).sort((x, y) => x.input.localeCompare(y.input));
  assert.deepEqual(exitRoots.map((r) => [r.t, r.input, r.from, r.to]),
    [[4, 'a', '0', '1'], [4, 'b', '0', '1']]);
  for (const path of p.exitChains) replayChain(res, path, p.exitSeq);

  // 兼容字段：首条进入路径。
  assert.deepEqual(p.chain, p.chains[0]);
});

test('双支路同刻汇合：门/连线/边沿录入顺序变化不影响事件标识、脉冲边界与因果证据', () => {
  const a = simulate(dualBranchConfig(false));
  const b = simulate(dualBranchConfig(true));
  const pa = a.pulses.find((x) => x.gate === 'Y');
  const pb = b.pulses.find((x) => x.gate === 'Y');
  assert.equal(a.status, b.status);
  assert.equal(a.normalized.hash, b.normalized.hash);
  for (const k of ['start', 'end', 'width', 'short', 'enterSeq', 'exitSeq']) {
    assert.equal(pa[k], pb[k], `字段 ${k} 不应随录入顺序变化`);
  }
  assert.deepEqual(pa.chains, pb.chains);
  assert.deepEqual(pa.exitChains, pb.exitChains);
});

test('单支路脉冲仍只产出一条因果路径（多诱因修复不污染单支路语义）', () => {
  const res = simulate(pulseConfig());
  const p = res.pulses.find((x) => x.gate === 'Y');
  assert.equal(p.chains.length, 1);
  assert.equal(p.exitChains.length, 1);
  replayChain(res, p.chains[0], p.enterSeq);
});

test('校验失败时 simulate 返回错误且不产出旧结论', () => {
  const res = simulate({ gates: [], edges: [], monitors: [] });
  assert.equal(res.ok, false);
  assert.equal(res.status, undefined);
});
