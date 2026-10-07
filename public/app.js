const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, style = '') => `<svg class="i" style="${style}"><use href="#i-${id}"/></svg>`;
const fmtTok = (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); };
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const hhmm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const initials = (n) => String(n || '?').trim().charAt(0).toUpperCase();
const EFFORT = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const STATUS = { running: 'Running', done: 'Done', passed: 'Passed', 'needs-you': 'Needs you', stopped: 'Stopped', error: 'Error', idle: 'Idle' };
const lastLine = (t) => (t || '').trim().split(/\r?\n/).pop().replace(/[*`_]/g, '').trim();
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

async function api(p, b) {
  const r = await fetch(p, b !== undefined ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : undefined);
  const j = await r.json(); if (j && j.error) { toast(j.error); throw new Error(j.error); } return j;
}
function toast(text) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; $('#toasts').append(t); setTimeout(() => t.remove(), 4000); }

const S = { seats: {}, order: [], rooms: {}, active: null, models: {}, efforts: {}, limits: {}, settings: {}, connected: false };
const roundLabel = (round) => typeof round === 'number' ? `Round ${round}` : round ? String(round).replace(/^./, (c) => c.toUpperCase()) : '';
const seatColor = (id) => S.seats[id]?.color || 'var(--text-3)';
const avatar = (id, cls = '') => { const s = S.seats[id]; return `<div class="av ${cls} ${s?.status === 'working' ? 'working' : ''}" style="--c:${s?.color || 'var(--text-3)'}">${initials(s?.name || id)}</div>`; };
const kindIcon = (k) => k === 'meeting' ? 'users' : k === 'chain' ? 'loop' : 'chat';
const KIND = { meeting: 'Debate', chain: 'Propose → Review', dm: 'Direct chat' };

/* ================= top bar ================= */
const WIN = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' };
function countdown(ms) { if (!ms) return ''; let s = Math.max(0, Math.round((ms - Date.now()) / 1000)); const d = Math.floor(s / 86400); s %= 86400; const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
// One group per CLI: [agent, windows[]], Claude first.
function meterGroups() {
  const out = [];
  for (const [agent, lim] of Object.entries(S.limits || {})) {
    if (!lim) continue;
    const ws = Object.entries(lim.windows || {}).map(([k, w]) => ({ agent, k, pct: Math.max(0, Math.min(100, w.pct || 0)), resetsAt: w.resetsAt, updated: lim.updated }));
    if (ws.length) out.push([agent, ws.sort((a, b) => (a.k === 'five_hour' ? -1 : b.k === 'five_hour' ? 1 : 0))]);
  }
  return out.sort(([a], [b]) => (a === 'claude' ? 0 : 1) - (b === 'claude' ? 0 : 1));
}
const cliName = (a) => a === 'claude' ? 'Claude' : 'Codex';
const pctTxt = (p) => p.toFixed(p < 10 ? 1 : 0) + '%';
let meterPop = false;
function renderMeters() {
  const groups = meterGroups();
  const meters = groups.map(([agent, ws]) => {
    const m = ws.reduce((a, b) => (b.pct > a.pct ? b : a));
    const col = m.pct >= 90 ? 'var(--bad)' : m.pct >= 75 ? 'var(--warn)' : agent === 'claude' ? 'var(--claude)' : 'var(--codex)';
    return `<div class="meter" title="Updated ${m.updated ? hhmm(m.updated) : '—'} · click for all windows"><div class="top"><span>${cliName(agent)} <b>${pctTxt(m.pct)}</b> · ${WIN[m.k] || m.k}</span></div><div class="bar"><i style="width:${m.pct}%;background:${col}"></i></div><div class="sub" data-reset="${m.resetsAt || ''}">resets in ${countdown(m.resetsAt)}</div></div>`;
  }).join('') || '<span class="hint" style="margin:0">Usage appears after the first agent run</span>';
  const pop = !meterPop ? '' : `<div class="mpop" id="mpop">${groups.map(([agent, ws]) => `<div class="mpop-h" style="margin-top:${agent === groups[0][0] ? 0 : 10}px">${cliName(agent)}</div>${ws.map((m) => `<div class="mpop-r"><span>${WIN[m.k] || m.k}</span><b>${pctTxt(m.pct)}</b><span class="sub" data-reset="${m.resetsAt || ''}">resets in ${countdown(m.resetsAt)}</span></div>`).join('')}`).join('') || '<div class="hint" style="margin:0">No usage data yet</div>'}
    <button class="btn sm" id="mProbe">Refresh Claude usage (~$0.001)</button></div>`;
  $('#meters').innerHTML = meters + pop;
  $('#mProbe') && ($('#mProbe').onclick = async () => { try { await api('/api/limits/refresh', {}); toast('Refreshing usage…'); } catch {} });
}
$('#meters').onclick = (e) => { if (e.target.closest('#mpop')) return; meterPop = !meterPop; renderMeters(); };
document.addEventListener('click', (e) => { if (meterPop && !e.composedPath().includes($('#meters'))) { meterPop = false; renderMeters(); } });
function budgetWarning() {
  const c = S.limits?.claude; const w = c?.windows?.seven_day;
  if (!w || !c.updated || Date.now() - new Date(c.updated) > 6 * 3600e3) return null;
  return w.pct >= 80 ? w.pct : null;
}
function renderConn() { $('#conn').innerHTML = `<span class="dot ${S.connected ? 'ok' : 'bad'}"></span><span>${S.connected ? 'Live' : 'Reconnecting'}</span>`; }

/* ================= sidebar ================= */
function renderSessions() {
  const list = Object.values(S.rooms).sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.created.localeCompare(a.created));
  const TAG = { 'needs-you': 1, error: 1, stopped: 1, passed: 1 };
  $('#sessions').innerHTML = list.length ? list.map((r) => `<div class="row ${r.id === S.active ? 'on' : ''}" data-room="${r.id}" title="${esc(new Date(r.created).toLocaleString())}">
      <div class="kind">${icon(kindIcon(r.kind), 'width:14px;height:14px')}</div>
      <div class="t">${esc(r.title)}<span class="sub">${KIND[r.kind] || r.kind}${r.usage?.tokens ? ' · ' + fmtTok(r.usage.tokens) + ' tok' : ''}</span></div>
      ${r.status === 'running' ? '<span class="dot live"></span>' : TAG[r.status] ? `<span class="pill ${r.status}" style="height:18px;padding:0 7px;font-size:10.5px">${STATUS[r.status]}</span>` : `<span class="m">${ago(r.created)}</span>`}</div>`).join('')
    : '<div class="hint" style="padding:4px 8px">No sessions yet</div>';
  $('#sessions').querySelectorAll('[data-room]').forEach((el) => el.onclick = () => openRoom(el.dataset.room));
}
function renderAgents() {
  $('#agents').innerHTML = S.order.map((id) => { const s = S.seats[id]; return `<div class="row" data-seat="${id}" title="${esc([`Effort: ${EFFORT[s.effort] || s.effort}`, s.activity].filter(Boolean).join(' · '))}">
      ${avatar(id)}<div class="t">${esc(s.name)}<span class="sub">${s.status === 'working' ? `<span style="color:var(--warn)">${esc(s.activity || 'working')}…</span>` : s.status === 'error' ? `<span style="color:var(--bad)">error</span>` : esc([s.role, s.model].filter(Boolean).join(' · '))}</span></div>
      <span class="dot ${s.status === 'working' ? 'live' : s.status === 'error' ? 'bad' : ''}"></span></div>`; }).join('');
  $('#agents').querySelectorAll('[data-seat]').forEach((el) => el.onclick = () => openAgent(el.dataset.seat));
}

/* ================= markdown ================= */
function md(s) {
  const out = []; let list = false, code = false, buf = [];
  for (const raw of String(s).split('\n')) {
    if (raw.trim().startsWith('```')) { if (code) { out.push(`<pre>${esc(buf.join('\n'))}</pre>`); buf = []; } code = !code; continue; }
    if (code) { buf.push(raw); continue; }
    let l = esc(raw).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1');
    const li = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${li[1]}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (/^#{1,4}\s/.test(l)) { out.push(`<h4>${l.replace(/^#+\s/, '')}</h4>`); continue; }
    if (l.trim()) out.push(`<p>${l}</p>`);
  }
  if (list) out.push('</ul>'); if (code) out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
  return out.join('');
}

/* ================= main: home ================= */
function renderHome() {
  const seats = Object.values(S.seats), tok = seats.reduce((a, s) => a + (s.used || 0), 0), cost = seats.reduce((a, s) => a + (s.cost || 0), 0);
  const warn = budgetWarning();
  $('#main').innerHTML = `${warn ? `<div class="banner">${icon('alert')}<span><b>Claude weekly usage is at ${warn.toFixed(0)}%.</b> Consider Codex agents for heavy work.</span></div>` : ''}
    <div class="home">
      <h2>Start a session</h2><p class="lead">Agents are Claude or Codex CLI runs with a role. Every turn uses your plan quota. Agents can read your project but never edit it.</p>
      <div class="tpls">
        <button class="tpl" data-tpl="meeting"><div class="ic">${icon('users')}</div><b>Debate</b><span>A scout reads the code once, agents give independent ideas, discuss, and a facilitator writes the synthesis.</span></button>
        <button class="tpl" data-tpl="chain"><div class="ic">${icon('loop')}</div><b>Propose → Review</b><span>One agent proposes a change, another reviews it with a PASS/FAIL verdict, looping until it passes.</span></button>
        <button class="tpl" data-tpl="dm"><div class="ic">${icon('chat')}</div><b>Direct chat</b><span>A direct conversation with a single agent that remembers previous messages.</span></button>
      </div>
      ${tok || cost ? `<p class="hint" style="margin-top:22px">This project so far: ${fmtTok(tok)} tokens · $${cost.toFixed(2)} Claude</p>` : ''}
    </div>`;
  $('#main').querySelectorAll('[data-tpl]').forEach((b) => b.onclick = () => openNew(b.dataset.tpl));
}

/* ================= main: room ================= */
// Full build of the room view. Runs only when the active room changes (openRoom) or the view is missing.
function renderRoom() {
  const r = S.rooms[S.active];
  if (!r) { $('#main').innerHTML = '<div class="empty">Starting session…</div>'; return; }
  $('#main').innerHTML = `<div class="head"></div>
    <div class="feed" id="feed"><div class="feed-inner" id="feedInner"></div></div>
    <div class="composer" id="composerArea"></div>`;
  renderRoomHead(); renderComposer();
  r.messages.forEach((m) => paintMsg(m, false));
  if (!r.messages.length) $('#feedInner').innerHTML = '<div class="empty">No messages yet.</div>';
  const f = $('#feed'); f.scrollTop = f.scrollHeight;
}
// Repaints only the header: title, pills, Stop, Run again, Result, Delete.
function renderRoomHead() {
  const r = S.rooms[S.active], h = $('#main .head'); if (!r || !h) return;
  const total = r.kind === 'meeting' ? r.rounds : r.kind === 'chain' ? r.maxRounds : null;
  const roundTxt = total ? (typeof r.round === 'number' ? `${roundLabel(r.round)} of ${total}` : roundLabel(r.round)) : '';
  const live = r.status === 'running', dm = r.kind === 'dm';
  const ready = dm && !live && r.status !== 'error';
  const statusTxt = dm ? (live ? 'Replying' : ready ? 'Ready' : STATUS[r.status] || r.status) : STATUS[r.status] || r.status;
  h.innerHTML = `
      <div class="kind">${icon(kindIcon(r.kind), 'width:14px;height:14px')}</div>
      <h1 title="${esc(r.topic || r.task || r.title)}">${esc(r.title)}</h1>
      <span class="pill">${KIND[r.kind] || r.kind}</span>${roundTxt ? `<span class="pill">${esc(roundTxt)}</span>` : ''}<span class="pill ${ready ? 'idle' : r.status}">${live ? '<span class="dot live"></span>' : ''}${esc(statusTxt)}</span>
      ${live ? `<button class="btn sm danger" id="stopRoom">${icon('stop', 'width:13px;height:13px')}Stop</button>` : ''}
      ${r.resultId ? '<button class="btn sm" id="resultRoom">Result</button>' : ''}
      ${!live && !dm ? '<button class="btn sm" id="againRoom">Run again</button>' : ''}
      <button class="btn sm ghost icon" id="delRoom" title="Delete session" aria-label="Delete session">${icon('trash', 'width:14px;height:14px')}</button>`;
  $('#stopRoom') && ($('#stopRoom').onclick = () => api(`/api/rooms/${r.id}/stop`, {}).catch(() => {}));
  $('#resultRoom') && ($('#resultRoom').onclick = () => jumpTo(r.resultId));
  $('#againRoom') && ($('#againRoom').onclick = () => openNew(r.kind, roomPreset(r)));
  $('#delRoom').onclick = () => { if (confirm('Delete this session and its transcript?')) api(`/api/rooms/${r.id}/delete`, {}).catch(() => {}); };
}
// Composer for Direct chat and running sessions; a next-step bar for finished Debate / Propose → Review.
const composerMode = (r) => r.kind === 'dm' ? 'dm' : r.status === 'running' ? 'live' : 'done';
function renderComposer() {
  const r = S.rooms[S.active], el = $('#composerArea'); if (!r || !el) return;
  const mode = composerMode(r); el.dataset.mode = mode;
  if (mode === 'done') {
    el.innerHTML = `<div class="nextbar"><span>Session finished</span><button class="btn sm" id="nbAgain">Run again</button><button class="btn sm primary" id="nbDm">Continue in Direct chat</button></div>`;
    $('#nbAgain').onclick = () => openNew(r.kind, roomPreset(r));
    $('#nbDm').onclick = () => continueInDm(r);
    return;
  }
  const draft = $('#compose')?.value || ''; // keep what the user is typing across re-renders
  const placeholder = mode === 'dm' ? `Message ${S.seats[r.seatId]?.name || 'agent'}…` : 'Add a note — the next agent turn will read it…';
  el.innerHTML = `<div class="composer-inner">
      <textarea class="input" id="compose" rows="1" placeholder="${esc(placeholder)}"></textarea>
      <button class="btn primary icon" id="sendBtn" aria-label="Send" style="height:38px;width:38px">${icon('send')}</button>
    </div><div class="hint">${mode === 'dm' ? 'Enter to send · Shift+Enter for a new line' : 'Interject: your note goes to the next agent turn.'}</div>`;
  const ta = $('#compose');
  if (draft) { ta.value = draft; ta.focus(); }
  ta.oninput = () => { ta.style.height = '38px'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; };
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('#sendBtn').onclick = send;
}
function markResult() {
  const r = S.rooms[S.active];
  document.querySelectorAll('#feedInner .msg.result').forEach((el) => { if (el.dataset.id !== r?.resultId) el.classList.remove('result'); });
  if (r?.resultId) document.querySelector(`#feedInner [data-id="${r.resultId}"]`)?.classList.add('result');
}
function jumpTo(id) {
  const t = document.querySelector(`#feedInner [data-id="${id}"]`); if (!t) return;
  t.scrollIntoView({ block: 'center' }); t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
}
function roomPreset(r) {
  if (r.kind === 'meeting') return { topic: r.topic, seatIds: r.seatIds, scoutId: r.scoutId, synthId: r.synthId, rounds: r.rounds, withContext: r.withContext };
  if (r.kind === 'chain') return { task: r.task, builderId: r.builderId, reviewerId: r.reviewerId, maxRounds: r.maxRounds, escalate: r.escalate, withContext: r.withContext };
  return { seatId: r.seatId };
}
function continueInDm(r) {
  const seatId = r.synthId || r.builderId || r.seatIds?.[0];
  const res = (r.resultId && r.messages.find((m) => m.id === r.resultId)) || [...r.messages].reverse().find((m) => m.seatId !== 'system' && m.seatId !== 'user' && !m.streaming && m.text);
  const body = (res?.text || '').trim().slice(0, 1500);
  openNew('dm', { seatId, message: `About: ${r.topic || r.task || r.title}\n\nResult so far:\n${body}\n\n` });
}
async function send() {
  const r = S.rooms[S.active], ta = $('#compose'), btn = $('#sendBtn'); if (!r || !ta || !btn || btn.disabled) return;
  const text = ta.value.trim(); if (!text) return;
  btn.disabled = true;
  try {
    if (r.kind === 'dm') await api(`/api/seats/${r.seatId}/send`, { text });
    else { await api(`/api/rooms/${r.id}/say`, { text }); toast('Note added — the next agent turn will read it'); }
    const cur = $('#compose'); if (cur && cur.value.trim() === text) { cur.value = ''; cur.style.height = '38px'; }
  } catch {} finally { const b = $('#sendBtn'); if (b) b.disabled = false; }
}

const tw = {}; // streaming text buffers: msg id -> { shown, pending }
function msgHtml(m) {
  if (m.seatId === 'system') return `<div class="sysline" data-id="${m.id}">${esc(m.text)}</div>`;
  const isUser = m.seatId === 'user';
  return `<div class="msg ${isUser ? 'user' : ''}" data-id="${m.id}" style="--c:${isUser ? 'var(--text-2)' : m.color || seatColor(m.seatId)}">
    ${isUser ? '<div class="av">Y</div>' : `<div class="av" style="--c:${m.color || seatColor(m.seatId)}">${initials(m.name)}</div>`}
    <div class="body"><div class="meta"></div><div class="content"></div><div class="tools"></div><div class="foot"></div></div></div>`;
}
function paintMsg(m, scroll = true) {
  const inner = $('#feedInner'), r = S.rooms[S.active]; if (!inner || !r?.messages.some((x) => x.id === m.id)) return;
  inner.querySelector('.empty')?.remove();
  let el = inner.querySelector(`[data-id="${m.id}"]`);
  const f = $('#feed'), near = f.scrollHeight - f.scrollTop - f.clientHeight < 140;
  if (!el) {
    const msgs = r.messages, i = msgs.findIndex((x) => x.id === m.id), prev = msgs.slice(0, i).reverse().find((x) => x.seatId !== 'system' && x.seatId !== 'user');
    if (m.seatId !== 'system' && m.seatId !== 'user' && m.round !== undefined && (!prev || String(prev.round) !== String(m.round))) {
      inner.insertAdjacentHTML('beforeend', `<div class="sysline">${esc(roundLabel(m.round))}</div>`);
    }
    inner.insertAdjacentHTML('beforeend', msgHtml(m)); el = inner.lastElementChild;
  }
  if (m.seatId === 'system') return;
  el.classList.toggle('streaming', !!m.streaming);
  el.classList.toggle('result', m.id === r.resultId);
  const s = S.seats[m.seatId];
  if (m.seatId === 'user') el.querySelector('.meta').innerHTML = `<b>You</b><span class="tag">${hhmm(m.ts)}</span>`;
  else {
    const stance = !m.streaming && /^STANCE:/i.test(lastLine(m.text)) ? (/CONVERGED/i.test(lastLine(m.text)) ? '<span class="stance yes">Converged</span>' : '<span class="stance">Open</span>') : '';
    el.querySelector('.meta').innerHTML = `<b>${esc(m.name)}</b><span class="tag">${esc(m.label || '')}</span>${m.verdict ? `<span class="verdict ${m.verdict}">${m.verdict === 'pass' ? 'PASS' : 'FAIL'}</span>` : ''}${stance}${m.streaming && s?.activity ? `<span class="act">${esc(s.activity)}…</span>` : ''}`;
    const foot = el.querySelector('.foot');
    foot.innerHTML = m.streaming ? '' : [hhmm(m.ts), m.ended ? fmtDur(new Date(m.ended) - new Date(m.ts)) : '', m.tokens ? `${fmtTok(m.tokens)} tokens` : ''].filter(Boolean).map(esc).join('<span>·</span>');
    foot.title = m.streaming ? '' : [m.cached ? `${fmtTok(m.cached)} cached` : '', m.cost ? '$' + m.cost.toFixed(3) : '', m.effort ? (EFFORT[m.effort] || m.effort) + ' effort' : '', m.tools === 'none' ? 'no tools' : ''].filter(Boolean).join(' · ');
  }
  const c = el.querySelector('.content'), st = tw[m.id];
  if (m.streaming) { if (!st || (!st.shown && !st.pending)) c.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; }
  else if (!st || !st.pending) {
    const body = (m.text || '').replace(/\n?\s*\**STANCE:\s*\w+\**\s*$/i, '').replace(/\n?\s*\**VERDICT:\s*\w+\**\s*$/i, '');
    c.classList.remove('raw'); c.innerHTML = md(body) + (m.error ? `<div class="err">${esc(m.error)}</div>` : '');
  }
  if (scroll && near) f.scrollTop = f.scrollHeight;
}
// Reveal streamed text progressively; Codex delivers whole messages at once.
function twLoop() {
  for (const [id, st] of Object.entries(tw)) {
    if (!st.pending) continue;
    const n = Math.max(3, Math.ceil(st.pending.length / 12));
    st.shown += st.pending.slice(0, n); st.pending = st.pending.slice(n);
    const el = document.querySelector(`#feedInner [data-id="${id}"] .content`);
    if (el) { el.classList.add('raw'); el.textContent = st.shown; el.insertAdjacentHTML('beforeend', '<span class="caret"></span>'); const f = $('#feed'); if (f && f.scrollHeight - f.scrollTop - f.clientHeight < 160) f.scrollTop = f.scrollHeight; }
    if (!st.pending) { const m = findMsg(id); if (m && !m.streaming) paintMsg(m); }
  }
  requestAnimationFrame(twLoop);
}
const findMsg = (id) => { for (const r of Object.values(S.rooms)) { const m = r.messages?.find((x) => x.id === id); if (m) return m; } return null; };

/* ================= inspector: workflow ================= */
function nodeState(r, seatId, round) {
  const m = r.messages.find((x) => x.seatId === seatId && String(x.round) === String(round));
  if (m) return { m, state: m.streaming ? 'running' : m.error ? 'failed' : 'done' };
  const silent = r.messages.find((x) => x.skip && x.skip.seatId === seatId && String(x.skip.round) === String(round));
  const early = r.messages.find((x) => x.earlyStop);
  if (silent || (early && typeof round === 'number' && round > early.earlyStop)) return { state: 'skipped', why: silent ? 'silent agreement' : 'converged early' };
  return { state: r.status === 'running' ? 'pending' : 'skipped' };
}
function stage(title, nodes, { parallel = false, meta = '' } = {}) {
  const states = nodes.map((n) => n.state);
  const st = states.includes('running') ? 'running' : states.every((s) => s === 'done' || s === 'skipped') && states.some((s) => s === 'done') ? 'done' : states.every((s) => s === 'skipped') ? 'skipped' : 'pending';
  return `<div class="wf-stage ${st}"><div class="wf-marker"></div><div class="wf-title">${esc(title)}${parallel ? '<span class="pill" style="height:18px;font-size:10.5px">parallel</span>' : ''}<span class="m">${meta}</span></div>
    <div class="wf-nodes ${parallel ? 'par' : ''}">${nodes.map(nodeHtml).join('')}</div></div>`;
}
function nodeHtml(n) {
  const s = S.seats[n.seatId], m = n.m;
  const ic = n.state === 'done' ? icon('check', 'width:14px;height:14px;color:var(--ok)') : n.state === 'failed' ? icon('alert', 'width:14px;height:14px;color:var(--bad)') : n.state === 'skipped' ? icon('skip', 'width:14px;height:14px;color:var(--text-3)') : n.state === 'running' ? icon('clock', 'width:14px;height:14px;color:var(--warn)') : icon('clock', 'width:14px;height:14px;color:var(--text-3)');
  const extra = m?.verdict ? `<span class="verdict ${m.verdict}" style="height:16px;font-size:10px">${m.verdict.toUpperCase()}</span>` : '';
  const stat = n.state === 'running' && s?.startedAt ? `<span class="s" data-since="${s.startedAt}"></span>` : m && !m.streaming && m.tokens ? `<span class="s">${fmtTok(m.tokens)}${m.ended ? ' · ' + fmtDur(new Date(m.ended) - new Date(m.ts)) : ''}</span>` : n.why ? `<span class="s">${n.why}</span>` : '';
  return `<div class="wf-node ${n.state}" ${m ? `data-jump="${m.id}"` : ''}>${avatar(n.seatId, 'xs')}<span class="n">${esc(s?.name || n.seatId)} <small>${esc(n.label || '')}</small></span>${extra}${stat}${ic}</div>`;
}
function renderInspector() {
  const ins = $('#inspector'); const r = S.rooms[S.active];
  if (!r) { ins.innerHTML = ''; return; } // Home: no inspector (#app.no-ins)
  let flow = '';
  if (r.kind === 'meeting') {
    const N = (id, round, label) => ({ seatId: id, label, ...nodeState(r, id, round) });
    if (r.scoutId) flow += stage('Scout', [N(r.scoutId, 'scout', 'reads code, writes brief')]);
    flow += stage('Round 1 · ideas', r.seatIds.map((id) => N(id, 1, 'independent')), { parallel: true });
    for (let i = 2; i <= r.rounds; i++) flow += stage(`Round ${i} · discussion`, r.seatIds.map((id) => N(id, i, 'no tools')));
    if (r.synthId) flow += stage('Synthesis', [N(r.synthId, 'synthesis', 'writes to BRAINSTORM.md')]);
  } else if (r.kind === 'chain') {
    const passedAt = r.messages.find((m) => m.verdict === 'pass')?.round;
    for (let i = 1; i <= r.maxRounds; i++) {
      const nodes = [{ seatId: r.builderId, label: 'propose', ...nodeState(r, r.builderId, i) }, { seatId: r.reviewerId, label: 'review', ...nodeState(r, r.reviewerId, i) }];
      if (passedAt && i > passedAt) nodes.forEach((n) => { n.state = 'skipped'; n.why = 'passed'; });
      flow += stage(`Round ${i}`, nodes);
    }
    flow += `<div class="wf-stage ${r.status === 'passed' ? 'done' : ''}"><div class="wf-marker"></div><div class="wf-title">${r.status === 'passed' ? 'Passed review' : r.status === 'needs-you' ? 'Your decision' : 'Result'}</div></div>`;
  } else {
    const turns = r.messages.filter((m) => m.seatId === r.seatId);
    flow = stage('Conversation', turns.length ? turns.map((m) => ({ seatId: m.seatId, label: hhmm(m.ts), m, state: m.streaming ? 'running' : m.error ? 'failed' : 'done' })) : [{ seatId: r.seatId, state: 'pending', label: 'waiting for a message' }]);
  }
  // usage in this session (computed by the server after every agent turn)
  const u = r.usage, per = Object.entries(u?.perSeat || {}).filter(([, v]) => v > 0), max = Math.max(1, ...per.map(([, v]) => v));
  ins.innerHTML = `<div class="ins-sec"><div class="ins-h">Workflow</div>${flow}</div>
    <div class="ins-sec"><div class="ins-h">Usage ${u?.tokens ? `<span style="text-transform:none;letter-spacing:0">${fmtTok(u.tokens)} net</span>` : ''}</div>
      ${per.map(([id, v]) => `<div class="usage-row">${avatar(id, 'xs')}<span style="width:56px;overflow:hidden;text-overflow:ellipsis">${esc(S.seats[id]?.name || id)}</span><div class="bar"><i style="width:${(v / max) * 100}%;background:${seatColor(id)}"></i></div><span class="v">${fmtTok(v)}</span></div>`).join('') || '<div class="hint">No usage yet</div>'}
      <dl class="kv" style="margin-top:10px">${u ? `<dt>Cached input</dt><dd>${fmtTok(u.cached)}</dd><dt>Claude cost</dt><dd>$${(u.cost || 0).toFixed(3)}</dd>` : ''}<dt>Started</dt><dd>${hhmm(r.created)}</dd></dl></div>`;
  ins.querySelectorAll('[data-jump]').forEach((el) => el.onclick = () => jumpTo(el.dataset.jump));
  tickTimers();
}
let insTimer = null;
const scheduleInspector = () => { if (insTimer) return; insTimer = setTimeout(() => { insTimer = null; renderInspector(); }, 150); };
function tickTimers() {
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmtDur(Date.now() - new Date(el.dataset.since)); });
  document.querySelectorAll('[data-reset]').forEach((el) => { el.textContent = el.dataset.reset ? 'resets in ' + countdown(Number(el.dataset.reset)) : ''; });
}
setInterval(tickTimers, 1000);

