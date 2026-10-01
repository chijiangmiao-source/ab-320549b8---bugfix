// 离散惯性延迟事件驱动仿真内核。
//
// 语义：
//  - 每个门有正整数惯性延迟 d；门输出仅当其计算值相对当前输出“连续保持 d 个刻度”
//    时才翻转。实现：计算值与输出不同即在 t 刻安排 t+d 的待发事件；
//    计算值恢复为当前输出时撤销该门的待发事件（惯性延迟 + 待发事件撤销），
//    因此短于 d 的输入扰动不会产生输出翻转，且“后续输入变化不得使失效翻转落入轨迹”。
//  - 同刻事件按稳定顺序处理：外部边沿（按输入名）→ 到期待发事件（按门标识）
//    → 受影响门闭包的同刻重算（按门标识迭代到不再变化）。
//    一个门同刻被多个直接诱因（多条外部边沿 / 多个门翻转）共同触发时，诱因集合
//    全部保留并规范化排序，短脉冲证据沿全部诱因回溯出每条独立输入因果路径，
//    不得压缩为任意一条。
//  - 悬空连线、重复驱动、非法边沿、环内零延迟等在 validate() 中逐项报错。
//  - 外部边沿结束后做状态规范化（门当前值 + 相对当前刻度的待发事件），
//    签名重复即得到振荡前缀与循环；无待发事件则为静稳。

