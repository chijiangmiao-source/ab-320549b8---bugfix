// 离散惯性延迟事件驱动仿真内核。
//
// 语义：
//  - 每个门有正整数惯性延迟 d；门输出仅当其计算值相对当前输出“连续保持 d 个刻度”
//    时才翻转。实现：计算值与输出不同即在 t 刻安排 t+d 的待发事件；
//    计算值恢复为当前输出时撤销该门的待发事件（惯性延迟 + 待发事件撤销），
//    因此短于 d 的输入扰动不会产生输出翻转，且“后续输入变化不得使失效翻转落入轨迹”。
//  - 同刻事件按稳定顺序处理：外部边沿（按输入名）→ 到期待发事件（按门标识）
//    → 受影响门闭包的同刻重算（按门标识迭代到不再变化）。
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

// 诱因标识为事件 seq（number）或 edge:t:input（string）/null（上电）。
// 同一事件的多个直接诱因必须按与录入顺序无关的稳定规则排序，
// 避免同刻多支路汇合时因果证据丢失或随录入顺序变化。
const causeCmp = (x, y) => {
  if (x === y) return 0;
  if (x == null) return -1;
  if (y == null) return 1;
  const sx = String(x), sy = String(y);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
};
const uniqCauses = (list) => [...new Set(list)].sort(causeCmp);

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

  // 当前值出处：门当前输出由哪次生效翻转建立（null=上电初值）；
  // 外部输入当前电平由哪条外部边沿建立（null=初始电平，静态背景）。
  // 调度待发事件时据此直接计算控制输入的诱因集合，
  // 使同刻多支路汇合被完整记录，且与录入/到达顺序无关。
  const valueOrigin = new Map();
  for (const g of gates) valueOrigin.set(g.id, null);
  const inputOrigin = new Map();
  for (const name of model.externalInputs) inputOrigin.set(name, null);

  let eventSeq = 0;
  const pending = new Map(); // gateId -> 待发事件 {seq,time,to,born,cause,causes} 或 null
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

  // 计算使门 g 当前输出为 want 的控制输入出处集合：
  //  NOT：唯一输入；AND→1：全部输入；AND→0：当前为 0 的输入（任一 0 即决定）；
  //  OR→0：全部输入；OR→1：当前为 1 的输入。
  // 出处为 FIRE 事件 seq（门输入）或 'edge:t:name'（外部输入）或 null（静态初值）。
  const controllingCauses = (g, want) => {
    const out = [];
    for (const link of g.inputs) {
      if (link.kind === 'input') {
        if (!inputValues.has(link.name) || inputValues.get(link.name) === 'x') continue;
        const controlling =
          g.type === 'NOT' ? true
          : g.type === 'AND' ? (want === '1' || inputValues.get(link.name) === '0')
          : (want === '0' || inputValues.get(link.name) === '1');
        if (controlling) out.push(inputOrigin.get(link.name) ?? null);
      } else {
        if (!values.has(link.id) || values.get(link.id) === 'x') continue;
        const controlling =
          g.type === 'NOT' ? true
          : g.type === 'AND' ? (want === '1' || values.get(link.id) === '0')
          : (want === '0' || values.get(link.id) === '1');
        if (controlling) out.push(valueOrigin.get(link.id));
      }
    }
    return uniqCauses(out);
  };

  // 重算门 g：必要时安排/撤销待发事件。诱因从各控制输入的当前值出处直接计算，
  // 同刻多支路（如 AND 两输入同刻变化）作为多个直接诱因共同保留；
  // 已安排但尚未生效的中间变化不会污染目标事件的因果证据。
  const reconsider = (g, t) => {
    const want = computeGate(g, values, inputValues);
    const cur = values.get(g.id);
    const p = pending.get(g.id);
    if (want === 'x') return null;
    // 建立当前计算值 want 的控制输入出处，即本次安排/撤销/延续的诱因。
    // 静态初值（null）仅当它是唯一诱因时保留——用于反馈环门上电失配自启动；
    // 若已存在真实事件诱因（外部边沿/门翻转），从未变化的静态背景不另立支路。
    const rawCauses = controllingCauses(g, want);
    const causes = rawCauses.some((c) => c != null) ? rawCauses.filter((c) => c != null) : rawCauses;
    const cause = causes[causes.length - 1] ?? null;
    if (want === cur) {
      if (p) {
        pending.set(g.id, null);
        eventsLog.push({ seq: p.seq, time: t, gate: g.id, action: 'CANCEL', wasTo: p.to, cause, causes: [...causes] });
        return { action: 'CANCEL', gate: g.id, seq: p.seq, wasTo: p.to, cause, causes: [...causes] };
      }
      return null;
    }
    if (p && p.to === want) {
      // 同目标待发事件保留：惯性窗口延续（出生时刻/生效时刻不变）。
      // 但诱因要刷新为当前控制输入出处：窗口内可能发生支路交棒或新支路汇入
      // （如 AND→0 期间第二个输入也变 0），证据须反映翻转生效时实际依赖的全部支路。
      const same = p.causes.length === causes.length && p.causes.every((c, i) => causeCmp(c, causes[i]) === 0);
      if (!same) {
        p.causes = [...causes];
        p.cause = cause;
        eventsLog.push({ seq: p.seq, time: t, gate: g.id, action: 'CAUSE_REFRESH', to: want, at: p.time, cause, causes: [...causes] });
      }
      return null;
    }
    if (p) eventsLog.push({ seq: p.seq, time: t, gate: g.id, action: 'CANCEL', wasTo: p.to, cause, causes });
    const seq = ++eventSeq;
    const ev = { seq, time: t + g.delay, gate: g.id, to: want, born: t, cause, causes: [...causes] };
    pending.set(g.id, ev);
    eventsLog.push({ seq, time: t, gate: g.id, action: 'SCHEDULE', to: want, at: ev.time, born: t, cause, causes: [...causes] });
    return { action: 'SCHEDULE', gate: g.id, seq, to: want, at: ev.time, cause, causes: [...causes] };
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
    for (const id of sortedIds) reconsider(gateMap.get(id), 0);
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
      inputOrigin.set(e.input, edgeCause(t, e.input));
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
      valueOrigin.set(ev.gate, ev.seq);
      pending.set(ev.gate, null);
      fired.push({ seq: ev.seq, gate: ev.gate, to: ev.to, born: ev.born, cause: ev.cause, causes: ev.causes });
      eventsLog.push({ seq: ev.seq, time: t, gate: ev.gate, action: 'FIRE', to: ev.to, cause: ev.cause, causes: ev.causes });
    }

    // 3) 同刻重算定点：脏门集合只作重算标记（诱因在 reconsider 内从当前值出处
    // 直接计算），按门标识稳定迭代到本刻无新安排/撤销。
    const dirty = new Set();
    for (const e of ext) {
      for (const g of gates) {
        if (g.inputs.some((l) => l.kind === 'input' && l.name === e.input)) dirty.add(g.id);
      }
    }
    for (const f of fired) {
      dirty.add(f.gate); // 自环门
      for (const g of gates) {
        if (g.inputs.some((l) => l.kind === 'gate' && l.id === f.gate)) dirty.add(g.id);
      }
    }
    let guard = 0;
    while (dirty.size > 0 && guard++ < gates.length * 6 + 8) {
      const id = [...dirty].sort()[0];
      dirty.delete(id);
      const r = reconsider(gateMap.get(id), t);
      if (r) {
        if (r.action === 'CANCEL') cancelled.push(r);
        for (const dg of gates) {
          if (dg.inputs.some((l) => l.kind === 'gate' && l.id === id)) dirty.add(dg.id);
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
  // 同一 seq 同时存在 SCHEDULE 与 FIRE 记录；因果追踪只沿实际生效翻转。
  const fireBySeq = new Map();
  for (const e of eventsLog) if (e.action === 'FIRE') fireBySeq.set(e.seq, e);

  const edgeNode = (cause) => {
    const [, ts, ...rest] = cause.split(':');
    const input = rest.join(':');
    const e = edgeTable.get(`${Number(ts)}:${input}`);
    return e
      ? { kind: 'edge', t: e.time, input: e.input, from: e.from, to: e.to }
      : { kind: 'edge', ref: cause };
  };
  const fireNode = (e) => ({ kind: 'fire', seq: e.seq, gate: e.gate, t: e.time, to: e.to });
  const pathKey = (path) => path.map((n) =>
    (n.kind === 'fire' ? `f:${n.seq}` : n.kind === 'edge' ? `e:${n.t}:${n.input ?? n.ref}` : n.kind))
    .join('>');

  /**
   * 从进入翻转事件出发，沿完整直接诱因集合枚举全部端到端因果路径：
   * 每条路径为 [外部边沿|上电初值, …中间门翻转, 汇合输出翻转]（按因果时间顺序）。
   * 同刻多支路汇合（如 AND 两个输入同刻变化）时不得压缩为任意一条。
   */
  const buildChains = (seq) => {
    const enter = fireBySeq.get(seq);
    if (!enter) return [];
    // prefixes(ev)：所有“根 → … → ev”的路径前缀。
    const prefixes = (ev, seen) => {
      const node = fireNode(ev);
      const raw = Array.isArray(ev.causes) && ev.causes.length
        ? ev.causes
        : (ev.cause == null ? [] : [ev.cause]);
      const roots = [];
      for (const c of uniqCauses(raw)) {
        if (c == null) {
          roots.push([{ kind: 'powerup', note: '上电初始状态' }]);
        } else if (typeof c === 'string' && c.startsWith('edge:')) {
          roots.push([edgeNode(c)]);
        } else if (typeof c === 'number') {
          const pred = fireBySeq.get(c);
          if (!pred) roots.push([{ kind: 'unknown', seq: c }]);
          else if (seen.has(c)) roots.push([{ kind: 'cycle', seq: c }]);
          else for (const p of prefixes(pred, new Set(seen).add(c))) roots.push(p);
        } else {
          roots.push([{ kind: 'unknown', ref: String(c) }]);
        }
      }
      return roots.map((p) => [...p, node]);
    };
    const paths = prefixes(enter, new Set([seq]));
    const dedup = new Map();
    for (const p of paths) if (!dedup.has(pathKey(p))) dedup.set(pathKey(p), p);
    return [...dedup.values()].sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
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
        const enterFire = fireBySeq.get(run.enterSeq);
        const enterCauses = enterFire
          ? uniqCauses(enterFire.causes?.length ? enterFire.causes : [enterFire.cause])
          : [];
        // 进入翻转存在两个及以上直接诱因（含同刻双支路）时，标记汇合事件。
        const converged = enterCauses.length >= 2;
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
          converged,
          branchCount: chains.length,
          // chain：稳定主路径（按诱因排序的第一条端到端路径），向后兼容；
          // chains：全部可独立复算的输入因果路径，多直接诱因不压缩。
          chain: chains[0] ?? [],
          chains,
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
      inputs: g.inputs.map((l) => (l.kind === 'gate' ? l.id : `input:${l.name}`)),
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