/* ================= overlays ================= */
function closeOverlay() { $('#overlay').innerHTML = ''; }
// Escape / scrim: never throw away a modal that has typed text (Cancel / X still close it).
function softClose() { const m = $('#overlay .modal'); if (m && [...m.querySelectorAll('textarea')].some((t) => t.value.trim())) return; closeOverlay(); }
function overlay(html, cls = 'modal') { $('#overlay').innerHTML = `<div class="scrim"></div><div class="${cls}" role="dialog">${html}</div>`; $('#overlay .scrim').onclick = softClose; return $('#overlay .' + cls.split(' ')[0]); }
const newKind = () => ls.get('ob.new.kind') || 'meeting';
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (meterPop) { meterPop = false; renderMeters(); } else softClose(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openNew(newKind()); }
});

// preset (from "Run again" / "Continue in Direct chat") uses room field names; stored values use form names.
const PRESET_MAP = { seatIds: 'participants', scoutId: 'scout', synthId: 'facilitator', rounds: 'rounds', withContext: 'ctx', builderId: 'builder', reviewerId: 'reviewer', maxRounds: 'max', escalate: 'escalate', seatId: 'seat', topic: 'topic', task: 'task', message: 'message' };
function openNew(kind, preset) {
  if (!KIND[kind]) kind = 'meeting';
  const seats = S.order.map((id) => S.seats[id]), has = (id) => !!S.seats[id];
  const firstClaude = seats.find((s) => s.agent === 'claude')?.id || S.order[0], firstCodex = seats.find((s) => s.agent === 'codex')?.id || S.order[1] || S.order[0];
  const stored = (k) => { try { return JSON.parse(ls.get('ob.new.' + k) || '{}') || {}; } catch { return {}; } };
  const P = {}; for (const [from, to] of Object.entries(PRESET_MAP)) if (preset && from in preset) P[to] = preset[from] ?? '';
  const defaults = {
    meeting: { topic: '', participants: [...new Set([firstClaude, firstCodex].filter(Boolean))], scout: firstCodex || '', facilitator: firstClaude || '', rounds: 2, ctx: false },
    chain: { task: '', builder: firstClaude, reviewer: firstCodex, max: 2, escalate: false, ctx: false },
    dm: { seat: firstClaude, message: '' },
  };
  const v = {};
  for (const k of Object.keys(defaults)) {
    const x = v[k] = { ...defaults[k], ...stored(k), ...(k === kind ? P : {}) }, d = defaults[k];
    // ignore seats that no longer exist
    if ('participants' in x) { x.participants = (Array.isArray(x.participants) ? x.participants : []).filter(has); if (!x.participants.length) x.participants = d.participants; }
    for (const f of ['scout', 'facilitator']) if (f in x && x[f] && !has(x[f])) x[f] = d[f];
    for (const f of ['builder', 'reviewer', 'seat']) if (f in x && !has(x[f])) x[f] = d[f];
  }
  const opt = (sel, none) => (none ? '<option value="">None</option>' : '') + seats.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} · ${esc(s.model)}</option>`).join('');
  const nums = (list, sel) => [...new Set([...list, Number(sel) || list[1]])].sort((a, b) => a - b).map((n) => `<option ${n === (Number(sel) || list[1]) ? 'selected' : ''}>${n}</option>`).join('');
  const ctxBox = (on, style = '') => `<label class="check" style="${style}"><input type="checkbox" id="nCtx" ${on ? 'checked' : ''}> Include project notes (.orchestra PLAN / HANDOFF / LOG)</label>`;
  const box = overlay(`<div class="modal-h">New session<button class="btn ghost icon" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-b">
      <div class="label">Workflow</div>
      <div class="seg" id="nKind">${['meeting', 'chain', 'dm'].map((k) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${KIND[k]}</button>`).join('')}</div>
      <div id="nForm"></div>
    </div>
    <div class="modal-f"><span class="hint" id="nCost" style="margin:0 auto 0 0;align-self:center"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="nGo">Start</button></div>`);
  box.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeOverlay);
  const cur = () => box.querySelector('#nKind .on').dataset.k, q = (s) => box.querySelector(s);
  // read the visible form into v[k]
  const read = () => {
    const k = cur(), x = v[k];
    if (k === 'meeting') Object.assign(x, { topic: q('#nTopic').value, scout: q('#nScout').value, facilitator: q('#nSynth').value, rounds: Number(q('#nRounds').value), ctx: q('#nCtx').checked });
    else if (k === 'chain') Object.assign(x, { task: q('#nTask').value, builder: q('#nBuilder').value, reviewer: q('#nReviewer').value, max: Number(q('#nMax').value), escalate: q('#nEsc').checked, ctx: q('#nCtx').checked });
    else Object.assign(x, { seat: q('#nSeat').value, message: q('#nMsg').value });
  };
  const update = () => {
    read(); const k = cur(), x = v[k];
    const n = k === 'meeting' ? (x.scout ? 1 : 0) + x.participants.length * x.rounds + (x.facilitator ? 1 : 0) : k === 'chain' ? 2 * x.max : 1;
    q('#nCost').textContent = `Up to ${n} agent run${n === 1 ? '' : 's'} · uses your Claude/Codex quota`;
    if (k === 'dm') { const s = S.seats[x.seat]; q('#nDmHint').textContent = s ? `Continues your existing chat with ${s.name} (memory: ${s.thread ? 'active' : 'empty'})` : ''; }
  };
  const form = () => {
    const k = cur(), f = q('#nForm'), x = v[k];
    if (k === 'meeting') f.innerHTML = `
      <div class="label">Topic</div><textarea class="input" id="nTopic" placeholder="What should the agents discuss?">${esc(x.topic)}</textarea>
      <div class="label">Participants</div><div class="picks" id="nPicks">${seats.map((s) => `<button class="pick ${x.participants.includes(s.id) ? 'on' : ''}" data-id="${s.id}">${avatar(s.id, 'xs')}${esc(s.name)}</button>`).join('')}</div>
      <div class="grid3"><div><div class="label">Scout</div><select class="input" id="nScout">${opt(x.scout, true)}</select><div class="hint">Reads the code once so others don't have to (saves tokens)</div></div>
        <div><div class="label">Facilitator</div><select class="input" id="nSynth">${opt(x.facilitator, true)}</select><div class="hint">Summarizes at the end; saved to .orchestra/BRAINSTORM.md</div></div>
        <div><div class="label">Rounds</div><select class="input" id="nRounds">${nums([1, 2, 3, 4], x.rounds)}</select><div class="hint">Stops early on consensus</div></div></div>
      ${ctxBox(x.ctx)}`;
    else if (k === 'chain') f.innerHTML = `
      <div class="label">Task</div><textarea class="input" id="nTask" placeholder="What should be proposed and reviewed?">${esc(x.task)}</textarea>
      <div class="grid3"><div><div class="label">Proposer</div><select class="input" id="nBuilder">${opt(x.builder)}</select></div>
        <div><div class="label">Reviewer</div><select class="input" id="nReviewer">${opt(x.reviewer)}</select></div>
        <div><div class="label">Max rounds</div><select class="input" id="nMax">${nums([1, 2, 3], x.max)}</select></div></div>
      <label class="check"><input type="checkbox" id="nEsc" ${x.escalate ? 'checked' : ''}> Raise proposer effort after a FAIL</label>
      ${ctxBox(x.ctx, 'margin-top:6px')}`;
    else f.innerHTML = `<div class="label">Agent</div><select class="input" id="nSeat">${opt(x.seat)}</select>
      <div class="label">Message</div><textarea class="input" id="nMsg" placeholder="Ask something…">${esc(x.message)}</textarea><div class="hint" id="nDmHint"></div>`;
    f.querySelectorAll('.pick').forEach((p) => p.onclick = () => { const id = p.dataset.id, l = v.meeting.participants; v.meeting.participants = l.includes(id) ? l.filter((y) => y !== id) : [...l, id]; p.classList.toggle('on'); update(); });
    f.oninput = f.onchange = update;
    const ta = f.querySelector('textarea'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    update();
  };
  box.querySelectorAll('#nKind button').forEach((b) => b.onclick = () => { read(); box.querySelectorAll('#nKind button').forEach((x) => x.classList.toggle('on', x === b)); form(); });
  form();
  const go = q('#nGo');
  go.onclick = async () => {
    if (go.disabled) return;
    read(); const k = cur(), x = v[k]; let r;
    if (k === 'dm' && !x.message.trim()) return toast('Write a message first');
    go.disabled = true; go.textContent = 'Starting…';
    try {
      if (k === 'meeting') r = await api('/api/meeting', { topic: x.topic, seatIds: S.order.filter((id) => x.participants.includes(id)), scoutId: x.scout, synthId: x.facilitator, rounds: x.rounds, withContext: x.ctx });
      else if (k === 'chain') r = await api('/api/chain', { task: x.task, builderId: x.builder, reviewerId: x.reviewer, maxRounds: x.max, escalate: x.escalate, withContext: x.ctx });
      else r = await api(`/api/seats/${x.seat}/send`, { text: x.message.trim() });
      const { topic, task, message, ...keep } = x; // remember the setup, never the text
      ls.set('ob.new.kind', k); ls.set('ob.new.' + k, JSON.stringify(keep));
      closeOverlay(); openRoom(r.roomId);
    } catch {} finally { go.disabled = false; go.textContent = 'Start'; }
  };
}