export function validate(config) {
  const errors = [];
  const push = (code, message) => errors.push({ code, message });
  const gates = Array.isArray(config?.gates) ? config.gates : [];
  const rawEdges = Array.isArray(config?.edges) ? config.edges : [];
  const rawMonitors = Array.isArray(config?.monitors) ? config.monitors : [];

  if (gates.length === 0) push('NO_GATES', '至少需要定义一个门。');
  if (gates.length > 12) push('TOO_MANY_GATES', `门数量不得超过 12 个（当前 ${gates.length} 个）。`);

  const gateMap = new Map();
  const parsedGates = [];

  const normId = (s) => String(s ?? '').trim();
  const normLink = (raw, iw) => {
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) return { error: '为空（悬空连线）。' };
      if (s.startsWith('input:')) {
        const name = normId(s.slice(6));
        if (!name) return { error: '的外部输入名为空。' };
        return { link: { kind: 'input', name } };
      }
      return { link: { kind: 'gate', id: s } };
    }
    if (raw && typeof raw === 'object') {
      if (raw.kind === 'input') {
        const name = normId(raw.name);
        if (!name) return { error: '的外部输入名为空。' };
        return { link: { kind: 'input', name } };
      }
      const gid = normId(raw.id ?? raw.name);
      if (!gid) return { error: '未指定驱动门（悬空连线）。' };
      return { link: { kind: 'gate', id: gid } };
    }
    return { error: '为空（悬空连线）。' };
  };

  for (let i = 0; i < gates.length; i++) {
    const g = gates[i] || {};
    const where = `第 ${i + 1} 个门`;
    const id = normId(g.id);
    if (!id) { push('GATE_ID_MISSING', `${where} 缺少唯一标识。`); continue; }
    if (gateMap.has(id)) { push('GATE_ID_DUP', `门标识重复：“${id}”。`); continue; }

    const type = String(g.type ?? '').trim().toUpperCase();
    if (!['NOT', 'AND', 'OR'].includes(type)) {
      push('GATE_TYPE_BAD', `门“${id}”类型必须是 NOT、AND 或 OR（收到“${g.type}”）。`);
    }

    let delay = null;
    const dNum = Number(g.delay);
    if (g.delay === '' || g.delay === null || g.delay === undefined || !Number.isFinite(dNum) ||
        !Number.isInteger(dNum) || dNum <= 0) {
      push('DELAY_BAD', `门“${id}”的惯性延迟必须是正整数（收到“${g.delay}”）；零或负数延迟非法。`);
    } else {
      delay = dNum;
    }

    const inputs = Array.isArray(g.inputs) ? g.inputs : [];
    if (type === 'NOT' && inputs.length !== 1) {
      push('ARITY_BAD', `NOT 门“${id}”必须恰好有 1 条输入连线（当前 ${inputs.length} 条）。`);
    }
    if ((type === 'AND' || type === 'OR') && inputs.length < 1) {
      push('ARITY_BAD', `${type} 门“${id}”至少需要 1 条输入连线。`);
    }

    const parsedInputs = [];
    const seenDriver = new Set();
    inputs.forEach((raw, j) => {
      const iw = `门“${id}”第 ${j + 1} 条连线`;
      const { link, error } = normLink(raw, iw);
      if (error) { push('WIRE_EMPTY', `${iw} ${error}`); return; }
      const key = link.kind === 'gate' ? `g:${link.id}` : `in:${link.name}`;
      if (seenDriver.has(key)) {
        push('WIRE_DUP_DRIVER',
          `${iw}：同一驱动源“${link.kind === 'gate' ? link.id : 'input:' + link.name}”被重复接入该门（重复驱动）。`);
      }
      seenDriver.add(key);
      parsedInputs.push(link);
    });

    const rec = { id, type: ['NOT', 'AND', 'OR'].includes(type) ? type : null, delay, inputs: parsedInputs, index: i };
    gateMap.set(id, rec);
    parsedGates.push(rec);
  }

  // 悬空连线：门间引用必须存在。
  const externalInputs = new Set();
  for (const g of parsedGates) {
    for (const link of g.inputs) {
      if (link.kind === 'gate') {
        if (link.id !== g.id && !gateMap.has(link.id)) {
          push('WIRE_DANGLING', `门“${g.id}”的输入连线引用了不存在的门“${link.id}”（悬空连线）。`);
        }
      } else {
        externalInputs.add(link.name);
      }
    }
  }

  // 组合反馈环检测（用于环内零延迟判定）。
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(parsedGates.map((g) => [g.id, WHITE]));
  const inCycle = new Set();
  const dfs = (u, stack) => {
    color.set(u, GRAY);
    stack.push(u);
    const gu = gateMap.get(u);
    for (const link of gu.inputs) {
      if (link.kind !== 'gate' || !gateMap.has(link.id)) continue;
      const v = link.id;
      if (color.get(v) === GRAY) {
        const k = stack.lastIndexOf(v);
        for (let p = k; p < stack.length; p++) inCycle.add(stack[p]);
      } else if (color.get(v) === WHITE) {
        dfs(v, stack);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const g of parsedGates) if (color.get(g.id) === WHITE) dfs(g.id, []);
  for (const id of inCycle) {
    if (gateMap.get(id).delay === null) {
      push('ZERO_DELAY_CYCLE',
        `门“${id}”位于反馈环内但惯性延迟为 0 或非法；环内零延迟会导致同刻振荡，必须使用正延迟。`);
    }
  }

  // 外部边沿表。
  const normLevel = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    return s === '0' || s === 'false' ? '0' : s === '1' || s === 'true' ? '1' : null;
  };
  const edgeRecs = [];
  const edgeSeen = new Set();
  rawEdges.forEach((e, i) => {
    const where = `第 ${i + 1} 条边沿`;
    const name = normId(e?.input ?? e?.name);
    if (!name) { push('EDGE_BAD', `${where} 缺少外部输入标识。`); return; }
    const tNum = Number(e?.time);
    const tOk = Number.isInteger(tNum) && tNum >= 0;
    if (!tOk) push('EDGE_BAD', `${where}（输入“${name}”）时刻必须为非负整数（收到“${e?.time}”）。`);
    const from = normLevel(e?.from);
    const to = normLevel(e?.to);
    if (!from) push('EDGE_BAD', `${where}（输入“${name}”）起始电平非法：必须为 0 或 1（收到“${e?.from}”）。`);
    if (!to) push('EDGE_BAD', `${where}（输入“${name}”）目标电平非法：必须为 0 或 1（收到“${e?.to}”）。`);
    if (from && to && from === to) {
      push('EDGE_BAD', `${where}（输入“${name}”）不是有效边沿：from 与 to 相同（${from}）。`);
    }
    if (tOk) {
      const key = `${tNum}|${name}`;
      if (edgeSeen.has(key)) push('EDGE_BAD', `${where}：输入“${name}”在刻度 ${tNum} 存在重复边沿。`);
      edgeSeen.add(key);
    }
    if (tOk && from && to) edgeRecs.push({ time: tNum, input: name, from, to, index: i });
  });

  // 边沿方向必须连续衔接；输入初始电平由最早一条边沿的 from 隐含。
  const byInput = new Map();
  for (const e of edgeRecs) {
    if (!byInput.has(e.input)) byInput.set(e.input, []);
    byInput.get(e.input).push(e);
  }
  const inputInitial = new Map();
  for (const [name, list] of byInput) {
    list.sort((a, b) => a.time - b.time || a.index - b.index);
    let expect = null;
    for (const e of list) {
      if (expect === null) inputInitial.set(name, e.from);
      else if (e.from !== expect) {
        push('EDGE_INCONSISTENT',
          `输入“${name}”在刻度 ${e.time} 的边沿 from=${e.from} 与此前电平 ${expect} 矛盾（边沿表必须连续衔接）。`);
      }
      expect = e.to;
    }
  }
  for (const name of externalInputs) if (!inputInitial.has(name)) inputInitial.set(name, '0');
  if (config?.initialInputs && typeof config.initialInputs === 'object') {
    for (const [k, v] of Object.entries(config.initialInputs)) {
      const name = normId(k);
      const lv = normLevel(v);
      if (!name) continue;
      if (!lv) push('INITIAL_BAD', `外部输入“${name}”的初始电平非法：必须为 0 或 1（收到“${v}”）。`);
      else inputInitial.set(name, lv);
    }
  }
  for (const name of byInput.keys()) {
    if (!externalInputs.has(name)) {
      push('EDGE_UNUSED', `边沿表中的外部输入“${name}”未连接到任何门，请检查录入。`);
    }
  }

  // 受监控输出。
  const monitors = [];
  const monSeen = new Set();
  for (const m of rawMonitors) {
    const id = normId(m);
    if (!id) { push('MONITOR_BAD', '监控列表中存在空标识。'); continue; }
    if (!gateMap.has(id)) { push('MONITOR_BAD', `受监控输出“${id}”不是已定义的门。`); continue; }
    if (monSeen.has(id)) push('MONITOR_BAD', `受监控输出“${id}”重复列出。`);
    monSeen.add(id);
    monitors.push(id);
  }
  if (monitors.length === 0 && parsedGates.length > 0) {
    for (const g of parsedGates) monitors.push(g.id);
  }

  const model = {
    gates: parsedGates,
    gateMap,
    externalInputs,
    edges: edgeRecs.sort((a, b) => a.time - b.time || a.input.localeCompare(b.input) || a.index - b.index),
    initialInputs: inputInitial,
    monitors,
    inCycle: [...inCycle].sort(),
  };
  return { ok: errors.length === 0, errors, model };
}

