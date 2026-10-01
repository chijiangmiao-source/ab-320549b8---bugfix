import { simulate } from '../src/sim.js';

const $ = (sel) => document.querySelector(sel);
const gateRows = $('#gateRows');
const edgeBody = $('#edgeTable tbody');
const DRAFT_KEY = 'inertial-review-draft-v1';

let gateSeq = 0;

function gateRowHtml(g = {}) {
  gateSeq += 1;
  const div = document.createElement('div');
  div.className = 'gate-row';
  div.innerHTML = `
    <input data-k="id" placeholder="门标识，如 Y1" value="${esc(g.id ?? '')}" />
    <select data-k="type">
      ${['NOT', 'AND', 'OR'].map((t) => `<option ${g.type === t ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <input data-k="delay" type="number" min="1" step="1" placeholder="延迟" value="${esc(g.delay ?? '')}" />
    <input data-k="inputs" placeholder="连线：A, input:en" value="${esc(Array.isArray(g.inputs) ? g.inputs.join(', ') : '')}" />
    <button type="button" class="ghost del" title="删除">✕</button>`;
  div.querySelector('.del').addEventListener('click', () => div.remove());
  return div;
}

function edgeRowHtml(e = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input data-k="time" type="number" min="0" step="1" value="${esc(e.time ?? '')}" style="width:80px" /></td>
    <td><input data-k="input" placeholder="输入名" value="${esc(e.input ?? '')}" /></td>
    <td><input data-k="from" type="text" maxlength="1" value="${esc(e.from ?? '')}" style="width:52px" /></td>
    <td><input data-k="to" type="text" maxlength="1" value="${esc(e.to ?? '')}" style="width:52px" /></td>
    <td><button type="button" class="ghost del">✕</button></td>`;
  tr.querySelector('.del').addEventListener('click', () => tr.remove());
  return tr;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function collectConfig() {
  const gates = [...gateRows.children].map((row) => {
    const get = (k) => row.querySelector(`[data-k="${k}"]`);
    const inputs = get('inputs').value.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      id: get('id').value.trim(),
      type: get('type').value,
      delay: get('delay').value.trim(),
      inputs,
    };
  });
  const edges = [...edgeBody.children].map((row) => {
    const get = (k) => row.querySelector(`[data-k="${k}"]`);
    return { time: get('time').value.trim(), input: get('input').value.trim(), from: get('from').value.trim(), to: get('to').value.trim() };
  });
  const monitors = $('#monitors').value.split(',').map((s) => s.trim()).filter(Boolean);
  const initialInputs = {};
  $('#initialInputs').value.split(',').map((s) => s.trim()).filter(Boolean).forEach((pair) => {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (k) initialInputs[k] = v;
  });
  return { gates, edges, monitors, initialInputs };
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(collectConfig())); } catch { /* ignore */ }
}
function loadDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { d = null; }
  return d;
}

function hydrate(d) {
  gateRows.innerHTML = '';
  edgeBody.innerHTML = '';
  (d?.gates?.length ? d.gates : [{ id: 'Y', type: 'NOT', delay: 3, inputs: 'input:x' }]).forEach((g) => gateRows.appendChild(gateRowHtml(g)));
  (d?.edges || []).forEach((e) => edgeBody.appendChild(edgeRowHtml(e)));
  if (!edgeBody.children.length) {
    edgeBody.appendChild(edgeRowHtml({ time: 0, input: 'x', from: 0, to: 1 }));
    edgeBody.appendChild(edgeRowHtml({ time: 1, input: 'x', from: 1, to: 0 }));
  }
  $('#monitors').value = (d?.monitors || []).join(', ');
  $('#initialInputs').value = Object.entries(d?.initialInputs || {}).map(([k, v]) => `${k}=${v}`).join(', ');
}

function chainHtml(chain) {
  return chain.map((c) => {
    if (c.kind === 'edge') return `边沿 t=${c.t} ${esc(c.input)}:${c.from}→${c.to}`;
    if (c.kind === 'fire') return `#${c.seq} ${esc(c.gate)}→${c.to}@t${c.t}`;
    if (c.kind === 'powerup') return '上电初值';
    if (c.kind === 'cycle') return `#${c.seq}（反馈环内）`;
    return JSON.stringify(c);
  }).join(' &nbsp;→&nbsp; ');
}

function pulseChainHtml(pulse) {
  const chains = pulse.chains?.length ? pulse.chains : (pulse.chain?.length ? [pulse.chain] : []);
  if (!chains.length) return '<span class="chain-trace">起因待定</span>';
  if (chains.length === 1) {
    const first = chains[0][0];
    const origin = first?.kind === 'edge'
      ? `起因 t=${first.t} ${esc(first.input)}`
      : first?.kind === 'powerup' ? '起因上电' : '起因待定';
    return `<span class="chain-origin">${origin}</span><span class="chain-trace">${chainHtml(chains[0])}</span>`;
  }
  // 多条可独立复算的输入因果路径（同刻多支路汇合）：逐条回放，不得压缩为一条。
  const rows = chains.map((ch, i) => {
    const root = ch[0];
    const rootTxt = root?.kind === 'edge'
      ? `支路 ${i + 1}：边沿 t=${root.t} ${esc(root.input)}:${root.from}→${root.to}`
      : root?.kind === 'powerup' ? `支路 ${i + 1}：上电初值` : `支路 ${i + 1}`;
    const joinSeq = pulse.enterSeq;
    const trace = chainHtml(ch);
    return `<div class="chain-branch"><span class="chain-origin">${rootTxt}</span><span class="chain-trace">${trace}</span>${ch[ch.length - 1]?.seq === joinSeq ? '<span class="converge">⇢ 汇合 #' + joinSeq + '</span>' : ''}</div>`;
  }).join('');
  return `<div class="chain-converge">${pulse.converged ? '同刻多支路汇合（' : ''}${chains.length} 条可复算因果路径${pulse.converged ? '）' : ''}</div>${rows}`;
}