function openAgent(id) {
  const isNew = !id; const s = isNew ? { name: '', role: '', agent: 'codex', model: S.models.codex[0], effort: 'medium', perm: 'read', target: '', budget: 0, color: '#14b8a6' } : S.seats[id];
  const box = overlay(`<div class="modal-h">${isNew ? 'New agent' : `<span style="display:flex;align-items:center;gap:10px">${avatar(id, 'lg')}${esc(s.name)}</span>`}<button class="btn ghost icon" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-b">
      <div class="grid2"><div><div class="label">Name</div><input class="input" id="aName" maxlength="24" value="${esc(s.name)}"></div><div><div class="label">Role</div><input class="input" id="aRole" maxlength="40" value="${esc(s.role || '')}" placeholder="e.g. Reviewer"></div></div>
      <div class="hint">Changing name, role, runtime or scope resets this agent's memory.</div>
      <div class="label">Runtime</div><div class="seg" id="aAgent">${['claude', 'codex'].map((a) => `<button data-a="${a}" class="${a === s.agent ? 'on' : ''}">${a === 'claude' ? 'Claude CLI' : 'Codex CLI'}</button>`).join('')}</div>
      <div class="label">Model</div><input class="input" id="aModel" list="aModels" value="${esc(s.model || '')}" placeholder="pick or type a model"><datalist id="aModels"></datalist>
      <div class="label">Effort</div><div class="seg" id="aEffort"></div><div class="hint">Discussion rounds are capped at Medium automatically.</div>
      <details class="adv"><summary>Advanced</summary>
        <div class="label">Scope</div><input class="input" id="aTarget" value="${esc(s.target || '')}" placeholder="folder or file inside the project (empty = whole project)" style="font-family:var(--mono);font-size:12.5px">
        <div class="grid2"><div><div class="label">Token budget</div><input class="input" id="aBudget" type="number" min="0" step="10000" value="${s.budget || 0}"><div class="hint">0 = unlimited</div></div><div><div class="label">Color</div><input class="input" id="aColor" type="color" value="${s.color || '#14b8a6'}" style="padding:2px 4px"></div></div>
      </details>
      ${isNew ? '' : `<div class="label">Usage</div><dl class="kv"><dt>Net tokens</dt><dd>${fmtTok(s.used)}</dd><dt>Cached</dt><dd>${fmtTok(s.cached)}</dd><dt>Cost</dt><dd>$${(s.cost || 0).toFixed(3)}</dd><dt>Memory</dt><dd>${s.thread ? 'active' : 'empty'}</dd></dl>`}
    </div>
    <div class="modal-f">${isNew ? '' : `<button class="btn danger" id="aDel" style="margin-right:auto">${icon('trash', 'width:14px;height:14px')}Delete</button><button class="btn" id="aReset">Clear memory</button>`}<button class="btn" data-close>Cancel</button><button class="btn primary" id="aSave">${isNew ? 'Add agent' : 'Save'}</button></div>`, 'drawer');
  box.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeOverlay);
  let agent = s.agent, effort = s.effort;
  // Runs only when the runtime changes, so a typed model is never reverted.
  const fillRuntime = () => {
    box.querySelector('#aModels').innerHTML = (S.models[agent] || []).map((m) => `<option value="${esc(m)}">`).join('');
    const list = S.efforts[agent] || [];
    if (!list.includes(effort)) effort = list.includes('medium') ? 'medium' : list[0];
    box.querySelector('#aEffort').innerHTML = list.map((e) => `<button data-e="${e}" class="${e === effort ? 'on' : ''}">${EFFORT[e] || e}</button>`).join('');
    box.querySelectorAll('#aEffort button').forEach((b) => b.onclick = () => { effort = b.dataset.e; box.querySelectorAll('#aEffort button').forEach((x) => x.classList.toggle('on', x === b)); });
  };
  box.querySelectorAll('#aAgent button').forEach((b) => b.onclick = () => {
    if (b.dataset.a === agent) return;
    agent = b.dataset.a; box.querySelectorAll('#aAgent button').forEach((x) => x.classList.toggle('on', x === b));
    box.querySelector('#aModel').value = S.models[agent]?.[0] || ''; fillRuntime();
  });
  fillRuntime();
  box.querySelector('#aSave').onclick = async () => {
    const model = box.querySelector('#aModel').value.trim() || S.models[agent]?.[0];
    try {
      await api('/api/seats', { id: isNew ? undefined : id, name: box.querySelector('#aName').value || 'Agent', role: box.querySelector('#aRole').value, agent, model, effort, perm: 'read', target: box.querySelector('#aTarget').value, budget: Number(box.querySelector('#aBudget').value) || 0, color: box.querySelector('#aColor').value });
      closeOverlay(); toast(isNew ? 'Agent added' : 'Saved');
    } catch {}
  };
  if (!isNew) {
    box.querySelector('#aReset').onclick = async () => { await api(`/api/seats/${id}/reset`, {}); toast(`${s.name}: memory cleared`); closeOverlay(); };
    box.querySelector('#aDel').onclick = async () => { if (confirm(`Delete ${s.name}?`)) { await api(`/api/seats/${id}/delete`, {}); closeOverlay(); } };
  }
}