function computeGate(g, values, inputs) {
  const lv = g.inputs.map((link) =>
    (link.kind === 'gate' ? values.get(link.id) : inputs.get(link.name)) ?? 'x');
  if (g.type === 'NOT') return lv[0] === 'x' ? 'x' : lv[0] === '1' ? '0' : '1';
  if (g.type === 'AND') return lv.some((v) => v === '0') ? '0' : lv.some((v) => v === 'x') ? 'x' : '1';
  return lv.some((v) => v === '1') ? '1' : lv.some((v) => v === 'x') ? 'x' : '0';
}

const edgeCause = (t, input) => `edge:${t}:${input}`;
const parseEdgeCause = (cause) => {
  const sep1 = cause.indexOf(':');
  const sep2 = cause.indexOf(':', sep1 + 1);
  return { t: Number(cause.slice(sep1 + 1, sep2)), name: cause.slice(sep2 + 1) };
};

/**
 * 执行仿真并返回完整复核结论。
 * config: { gates, edges, monitors, initialInputs? }
 * options: { maxTicks }
 */
export function simulate(config, options = {}) {
  const check = validate(config);
  if (!check.ok) return { ok: false, errors: check.errors };
  const model = check.model;
  const { gates, gateMap, edges, initialInputs, monitors } = model;
  const cycleGateSet = new Set(model.inCycle ?? []);
  const maxTicks = options.maxTicks ?? 4096;

  const inputValues = new Map(initialInputs);
  const values = new Map();
  for (const g of gates) values.set(g.id, '0'); // 确定性上电约定：门输出初值 0

  let eventSeq = 0;
  const pending = new Map(); // gateId -> 待发事件 {seq,time,to,born,cause} 或 null
  for (const g of gates) pending.set(g.id, null);
  const eventsLog = [];
  const timeline = [];

  const edgeByTime = new Map();
  for (const e of edges) {
    if (!edgeByTime.has(e.time)) edgeByTime.set(e.time, []);
    edgeByTime.get(e.time).push(e);
  }
  const lastEdgeTime = edges.reduce((m, e) => Math.max(m, e.time), -1);
  const endTime = lastEdgeTime + 1; // 外部边沿结束后的首个刻度

  const sortedIds = gates.map((g) => g.id).sort();

  // 诱因规范化：同刻多个直接诱因（外部边沿 / 到期待发事件）必须全部保留，
  // 且顺序与门、连线、边沿的录入顺序无关——外部边沿按（刻度、输入名），
  // 门翻转事件按事件标识数值排序；null（上电初值）排末尾。
  const compareCause = (x, y) => {
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const kx = typeof x === 'string' ? 0 : 1;
    const ky = typeof y === 'string' ? 0 : 1;
    if (kx !== ky) return kx - ky;
    if (kx === 0) {
      const px = parseEdgeCause(x);
      const py = parseEdgeCause(y);
      return px.t - py.t || px.name.localeCompare(py.name);
    }
    return x - y;
  };
  const canonicalCauses = (list) => {
    const uniq = [];
    for (const c of list) if (!uniq.includes(c ?? null)) uniq.push(c ?? null);
    return uniq.sort(compareCause);
  };

  // 重算门 g：必要时安排/撤销待发事件。causes 为本次重算的全部同刻诱因
  // （事件 seq 或 edge:t:name）；多个直接诱因不得压缩为任意一条。
  const reconsider = (g, t, causes) => {
    const cc = canonicalCauses(causes);
    const cause = cc[0] ?? null;
    const want = computeGate(g, values, inputValues);
    const cur = values.get(g.id);
    const p = pending.get(g.id);
    if (want === 'x') return null;
    if (want === cur) {
      if (p) {
        pending.set(g.id, null);
        eventsLog.push({ seq: p.seq, time: t, gate: g.id, action: 'CANCEL', wasTo: p.to, cause, causes: cc });
        return { action: 'CANCEL', gate: g.id, seq: p.seq, wasTo: p.to, cause, causes: cc };
      }
      return null;
    }
    if (p && p.to === want) {
      // 同目标待发事件保留：惯性窗口延续。这里到达的诱因只经过“安排”而非
      // “生效”的上游门——同刻真实值变化（FIRE）在重算前已全部生效并一次性
      // 播种，本刻该门输入实际未变，故这些预防性诱因不并入待发事件
      // （并入会把尚未传播到本门的外部边沿误记为翻转诱因）。
      return null;
    }
    if (p) eventsLog.push({ seq: p.seq, time: t, gate: g.id, action: 'CANCEL', wasTo: p.to, cause, causes: cc });
    const seq = ++eventSeq;
    const ev = { seq, time: t + g.delay, gate: g.id, to: want, born: t, cause, causes: cc };
    pending.set(g.id, ev);
    eventsLog.push({ seq, time: t, gate: g.id, action: 'SCHEDULE', to: want, at: ev.time, born: t, cause, causes: cc });
    return { action: 'SCHEDULE', gate: g.id, seq, to: want, at: ev.time, cause, causes: cc };
  };

  // 上电组合稳态：先直接求值组合部分（环外门按拓扑传播；环内门保持初值 0），
  // 再按此稳态建立初始待发事件（仅反馈环内因初值约定可能存在待决事件）。
  {
    const comboOrder = [];
    const done = new Set(cycleGateSet); // 环内门视为已固定，避免组合求值绕环
    let changed = true;
    while (changed && comboOrder.length + done.size < gates.length) {
      changed = false;
      for (const g of gates) {
        if (done.has(g.id)) continue;
        if (g.inputs.every((l) => l.kind === 'input' || done.has(l.id))) {
          values.set(g.id, computeGate(g, values, inputValues));
          done.add(g.id);
          comboOrder.push(g.id);
          changed = true;
        }
      }
    }
    for (const id of sortedIds) if (!done.has(id)) done.add(id);
    for (const id of sortedIds) reconsider(gateMap.get(id), 0, [null]);
  }

  const signatures = new Map(); // 规范化状态签名 -> 首次出现刻度
  let cycle = null;
  let stableConfirmed = false;
  let stopTick = null;

  let t = 0;
  for (; t <= maxTicks; t++) {
    const fired = [];
    const cancelled = [];
    const external = [];

    // 1) 外部边沿生效（稳定顺序）。
    const ext = (edgeByTime.get(t) || []).slice().sort((a, b) => a.input.localeCompare(b.input));
    for (const e of ext) {
      inputValues.set(e.input, e.to);
      external.push({ input: e.input, from: e.from, to: e.to });
    }

    // 2) 到期待发事件生效（稳定顺序：按门标识）。
    const due = [];
    for (const id of sortedIds) {
      const p = pending.get(id);
      if (p && p.time === t) due.push(p);
    }
    for (const ev of due) {
      values.set(ev.gate, ev.to);
      pending.set(ev.gate, null);
      fired.push({ seq: ev.seq, gate: ev.gate, to: ev.to, born: ev.born, cause: ev.cause, causes: ev.causes });
      eventsLog.push({ seq: ev.seq, time: t, gate: ev.gate, action: 'FIRE', to: ev.to, cause: ev.cause, causes: ev.causes });
    }

    // 3) 同刻重算定点：脏门集合携带诱因，按门标识稳定迭代到本刻无新结论。
    const dirty = new Map(); // gateId -> 同刻到达的诱因集合
    const seed = (id, cause) => {
      if (!dirty.has(id)) dirty.set(id, []);
      const causes = dirty.get(id);
      if (!causes.includes(cause)) causes.push(cause);
    };
    for (const e of ext) {
      const cause = edgeCause(t, e.input);
      for (const g of gates) {
        if (g.inputs.some((l) => l.kind === 'input' && l.name === e.input)) seed(g.id, cause);
      }
    }
    for (const f of fired) {
      // 仅按真实连线扇出播种：门自身翻转只在自环（自身输出接入自身输入）时
      // 才是自己的直接诱因；普通门翻转后其输入未变，不得把自身翻转事件
      // 误记为诱因（否则汇合输出的因果路径会被自身事件污染）。
      for (const g of gates) {
        if (g.inputs.some((l) => l.kind === 'gate' && l.id === f.gate)) seed(g.id, f.seq);
      }
    }
    let guard = 0;
    while (dirty.size > 0 && guard++ < gates.length * 6 + 8) {
      const id = [...dirty.keys()].sort()[0];
      const causes = dirty.get(id);
      dirty.delete(id);
      const r = reconsider(gateMap.get(id), t, causes);
      if (r) {
        if (r.action === 'CANCEL') cancelled.push(r);
        for (const dg of gates) {
          if (dg.inputs.some((l) => l.kind === 'gate' && l.id === id)) {
            for (const cause of causes) seed(dg.id, cause);
          }
        }
      }
    }

    timeline.push({
      t,
      values: Object.fromEntries(sortedIds.map((id) => [id, values.get(id)])),
      fired,
      cancelled,
      external,
    });

    // 边沿激励结束后，规范化“门值 + 相对待发事件”以识别重复配置。
    if (t >= endTime) {
      const sig = stateSignature(sortedIds, values, pending, t);
      if (signatures.has(sig.key)) {
        cycle = { start: signatures.get(sig.key), end: t, key: sig.key };
        stopTick = t;
        break;
      }
      signatures.set(sig.key, t);
      if ([...pending.values()].every((p) => p === null)) {
        stableConfirmed = true;
        stopTick = t; // 无待发事件：自治系统不可能再变，静稳
        break;
      }
    }
  }
  if (stopTick === null) stopTick = maxTicks;

  const framesBetween = (t0, t1) =>
    timeline.filter((s) => s.t >= t0 && s.t < t1).map((s) => ({
      t: s.t,
      relative: s.t - t0,
      values: s.values,
      external: s.external,
      fired: s.fired,
      cancelled: s.cancelled,
    }));

  let status = 'UNRESOLVED';
  let oscillation = null;
  if (cycle) {
    status = 'OSCILLATING';
    const cycleFrames = framesBetween(cycle.start, cycle.end);
    const toggled = new Set();
    for (const f of cycleFrames) for (const e of f.fired) toggled.add(e.gate);
    oscillation = {
      prefix: framesBetween(endTime, cycle.start),
      cycle: cycleFrames,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      period: cycle.end - cycle.start,
      gates: [...toggled].filter((id) => monitors.includes(id)).sort(),
      events: cycleEvents(eventsLog, cycle.start, cycle.end),
      signature: cycle.key,
    };
  } else if (stableConfirmed) {
    status = 'STABLE';
  }

  const allRuns = detectPulses(timeline, monitors, gateMap, eventsLog, edges);
  const pulses = allRuns.filter((p) => p.short);
  const finalValues = Object.fromEntries(sortedIds.map((id) => [id, values.get(id)]));
  const stableValues = Object.fromEntries(monitors.map((id) => [id, values.get(id)]));

  return {
    ok: true,
    status,
    monitors,
    endTime,
    stopTick,
    stableValues,
    finalValues,
    inputValues: Object.fromEntries([...inputValues.entries()].sort()),
    timeline: timeline.map((s) => ({ t: s.t, values: s.values, fired: s.fired, cancelled: s.cancelled, external: s.external })),
    events: eventsLog,
    pendingAfterEnd: [...pending.values()].filter(Boolean).map((p) => ({
      gate: p.gate, to: p.to, at: p.time, relativeToEnd: p.time - endTime,
    })),
    oscillation,
    pulses,
    normalized: normalizeModel(model),
  };
}