function framesTable(frames, monitors, title) {
  if (!frames.length) return `<p class="kv">${title}：空</p>`;
  const head = `<tr><th>相对刻</th><th>刻度</th>${monitors.map((m) => `<th>${esc(m)}</th>`).join('')}<th>本刻事件</th></tr>`;
  const rows = frames.map((f) => {
    const evs = [
      ...f.external.map((e) => `边沿 ${esc(e.input)} ${e.from}→${e.to}`),
      ...f.fired.map((e) => `#${e.seq} ${esc(e.gate)}→${e.to} 生效`),
      ...f.cancelled.map((e) => `#${e.seq} ${esc(e.gate)}→${esc(e.wasTo ?? '')} 撤销`),
    ].join('；') || '—';
    return `<tr><td>${f.relative}</td><td>${f.t}</td>${monitors.map((m) => `<td class="v${f.values[m]}">${f.values[m]}</td>`).join('')}<td style="text-align:left">${evs}</td></tr>`;
  }).join('');
  return `<div class="sec-title">${title}</div><table class="out"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function render(result) {
  const box = $('#result');
  box.classList.remove('hidden');
  if (!result.ok) {
    box.innerHTML = `<h2><span class="badge err">校验失败 · 已清除旧结论</span></h2>
      <ul class="errors">${result.errors.map((e) => `<li>[${e.code}] ${esc(e.message)}</li>`).join('')}</ul>`;
    return;
  }
  const stableLine = Object.entries(result.stableValues).map(([k, v]) => `${esc(k)}=<b>${v}</b>`).join('，');
  const badgeCls = result.status === 'OSCILLATING' ? 'osc' : result.status === 'UNRESOLVED' ? 'err' : 'stable';
  const badgeText = result.status === 'OSCILLATING' ? '持续振荡' : result.status === 'UNRESOLVED' ? '观察窗口内未收敛' : '静稳';
  let html = `<h2><span class="badge ${badgeCls}">${badgeText}</span></h2>`;
  html += `<p class="kv">外部边沿结束刻度：${result.endTime} ｜ 规范化配置哈希：<code>${result.normalized.hash}</code> ｜ 静稳输出：${stableLine}</p>`;

  if (result.pulses.length) {
    html += `<div class="sec-title">短脉冲（${result.pulses.length} 个）</div>
      <table class="out"><thead><tr><th>输出</th><th>电平</th><th>起</th><th>止</th><th>宽度</th><th>门惯性延迟</th><th>进入/退出事件</th><th style="text-align:left">因果事件链</th></tr></thead><tbody>`;
    html += result.pulses.map((p) => `<tr class="pulse-row">
      <td>${esc(p.gate)}</td><td class="v${p.level}">${p.level}</td><td>${p.start}</td><td>${p.end}</td>
      <td><b>${p.width}</b> 刻</td><td>${p.inertialDelay}</td><td>#${p.enterSeq} → #${p.exitSeq}</td>
      <td style="text-align:left"><div class="chain">${pulseChainHtml(p)}</div></td></tr>`).join('');
    html += `</tbody></table>`;
  } else {
    html += `<p class="kv">未发现短脉冲。</p>`;
  }

  if (result.status === 'OSCILLATING') {
    const o = result.oscillation;
    html += `<div class="sec-title">振荡证据</div>
      <p class="kv">循环区间：t=${o.cycleStart}…${o.cycleEnd - 1}（周期 ${o.period} 刻）｜
      振荡门：${o.gates.map(esc).join(', ') || '—'} ｜
      循环事件标识：${o.events.map((e) => `#${e.seq}@${e.relative}`).join(', ')}</p>
      <p class="kv">状态签名（门值与相对待发事件）重复：<code>${esc(o.signature)}</code></p>`;
    html += framesTable(o.prefix, result.monitors, '振荡前缀（边沿结束后到进入循环）');
    html += framesTable(o.cycle, result.monitors, '可回放循环（按稳定门顺序与事件标识）');
  } else {
    const tail = result.timeline.filter((s) => s.t >= result.endTime);
    html += framesTable(tail.map((s) => ({ ...s, relative: s.t - result.endTime })), result.monitors, '边沿结束后的轨迹');
    if (result.pendingAfterEnd.length) {
      html += `<p class="kv">结束后仍有待发事件：${result.pendingAfterEnd.map((p) => `${esc(p.gate)}→${p.to}@+${p.relativeToEnd}`).join('，')}（均在生效前得到确认，未影响静稳结论）</p>`;
    }
  }
  box.innerHTML = html;
}

$('#addGate').addEventListener('click', () => gateRows.appendChild(gateRowHtml({ type: 'AND', delay: 1 })));
$('#addEdge').addEventListener('click', () => edgeBody.appendChild(edgeRowHtml()));
$('#clear').addEventListener('click', () => {
  localStorage.removeItem(DRAFT_KEY);
  gateRows.innerHTML = '';
  edgeBody.innerHTML = '';
  $('#monitors').value = '';
  $('#initialInputs').value = '';
  $('#result').classList.add('hidden');
  hydrate(null);
  $('#draftNote').textContent = '草稿已清空。';
});
$('#submit').addEventListener('click', () => {
  saveDraft();
  $('#draftNote').textContent = '';
  const config = collectConfig();
  try {
    render(simulate(config));
  } catch (err) {
    render({ ok: false, errors: [{ code: 'INTERNAL', message: String(err?.stack || err) }] });
  }
});

hydrate(loadDraft());