function openSettings() {
  const notify = ls.get('ob.notify') === '1';
  const box = overlay(`<div class="modal-h">Settings<button class="btn ghost icon" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-b">
      <div class="label">Agents reply in</div><input class="input" id="sLang" value="${esc(S.settings.lang || 'English')}" placeholder="English">
      <div class="hint">Applies to new conversations (existing memories keep their language).</div>
      <div class="label">Theme</div><div class="seg" id="sTheme">${['system', 'light', 'dark'].map((t) => `<button data-t="${t}" class="${(ls.get('ob.theme') || 'system') === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" id="sNotify" ${notify ? 'checked' : ''}> Desktop notification when a session finishes or needs you</label>
    </div>
    <div class="modal-f"><button class="btn" data-close>Close</button></div>`);
  box.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeOverlay);
  box.querySelectorAll('#sTheme button').forEach((b) => b.onclick = () => { box.querySelectorAll('#sTheme button').forEach((x) => x.classList.toggle('on', x === b)); applyTheme(b.dataset.t); });
  const cb = box.querySelector('#sNotify');
  cb.onchange = async () => {
    let want = cb.checked;
    if (want && 'Notification' in window && Notification.permission !== 'granted') {
      if (await Notification.requestPermission() !== 'granted') { want = false; cb.checked = false; toast('Notifications are blocked by the browser'); }
    }
    ls.set('ob.notify', want ? '1' : '0');
  };
  const lang = box.querySelector('#sLang'); let savedLang = S.settings.lang || 'English';
  const saveLang = async () => {
    const val = lang.value.trim() || 'English'; if (val === savedLang) return;
    savedLang = val;
    try { await api('/api/settings', { lang: val }); toast('Language saved'); } catch { savedLang = null; }
  };
  lang.onblur = saveLang;
  lang.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); saveLang(); } };
}
function applyTheme(t) { ls.set('ob.theme', t); if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }
applyTheme(ls.get('ob.theme') || 'system');

function notify(title, body) {
  if (ls.get('ob.notify') !== '1' || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try { new Notification(title, { body }); } catch {}
}

/* ================= navigation ================= */
function openRoom(id) {
  S.active = id; ls.set('ob.room', id || '');
  const app = $('#app'); app.classList.remove('show-side'); app.classList.toggle('no-ins', !id); if (!id) app.classList.remove('show-ins');
  renderSessions(); id ? renderRoom() : renderHome(); renderInspector();
}
$('.brand').onclick = () => openRoom(null); $('.brand').style.cursor = 'pointer';
$('#newBtn').onclick = () => openNew(newKind());
$('#addAgent').onclick = () => openAgent(null);
$('#settingsBtn').onclick = openSettings;
$('#menuBtn').onclick = () => $('#app').classList.toggle('show-side');
$('#insBtn').onclick = () => $('#app').classList.toggle('show-ins');

/* ================= live events ================= */
async function load() {
  const st = await (await fetch('/api/state')).json();
  Object.assign(S, { models: st.models, efforts: st.efforts, limits: st.limits || {}, settings: st.settings || {} });
  S.seats = {}; S.order = []; st.seats.forEach((s) => { S.seats[s.id] = s; S.order.push(s.id); });
  S.rooms = {}; st.rooms.forEach((r) => { S.rooms[r.id] = r; });
  const prev = S.active, saved = ls.get('ob.room'); if (!S.rooms[S.active]) S.active = S.rooms[saved] ? saved : null;
  $('#project').textContent = st.project; $('#project').title = st.project;
  renderMeters(); renderSessions(); renderAgents();
  if (S.active !== prev || !$('#feedInner')) return openRoom(S.active);
  // reconnect to the same room: keep the feed (and its scroll), refresh what may have changed
  const r = S.rooms[S.active];
  renderRoomHead(); if ($('#composerArea')?.dataset.mode !== composerMode(r)) renderComposer();
  r.messages.forEach((m) => paintMsg(m, false)); markResult(); renderInspector();
}
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { S.connected = true; renderConn(); };
  es.onerror = () => { S.connected = false; renderConn(); };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    switch (ev.t) {
      case 'hello': return load();
      case 'seat': {
        const isNew = !S.seats[ev.seat.id]; S.seats[ev.seat.id] = ev.seat; if (isNew) S.order.push(ev.seat.id);
        renderAgents(); scheduleInspector();
        const r = S.rooms[S.active], m = r?.messages?.find((x) => x.streaming && x.seatId === ev.seat.id); if (m) paintMsg(m);
        break;
      }
      case 'seatGone': delete S.seats[ev.id]; S.order = S.order.filter((x) => x !== ev.id); renderAgents(); break;
      case 'room': {
        const old = S.rooms[ev.room.id], r = S.rooms[ev.room.id] = { ...(old || { messages: [] }), ...ev.room };
        if (old && old.status === 'running' && r.status !== 'running' && (r.kind !== 'dm' || document.hidden)) {
          const msg = `${r.title}: ${STATUS[r.status] || r.status}`; toast(msg); notify('Orchestra Board', msg);
        }
        renderSessions();
        if (r.id === S.active) {
          // The POST that created a room can return before this event: build the view once it is known.
          if (!$('#main .head')) renderRoom();
          else { renderRoomHead(); if ($('#composerArea')?.dataset.mode !== composerMode(r)) renderComposer(); markResult(); }
          scheduleInspector();
        }
        break;
      }
      case 'roomGone': delete S.rooms[ev.id]; if (S.active === ev.id) openRoom(null); else renderSessions(); break;
      case 'msg': {
        const r = S.rooms[ev.roomId]; if (!r) break; // unknown room: its 'room' event / next load brings it
        const i = r.messages.findIndex((x) => x.id === ev.msg.id); if (i >= 0) r.messages[i] = ev.msg; else r.messages.push(ev.msg);
        if (!ev.msg.streaming && tw[ev.msg.id] && !tw[ev.msg.id].pending) delete tw[ev.msg.id];
        if (ev.roomId === S.active) { paintMsg(ev.msg); scheduleInspector(); }
        break;
      }
      case 'delta': (tw[ev.runId] ||= { shown: '', pending: '' }).pending += ev.text; break;
      case 'item': {
        const box = document.querySelector(`#feedInner [data-id="${ev.runId}"] .tools`);
        if (box && ev.kind === 'tool') { box.insertAdjacentHTML('beforeend', `<div>› ${esc(ev.text)}</div>`); while (box.children.length > 4) box.firstElementChild.remove(); }
        break;
      }
      case 'limits': S.limits = ev.limits; renderMeters(); if (!S.active) renderHome(); break;
      case 'settings': S.settings = ev.settings; break;
    }
  };
}
renderConn(); connect(); twLoop();