function stateSignature(sortedIds, values, pending, t) {
  const rel = sortedIds.map((id) => {
    const p = pending.get(id);
    return `${id}=${values.get(id)}${p ? `>${p.to}@${p.time - t}` : ''}`;
  });
  return { key: rel.join('|') };
}

function cycleEvents(eventsLog, t0, t1) {
  return eventsLog
    .filter((e) => e.action === 'FIRE' && e.time >= t0 && e.time < t1)
    .sort((a, b) => a.time - b.time || a.gate.localeCompare(b.gate) || a.seq - b.seq)
    .map((e) => ({ seq: e.seq, t: e.time, relative: e.time - t0, gate: e.gate, to: e.to, cause: e.cause }));
}

/**
 * 短脉冲检测：受监控输出上的有界窄电平段（前后均为相反电平，如 0-1-0）。
 * 惯性延迟语义下输出电平段宽度不可能小于该门延迟；宽度恰好等于延迟者为
 * 临界窄脉冲（仅靠惯性窗口边界存活），标记 short=true，并给出起止刻度、宽度、
 * 进入/退出翻转的事件标识以及可回溯到外部边沿的因果事件链。
 */
function detectPulses(timeline, monitors, gateMap, eventsLog, edges) {
  const initial = timeline[0]?.values ?? {};
  // 每个受监控门的电平段：[{level,start,end,enterSeq,exitSeq}]
  const runsById = new Map();
  for (const id of monitors) {
    const runs = [{ level: initial[id] ?? '0', start: 0, end: null, enterSeq: null }];
    for (const s of timeline) {
      for (const f of s.fired) {
        if (f.gate !== id) continue;
        const last = runs[runs.length - 1];
        last.end = s.t;
        last.exitSeq = f.seq;
        runs.push({ level: f.to, start: s.t, end: null, enterSeq: f.seq });
      }
    }
    runsById.set(id, runs);
  }

  const edgeTable = new Map(edges.map((e) => [`${e.time}:${e.input}`, e]));
  const bySeq = new Map(eventsLog.map((e) => [e.seq, e]));

  const nodeOfCause = (cause) => {
    if (cause == null) return { kind: 'powerup', note: '上电初始状态' };
    if (typeof cause === 'string' && cause.startsWith('edge:')) {
      const { t, name } = parseEdgeCause(cause);
      const e = edgeTable.get(`${t}:${name}`);
      return e
        ? { kind: 'edge', t: e.time, input: e.input, from: e.from, to: e.to }
        : { kind: 'edge', ref: cause };
    }
    const ev = bySeq.get(cause);
    return ev ? { kind: 'fire', seq: ev.seq, gate: ev.gate, t: ev.time, to: ev.to }
      : { kind: 'unknown', seq: cause };
  };

  // 沿一个翻转事件的“全部直接诱因”回溯（causes 已在仿真期规范化排序），
  // 枚举出每条从外部边沿（或上电初值）到该翻转的完整因果路径。
  // 同刻多个直接诱因各自独立成路，不得压缩为任意一条；
  // 汇合后的输出事件在每条路径末尾保留，使每条支路均可连续复算。
  const buildChains = (seq) => {
    const paths = [];
    const walk = (curSeq, suffix, onPath) => {
      const cur = bySeq.get(curSeq);
      if (!cur || onPath.has(curSeq)) {
        paths.push([nodeOfCause(curSeq), ...suffix]);
        return;
      }
      const node = { kind: 'fire', seq: cur.seq, gate: cur.gate, t: cur.time, to: cur.to };
      const causes = (Array.isArray(cur.causes) && cur.causes.length ? cur.causes : [cur.cause ?? null]);
      const roots = causes.filter((c) => c == null || typeof c === 'string');
      if (roots.length === causes.length) {
        // 本节点直接由外部边沿 / 上电触发：每个诱因各自成路。
        for (const c of causes) paths.push([nodeOfCause(c), node, ...suffix]);
        return;
      }
      onPath.add(curSeq);
      for (const c of causes) {
        if (c == null || typeof c === 'string') paths.push([nodeOfCause(c), node, ...suffix]);
        else walk(c, [node, ...suffix], onPath);
      }
      onPath.delete(curSeq);
    };
    walk(seq, [], new Set());
    // 去重（不同诱因可能汇合到同一上游翻转）并保持确定性顺序。
    const seen = new Set();
    return paths.filter((path) => {
      const key = path.map((n) => n.kind === 'fire' ? `f${n.seq}` : n.kind === 'edge' ? `e${n.t}:${n.input}` : n.kind).join('>');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const pulses = [];
  for (const id of monitors) {
    const runs = runsById.get(id);
    for (let i = 1; i < runs.length - 1; i++) {
      const run = runs[i];
      const before = runs[i - 1];
      const after = runs[i + 1];
      if (run.end == null) continue;
      if (before.level !== run.level && after.level === before.level) {
        const width = run.end - run.start;
        const chains = buildChains(run.enterSeq);
        const exitChains = after.enterSeq == null ? [] : buildChains(after.enterSeq);
        pulses.push({
          gate: id,
          level: run.level,
          start: run.start,
          end: run.end,
          width,
          inertialDelay: gateMap.get(id).delay,
          short: width <= gateMap.get(id).delay,
          enterSeq: run.enterSeq,
          exitSeq: after.enterSeq,
          // 进入翻转的全部输入因果路径：每条均从一个外部边沿（或上电初值）
          // 连续经过各自支路的门翻转，汇合到该输出进入事件。
          chains,
          // 退出翻转的全部输入因果路径，用于复核脉冲边界的建立与撤除。
          exitChains,
          // 兼容旧消费方：首条进入路径（按规范化诱因顺序确定）。
          chain: chains[0] ?? [],
        });
      }
    }
  }
  return pulses.sort((a, b) => a.start - b.start || a.gate.localeCompare(b.gate));
}

/** 规范化配置：门按标识排序、连线归一化、边沿/初值归一化，并生成去重哈希。 */
export function normalizeConfig(config) {
  const check = validate(config);
  if (!check.ok) return { ok: false, errors: check.errors };
  return { ok: true, ...normalizeModel(check.model) };
}

function normalizeModel(model) {
  const gates = [...model.gates]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((g) => ({
      id: g.id,
      type: g.type,
      delay: g.delay,
      // 连线按归一化驱动源排序：连线录入顺序不影响规范化哈希。
      inputs: g.inputs.map((l) => (l.kind === 'gate' ? l.id : `input:${l.name}`)).sort(),
    }));
  const edges = model.edges
    .map((e) => ({ time: e.time, input: e.input, from: e.from, to: e.to }))
    .sort((a, b) => a.time - b.time || a.input.localeCompare(b.input));
  const initialInputs = Object.fromEntries([...model.initialInputs.entries()].sort());
  const normalized = { gates, edges, initialInputs, monitors: [...model.monitors].sort() };
  const json = canonicalJSON(normalized);
  return { normalized, json, hash: fnv1a(json) };
}

function canonicalJSON(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
