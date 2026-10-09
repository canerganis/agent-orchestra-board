/* Agent Orchestra Board frontend: plain script, no build step. State, rendering, SSE client, API calls. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, size = 16) => `<svg class="i" width="${size}" height="${size}" style="width:${size}px;height:${size}px" aria-hidden="true" focusable="false"><use href="#i-${id}"/></svg>`;
const fmtTok = (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); };
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const fmtCost = (c) => '$' + (c > 0 && c < 0.01 ? c.toFixed(3) : (c || 0).toFixed(2));
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const hhmm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
const APP = 'Agent Orchestra Board';
const EFFORT = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
// Fixed status vocabulary: always a dot (or icon) plus a word.
const STATUS = { running: 'Running', done: 'Done', passed: 'Passed', 'needs-you': 'Needs you', stopped: 'Stopped', error: 'Failed', idle: 'Idle',
  'awaiting-approval': 'Needs approval', approved: 'Approved', rejected: 'Rejected', paused: 'Paused', 'needs-approval': 'Needs approval',
  // A handoff run (U4): it waits for the user's own CLI, or it ended without a summary.
  waiting: 'Waiting for you', unknown: 'Ended without a summary' };
const ST_DOT = { running: 'run', done: 'ok', passed: 'ok', 'needs-you': 'warn', stopped: 'hollow', error: 'fail', idle: 'hollow',
  'awaiting-approval': 'warn', 'needs-approval': 'warn', approved: 'ok', rejected: 'hollow', paused: 'hollow', waiting: 'warn', unknown: 'hollow' };
const statusHtml = (st, word) => `<span class="state"><span class="dot ${ST_DOT[st] || 'hollow'}" aria-hidden="true"></span>${esc(word || STATUS[st] || st)}</span>`;
const lastLine = (t) => (t || '').trim().split(/\r?\n/).pop().replace(/[*`_]/g, '').trim();
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
// The board only answers localhost, so the browser's platform is the server's platform.
const isWin = /^Win/i.test(navigator.userAgentData?.platform || navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
const MOD = isMac ? '⌘' : 'Ctrl';

/* ================= session token =================
   The server signs this browser in with a cookie when the board is opened from the URL it prints; that URL carries the
   board's token (per project, persisted in .orchestra/session). Drop it from the address bar immediately so it is never
   bookmarked, shared or sent again. Later requests rely on the cookie only (same-origin fetch and EventSource send it
   automatically). */
(function dropToken() {
  try {
    const u = new URL(location.href); let dirty = false;
    for (const k of [...u.searchParams.keys()]) if (/^(t|token|session|sid|auth|key)$/i.test(k)) { u.searchParams.delete(k); dirty = true; }
    if (/(^|[#&?])(t|token|session|sid|auth|key)=/i.test(u.hash)) { u.hash = ''; dirty = true; }
    if (dirty) history.replaceState(null, '', u.pathname + u.search + u.hash);
  } catch {}
})();
let gated = false;
function authGate() {
  if (gated) return; gated = true;
  overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">${icon('lock')}Session not recognised</h2></div>
    <div class="modal-b"><p>This board only answers a browser the server has signed in. Go back to the terminal where the board is running and open the link it printed: it sets a session cookie for this browser. The link itself is not needed again.</p>
    <p class="hint">This browser's session does not match this board. Most likely a different project is running on this port, or the board's <code class="inline">.orchestra/session</code> file was deleted or rotated. A plain server restart keeps the session valid.</p></div>
    <div class="modal-f"><button class="btn primary" id="gReload">Reload</button></div>`, 'modal sm', { locked: true });
  $('#gReload').onclick = () => location.reload();
}

// opts.toast === false: the caller shows the error itself. A thrown error carries the server's code (e.g. 'stale').
async function api(p, b, opts = {}) {
  const r = await fetch(p, { credentials: 'same-origin', ...(b !== undefined ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {}) });
  if (r.status === 401) { authGate(); throw new Error('unauthorized'); }
  let j; try { j = await r.json(); } catch { j = { error: `HTTP ${r.status}` }; }
  if (j && j.error) {
    if (opts.toast !== false) toast(j.error);
    const err = new Error(j.error); err.code = j.code; err.status = r.status; err.body = j; throw err;
  }
  return j;
}
function toast(text) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; $('#toasts').append(t); setTimeout(() => t.remove(), 4000); }
// Screen-reader announcements for streaming status (aria-live region, debounced so activity ticks do not flood it).
let liveT = null;
function announce(text) { clearTimeout(liveT); liveT = setTimeout(() => { const el = $('#live'); if (!el) return; el.textContent = ''; requestAnimationFrame(() => { el.textContent = text; }); }, 120); }
async function copyText(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px'; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { ta.remove(); return toast('Copy failed: select the text and copy it manually'); }
    ta.remove();
  }
  toast(what);
}
function download(name, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copyText(b.dataset.copy, b.dataset.copyMsg || 'Copied to clipboard'); });

// rooms: the newest rooms in full (and any room opened since); roomIndex: id -> metadata of the newest 500 (the sidebar
// lists from it). mode: the current mode; view: 'home' (the brand page) or 'mode' (the current mode's home) with no room.
// wf: the Claude Code runs (U2). runs: the list (summaries); byId: one run's summary and agents once read; open: the run
// whose detail is shown; previews: prompt and result text of the agents whose Prompt is open (kept only while open).
const S = { seats: {}, order: [], rooms: {}, roomIndex: {}, active: null, models: {}, efforts: {}, limits: {}, settings: {}, connected: false, doctor: null, setupOpen: false, query: '', cli: null, capability: null, project: '',
  engines: null, watch: null, mode: 'ask', view: 'home', wf: { runs: [], byId: {}, open: null, previews: {} } };
const roundLabel = (round) => typeof round === 'number' ? `Round ${round}` : round ? cap(round) : '';
// Every agent is labelled tool first; its avatar carries the tool mark (asterisk = Claude Code, prompt = Codex).
const TOOL = { claude: 'Claude Code', codex: 'Codex' };
const toolMark = (agent) => `<svg aria-hidden="true" focusable="false"><use href="#t-${agent === 'claude' ? 'claude' : 'codex'}"/></svg>`;
const avatar = (id, cls = '', agent) => { const a = agent || S.seats[id]?.agent || 'codex'; return `<span class="av ${a === 'claude' ? 'claude' : 'codex'} ${cls}" aria-hidden="true">${toolMark(a)}</span>`; };
const userAvatar = (cls = '') => `<span class="av user ${cls}" aria-hidden="true"><svg aria-hidden="true" focusable="false"><use href="#i-user"/></svg></span>`;
const KIND_ICON = { meeting: 'debate', chain: 'review', dm: 'chat', ask: 'chat', plan: 'list', build: 'review', run: 'review' };
const kindIcon = (k) => KIND_ICON[k] || 'chat';
const KIND = { meeting: 'Debate', chain: 'Propose → Review', dm: 'Direct chat', ask: 'Ask', plan: 'Plan → Build', build: 'Build', run: 'External run' };
const isAgentMsg = (m) => m && m.seatId !== 'system' && m.seatId !== 'user';

/* ================= keyboard focus and pointer-safe re-renders =================
   Live events re-render regions of the page. A replaced button loses keyboard focus, and one replaced between
   mousedown and mouseup swallows the click, so: (1) focus is put back on the same control (matched by its id or
   data-* key) after a re-render, and (2) while a pointer is down, re-renders are deferred until it is released. */
const FOCUS_SEL = '[id],[data-seat],[data-room],[data-jump],[data-cap-verify],[data-item-view],[data-item-apply],[data-item-discard],[data-mode],[data-ask-pick],[data-run],[data-run-prev],[data-run-room],[data-run-scope],[data-run-reads],[data-run-find],[data-run-link],[data-run-unlink],[data-run-delete],[data-engine]';
function focusKey(el) {
  if (!el || !el.dataset) return null;
  if (el.id) return '#' + el.id;
  for (const k of ['seat', 'room', 'jump', 'capVerify', 'itemView', 'itemApply', 'itemDiscard', 'mode', 'askPick', 'run', 'runPrev', 'runRoom', 'runScope', 'runReads', 'runFind', 'runLink', 'runUnlink', 'runDelete', 'engine']) if (el.dataset[k]) return k + ':' + el.dataset[k];
  return null;
}
const findByKey = (root, key) => key && [...root.querySelectorAll(FOCUS_SEL)].find((el) => focusKey(el) === key) || null;
// Runs fn (a region re-render) and restores focus to the same control when focus was inside the region.
function keepFocus(root, fn) {
  const act = document.activeElement, inside = !!root && !!act && act !== root && root.contains(act);
  const key = inside ? focusKey(act) : null;
  fn();
  if (!key || !root) return;
  const next = findByKey(root, key);
  if (next && typeof next.focus === 'function') next.focus({ preventScroll: true });
}
let pointerDown = false; const deferred = new Set();
const releasePointer = () => { if (!pointerDown) return; pointerDown = false; const fns = [...deferred]; deferred.clear(); fns.forEach((f) => f()); };
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
document.addEventListener('pointerup', releasePointer, true);
document.addEventListener('pointercancel', releasePointer, true);
// True (and the render is queued) while a pointer is held: the render runs on release instead.
const deferRender = (fn) => { if (!pointerDown) return false; deferred.add(fn); return true; };

/* ================= top bar ================= */
const WIN = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' };
function countdown(ms) { if (!ms) return ''; let s = Math.max(0, Math.round((ms - Date.now()) / 1000)); const d = Math.floor(s / 86400); s %= 86400; const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
// One group per CLI: [agent, windows[]], Claude first.
function meterGroups() {
  const out = [];
  for (const [agent, lim] of Object.entries(S.limits || {})) {
    if (!lim) continue;
    // A window with no observation time is not shown as a number: an old reading from before a reset would look current.
    const ws = Object.entries(lim.windows || {}).map(([k, w]) => { const known = typeof lim.observed?.[k] === 'number'; return { agent, k, pct: known ? Math.max(0, Math.min(100, w.pct || 0)) : 0, unknown: !known, resetsAt: w.resetsAt, updated: lim.updated, stale: winStale(lim, k, w), age: ageTxt(lim.observed?.[k]) }; });
    if (ws.length) out.push([agent, ws.sort((a, b) => (a.k === 'five_hour' ? -1 : b.k === 'five_hour' ? 1 : 0))]);
  }
  return out.sort(([a], [b]) => (a === 'claude' ? 0 : 1) - (b === 'claude' ? 0 : 1));
}
// A reading is stale when the server said so, it has no observation time, its window has reset, or it is over 30 minutes old (re-checked here: the clock moves between broadcasts).
const winStale = (lim, k, w) => { const o = lim.observed?.[k]; return !!lim.stale?.[k] || typeof o !== 'number' || (typeof w.resetsAt === 'number' && Date.now() >= w.resetsAt) || Date.now() - o > 30 * 60e3; };
const ageTxt = (t) => { if (typeof t !== 'number') return 'age unknown'; const m = Math.max(0, Math.round((Date.now() - t) / 60e3)); return m < 60 ? `${m} min old` : m < 2880 ? `${Math.round(m / 60)} h old` : `${Math.round(m / 1440)} d old`; };
const pctShow = (m) => (m.unknown ? 'no recent reading' : m.stale ? `${pctTxt(m.pct)}, ${m.age}` : pctTxt(m.pct));
const cliName = (a) => a === 'claude' ? 'Claude' : 'Codex';
const pctTxt = (p) => p.toFixed(p < 10 ? 1 : 0) + '%';
let meterPop = false;
// Failures recorded by the limits module (failed Haiku probe, missing CLI, API-key login without usage windows).
const limitErrors = () => Object.entries(S.limits || {}).filter(([, l]) => l && l.error).map(([agent, l]) => ({ agent, error: String(l.error), at: l.errorAt }));
// Which windows are stale right now. tickTimers compares this with the last paint so a reading that ages or passes its reset repaints on its own.
const meterStaleSig = () => Object.entries(S.limits || {}).map(([a, l]) => l ? Object.entries(l.windows || {}).map(([k, w]) => a + k + (winStale(l, k, w) ? 1 : 0)).join() : '').join('|');
let paintedStaleSig = null;
function renderMeters() { if (deferRender(renderMeters)) return; keepFocus($("#meters"), paintMeters); }
function paintMeters() {
  paintedStaleSig = meterStaleSig();
  const groups = meterGroups(), errs = limitErrors(), errOf = (agent) => errs.find((e) => e.agent === agent);
  const summary = [];
  // Each CLI shows its fullest window; every window is in the popover.
  const meters = groups.map(([agent, ws]) => {
    // Fresh readings win over stale ones: an old high number must not outrank a current one.
    const fresh = ws.filter((x) => !x.stale), m = (fresh.length ? fresh : ws).reduce((a, b) => (b.pct > a.pct ? b : a));
    const lvl = m.stale ? '' : m.pct >= 90 ? 'bad' : m.pct >= 75 ? 'warn' : '';
    const err = errOf(agent);
    summary.push(`${TOOL[agent] || agent} ${pctShow(m)} of the ${WIN[m.k] || m.k} limit`);
    return `<span class="quota ${lvl}${m.stale ? ' stale' : ''}" style="${m.stale ? 'opacity:.55' : ''}"><span class="q-name"><span class="long">${TOOL[agent] || cliName(agent)}</span><span class="short">${cliName(agent)}</span></span><span class="meter" aria-hidden="true"><i style="width:${m.pct}%"></i></span><span class="q-pct num">${pctShow(m)}</span>${err ? '<span class="dot warn" aria-hidden="true"></span>' : ''}${m.stale ? '' : `<span class="q-reset num" data-reset="${m.resetsAt || ''}">resets in ${countdown(m.resetsAt)}</span>`}</span>`;
  }).join('');
  const label = groups.length ? `Usage limits: ${summary.join('; ')}. Updated ${groups[0][1][0].updated ? hhmm(groups[0][1][0].updated) : 'unknown'}.${errs.length ? ' Last refresh failed.' : ''} Open for every window.` : errs.length ? 'Usage refresh failed. Open for details' : 'No usage data yet. Open to refresh';
  // Popover: one section per CLI that has windows or an error; always offers the Claude refresh.
  const agents = [...new Set([...groups.map(([a]) => a), ...errs.map((e) => e.agent)])].sort((a, b) => (a === 'claude' ? 0 : 1) - (b === 'claude' ? 0 : 1));
  const section = (agent, i) => {
    const ws = (groups.find(([a]) => a === agent) || [, []])[1], err = errOf(agent);
    return `<div class="mpop-h eyebrow" style="margin-top:${i ? 12 : 0}px">${TOOL[agent] || cliName(agent)}</div>
      ${ws.map((m) => `<div class="mpop-r"><span>${WIN[m.k] || m.k}</span><b${m.stale ? ' style="opacity:.55"' : ''}>${pctShow(m)}</b>${m.stale ? '<span class="sub">stale</span>' : `<span class="sub" data-reset="${m.resetsAt || ''}">resets in ${countdown(m.resetsAt)}</span>`}</div>`).join('')}
      ${err ? `<div class="mpop-err" role="alert">${icon('alert', 14)}<span><b>Refresh failed${err.at ? ` at ${hhmm(err.at)}` : ''}.</b> ${esc(err.error)}</span></div>` : ''}`;
  };
  const pop = !meterPop ? '' : `<div class="mpop" id="mpop" role="group" aria-label="Usage limits">${agents.map(section).join('') || '<div class="hint" style="margin:0">No usage data yet. Claude usage appears after the first agent run or a refresh; Codex usage is read from the newest Codex session.</div>'}
    <button class="btn" id="mProbe">${icon('refresh', 14)}Refresh Claude usage (one Haiku call)</button></div>`;
  const inner = meters || `<span class="quota-none">${errs.length ? '<span class="dot warn" aria-hidden="true"></span>Usage refresh failed' : 'Usage'}</span>`;
  $('#meters').innerHTML = `<button class="meter-btn" id="metersBtn" title="${esc(label)}" aria-expanded="${meterPop}" aria-controls="mpop" aria-label="${esc(label)}">${inner}</button>${pop}`;
  $('#metersBtn').onclick = () => { meterPop = !meterPop; renderMeters(); if (meterPop) $('#mProbe')?.focus(); else $('#metersBtn')?.focus(); };
  $('#mProbe') && ($('#mProbe').onclick = async () => { try { await api('/api/limits/refresh', {}); toast('Refreshing usage…'); } catch {} });
}
// A new failure (errorAt changed) gets a short toast; the details live in the meter popover.
const seenErrAt = {};
function noteLimitErrors(silent = false) {
  for (const e of limitErrors()) { if (e.at && seenErrAt[e.agent] !== e.at) { seenErrAt[e.agent] = e.at; if (!silent) toast(`${cliName(e.agent)} usage refresh failed. Open the usage meter for details`); } }
}
document.addEventListener('click', (e) => { if (meterPop && !e.composedPath().includes($('#meters'))) { meterPop = false; renderMeters(); } });
function budgetWarning() {
  const c = S.limits?.claude; const w = c?.windows?.seven_day;
  if (!w || winStale(c, 'seven_day', w)) return null;
  return w.pct >= 80 ? w.pct : null;
}
// Only a change of state repaints the badge: a re-render would make the polite live region announce it again on every retry.
let connPainted = null;
function renderConn() {
  if (connPainted === S.connected) return;
  connPainted = S.connected;
  $('#conn').innerHTML =`<span class="dot ${S.connected ? 'ok' : 'fail'}" aria-hidden="true"></span><span class="txt">${S.connected ? 'Connected' : 'Reconnecting'}</span>${S.connected ? '' : '<span class="sr-only">Live updates disconnected</span>'}`;
  $('#conn').title = S.connected ? `Live updates connected to ${location.host}` : 'Live updates disconnected, reconnecting';
}

/* ================= sidebar ================= */
const DAY = 864e5;
function dayStart() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(); }
// Right accessory for a finished session: relative today, weekday this week, date before that.
function whenTxt(iso) {
  const t = new Date(iso).getTime(), d0 = dayStart();
  if (t >= d0) return ago(iso);
  if (t >= d0 - 6 * DAY) return new Date(iso).toLocaleDateString('en', { weekday: 'short' });
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
// A row from roomIndex carries metadata only (no seats, plan or items): its subtitle names the kind and leaves the counts out.
function sessionSub(r) {
  const seat = esc(S.seats[r.seatId]?.name || 'agent');
  if (r.kind === 'meeting') return Array.isArray(r.seatIds) ? `Debate · ${r.seatIds.length} agents` : 'Debate';
  if (r.kind === 'chain') return 'Propose → Review';
  if (r.kind === 'plan') return r.plan ? `Plan · ${(r.plan.items || []).length} items` : 'Plan';
  if (r.kind === 'build') return r.items ? `Build · ${Object.keys(r.items).length} items` : 'Build';
  if (r.kind === 'ask') return r.seatId ? `Ask · ${seat}` : 'Ask';
  if (r.kind === 'run') return esc(`External run · ${r.engine === 'codex' ? 'Codex' : 'Claude Code'}`);
  if (r.kind === 'dm') return r.seatId ? `Agent memory · ${seat}` : 'Agent memory';
  return esc(KIND[r.kind] || r.kind || 'Session');
}
// A legacy Direct chat is listed under Ask as "Chat with <agent> (agent memory)": it stays fixed to that agent.
const sessionTitle = (r) => r.kind === 'dm' && S.seats[r.seatId] ? `Chat with ${S.seats[r.seatId].name} (agent memory)` : r.title;
function sessionRow(r) {
  const on = r.id === S.active;
  const sub = sessionSub(r);
  let acc;
  if (r.status === 'running') acc = `<span class="srow-acc live" title="Running"><span class="dot run" aria-hidden="true"></span><span class="acc-word">Running</span></span>`;
  else if (r.status === 'needs-you' || r.status === 'awaiting-approval' || r.status === 'needs-approval' || r.status === 'waiting') acc = `<span class="srow-acc warn" title="${esc(STATUS[r.status])}"><span class="dot warn" aria-hidden="true"></span><span class="acc-word">${esc(STATUS[r.status])}</span></span>`;
  else if (r.status === 'error') acc = `<span class="srow-acc failed" title="Failed">${icon('x', 12)}<span class="acc-word">Failed</span></span>`;
  else if (r.status === 'stopped') acc = `<span class="srow-acc stopped" title="Stopped"><span class="dot hollow" aria-hidden="true"></span><span class="acc-word">Stopped</span></span>`;
  else acc = `<span class="srow-acc" title="${esc(`${STATUS[r.status] || r.status} · started ${new Date(r.created).toLocaleString()}`)}">${esc(whenTxt(r.created))}<span class="sr-only">, ${esc(STATUS[r.status] || r.status)}</span></span>`;
  return `<div role="listitem"><button class="srow" data-room="${esc(r.id)}" ${on ? 'aria-current="page"' : ''}>
    <span class="srow-ico" aria-hidden="true">${icon(kindIcon(r.kind), 14)}</span><span class="srow-title">${esc(sessionTitle(r))}</span><span class="srow-sub">${sub}</span>${acc}</button></div>`;
}
// Every room the sidebar knows, newest first: the room index (metadata of the newest 500) with the full rooms on top.
function roomIndexList() {
  const all = new Map();
  for (const e of Object.values(S.roomIndex || {})) if (e && e.id) all.set(e.id, e);
  for (const r of Object.values(S.rooms)) if (r && r.id) all.set(r.id, { ...(all.get(r.id) || {}), ...r });
  return [...all.values()].sort((a, b) => String(b.created).localeCompare(String(a.created)));
}
const EMPTY_LIST = { ask: 'No chats yet', council: 'No councils yet', workflow: 'No workflows yet' };
// The session list of the current mode (Runs lists its runs in the main view instead).
function sessionListHtml() {
  if (S.mode === 'runs') return '<div class="group"><div class="side-empty">Runs are listed in the main view.</div></div>';
  const q = (S.query || '').trim().toLowerCase();
  const all = roomIndexList().filter((r) => modeOf(r) === S.mode);
  const list = q ? all.filter((r) => `${sessionTitle(r)} ${r.topic || ''} ${r.task || ''}`.toLowerCase().includes(q)) : all;
  const d0 = dayStart(), groups = [['Today', []], ['This week', []], ['Earlier', []]];
  for (const r of list) { const t = new Date(r.created).getTime(); groups[t >= d0 ? 0 : t >= d0 - 6 * DAY ? 1 : 2][1].push(r); }
  const html = groups.filter(([, rs]) => rs.length).map(([label, rs]) => {
    const id = 'sg-' + slug(label);
    return `<section class="group" aria-labelledby="${id}"><h2 class="group-label eyebrow" id="${id}"><span>${label}</span><span class="count">${rs.length}</span></h2><div role="list" aria-labelledby="${id}">${rs.map(sessionRow).join('')}</div></section>`;
  }).join('');
  return html || `<div class="group"><div class="side-empty">${q ? 'No matching sessions' : EMPTY_LIST[S.mode] || 'No sessions yet'}</div></div>`;
}
function renderSessions() { if (deferRender(renderSessions)) return; keepFocus($("#sessions"), paintSessions); }
function paintSessions() {
  $('#sessions').innerHTML = sessionListHtml();
  $$('#sessions [data-room]').forEach((el) => el.onclick = () => openRoom(el.dataset.room));
}

/* ================= modes: Ask, Council, Workflow, Runs ================= */
const MODES = [
  { id: 'ask', label: 'Ask', icon: 'chat', newLabel: 'New chat' },
  { id: 'council', label: 'Council', icon: 'debate', newLabel: 'New council' },
  { id: 'workflow', label: 'Workflow', icon: 'list', newLabel: 'New workflow' },
  { id: 'runs', label: 'Runs', icon: 'target', newLabel: '', tag: 'experimental' },
];
const MODE_OF_KIND = { dm: 'ask', ask: 'ask', meeting: 'council', plan: 'workflow', build: 'workflow', chain: 'workflow', run: 'workflow' };
// The mode a room belongs to. Unknown kinds go to Workflow.
const modeOf = (room) => MODE_OF_KIND[room?.kind] || 'workflow';
const modeById = (id) => MODES.find((m) => m.id === id) || null;
// Runs needs no CLI: it shows when the server found <claudeHome>/projects (state().watch.claude).
const visibleModes = () => MODES.filter((m) => m.id !== 'runs' || S.watch?.claude === true);
S.mode = (() => { const m = ls.get('ob.mode'); return modeById(m) ? m : 'ask'; })();
// Called when the mode list may have changed (a snapshot): a saved mode that is no longer shown falls back to Ask.
function fixMode() { if (!visibleModes().some((m) => m.id === S.mode)) S.mode = 'ask'; }
// Something running in a mode puts a dot on its row (no counts). Runs reads the runs list once that view has it.
function modeRunning(id) {
  if (id === 'runs') return !!(S.wf?.runs || []).some?.((r) => r && r.status === 'running');
  return roomIndexList().some((r) => r.status === 'running' && modeOf(r) === id);
}
function modeNavHtml() {
  const current = S.active || S.view === 'mode' ? S.mode : null;
  return `<ul class="modes-list">${visibleModes().map((m, i) => {
    const run = modeRunning(m.id);
    return `<li><button class="mrow" data-mode="${m.id}" ${m.id === current ? 'aria-current="page"' : ''} title="Shortcut: ${i + 1}">`
      + `<span class="mrow-ico" aria-hidden="true">${icon(m.icon, 14)}</span><span class="mrow-label">${esc(m.label)}</span>`
      + `${m.tag ? `<span class="tag">${esc(m.tag)}</span>` : ''}`
      + `${run ? '<span class="dot run" aria-hidden="true"></span><span class="sr-only">, something is running</span>' : ''}</button></li>`;
  }).join('')}</ul>`;
}
function paintModeNav() {
  const nav = $('#modeNav'); if (!nav) return;
  keepFocus(nav, () => { nav.innerHTML = modeNavHtml(); $$('[data-mode]', nav).forEach((b) => b.onclick = () => setMode(b.dataset.mode)); });
  paintNewBtn();
}
// The New button follows the mode; Runs has none.
function paintNewBtn() {
  const b = $('#newBtn'); if (!b) return;
  const m = modeById(S.mode);
  b.hidden = !m || !m.newLabel;
  if (m?.newLabel) b.innerHTML = `${icon('plus', 14)}${esc(m.newLabel)}<kbd aria-hidden="true">N</kbd>`;
}
// Switches the mode and shows its home. A mode that is not shown (Runs without Claude Code data) falls back to Ask.
function setMode(id) {
  if (!visibleModes().some((m) => m.id === id)) id = 'ask';
  S.mode = id; ls.set('ob.mode', id); S.view = 'mode';
  openRoom(null);
}
// Opening a room moves the mode to the room's mode, without leaving the room.
function syncModeTo(room) {
  if (!room?.kind) return;
  const m = modeOf(room);
  if (m !== S.mode) { S.mode = m; ls.set('ob.mode', m); }
}
// N: something new in the current mode. Ask starts a new chat on its home; Runs has nothing to create.
function newInMode(mode = S.mode) {
  if (mode === 'ask') { setMode('ask'); $('#askText')?.focus(); }
  else if (mode === 'council') openNew('meeting', null, 'mode');
  else if (mode === 'workflow') openNew('plan', null, 'mode');
}
function renderAgents() { if (deferRender(renderAgents)) return; keepFocus($("#agents"), paintAgents); }
function paintAgents() {
  const running = S.order.filter((id) => S.seats[id]?.status === 'working').length;
  $('#agentsCount').textContent = running ? `${running} running` : S.order.length ? String(S.order.length) : '';
  $('#agents').innerHTML = S.order.map((id) => {
    const s = S.seats[id];
    const st = s.status === 'working' ? `<span class="state"><span class="dot run" aria-hidden="true"></span><span class="acc-word">Running</span></span>`
      : s.status === 'error' ? `<span class="state failed">${icon('x', 12)}<span class="acc-word">Failed</span></span>` : '';
    const tip = [s.role, `Effort: ${EFFORT[s.effort] || s.effort}`, s.activity].filter(Boolean).join(' · ');
    return `<div role="listitem"><button class="arow" data-seat="${esc(id)}" title="${esc(tip)}">${avatar(id)}<span class="arow-text"><span class="arow-name">${esc(s.name)}</span><span class="arow-sub">${esc(TOOL[s.agent] || s.agent)} · ${esc(s.model || 'default')}</span></span>${st}</button></div>`;
  }).join('') || '<div class="side-empty">No agents. Add one with +</div>';
  $$('#agents [data-seat]').forEach((el) => el.onclick = () => openAgent(el.dataset.seat));
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

/* ================= setup check (GET /api/doctor) ================= */
// Reference guidance, used only when the doctor reports a problem WITHOUT its own hint (or reports nothing at all).
// On Windows the npm global install leaves only a .cmd shim that Node cannot spawn, so the npm command is never
// offered there: the native installers (or ORCHESTRA_*_BIN pointing at the .exe) are the fix.
const FIX = isWin ? {
  claudeInstall: 'irm https://claude.ai/install.ps1 | iex', claudeLogin: 'claude',
  codexInstall: '', codexLogin: 'codex login',
} : {
  claudeInstall: 'npm install -g @anthropic-ai/claude-code', claudeLogin: 'claude',
  codexInstall: 'npm install -g @openai/codex', codexLogin: 'codex login',
};
const FIX_NOTE = { claudeInstall: isWin ? 'native installer, run in PowerShell' : '', claudeLogin: 'then type /login inside the Claude CLI', codexLogin: 'signs in with your ChatGPT account or an API key' };
const FIX_HINT = {
  claudeInstall: isWin ? 'Or set ORCHESTRA_CLAUDE_BIN to the full path of claude.exe. Avoid `npm install -g`: on Windows it leaves only a claude.cmd shim, which the board cannot launch.' : '',
  codexInstall: isWin ? 'Install the native Windows build: download codex.exe from github.com/openai/codex/releases and put it on PATH, or set ORCHESTRA_CODEX_BIN to its full path. Avoid `npm install -g`: on Windows it leaves only a codex.cmd shim, which the board cannot launch.' : '',
};
const FIX_URL = { codexInstall: 'https://github.com/openai/codex/releases', claudeInstall: 'https://claude.com/claude-code' };
// A warn on a CLI check means the board cannot launch that CLI (shim-only install, --version timed out or failed,
// or a non-zero exit): agents would fail on every turn, so it blocks like a fail. A same-named file in the project
// is only a note (doctor says "The board ignores it"): the CLI still runs from PATH, so it never blocks.
const CLI_CHECK = (c) => /^(claude|codex)$/i.test(c.id) || /\bCLI\b/.test(c.name);
const CLI_STATES = ['ok', 'warn', 'broken', 'missing'];
const CWD_SHADOW_NOTE = /The board ignores it\b/;
// Tolerant normalisation: the doctor module decides the exact check shape; the UI only needs name, state, detail, fix.
function normChecks(raw) {
  let arr = Array.isArray(raw) ? raw : Array.isArray(raw?.checks) ? raw.checks : [];
  if (!arr.length && raw?.checks && typeof raw.checks === 'object') arr = Object.entries(raw.checks).map(([id, c]) => (c && typeof c === 'object' ? { id, ...c } : { id, name: id, ok: !!c }));
  return arr.map((c, i) => {
    if (typeof c === 'string') c = { name: c };
    const stRaw = typeof c.ok === 'boolean' ? (c.ok ? 'ok' : 'fail') : typeof c.pass === 'boolean' ? (c.pass ? 'ok' : 'fail') : String(c.status ?? c.level ?? c.state ?? 'ok').toLowerCase();
    let st = /^(ok|pass|passed|good|found|ready|true)$/.test(stRaw) ? 'ok' : /^(warn|warning|skip|skipped|unknown|info|optional)$/.test(stRaw) ? 'warn' : 'fail';
    if (st === 'fail' && (c.optional === true || c.required === false)) st = 'warn';
    const detail = String(c.detail || c.message || c.msg || c.description || c.version || ''), hint = String(c.hint || c.advice || '');
    const n = { id: String(c.id || c.key || c.name || `check-${i}`), name: String(c.name || c.label || c.title || c.id || 'Check'), st, skipped: /^(skip|skipped)$/.test(stRaw),
      detail: detail || hint, hint: detail && hint !== detail ? hint : '', fix: String(c.fix || c.command || c.fixCommand || c.cmd || ''), fixNote: String(c.fixNote || c.fixLabel || ''), url: /^https?:\/\//.test(c.url || c.docs || '') ? (c.url || c.docs) : '' };
    if (!n.url) { const m = hint.match(/https?:\/\/[^\s)>\]]+/); if (m) n.url = m[0]; }
    // Which CLI a check is about (null for Node, logins, port, ...): decides whether a failure can block at all.
    n.cli = /^claude$/i.test(n.id) || /claude cli/i.test(n.name) ? 'claude' : /^codex$/i.test(n.id) || /codex cli/i.test(n.name) ? 'codex' : null;
    // The doctor's CLI state (plan 2.6): ok, warn, broken or missing. Only broken and missing turn anything off.
    n.state = CLI_STATES.includes(c.state) ? c.state : null;
    // Raw verdict for the CLI as found; whether it actually blocks depends on the seats (isBlocking, at render time).
    n.blocking = n.st === 'fail' || (n.st === 'warn' && !n.skipped && CLI_CHECK(n) && !CWD_SHADOW_NOTE.test(`${n.detail} ${n.hint}`));
    if (n.blocking && n.st === 'warn' && !n.hint) n.hint = `The board cannot use this CLI as found. Re-check; if it keeps failing, point ${/codex/i.test(n.id + n.name) ? 'ORCHESTRA_CODEX_BIN' : 'ORCHESTRA_CLAUDE_BIN'} at a working native executable (.exe) and restart the board.`;
    // The doctor's own hint always wins; a guess is a fallback for a check that explains nothing.
    if (n.st !== 'ok' && !n.fix && !n.hint) { const g = guessFix(n); if (g) { n.fix = FIX[g] || ''; n.fixNote = n.fix ? FIX_NOTE[g] || '' : ''; n.hint = FIX_HINT[g] || ''; if (!n.url && !n.fix) n.url = FIX_URL[g] || ''; } }
    return n;
  });
}
function guessFix(c) {
  const s = `${c.id} ${c.name} ${c.detail}`.toLowerCase();
  const agent = /codex/.test(s) ? 'codex' : /claude/.test(s) ? 'claude' : null; if (!agent) return null;
  // Never guess for a CLI that exists but cannot be launched or answered: the doctor describes those itself.
  if (/(shim|\.cmd|\.bat|timed out|exited|could not be started|cannot (be )?launch|einval|shadow)/.test(s)) return null;
  if (/(logged|signed|sign in|log in|login|auth|credential|api key|token|unauthori[sz]ed)/.test(s)) return agent + 'Login';
  if (/not found on path|not installed|not found|not on path/.test(s)) return agent + 'Install';
  return null;
}
// A CLI that no agent uses is never launched, so its absence cannot block anything (one of the two CLIs is enough
// when every agent uses it). Evaluated at render time: seats change without a re-check.
const seatsOn = (agent) => Object.values(S.seats).filter((s) => s.agent === agent);
const isBlocking = (c) => c.blocking && !(c.cli && c.st !== 'ok' && !seatsOn(c.cli).length);
const doctorProblems = () => (S.doctor?.checks || []).filter(isBlocking);
// False when the setup check found this CLI unusable (missing, shim-only, failed --version); true without a result yet.
const cliReady = (agent) => !(S.doctor?.checks || []).some((c) => c.cli === agent && c.blocking);
// A CLI's state for the pickers and mode homes (plan 2.6): 'ok', 'warn', 'broken', 'missing', or 'unknown' before the
// setup check has a result (then nothing is hidden or disabled). A check without a state is read from its verdict.
function cliState(agent) {
  const c = (S.doctor?.checks || []).find((x) => x.cli === agent);
  if (!c) return 'unknown';
  if (CLI_STATES.includes(c.state)) return c.state;
  if (c.st === 'ok') return 'ok';
  if (/not found|not installed|does not exist/i.test(`${c.detail} ${c.hint}`)) return 'missing';
  return c.st === 'fail' ? 'broken' : 'warn';
}
// Why a CLI cannot be used, as plain text for a disabled row or card.
function cliReason(agent) {
  const c = (S.doctor?.checks || []).find((x) => x.cli === agent), st = cliState(agent), name = TOOL[agent] || agent;
  const detail = c?.detail ? `: ${c.detail}` : '';
  if (st === 'missing') return `${name} is not installed${detail}`;
  if (st === 'broken') return `${name} cannot be started by the board${detail}`;
  if (st === 'warn') return `${name} needs a setup check${detail}`;
  return '';
}
// A CLI the board can spawn: ok, warn or not checked yet.
const cliUsable = (agent) => ['ok', 'warn', 'unknown'].includes(cliState(agent));
async function runDoctor() {
  S.doctor = { loading: true, checks: S.doctor?.checks || [], error: null, at: S.doctor?.at };
  renderSetup();
  try { const r = await fetch('/api/doctor', { credentials: 'same-origin' }); if (r.status === 401) { authGate(); return; } const j = await r.json(); if (j?.error) throw new Error(j.error); S.doctor = { loading: false, checks: normChecks(j), error: null, at: Date.now() }; }
  catch (e) { S.doctor = { loading: false, checks: [], error: e.message || String(e), at: Date.now() }; }
  renderSetup();
  const n = doctorProblems().length;
  if (S.doctor.at && !S.doctor.loading) announce(S.doctor.error ? 'Setup check failed to run' : n ? `Setup check: ${n} problem${n === 1 ? '' : 's'} found` : 'Setup check passed');
}
const cmdRow = (cmd, note = '') => `<div class="cmd"><code>${esc(cmd)}</code>${note ? `<span class="hint" style="margin:0;flex:none">${esc(note)}</span>` : ''}<button class="btn sm" data-copy="${esc(cmd)}" data-copy-msg="Command copied" aria-label="Copy command: ${esc(cmd)}">${icon('copy', 12)}Copy</button></div>`;
const stateTxt = (c) => c.st === 'ok' ? 'OK' : c.skipped ? 'Skipped' : c.blocking && !isBlocking(c) ? 'Optional' : c.st === 'fail' ? (/not found|not installed|does not exist/i.test(c.detail) ? 'Missing' : 'Failed') : c.blocking ? 'Blocked' : 'Check';
function checkRow(c) {
  const blocking = isBlocking(c), optional = c.blocking && !blocking, st = optional ? 'warn' : c.st;
  const ic = st === 'ok' ? 'check' : st === 'warn' && !blocking ? 'alert' : 'x';
  // For a CLI problem: who depends on it, and how to go on with the other CLI alone.
  const users = c.cli && c.st !== 'ok' ? seatsOn(c.cli) : null;
  const who = !users ? '' : users.length
    ? `<div class="hint" style="color:var(--text-2)">Used by ${users.map((s) => esc(s.name)).join(', ')}. To go on without ${cliName(c.cli)}, switch ${users.length === 1 ? 'that agent' : 'those agents'} to the other runtime (open the agent and change Runtime) or delete ${users.length === 1 ? 'it' : 'them'}.</div>`
    : `<div class="hint" style="color:var(--text-2)">No agent uses the ${cliName(c.cli)} CLI, so this does not block you. Install it when you add a ${cliName(c.cli)} agent.</div>`;
  return `<div class="check ${st} ${blocking ? 'blocking' : ''}" role="listitem"><span class="check-ic">${icon(ic, 12)}</span>
    <div class="check-b"><b>${esc(c.name)}</b>${c.detail ? `<div class="hint">${esc(c.detail)}</div>` : ''}${who}${c.hint ? `<div class="hint" style="color:var(--text-2)">${esc(c.hint)}</div>` : ''}${c.fix ? cmdRow(c.fix, c.fixNote) : ''}${c.url ? `<div class="hint"><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.url.replace(/^https?:\/\//, ''))}</a></div>` : ''}</div>
    <span class="check-state">${stateTxt(c)}</span></div>`;
}
const stepHint = (t) => t ? `<div class="hint" style="color:var(--text-2)">${esc(t)}</div>` : '';
const genericSteps = () => `<div class="setup-steps" role="list">
    <div class="setup-step" role="listitem"><b>1. Claude CLI</b>${cmdRow(FIX.claudeInstall, FIX_NOTE.claudeInstall)}${stepHint(FIX_HINT.claudeInstall)}${cmdRow(FIX.claudeLogin, FIX_NOTE.claudeLogin)}</div>
    <div class="setup-step" role="listitem"><b>2. Codex CLI</b>${FIX.codexInstall ? cmdRow(FIX.codexInstall) : ''}${stepHint(FIX_HINT.codexInstall)}${isWin ? `<div class="hint"><a href="${FIX_URL.codexInstall}" target="_blank" rel="noopener noreferrer">github.com/openai/codex/releases</a></div>` : ''}${cmdRow(FIX.codexLogin, FIX_NOTE.codexLogin)}</div>
    <div class="hint">Run these in ${isWin ? 'PowerShell' : 'a terminal'}, then re-check. One CLI is enough if every agent uses it. Both use your own plan quota; the board never calls an API directly.</div></div>`;
function setupHtml(firstRun) {
  const d = S.doctor, problems = doctorProblems();
  // Warnings that do not block (e.g. a CLI not signed in): the all-clear is shown only when every check passed or was skipped.
  const open = (d?.checks || []).filter((c) => c.st !== 'ok' && !c.skipped);
  const head = firstRun
    ? `<h2 id="setupTitle">Welcome. Let's check your setup</h2><p class="lead">${APP} drives the Claude Code and Codex CLIs installed on this machine. Each CLI your agents use must be installed and signed in; one of the two is enough if all your agents use it.</p>`
    : `<h2 id="setupTitle">Setup check</h2>`;
  let body;
  if (!d || d.loading && !d.checks.length) body = '<div class="hint" style="margin:10px 0">Checking the environment…</div>';
  else if (d.error) body = `<div class="checks"><div class="check fail"><span class="check-ic">${icon('x', 12)}</span><div class="check-b"><b>Could not run the check</b><div class="hint">${esc(d.error)}</div></div><span class="check-state">Failed</span></div></div><p class="hint">What a working setup needs:</p>${genericSteps()}`;
  else if (!d.checks.length) body = `<p class="hint" style="margin-top:8px">The environment check reported no results, so nothing could be verified automatically. Make sure both CLIs are installed and signed in:</p>${genericSteps()}`;
  else body = `<div class="checks" role="list">${d.checks.map(checkRow).join('')}</div>${problems.length ? `<p class="hint">Fix the items marked <b>Missing</b>, <b>Failed</b> or <b>Blocked</b>, then re-check. Agents on a CLI the board cannot launch fail on every turn.</p>` : open.length ? `<p class="hint">${open.length} item${open.length === 1 ? '' : 's'} to check: agents on a CLI that is not signed in will fail.</p>` : `<div class="ok-line">${icon('check', 14)}Everything looks good. Start a session below.</div>`}`;
  return `<section class="setup" aria-labelledby="setupTitle" aria-busy="${!!d?.loading}">${head}${body}
    <div class="setup-f"><button class="btn" id="setupRecheck" ${d?.loading ? 'disabled' : ''}>${icon('refresh', 14)}${d?.loading ? 'Checking…' : 'Re-check'}</button>
      ${problems.length ? '' : '<button class="btn ghost" id="setupHide">Hide</button>'}
      ${d?.at ? `<span class="hint">Checked ${hhmm(d.at)}</span>` : ''}</div></section>`;
}
function bindSetup() {
  $('#setupRecheck') && ($('#setupRecheck').onclick = runDoctor);
  $('#setupHide') && ($('#setupHide').onclick = () => { ls.set('ob.setup.hide', '1'); S.setupOpen = false; renderHome(); $('#setupOpen')?.focus(); });
}
// Re-renders only the setup card (keeps the rest of the home page and the focused control). A change in whether
// the card is shown at all, or a missing home page, falls back to the full render.
function renderSetup() {
  if (S.active || S.view !== 'home') return; // a mode home has no setup card
  const home = $('#main .home'), cur = home?.querySelector('.setup');
  const want = homeFlags().showSetup;
  if (!home || !!cur !== want) return renderHome();
  if (!cur) return;
  const act = document.activeElement, onCard = !!act?.closest?.('.setup'), focusId = onCard ? act.id : '';
  cur.outerHTML = setupHtml(homeFlags().firstRun); bindSetup();
  if (!onCard) return;
  // Keep focus on the card: the same control by id when it still exists and is enabled, else Re-check, else (while
  // Re-check is disabled during the run) the card itself, so a keyboard user is never dropped to <body>.
  const card = $('#main .setup'), same = focusId ? $('#' + focusId) : null, re = $('#setupRecheck');
  if (same && !same.disabled) same.focus({ preventScroll: true });
  else if (re && !re.disabled) re.focus({ preventScroll: true });
  else { card.setAttribute('tabindex', '-1'); card.focus({ preventScroll: true }); }
}
// Budget banner only (every Claude turn emits a limits event; the whole home page must not re-render for it).
function renderBanner() {
  const slot = $('#bannerSlot'); if (!slot) return;
  const warn = budgetWarning();
  slot.innerHTML = warn ? `<div class="banner" role="status">${icon('alert', 14)}<span><b>Claude weekly usage is at ${warn.toFixed(0)}%.</b> Consider Codex agents for heavy work.</span></div>` : '';
}

/* ================= capability: may agents edit files? ================= */
// Pure helpers (also reached by the tests). S.capability comes from /api/state, GET /api/capability and the 'capability' event.
// Unknown (null) reads as unavailable: the UI never claims file edits are possible before the server says so.
function capabilityText(cap) {
  const ok = cap?.writes === 'available';
  return { level: ok ? 'ok' : 'off', title: ok ? 'File edits: available' : 'File edits: unavailable',
    reason: cap ? (cap.reason || (ok ? '' : 'Not available on this machine')) : 'Checking…' };
}
const shortHash = (h) => String(h || '').slice(0, 12);
// Escaped table of a plan: id, title, difficulty, owned paths, dependencies.
function planTableHtml(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const rows = items.map((it) => `<tr><td><code class="inline">${esc(it.id)}</code></td><td>${esc(it.title)}</td><td>${esc(it.difficulty)}</td>`
    + `<td>${(it.owns || []).map((p) => esc(p)).join(', ')}</td><td>${(it.dependsOn || []).map((d) => esc(d)).join(', ') || '—'}</td></tr>`).join('');
  return `<div class="plan-scroll"><table class="plan-table"><thead><tr><th scope="col">ID</th><th scope="col">Title</th><th scope="col">Difficulty</th><th scope="col">Owns</th><th scope="col">Depends on</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
// Acceptance checks are shell commands. A manager's are only proposals (item.proposedChecks, never run); the live ones
// (item.checks) exist only after the owner turned them on. Both are listed verbatim, escaped.
const CHECKS_WARNING = 'Checks are shell commands. They run on this machine with your permissions, outside any sandbox, in the item worktree after the change is frozen, and they execute files the agent just wrote. They get a minimal environment (no tokens or keys) and a time limit. On Windows, background processes a check starts may outlive it.';
const planChecksOf = (plan, field) => (Array.isArray(plan?.items) ? plan.items : []).flatMap((it) => (Array.isArray(it?.[field]) ? it[field] : []).map((c) => ({ id: it.id, name: c?.name, cmd: c?.cmd })));
function checkRowsHtml(list) {
  return `<div class="plan-scroll"><table class="plan-table"><thead><tr><th scope="col">Item</th><th scope="col">Check</th><th scope="col">Command (verbatim)</th></tr></thead><tbody>${list.map((c) => `<tr><td><code class="inline">${esc(c.id)}</code></td><td>${esc(c.name)}</td><td><code class="inline" style="white-space:pre-wrap;word-break:break-all">${esc(c.cmd)}</code></td></tr>`).join('')}</tbody></table></div>`;
}
function planChecksHtml(plan) {
  const live = planChecksOf(plan, 'checks'), off = planChecksOf(plan, 'proposedChecks');
  if (!live.length && !off.length) return '';
  const warn = `<div class="banner" role="note">${icon('alert', 14)}<span><b>These commands run on this machine.</b> ${esc(CHECKS_WARNING)}</span></div>`;
  return `<div class="plan-checks">${live.length ? `<h3 class="label">Acceptance checks that will run (${live.length})</h3>${warn}${checkRowsHtml(live)}` : ''}${off.length ? `<h3 class="label">Proposed checks, off (${off.length})</h3><p class="hint">The manager proposed these. Nothing runs them unless you turn checks on for this plan.</p>${checkRowsHtml(off)}${live.length ? '' : '<div class="plan-f"><button class="btn" id="plChecksOn">Turn on checks...</button></div>'}` : ''}</div>`;
}
// The plan with every proposed check made live (the owner's decision, saved as a new revision that needs approval).
function planWithChecksOn(plan) {
  return { ...plan, items: plan.items.map((it) => {
    if (!Array.isArray(it.proposedChecks) || !it.proposedChecks.length) return it;
    const { proposedChecks, ...rest } = it;
    return { ...rest, checks: [...(it.checks || []), ...proposedChecks].slice(0, 5) };
  }) };
}
// A confirmation that lists every live check command verbatim; go() runs only after the owner ticks the box and confirms.
function confirmChecks(plan, { title, verb, go }) {
  const live = planChecksOf(plan, 'checks');
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">${esc(title)}</h2>${closeBtn()}</div>
    <div class="modal-b"><div class="banner" role="note">${icon('alert', 14)}<span><b>${live.length} command${live.length === 1 ? '' : 's'} will run on this machine.</b> ${esc(CHECKS_WARNING)}</span></div>
      ${checkRowsHtml(live)}
      <label class="check-l"><input type="checkbox" id="ckAck"> I read every command above and allow them to run with my permissions</label></div>
    <div class="modal-f"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ckGo" disabled>${esc(verb)}</button></div>`, 'modal');
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  box.querySelector('#ckAck').onchange = (e) => { box.querySelector('#ckGo').disabled = !e.target.checked; };
  box.querySelector('#ckGo').onclick = async () => { if (!box.querySelector('#ckAck').checked) return; closeOverlay(); await go(); };
}
// Mirrors the server's ROLE_FALLBACK: which assigned role takes over when a role has no seat (preview only; the server decides).
const ROLE_FALLBACK = {
  manager: ['hard', 'medium', 'easy', 'reviewer'], hard: ['medium', 'manager', 'easy', 'reviewer'],
  medium: ['hard', 'easy', 'manager', 'reviewer'], easy: ['medium', 'hard', 'manager', 'reviewer'], reviewer: ['manager', 'hard', 'medium', 'easy'],
};
// Options for a build role select: an empty value means "uses fallback"; then one option per seat.
function roleOptionsHtml(roleName, selectedId) {
  void roleName; // the caller labels the select; the options do not depend on the role
  return `<option value="">Uses the fallback</option>` + S.order.map((id) => S.seats[id]).filter(Boolean)
    .map((s) => `<option value="${esc(s.id)}" ${s.id === selectedId ? 'selected' : ''}>${esc(s.name)} · ${esc(TOOL[s.agent] || s.agent)}</option>`).join('');
}
// Label for a stored write-check record ({result: 'pass'|'fail', ...} or null, as the server keeps it).
function writeCheckText(verified) {
  const res = verified?.result;
  return res === 'pass' ? 'Write check passed' : res === 'fail' ? 'Write check failed' : 'Write check not run';
}
// Help text under the agent editor's write checkbox (pure; it reads the same capability entry as the card).
// verifiable === false: the CLI cannot be write-checked on this machine, so the reason is given with no check sentence.
// Available: the normal explanation. Anything else: the reason, and where to run the write check.
function writeHelpText(agent, a, capKnown) {
  const tool = TOOL[agent] || agent;
  if (a?.verifiable === false) return `Not available for ${tool}: ${a.reason || 'file edits are off for this CLI on this machine.'}`;
  if (a?.available) return 'When checked, Build sessions may let this agent edit files, each item inside its own git worktree. Unchecked, it proposes changes only.';
  return `Not available for ${tool}: ${a?.reason || (capKnown ? 'the write check has not passed' : 'checking…')}. Run the write check in Settings.`;
}
// The agent editor's write box (plan 5.10 and Appendix B item 2). A Claude seat may be allowed to edit only when its CLI passed
// the write gate. A Codex seat never edits files itself, so its box does not depend on the Codex gate, which stays closed in
// v0.2: checked, the seat builds in patch mode (a read-only turn whose diff the board applies in the item worktree).
const CODEX_PATCH_HELP = 'Codex never edits files itself in v0.2. When checked, Build sessions run this agent read only and apply the diff it returns inside the item worktree (patch mode). Unchecked, it proposes changes only.';
function seatWriteBox(agent, a, capKnown) {
  if (agent === 'codex') return { disabled: false, help: CODEX_PATCH_HELP };
  return { disabled: !(!!a?.available && a?.verifiable !== false), help: writeHelpText(agent, a, capKnown) };
}
// The capability card body (shared by the home page, Settings and any open card that needs a refresh).
// A CLI that cannot be write-checked here gets a disabled "Not available" button and its reason as visible text.
// An inconclusive record says so; the legacy note says a project capability.json was ignored.
function capInner() {
  const t = capabilityText(S.capability), cap = S.capability;
  const agents = ['claude', 'codex'].map((agent) => {
    const a = cap?.agents?.[agent] || null, name = TOOL[agent];
    const seats = S.order.map((id) => S.seats[id]).filter((s) => s && s.agent === agent);
    const blocked = a?.verifiable === false, ready = !!a?.available && !blocked;
    const state = !cap ? 'Checking…' : ready ? 'Available' : blocked ? 'Not available' : esc(a?.reason || 'Not available');
    const ver = a?.version ? ` · ${esc(a.version)}` : '';
    const vTxt = a?.verified?.result === 'inconclusive' ? 'Write check inconclusive' : writeCheckText(a?.verified);
    const why = blocked && a.reason ? `<p class="hint">${esc(a.reason)}</p>` : '';
    const list = Array.isArray(a?.settings) ? a.settings : [];
    const settings = list.length ? `<ul class="cap-settings">${list.map((s) => `<li>${esc(typeof s === 'string' ? s : [s?.name ?? s?.key, s?.value ?? s?.detail].filter(Boolean).join(': '))}</li>`).join('')}</ul>` : '';
    const tip = seats.length ? 'Runs one real turn in a throwaway repository to check that edits stay inside the worktree' : `Add a ${name} agent first`;
    const button = blocked
      ? `<button class="btn sm" data-cap-verify="${agent}" disabled title="${esc(a.reason || '')}">Not available</button>`
      : `<button class="btn sm" data-cap-verify="${agent}" ${seats.length ? '' : 'disabled'} title="${esc(tip)}">${icon('refresh', 12)}Run write check</button>`;
    return `<div class="cap-agent"><div class="cap-row"><b>${esc(name)}</b><span>${state}${ver}</span><span class="hint">${vTxt}</span></div>${why}${settings}
      ${button}</div>`;
  });
  const legacy = cap?.legacyRecordIgnored === true ? '<p class="hint">A capability.json in this project is ignored; write checks are stored per user.</p>' : '';
  return `<div class="cap-h"><span class="dot ${t.level === 'ok' ? 'ok' : 'hollow'}" aria-hidden="true"></span><b>${esc(t.title)}</b></div>
    <p class="hint cap-reason">${esc(t.reason)}</p>${legacy}
    <div class="cap-agents" role="list">${agents.map((a) => `<div role="listitem">${a}</div>`).join('')}</div>`;
}
// Home variant: one line by default, "Details" expands capInner(). The choice is remembered (ob.cap.open).
// The state lives in memory (capExpanded) so the toggle works even when localStorage throws; storage only seeds it.
let capExpanded = null;
const capOpen = () => (capExpanded === null ? (capExpanded = ls.get('ob.cap.open') === '1') : capExpanded);
function capToggle() { capExpanded = !capOpen(); ls.set('ob.cap.open', capExpanded ? '1' : '0'); refreshCapCards(); }
function capSummary() {
  const cap = S.capability;
  if (!cap) return 'File edits: checking…';
  const on = capabilityText(cap).level === 'ok', ag = cap.agents || {};
  const claude = ag.claude?.verifiable === false ? 'Claude unavailable' : ag.claude?.available ? 'Claude can edit' : 'Claude needs a write check';
  const codex = ag.codex?.verifiable === false ? 'Codex unavailable' : ag.codex?.available ? 'Codex can edit' : 'Codex proposes patches';
  return `File edits: ${on ? 'on' : 'off'} · ${claude} · ${codex}`;
}
function capBody(home) {
  if (!home) return capInner();
  const open = capOpen();
  return `<div class="cap-line"><span class="dot ${capabilityText(S.capability).level === 'ok' ? 'ok' : 'hollow'}" aria-hidden="true"></span>`
    + `<span class="cap-sum">${esc(capSummary())}</span>`
    + `<button class="btn link cap-toggle" data-cap-toggle aria-expanded="${open}" aria-controls="capDetails">${open ? 'Hide details' : 'Details'}</button></div>`
    + `<div id="capDetails" class="cap-details"${open ? '' : ' hidden'}>${capInner()}</div>`;
}
const capCardHtml = (home) => `<section class="capcard${home ? ' cap-home' : ''}" data-capcard="${home ? 'home' : ''}" aria-label="File edits">${capBody(home)}</section>`;
function bindCap(root) {
  $$('[data-cap-verify]', root).forEach((b) => b.onclick = () => verifyCli(b.dataset.capVerify));
  $$('[data-cap-toggle]', root).forEach((b) => b.onclick = capToggle);
}
// One real write check for the chosen CLI: its write seat if it has one, else its first seat.
async function verifyCli(agent) {
  const list = S.order.map((id) => S.seats[id]).filter((s) => s && s.agent === agent);
  const seat = list.find((s) => s.perm === 'write') || list[0];
  if (!seat) return;
  try { await api('/api/capability/verify', { seatId: seat.id }); toast('Write check started'); } catch {}
}
const permText = () => capabilityText(S.capability).level === 'ok'
  ? 'File edits run only in Build sessions, inside per-item git worktrees.' : 'Agents read your project and never edit it.';
// Re-renders every capability card and the live bits that depend on the capability, keeping keyboard focus.
function refreshCapCards() {
  $$('[data-capcard]').forEach((el) => keepFocus(el, () => { el.innerHTML = capBody(el.dataset.capcard === 'home'); bindCap(el); }));
  $$('[data-permtxt]').forEach((el) => { el.textContent = permText(); });
  const bn = $('#bCapNote'); if (bn) bn.textContent = buildCapNote();
  const aw = $('#aWrite'); if (aw && aw.__sync) aw.__sync();
}
function setCapability(c) { S.capability = c || null; refreshCapCards(); }
let capOnce = false;
// Fetched once per page load: the server detects the CLI versions and the write check on first use.
function loadCapability() { if (capOnce) return; capOnce = true; api('/api/capability').then(setCapability).catch(() => {}); }
const buildCapNote = () => {
  const t = capabilityText(S.capability);
  return t.level === 'ok' ? 'Builds may edit files, each item inside its own git worktree.' : `This build will propose changes only: ${t.reason}`;
};

/* ================= main: home ================= */
function homeFlags() {
  const tok = Object.values(S.seats).reduce((a, s) => a + (s.used || 0), 0);
  const firstRun = !Object.keys(S.rooms).length && !tok;
  const showSetup = doctorProblems().length > 0 || S.setupOpen || (firstRun && ls.get('ob.setup.hide') !== '1');
  return { firstRun, showSetup };
}
function renderHome() {
  const seats = Object.values(S.seats), tok = seats.reduce((a, s) => a + (s.used || 0), 0), cost = seats.reduce((a, s) => a + (s.cost || 0), 0);
  const { firstRun, showSetup } = homeFlags();
  // The permission line follows the capability gate: edits are possible only in Build sessions when the server says so.
  $('#main').innerHTML = `<div class="home-scroll"><div id="bannerSlot"></div>
    <div class="home">
      ${showSetup ? setupHtml(firstRun) : ''}
      <h2 id="homeTitle">Start a session</h2><p class="lead">Agents are Claude Code or Codex CLI runs with a role. Every turn uses your plan quota. <span data-permtxt>${esc(permText())}</span></p>
      ${capCardHtml(true)}
      ${modeCardsHtml()}
      ${recentHtml()}
      <div class="foot-hint">${tok || cost ? `<span class="num">This project so far: ${fmtTok(tok)} tokens · ${fmtCost(cost)} Claude</span>` : ''}
        ${showSetup ? '' : '<button class="btn link" id="setupOpen">Check setup</button>'}<button class="btn link" id="helpOpen">Shortcuts</button></div>
    </div></div>`;
  renderBanner();
  $$('#main [data-mode-card]').forEach((b) => b.onclick = () => setMode(b.dataset.modeCard));
  $$('#main [data-recent]').forEach((b) => b.onclick = () => openRoom(b.dataset.recent));
  bindSetup(); bindCap($('#main'));
  $('#setupOpen') && ($('#setupOpen').onclick = () => { S.setupOpen = true; runDoctor(); });
  $('#helpOpen') && ($('#helpOpen').onclick = openHelp);
}
// Recent on Home: the newest 5 rooms of every mode, from the room index. Empty when there are none.
function recentHtml() {
  const rows = roomIndexList().slice(0, 5);
  if (!rows.length) return '';
  return `<section class="recent" aria-labelledby="recentL"><h2 class="eyebrow" id="recentL">Recent</h2><div class="recent-list" role="list">${rows.map((r) =>
    `<div role="listitem"><button class="rrow" data-recent="${esc(r.id)}"><span class="rrow-ico" aria-hidden="true">${icon(kindIcon(r.kind), 14)}</span>`
    + `<span class="rrow-title">${esc(sessionTitle(r))}</span><span class="rrow-st">${esc(STATUS[r.status] || r.status || '')}</span><span class="rrow-age">${esc(ago(r.created))}</span></button></div>`).join('')}</div></section>`;
}
// The demo server adds #demo-banner to the page (src/demo.js); that is how the client knows it is the demo.
const isDemo = () => !!(typeof document.getElementById === 'function' && document.getElementById('demo-banner'));
let demoOpened = false;
// Demo only, once: land on the build that needs you instead of an empty Home.
function demoLanding() {
  if (demoOpened || !isDemo()) return false;
  demoOpened = true;
  const b = roomIndexList().find((r) => r.kind === 'build' && r.status === 'needs-you');
  if (!b) return false;
  openRoom(b.id);
  return true;
}
// Brings back the brand home page (setup and capability cards, the four mode cards).
function goHome() { S.view = 'home'; openRoom(null); }

/* ---------- mode homes ---------- */
const AGENTS = ['claude', 'codex'];
// Why a mode cannot start anything right now, as visible text; null when it can. Runs needs Claude Code data, the other
// modes need one CLI the board can start.
function modeBlock(mode) {
  if (mode === 'runs') return S.watch?.claude === true ? null : 'No Claude Code data folder was found, so there are no runs to read.';
  if (AGENTS.some(cliUsable)) return null;
  const broken = AGENTS.filter((a) => cliState(a) === 'broken');
  return broken.length ? `${broken.map(cliReason).join('. ')}. Open Check setup to fix it.`
    : 'Neither Claude Code nor Codex is installed. Install one of them, then run the setup check again.';
}
const MODE_DESC = {
  ask: 'Ask one model. Switch the model any time; the new one gets a short recap in its first prompt.',
  council: 'Several models debate your question, then one writes a synthesis. No files change.',
  workflow: 'Engineers plan, you approve, then a team builds it: the board\'s own team, or Claude Code or Codex run by you.',
  runs: 'Follow Claude Code workflow runs live. The board only reads them; it never starts or stops them.',
};
// The four mode cards of the brand home. With no CLI they still show, disabled, each with its reason as text.
function modeCardsHtml() {
  return `<div class="tpls mode-cards" role="group" aria-label="Modes">${MODES.map((m) => {
    const why = modeBlock(m.id);
    return `<button class="tpl" data-mode-card="${m.id}" ${why ? `disabled aria-describedby="mcWhy-${m.id}"` : ''}><span class="ic">${icon(m.icon)}</span>`
      + `<b>${esc(m.label)}${m.tag ? ` <span class="tag">${esc(m.tag)}</span>` : ''}</b><span>${esc(MODE_DESC[m.id])}</span>`
      + `${why ? `<span class="tpl-why" id="mcWhy-${m.id}">${esc(why)}</span>` : ''}</button>`;
  }).join('')}</div>`;
}
// Vendors whose CLI is installed (ok, warn or broken), once the setup check has a result.
const installedVendors = () => (S.doctor?.checks || []).length ? AGENTS.filter((a) => ['ok', 'warn', 'broken'].includes(cliState(a))) : null;
// Council presets on its home: the choice is the one New council starts from (ob.new.preset).
const COUNCIL_PRESETS = [['quick', 'Quick', () => '2 agents, 1 round'], ['full', 'Full', () => `${Math.max(2, S.order.length)} agents, 2 rounds`]];
const FULL_ESTIMATE = 'Full: about 460k tokens in one measured run (n=1)';
function modeHomeHtml(mode) {
  if (mode === 'runs') return runsViewHtml(); // the Runs view (U2) is its own page, not a mode home
  const m = modeById(mode) || MODES[0], why = modeBlock(m.id);
  const block = why ? `<p class="mode-why" role="note">${icon('alert', 14)}<span>${esc(why)}</span></p>` : '';
  const dis = why ? 'disabled' : '';
  const head = `<h2 id="modeTitle">${esc(m.label)}${m.tag ? ` <span class="tag">${esc(m.tag)}</span>` : ''}</h2>`;
  let body = '';
  if (m.id === 'ask') {
    body = `<p class="lead">${esc(MODE_DESC.ask)}</p>${block}
      ${S.order.length ? `<div class="composer ask-composer"><textarea id="askText" rows="2" placeholder="Message…" aria-label="Message" aria-describedby="askKeys"></textarea>
        <div class="ask-tools"><div class="ask-pick-slot" id="askPickSlot">${askPickerHtml(null)}</div>
        <span class="sr-only" id="askKeys">Enter sends, Shift+Enter adds a new line.</span><button class="btn primary" id="askSend" ${dis}>Send</button></div></div>`
        : '<p class="hint">Add an agent first: Ask runs on one of your agents.</p><button class="btn" id="askAddAgent">Add agent</button>'}`;
  } else if (m.id === 'council') {
    const vendors = installedVendors();
    const one = vendors && vendors.length === 1 ? ` With only one vendor installed, Council is one model family arguing with itself (${esc(TOOL[vendors[0]])}).` : '';
    const curP = ls.get('ob.new.preset') === 'full' ? 'full' : 'quick';
    body = `<p class="lead">${esc(MODE_DESC.council)}${one}</p>${block}
      <div class="label" id="cPresetL">Preset</div>
      <div class="presets council-presets" role="radiogroup" aria-labelledby="cPresetL">${COUNCIL_PRESETS.map(([id, name, desc]) => `<button type="button" role="radio" class="preset ${id === curP ? 'on' : ''}" aria-checked="${id === curP}" data-council-preset="${id}"><b>${name}</b><span>${esc(desc())}</span></button>`).join('')}</div>
      <p class="hint" id="cEstimate">${esc(FULL_ESTIMATE)}</p>
      <div class="mode-f"><button class="btn primary" id="councilNew" ${dis}>${icon('plus', 14)}New council</button></div>`;
  } else if (m.id === 'workflow') {
    body = `<p class="lead">${esc(MODE_DESC.workflow)}</p>${block}
      <div class="mode-f"><button class="btn primary" id="wfNew" ${dis}>${icon('plus', 14)}New workflow</button><button class="btn" id="wfReview" ${dis}>${icon('review', 14)}Single task review</button></div>`;
  }
  return `<div class="home-scroll"><div class="home mode-home" data-mode-home="${m.id}" aria-labelledby="modeTitle">${head}${body}</div></div>`;
}
function renderModeHome(mode = S.mode) {
  if (mode === 'runs') return renderRuns(); // U2
  // A repaint (a reconnect, a seat change) keeps what was typed on the Ask home.
  const typed = $('#askText')?.value || '';
  $('#main').innerHTML = modeHomeHtml(mode);
  if (typed && $('#askText')) $('#askText').value = typed;
  const on = (sel, fn) => { const b = $(sel); if (b) b.onclick = fn; };
  if (mode === 'ask') {
    bindAskPicker($('#askPickSlot'), null);
    const ta = $('#askText');
    if (ta) {
      ta.oninput = () => grow(ta);
      ta.onkeydown = (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askFromHome(); } };
    }
    on('#askSend', askFromHome);
    on('#askAddAgent', () => openAgent(null));
  } else if (mode === 'council') {
    $$('[data-council-preset]').forEach((b) => b.onclick = () => { ls.set('ob.new.preset', b.dataset.councilPreset); segSet(b.parentElement, b); });
    on('#councilNew', () => openNew('meeting', null, 'mode'));
  } else if (mode === 'workflow') {
    on('#wfNew', () => openNew('plan', null, 'mode'));
    on('#wfReview', () => openNew('chain', null, 'mode'));
  }
}
async function askFromHome() {
  const ta = $('#askText'), btn = $('#askSend'); if (!ta || !btn || btn.disabled) return;
  const text = ta.value.trim(); if (!text) { toast('Write a message first'); return; }
  btn.disabled = true;
  try { const id = await sendAsk(null, text, currentPick(null)); if (id) { ta.value = ''; openRoom(id); } }
  catch {} finally { const b = $('#askSend'); if (b) b.disabled = false; }
}

/* ---------- Runs: Claude Code workflow runs (U2, plan 2.5 and 4). Read only: the board never starts or stops a run ---------- */
const RUN_LIST_MS = 30000; // GET /api/wf/runs renews the list lease this often while Runs is open
const RUN_DETAIL_MS = 45000; // GET /api/wf/runs/:id renews the detail lease this often while a run is open
// The same id rules as the server (plan 4.6): checked before any request is made.
const isRunIdUi = (v) => typeof v === 'string' && /^wf_[\w-]{1,40}$/.test(v);
const isAgentIdUi = (v) => typeof v === 'string' && /^a\w{8,40}$/.test(v);
const RUN_STATUS = {
  running: { word: 'Running', dot: 'run' }, idle: { word: 'Idle', dot: 'hollow' }, completed: { word: 'Done', dot: 'ok' },
  killed: { word: 'Killed', dot: 'hollow' }, unknown: { word: 'Ended without a summary', dot: 'hollow' },
};
const AGENT_STATUS = {
  running: { word: 'Running', dot: 'run' }, done: { word: 'Done', dot: 'ok' }, failed: { word: 'Failed', dot: 'fail' },
  retried: { word: 'Retried', dot: 'hollow' }, stopped: { word: 'Stopped', dot: 'hollow' },
  waiting: { word: 'Waiting', dot: 'hollow' }, unknown: { word: 'Unknown', dot: 'hollow' },
};
// Codex sandbox policy types as the board shows them (plan 2.4). Any other value is shown as written.
const SANDBOX_WORD = { 'read-only': 'read-only', 'workspace-write': 'workspace-write', 'danger-full-access': 'full access !' };
const statusOf = (map, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : { word: String(key || 'Unknown'), dot: 'hollow' });
const sandboxWord = (v) => (typeof v !== 'string' || !v ? '-' : Object.prototype.hasOwnProperty.call(SANDBOX_WORD, v) ? SANDBOX_WORD[v] : v);
const dotHtml = (st) => `<span class="dot ${st.dot}" aria-hidden="true"></span>`;
const numOf = (v) => (Number.isFinite(v) ? v : 0);
const shortRunId = (id) => `${String(id || '').slice(0, 7)}..`;
const scopeNow = () => (S.settings && S.settings.watchScope === 'all' ? 'all' : 'project');
let runsListT = null, runsDetailT = null; // lease timers: null while stopped
let runsShown = false; // the Runs view is on screen: its parts repaint when events arrive
let runsLoaded = false; // a list has arrived (before that the view says it is loading)
let runsError = ''; // the last list read failed with this text
let detailErr = null; // { id, text } when the open run could not be read
let previewSeq = 0; // numbers each Prompt request, so an answer for a closed Prompt is dropped
const readingRuns = new Set(); // run ids whose detail read is in flight

function runDuration(r) {
  if (!Number.isFinite(r.startedAt)) return '';
  const live = r.status === 'running' || r.status === 'idle';
  const end = live ? Date.now() : Number.isFinite(r.endedAt) ? r.endedAt : Number.isFinite(r.lastActivityAt) ? r.lastActivityAt : Date.now();
  return fmtDur(end - r.startedAt);
}
function agentDuration(a) {
  if (!Number.isFinite(a.startedAt)) return '';
  const end = a.status === 'running' ? Date.now() : Number.isFinite(a.endedAt) ? a.endedAt : Number.isFinite(a.lastActivityAt) ? a.lastActivityAt : null;
  return end === null ? '' : fmtDur(end - a.startedAt);
}
function runsCountText() {
  const runs = S.wf.runs || [];
  const live = runs.filter((r) => r.status === 'running' || r.status === 'idle').length;
  return `${runs.length === 1 ? '1 run' : `${runs.length} runs`}${live ? ` · ${live} live` : ''}`;
}
// Title, the experimental tag, the scope control and "What the board reads". A blocked view (no Claude Code folder) has no controls.
function runsHeadHtml(blocked) {
  const head = `<h2 id="runsTitle">Claude Code runs <span class="tag">experimental</span></h2><p class="lead">${esc(MODE_DESC.runs)}</p>`;
  if (blocked) return head;
  const scope = scopeNow();
  return `${head}<div class="runs-bar"><span class="runs-count" id="runsCount">${esc(runsCountText())}</span>`
    + `<label class="runs-scope" for="runsScope"><span>Scope</span><select id="runsScope" class="input">`
    + `<option value="project"${scope === 'project' ? ' selected' : ''}>This project</option>`
    + `<option value="all"${scope === 'all' ? ' selected' : ''}>All projects</option></select></label>`
    + '<button type="button" class="btn link" data-run-reads="open">What the board reads</button></div>';
}
function runsEmptyHtml() {
  const text = 'Ask Claude Code to use a Workflow and the run appears here live. The board never starts or stops these runs.';
  if (scopeNow() === 'all') return `<div class="runs-empty"><p>No Claude Code workflow runs yet. ${text}</p></div>`;
  return `<div class="runs-empty"><p>No Claude Code workflow runs for this project yet. ${text}</p>`
    + '<button type="button" class="btn link" data-run-scope="all">Show all projects</button></div>';
}
function runsListHtml() {
  const err = runsError ? `<p class="run-error" role="status">${esc(runsError)}</p>` : '';
  if (!runsLoaded) return err || '<p class="hint" role="status">Loading runs…</p>';
  if (!S.wf.runs.length) return err + runsEmptyHtml();
  return `${err}<div class="run-cols eyebrow" aria-hidden="true"><span>Status</span><span>Run</span><span>Phases</span><span class="r">Agents</span><span class="r">Tokens</span><span class="r">Time</span></div>`
    + `<ul class="run-list">${S.wf.runs.map((r) => runRowHtml(r)).join('')}</ul>`;
}
// One run of the list. The whole row is one button; its detail opens below the list.
function runRowHtml(run) {
  const st = statusOf(RUN_STATUS, run.status);
  const name = run.title || shortRunId(run.id);
  const phases = Array.isArray(run.phases) ? run.phases.filter(Boolean).join(', ') : '';
  return `<li class="run-item"><button type="button" class="run-row" data-run="${esc(run.id)}" aria-expanded="${S.wf.open === run.id}" aria-controls="runsDetail">`
    + `<span class="run-st">${dotHtml(st)}${esc(st.word)}</span>`
    + `<span class="run-name" title="${esc(name)}">${esc(name)}</span>`
    + `<span class="run-phases">${esc(phases)}</span>`
    + `<span class="run-agents">${esc(`${numOf(run.done)}/${numOf(run.agentCount)} agents`)}</span>`
    + `<span class="run-tok">${esc(fmtTok(run.tokens))}</span>`
    + `<span class="run-dur">${esc(runDuration(run))}</span></button></li>`;
}
function runDetailSlotHtml() {
  const id = S.wf.open; if (!id) return '';
  const run = S.wf.byId[id] ? S.wf.byId[id].run : S.wf.runs.find((r) => r.id === id);
  if (!run) return `<section class="run-detail"><p class="hint" role="status">${esc(detailErr && detailErr.id === id ? detailErr.text : 'Loading run…')}</p></section>`;
  return runDetailHtml(run);
}
function runDetailHtml(run) {
  const rec = S.wf.byId[run.id];
  const st = statusOf(RUN_STATUS, run.status);
  const name = run.title || shortRunId(run.id);
  const started = Number.isFinite(run.startedAt) ? ` · started ${hhmm(run.startedAt)}` : '';
  const failed = numOf(run.failed) ? ` · ${numOf(run.failed)} failed` : '';
  const err = detailErr && detailErr.id === run.id ? `<p class="run-error" role="status">${esc(detailErr.text)}</p>` : '';
  let body;
  if (!rec) body = '<p class="hint" role="status">Loading agents…</p>';
  else if (!rec.agents.length) body = '<p class="hint">No agents recorded yet.</p>';
  else body = agentRowsHtml(rec.agents, { previews: S.wf.previews[run.id] || {}, sandbox: null });
  return '<section class="run-detail" aria-labelledby="runDetailTitle">'
    + `<div class="run-detail-head"><h3 id="runDetailTitle">${esc(name)}</h3>`
    + `<span class="run-detail-meta">${dotHtml(st)}${esc(st.word)}${esc(started)} · ${esc(fmtTok(run.tokens))} tokens${esc(failed)}</span>`
    + `${run.linkedRoomId ? linkedHtml(run.linkedRoomId) : ''}</div>${err}${body}</section>`;
}
// "Linked to <plan title>": opens that room. A room the board no longer lists is named without a link.
function linkedHtml(roomId) {
  const room = S.rooms[roomId] || S.roomIndex[roomId];
  return room
    ? `<p class="run-linked">Linked to <button type="button" class="btn link" data-run-room="${esc(roomId)}">${esc(room.title || 'Workflow')}</button></p>`
    : '<p class="run-linked">Linked to a workflow that is no longer listed.</p>';
}
// Agent rows grouped by phase. Shared with the run card of a Workflow room (U4): sandbox null hides the sandbox column,
// an object maps each agent id to its Codex sandbox policy type. previews maps an agent id to its open Prompt (if any).
function agentRowsHtml(agents, { previews = {}, sandbox = null, prompts = true } = {}) {
  const groups = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a !== 'object') continue;
    const k = typeof a.phase === 'string' ? a.phase : '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return [...groups].map(([phase, rows]) => {
    const done = rows.filter((a) => a.status === 'done').length;
    return `<div class="run-phase-group"><h4 class="run-phase"><span>${esc(phase || 'Agents')}</span><span class="run-phase-n">${done}/${rows.length}</span></h4>`
      + `<ul class="agent-rows">${rows.map((a) => agentRowHtml(a, previews, sandbox, prompts)).join('')}</ul></div>`;
  }).join('');
}
function agentRowHtml(a, previews, sandbox, prompts = true) {
  const label = a.label || a.key || a.id || 'agent';
  const st = statusOf(AGENT_STATUS, a.status);
  const pv = previews && a.id ? previews[a.id] : null;
  const tools = Number.isFinite(a.toolCalls) ? `${a.toolCalls} ${a.toolCalls === 1 ? 'tool' : 'tools'}` : '';
  const last = a.status === 'running' && a.lastTool ? ` · ${esc(a.lastTool)}` : '';
  const sb = sandbox ? `<span class="agent-sb">${esc(sandboxWord(sandbox[a.id]))}</span>` : '';
  const btn = a.id && prompts ? `<button type="button" class="btn sm agent-prompt" data-run-prev="${esc(a.id)}" aria-expanded="${!!pv}" aria-label="Prompt: ${esc(label)}">Prompt</button>` : '';
  return `<li class="agent-row"><div class="agent-line${sandbox ? ' has-sb' : ''}">`
    + `<span class="agent-label" title="${esc(label)}">${esc(label)}</span>`
    + `<span class="agent-model">${esc(a.model || '')}</span>`
    + `<span class="agent-st">${dotHtml(st)}${esc(st.word)}</span>`
    + `<span class="agent-tok">${esc(fmtTok(a.tokens))}</span>`
    + `<span class="agent-tools">${esc(tools)}${last}</span>`
    + `${sb}<span class="agent-dur">${esc(agentDuration(a))}</span>${btn}</div>`
    + `${pv ? previewHtml(pv) : ''}</li>`;
}
// An open Prompt: the text is clipped to 400 characters by the server and escaped here.
function previewHtml(pv) {
  if (pv.loading) return '<div class="run-preview" role="status"><p class="run-preview-t">Loading…</p></div>';
  if (pv.error) return `<div class="run-preview"><p class="run-preview-err">Could not load the preview: ${esc(pv.error)}</p></div>`;
  return '<div class="run-preview"><h5 class="run-preview-h">Prompt</h5>'
    + `<p class="run-preview-t">${esc(pv.prompt || 'No prompt text found.')}</p>`
    + '<h5 class="run-preview-h">Result</h5>'
    + `<p class="run-preview-t">${esc(pv.result || 'No result yet.')}</p></div>`;
}
function runsViewHtml() {
  const why = modeBlock('runs');
  return `<div class="home-scroll"><div class="home mode-home runs-home" data-mode-home="runs" aria-labelledby="runsTitle">${runsHeadHtml(!!why)}`
    + (why ? `<p class="mode-why" role="note">${icon('alert', 14)}<span>${esc(why)}</span></p>`
      : `<div id="runsList">${runsListHtml()}</div><div id="runsDetail">${runDetailSlotHtml()}</div>`)
    + '</div></div>';
}
// Repaints of the parts of the view. Nothing is painted while the view is not on screen; a held pointer defers them.
function paintRunsList() {
  if (!runsShown || deferRender(paintRunsList)) return;
  const list = $('#runsList');
  if (list) keepFocus(list, () => { list.innerHTML = runsListHtml(); });
  const count = $('#runsCount');
  if (count) count.textContent = runsCountText();
}
function paintRunDetail() {
  if (!runsShown || deferRender(paintRunDetail)) return;
  const box = $('#runsDetail');
  if (box) keepFocus(box, () => { box.innerHTML = runDetailSlotHtml(); });
}
// Shows the Runs view. The first show starts the list lease (30 s renewals) and reads the list at once.
function renderRuns() {
  if (deferRender(renderRuns)) return;
  runsShown = true;
  // Polling starts when the view is shown and Claude Code data is there, also when that data appears while the view is open.
  if (runsListT === null && S.watch?.claude === true) {
    runsListT = setInterval(() => { loadRuns(); }, RUN_LIST_MS);
    loadRuns();
  }
  const main = $('#main');
  keepFocus(main, () => { main.innerHTML = runsViewHtml(); });
}
// Leaving Runs (for a room, another mode or home) stops its polling, closes the open run and drops every preview.
function leaveRuns() {
  if (runsListT !== null) { clearInterval(runsListT); runsListT = null; }
  stopDetailTimer();
  runsShown = false; S.wf.open = null; S.wf.previews = {}; detailErr = null;
}
function startDetailTimer() {
  stopDetailTimer();
  runsDetailT = setInterval(() => { if (S.wf.open) loadRun(S.wf.open); }, RUN_DETAIL_MS);
}
function stopDetailTimer() { if (runsDetailT !== null) { clearInterval(runsDetailT); runsDetailT = null; } }
// The list: from GET /api/wf/runs, or from the wfRuns event when the list changes.
async function loadRuns() {
  try {
    const j = await api('/api/wf/runs', undefined, { toast: false });
    setRunsList(Array.isArray(j && j.runs) ? j.runs : []);
  } catch (e) {
    if (e.message === 'unauthorized') return;
    runsError = `Could not read the Claude Code runs: ${e.message}`;
    paintRunsList();
  }
}
function setRunsList(runs) {
  S.wf.runs = runs.filter((r) => r && isRunIdUi(r.id));
  runsLoaded = true; runsError = '';
  paintModeNav(); paintRunsList();
}
function upsertRun(run) {
  const i = S.wf.runs.findIndex((r) => r.id === run.id);
  if (i >= 0) S.wf.runs[i] = run;
  else S.wf.runs.unshift(run);
}
// One run's detail from GET /api/wf/runs/:id (the full agent list).
async function loadRun(runId) {
  if (!isRunIdUi(runId) || readingRuns.has(runId)) return;
  readingRuns.add(runId);
  try {
    const j = await api(`/api/wf/runs/${encodeURIComponent(runId)}`, undefined, { toast: false });
    if (!j || !j.run) return;
    S.wf.byId[runId] = { run: j.run, agents: Array.isArray(j.agents) ? j.agents : [] };
    upsertRun(j.run);
    if (detailErr && detailErr.id === runId) detailErr = null;
    paintRunsList(); paintModeNav(); paintRunDetail();
  } catch (e) {
    if (e.message === 'unauthorized') return;
    if (S.wf.open === runId) {
      detailErr = { id: runId, text: e.status === 404 ? 'That run is no longer listed.' : `Could not read the run: ${e.message}` };
      paintRunDetail();
    }
  } finally { readingRuns.delete(runId); }
}
// Merges changed agents into a full agent list by id (the order of the list is kept, new agents go last).
function mergeAgents(list, changed) {
  const out = list.slice();
  const at = new Map(out.map((a, i) => [a.id, i]));
  for (const a of changed) {
    if (at.has(a.id)) out[at.get(a.id)] = a;
    else { at.set(a.id, out.length); out.push(a); }
  }
  return out;
}
// wfRun: one run's summary and its changed agents (at most every 500 ms per run). A delta can only be merged into a
// detail that was read in full, so a run without one is read again instead, and so is a delta without agent ids.
function applyRunDelta(ev) {
  const run = ev && ev.run;
  if (!run || !isRunIdUi(run.id)) return;
  const changed = (Array.isArray(ev.agents) ? ev.agents : []).filter((a) => a && typeof a === 'object');
  const rec = S.wf.byId[run.id];
  upsertRun(run);
  if (!rec || changed.some((a) => !a.id)) loadRun(run.id);
  else S.wf.byId[run.id] = { run, agents: mergeAgents(rec.agents, changed) };
  paintRunsList(); paintRunDetail(); paintModeNav();
}
function openRunDetail(runId) {
  if (!isRunIdUi(runId)) return;
  if (S.wf.open !== runId) S.wf.previews = {}; // a Prompt belongs to the run it was opened in
  S.wf.open = runId; detailErr = null;
  startDetailTimer();
  loadRun(runId);
  paintRunsList(); paintRunDetail();
  const box = $('#runsDetail');
  if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
}
function closeRunDetail() {
  S.wf.open = null; S.wf.previews = {}; detailErr = null; stopDetailTimer();
  paintRunsList(); paintRunDetail();
}
// Prompt: the first press reads that agent's prompt and result, the next press closes it and drops the text.
async function togglePreview(runId, agentId) {
  if (!isRunIdUi(runId) || !isAgentIdUi(agentId)) return;
  const per = S.wf.previews[runId] || (S.wf.previews[runId] = {});
  if (per[agentId]) {
    delete per[agentId];
    if (!Object.keys(per).length) delete S.wf.previews[runId];
    paintRunDetail();
    return;
  }
  const seq = ++previewSeq;
  per[agentId] = { seq, loading: true, error: '', prompt: '', result: '' };
  paintRunDetail();
  try {
    const p = await api(`/api/wf/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/preview`, undefined, { toast: false });
    const cur = S.wf.previews[runId] && S.wf.previews[runId][agentId];
    if (cur && cur.seq === seq) {
      S.wf.previews[runId][agentId] = { seq, loading: false, error: '', prompt: String((p && p.prompt) || ''), result: String((p && p.result) || '') };
      paintRunDetail();
    }
  } catch (e) {
    if (e.message === 'unauthorized') return;
    const cur = S.wf.previews[runId] && S.wf.previews[runId][agentId];
    if (cur && cur.seq === seq) {
      S.wf.previews[runId][agentId] = { seq, loading: false, error: e.message || 'request failed', prompt: '', result: '' };
      paintRunDetail();
    }
  }
}
// Scope: saved through POST /api/settings. The server applies it on its next discovery pass (within 15 s).
async function setWatchScope(scope) {
  if ((scope !== 'project' && scope !== 'all') || scope === scopeNow()) return;
  try {
    const saved = await api('/api/settings', { watchScope: scope }, { toast: false });
    S.settings = saved && typeof saved === 'object' ? saved : { ...S.settings, watchScope: scope };
  } catch (e) {
    if (e.message === 'unauthorized') return;
    toast(`Could not change the scope: ${e.message}`);
    if (runsShown) renderRuns(); // puts the select back on the saved scope
    return;
  }
  if (runsShown) renderRuns();
  await loadRuns();
}
// "What the board reads" (plan 4.1 and 4.6): the four kinds of files, and what is never kept.
function runsReadsBody() {
  return '<p>The board reads Claude Code\'s own files under your Claude Code folder (<code class="inline">CLAUDE_CONFIG_DIR</code>, or <code class="inline">~/.claude</code>). It writes nothing and opens no other file.</p>'
    + '<ol class="plain">'
    + '<li><b>Session transcripts</b>: the working directory (cwd) of each session, read once, to match the session with this project.</li>'
    + '<li><b>Workflow journals</b>: the start and the result of each agent, with its key, label and phase. A result is counted by its size and shape only.</li>'
    + '<li><b>Agent files</b>: each agent\'s description, phase, model and start time, and while it runs its usage, tool names and timestamps.</li>'
    + '<li><b>Workflow summaries</b>: the run\'s name, status, times, agent count, phase titles and token total.</li>'
    + '</ol>'
    + '<p>Never kept: prompts, results, logs, arguments, errors and attachments. A Prompt loads when you press it and is dropped when you close it or leave Runs.</p>'
    + '<p class="hint">Claude Code\'s file formats are not documented and can change with any update, so Runs is experimental. Fields the board does not know are ignored.</p>';
}
function openRunsReads() {
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">${icon('lock')}What the board reads</h2>${closeBtn()}</div>
    <div class="modal-b">${runsReadsBody()}</div>
    <div class="modal-f"><button class="btn" data-close>Close</button></div>`, 'modal sm');
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
}
// One delegated handler for the Runs view: rows, Prompt buttons, linked rooms, the scope link and the reads dialog.
function onRunsClick(e) {
  if (!runsShown) return;
  const t = e && e.target;
  if (!t || typeof t.closest !== 'function') return;
  const d = (t.closest('[data-run],[data-run-prev],[data-run-room],[data-run-scope],[data-run-reads]') || {}).dataset;
  if (!d) return;
  if (d.run) { if (S.wf.open === d.run) closeRunDetail(); else openRunDetail(d.run); }
  else if (d.runPrev !== undefined) { if (S.wf.open) togglePreview(S.wf.open, d.runPrev); }
  else if (d.runRoom) openRoom(d.runRoom);
  else if (d.runScope) setWatchScope(d.runScope);
  else if (d.runReads !== undefined) openRunsReads();
}
function onRunsChange(e) {
  const t = e && e.target;
  if (runsShown && t && t.id === 'runsScope') setWatchScope(t.value);
}
document.addEventListener('click', onRunsClick);
document.addEventListener('change', onRunsChange);

/* ---------- Ask: model picker ---------- */
const VENDOR = { claude: 'Anthropic', codex: 'OpenAI' };
// Picker rows (plan 2.2): one per seat on its own model, then one "override" row per other model of that CLI on its
// first free seat. A missing CLI is hidden; a broken one is shown disabled with its reason; a warn one gets a badge.
function seatChoices() {
  const seats = S.order.map((id) => S.seats[id]).filter(Boolean), out = [];
  for (const agent of AGENTS) {
    const st = cliState(agent); if (st === 'missing') continue;
    const mine = seats.filter((s) => s.agent === agent); if (!mine.length) continue;
    const disabled = st === 'broken', reason = disabled ? cliReason(agent) : '', warn = st === 'warn' ? cliReason(agent) : '';
    const row = (s, model, override) => ({ key: `${s.id}|${model}`, seatId: s.id, seatName: s.name, agent, vendor: VENDOR[agent], model, override,
      busy: s.status === 'working', disabled, reason, warn });
    for (const s of mine) out.push(row(s, s.model || '', false));
    const covered = new Set(mine.map((s) => s.model || ''));
    const host = mine.find((s) => s.status !== 'working') || mine[0];
    for (const model of S.models[agent] || []) if (model && !covered.has(model)) { covered.add(model); out.push(row(host, model, true)); }
  }
  return out;
}
const askPicks = {}; // room id -> the pick for that conversation (switching the model is per conversation)
function storedPick() { try { const p = JSON.parse(ls.get('ob.ask.pick') || 'null'); return p && typeof p === 'object' ? p : null; } catch { return null; } }
function savePick(roomId, pick) {
  const p = { seatId: pick.seatId, model: pick.model || '', effort: pick.effort || '' };
  if (roomId) askPicks[roomId] = p;
  ls.set('ob.ask.pick', JSON.stringify(p));
}
// The pick in use: the conversation's own, else the remembered one, matched against the rows. A pick that is gone or
// disabled falls back to the first enabled row that is not busy, then to any enabled row.
function currentPick(room, choices = seatChoices()) {
  const want = room ? (askPicks[room.id] || { seatId: room.seatId, model: room.overrides?.[room.seatId]?.model || S.seats[room.seatId]?.model || '' }) : storedPick();
  const ok = choices.filter((c) => !c.disabled);
  const hit = want && ok.find((c) => c.seatId === want.seatId && c.model === (want.model || S.seats[want.seatId]?.model || ''));
  const c = hit || ok.find((x) => !x.busy) || ok[0] || null;
  return c ? { ...c, effort: hit && want.effort ? want.effort : '' } : null;
}
const isHaikuModel = (m) => /haiku/i.test(String(m || ''));
function askPickerHtml(room) {
  const choices = seatChoices(), cur = currentPick(room, choices);
  const hidden = AGENTS.filter((a) => cliState(a) === 'missing' && Object.values(S.seats).some((s) => s.agent === a));
  const hiddenTxt = hidden.length ? `<p class="hint pick-hidden">${hidden.map((a) => `${esc(TOOL[a])} is not installed, so its models are hidden.`).join(' ')}</p>` : '';
  if (!choices.length) return `<p class="hint pick-none">No model can be picked: ${S.order.length ? 'no agent runs on an installed CLI' : 'add an agent first'}.</p>${hiddenTxt}`;
  const rows = choices.map((c) => {
    const on = cur && c.key === cur.key;
    const badges = `${c.busy ? '<span class="pr-badge" title="Ask turns queue behind other work on this seat and count toward its budget">busy</span>' : ''}${c.warn ? '<span class="pr-badge warn">Check setup</span>' : ''}`;
    return `<div class="pick-item"><button type="button" class="pick-row ${on ? 'on' : ''}" role="radio" aria-checked="${!!on}" data-ask-pick="${esc(c.key)}" ${c.disabled ? 'disabled' : ''}>`
      + `<span class="pr-model">${esc(c.model || 'default model')}</span><span class="pr-vendor">${esc(c.vendor)}</span>`
      + `<span class="pr-seat">seat ${esc(c.seatName)}${c.override ? ' (override)' : ''}</span>${badges}</button>`
      + `${c.disabled ? `<p class="pr-why">${esc(c.reason)} <button type="button" class="btn link" data-ask-fix>Fix</button></p>` : ''}</div>`;
  }).join('');
  const efforts = cur ? S.efforts[cur.agent] || [] : [], noEffort = !cur || isHaikuModel(cur.model);
  const summary = cur ? `${esc(cur.model || 'default model')} · ${esc(cur.vendor)} · ${esc(cur.seatName)}` : 'Pick a model';
  return `<details class="ask-pick"><summary aria-label="Model: ${cur ? esc(`${cur.model || 'default model'}, ${cur.vendor}, seat ${cur.seatName}`) : 'none picked'}">${summary}</summary>
      <div class="ask-pick-pop"><div class="label" id="${room ? 'askPickL-' + esc(room.id) : 'askPickL'}">Pick a model</div>
      <div class="pick-rows" role="radiogroup" aria-labelledby="${room ? 'askPickL-' + esc(room.id) : 'askPickL'}">${rows}</div>${hiddenTxt}</div></details>
    <select class="input ask-effort" data-ask-effort aria-label="Effort" ${noEffort ? 'disabled title="Haiku takes no effort setting"' : ''}>
      <option value="">Seat effort</option>${efforts.map((e) => `<option value="${esc(e)}" ${cur?.effort === e ? 'selected' : ''}>${esc(EFFORT[e] || e)}</option>`).join('')}</select>`;
}
// Wires a picker slot: a row click sets the pick (for the room, or the remembered one on the Ask home) and repaints it.
function bindAskPicker(slot, room) {
  if (!slot) return;
  const paint = () => { keepFocus(slot, () => { slot.innerHTML = askPickerHtml(room); bindAskPicker(slot, room); }); };
  $$('[data-ask-pick]', slot).forEach((b) => b.onclick = () => {
    const c = seatChoices().find((x) => x.key === b.dataset.askPick); if (!c || c.disabled) return;
    savePick(room?.id, { seatId: c.seatId, model: c.model, effort: '' });
    paint();
  });
  $$('[data-ask-fix]', slot).forEach((b) => b.onclick = () => { S.setupOpen = true; goHome(); runDoctor(); });
  const eff = $('[data-ask-effort]', slot);
  if (eff) eff.onchange = () => { const cur = currentPick(room); if (cur) savePick(room?.id, { ...cur, effort: eff.value }); };
}
// POST /api/ask. roomId null starts a conversation. The model is sent only when it differs from the seat's own.
// Returns the room id; a refused request throws (the api() toast says why).
async function sendAsk(roomId, text, pick) {
  const msg = String(text || '').trim();
  if (!msg) { toast('Write a message first'); return null; }
  const s = pick && S.seats[pick.seatId];
  if (!s) { toast('Pick a model first'); return null; }
  const body = { seatId: s.id, text: msg };
  if (roomId) body.roomId = roomId;
  if (pick.model && pick.model !== s.model) body.model = pick.model;
  if (pick.effort && !isHaikuModel(pick.model || s.model)) body.effort = pick.effort;
  const j = await api('/api/ask', body);
  savePick(roomId || j?.roomId, pick);
  return j?.roomId || roomId || null;
}

/* ================= main: room ================= */
// Full build of the room view. Runs only when the active room changes (openRoom) or the view is missing.
function renderRoom() {
  const r = S.rooms[S.active];
  if (!r) { $('#main').innerHTML = `<div class="empty" role="status">${S.roomIndex[S.active] ? 'Loading session…' : 'Starting session…'}</div>`; return; }
  $('#main').innerHTML = `<div class="main-head"></div><div class="plan-slot" id="planCard" hidden></div><div class="build-slot" id="buildCard" hidden></div><div class="run-slot" id="runCard" hidden></div><div class="resultbar" id="resultBar" hidden></div>
    <div class="transcript" id="feed" role="region" aria-label="Transcript" tabindex="-1"><div class="thread" id="feedInner"></div></div>
    <div class="composer-wrap" id="composerArea"></div>`;
  // A running session opens at the latest turn (to follow it); a finished one opens at the top (the result bar jumps).
  const f = $('#feed'); pinned = r.status === 'running';
  f.addEventListener('scroll', () => { pinned = nearBottom(f); }, { passive: true });
  renderRoomHead(); renderResultBar(); renderComposer();
  r.messages.forEach((m) => paintMsg(m, false));
  if (!r.messages.length && r.kind !== 'run') $('#feedInner').innerHTML = '<div class="thread-empty">No messages yet.</div>';
  decorate();
  f.scrollTop = pinned ? f.scrollHeight : 0;
}
// Auto-follow: the transcript follows new output only while the reader is at its bottom. The flag is set by the reader's
// own scrolling, never measured after new content has already grown the feed (that measure drifts past the threshold).
let pinned = false;
const nearBottom = (f) => f.scrollHeight - f.scrollTop - f.clientHeight < 140;
function follow() { const f = $('#feed'); if (f && pinned) f.scrollTop = f.scrollHeight; }
// Elapsed time: ticking while running, else first message to the last finished turn.
function roomEnd(r) { let end = 0; for (const m of r.messages) { const t = new Date(m.ended || m.ts).getTime(); if (t > end) end = t; } return end || new Date(r.created).getTime(); }
// Repaints only the header: title, status, mode, round, elapsed, Stop, Export, Delete.
function renderRoomHead() {
  if (deferRender(renderRoomHead)) return;
  keepFocus($('#main .main-head'), paintRoomHead);
}
function paintRoomHead() {
  const r = S.rooms[S.active], h = $('#main .main-head'); if (!r || !h) return;
  const total = r.kind === 'meeting' ? r.rounds : r.kind === 'chain' ? r.maxRounds : null;
  const live = r.status === 'running', dm = r.kind === 'dm' || r.kind === 'ask';
  // The current round only while running; a finished session's rounds are in the transcript and the workflow panel.
  const roundTxt = !live || !total ? '' : typeof r.round === 'number' && r.round > 0 ? `${roundLabel(r.round)} of ${total}` : roundLabel(r.round);
  const ready = dm && !live && r.status !== 'error';
  const status = dm ? (live ? statusHtml('running', 'Replying') : ready ? statusHtml('idle', 'Ready') : statusHtml(r.status)) : statusHtml(r.status);
  const sep = '<span class="sep" aria-hidden="true">·</span>';
  const elapsed = live ? `<span class="num" title="Started ${esc(hhmm(r.created))}" data-since="${esc(r.created)}">${fmtDur(Date.now() - new Date(r.created))}</span>`
    : r.messages.length ? `<span class="num" title="Started ${esc(hhmm(r.created))}">${fmtDur(roomEnd(r) - new Date(r.created))}</span>` : '';
  h.innerHTML = `<h1 title="${esc(r.topic || r.task || r.title)}">${esc(r.title)}</h1>
    <div class="mh-meta"><span role="status">${status}</span>${sep}<span class="mode">${icon(kindIcon(r.kind), 12)}${KIND[r.kind] || esc(r.kind)}</span>${roundTxt ? `${sep}<span>${esc(roundTxt)}</span>` : ''}${elapsed ? sep + elapsed : ''}${r.kind === 'plan' ? stepperHtml(r) : ''}</div>
    <div class="mh-actions">
      ${r.kind === 'dm' && S.seats[r.seatId] ? '<button class="btn" id="dmToAsk" title="Start an Ask conversation on this agent\'s model">Continue in a new chat</button>' : ''}
      ${r.kind === 'build' && r.status === 'running' ? '<button class="btn" id="pauseBuild" title="Pause the build; resume continues with the next item">Pause</button>' : ''}
      ${r.kind === 'build' && buildResumable(r) ? '<button class="btn primary" id="resumeBuild" title="Continue the build with the next item">Resume</button>' : ''}
      ${live && r.kind !== 'run' ? `<button class="btn danger" id="stopRoom" title="Stop the run and kill the running CLI">${icon('stop', 12)}Stop</button>` : ''}
      ${r.messages.length ? `<button class="icon-btn" id="exportRoom" title="Export transcript (.md)" aria-label="Export transcript as Markdown">${icon('download')}</button>` : ''}
      <button class="icon-btn danger" id="delRoom" title="Delete session" aria-label="Delete session">${icon('trash')}</button>
    </div>`;
  $('#dmToAsk') && ($('#dmToAsk').onclick = () => { const s = S.seats[r.seatId]; if (s) savePick(null, { seatId: s.id, model: s.model || '', effort: '' }); setMode('ask'); $('#askText')?.focus(); });
  $('#stopRoom') && ($('#stopRoom').onclick = () => api(`/api/rooms/${r.id}/stop`, {}).catch(() => {}));
  $('#pauseBuild') && ($('#pauseBuild').onclick = () => api(`/api/build/${r.id}/pause`, {}).catch(() => {}));
  $('#resumeBuild') && ($('#resumeBuild').onclick = () => resumeBuild(r.id));
  $('#exportRoom') && ($('#exportRoom').onclick = () => exportTranscript(r));
  $('#delRoom').onclick = () => { if (confirm('Delete this session and its transcript?')) api(`/api/rooms/${r.id}/delete`, {}).catch(() => {}); };
}
// Result summary for a finished Debate / Propose → Review: where the synthesis or verdict is, and what to do next.
function resultInfo(r) {
  if (!r || r.kind === 'dm' || r.kind === 'ask' || r.kind === 'plan' || r.kind === 'build' || r.kind === 'run' || r.status === 'running') return null;
  const res = (r.resultId && r.messages.find((m) => m.id === r.resultId)) || null;
  const name = (id) => S.seats[id]?.name || id;
  let title, sub;
  if (r.status === 'stopped') { title = 'Stopped'; sub = res ? 'Stopped after a result was written.' : 'The session was stopped before it produced a result.'; }
  else if (r.status === 'error') { title = 'Failed'; sub = 'The session hit an error: see the last line of the transcript.'; }
  else if (r.kind === 'meeting') {
    if (res) { title = 'Synthesis ready'; sub = `Written by ${esc(res.name)} and saved to .orchestra/BRAINSTORM.md.`; }
    else if (r.synthId) { title = 'Debate finished'; sub = `The synthesis turn by ${esc(name(r.synthId))} did not complete; the discussion is still in the transcript.`; }
    else { title = 'Debate finished'; sub = 'No facilitator was set, so there is no synthesis. Export the transcript, or run again with a facilitator.'; }
  } else {
    const rev = esc(name(r.reviewerId)), bld = esc(name(r.builderId));
    const failed = [...r.messages].reverse().find((m) => isAgentMsg(m) && m.error);
    if (r.status === 'passed') { title = `Passed review${typeof res?.round === 'number' ? ` in round ${res.round}` : ''}`; sub = `${rev} approved ${bld}'s proposal. The verdict is the result.`; }
    else if (failed && !res) { title = 'Needs your decision'; sub = `${esc(failed.name)}'s turn failed: ${esc(failed.error)}`; }
    else { title = 'Needs your decision'; sub = `Round limit reached without a PASS from ${rev}. Read the last review, then run again or continue in Direct chat.`; }
  }
  return { res, title, sub };
}
function renderResultBar() {
  renderPlanCard(); renderBuildCard(); renderRunCard();
  const r = S.rooms[S.active], el = $('#resultBar'); if (!el) return;
  const info = resultInfo(r);
  if (!info) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false; el.className = `resultbar ${r.status}`; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Result');
  const ic = r.status === 'passed' || r.status === 'done' ? 'check' : r.status === 'stopped' ? 'stop' : 'alert';
  // A finished council can become a workflow (U4, plan 2.3): the plan starts from its synthesis and skips the debate.
  const wf = r.kind === 'meeting' && r.status === 'done' ? `<button class="btn" id="rbWorkflow">${icon('review', 14)}Turn into Workflow</button>` : '';
  el.innerHTML = `<span class="rb-ic">${icon(ic, 14)}</span><div class="rb-t"><b>${info.title}</b><span>${info.sub}</span></div>
    ${info.res || wf ? `<div class="rb-a">${info.res ? `<button class="btn" id="rbJump">${icon('target', 14)}Jump to ${r.kind === 'chain' ? 'verdict' : 'synthesis'}</button><button class="btn" id="rbCopy">${icon('copy', 14)}Copy as Markdown</button>` : ''}${wf}</div>` : ''}`;
  $('#rbJump') && ($('#rbJump').onclick = () => jumpTo(info.res.id));
  $('#rbCopy') && ($('#rbCopy').onclick = () => copyText(resultMd(r, info.res), 'Result copied as Markdown'));
  $('#rbWorkflow') && ($('#rbWorkflow').onclick = () => turnIntoWorkflow(r));
}
/* ---------- plan card: the plan of a Plan → Build session, and its approval (the server enforces every rule) ---------- */
const PLAN_ACTIVE = ['awaiting-approval', 'approved', 'rejected'];
const PLAN_PREFLIGHT = ['awaiting-approval', 'approved']; // the plan card shows "Before you build" while these hold (U3)
function renderPlanCard() {
  const el = $('#planCard'); if (!el) return;
  const r = S.rooms[S.active];
  if (!r || r.kind !== 'plan' || !r.plan) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (PLAN_PREFLIGHT.includes(r.status)) loadPreflight(r); // the checkout is read for the card; the card repaints when it arrives
  keepFocus(el, () => { el.innerHTML = planCardHtml(r); bindPlanCard(el, r); });
}
function planCardHtml(r) {
  const p = r.plan, st = r.status;
  const note = r.approval?.note ? `<p class="hint plan-note">Note: ${esc(r.approval.note)}</p>` : '';
  const acts = [];
  if (PLAN_ACTIVE.includes(st)) acts.push(`<button class="btn ${st === 'awaiting-approval' ? 'primary' : ''}" id="plApprove">${icon('check', 14)}Approve</button>`,
    '<button class="btn" id="plEdit">Edit</button>', `<button class="btn danger" id="plReject">${icon('x', 14)}Reject</button>`);
  if (st === 'approved') acts.push(`<button class="btn primary" id="plBuild">${icon('review', 14)}Start build</button>`);
  return `<section class="plan-card" aria-labelledby="planH">
    <header class="plan-h"><h2 id="planH">Revision ${esc(r.planRevision)} · <code class="inline">${esc(shortHash(r.planHash))}</code></h2>${statusHtml(st)}</header>
    ${p.goal ? `<p class="plan-goal">${esc(p.goal)}</p>` : ''}
    ${planTableHtml(p)}${planChecksHtml(p)}${PLAN_PREFLIGHT.includes(st) ? preflightBlockHtml(r) : ''}${note}
    ${acts.length ? `<div class="plan-f">${acts.join('')}</div>` : ''}
  </section>`;
}
function bindPlanCard(el, r) {
  const id = r.id, rev = r.planRevision, hash = r.planHash;
  const on = (sel, fn) => { const b = $(sel, el); if (b) b.onclick = fn; };
  const approve = async () => { const j = await planAct(`/api/plan/${id}/approve`, { revision: rev, hash }); if (j) toast('Plan approved'); };
  // A plan with live checks is approved only after the owner has seen every command and confirmed.
  on('#plApprove', () => (planChecksOf(r.plan, 'checks').length ? confirmChecks(r.plan, { title: 'Approve plan with checks', verb: 'Approve and allow checks', go: approve }) : approve()));
  on('#plChecksOn', () => {
    const next = planWithChecksOn(r.plan);
    confirmChecks(next, { title: 'Turn on acceptance checks', verb: 'Turn on checks', go: async () => { if (await planAct(`/api/plan/${id}/edit`, { revision: rev, hash, plan: next })) toast('Checks are on. Approve the new revision to build'); } });
  });
  on('#plEdit', () => openPlanEdit(r));
  on('#plReject', () => openPlanReject(r));
  on('#plBuild', () => openBuild(r));
}
// A plan action. A 409 'stale' means the plan changed under the user: say so, and re-read the session.
async function planAct(path, body) {
  try { return await api(path, body, { toast: false }); }
  catch (e) {
    if (e.code === 'stale') { toast('The plan changed. Reload and review it again.'); load().catch(() => {}); }
    else if (e.message !== 'unauthorized') toast(e.message);
    return null;
  }
}
function openPlanEdit(r) {
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">Edit plan</h2>${closeBtn()}</div>
    <div class="modal-b"><p class="hint">The plan as JSON. Saving changes it and clears its approval, so it must be approved again before a build can start.</p>
      <label class="label" for="planJson">Plan (JSON)</label>
      <textarea class="input" id="planJson" rows="20" spellcheck="false" style="font-family:var(--font-mono);font-size:12px">${esc(JSON.stringify(r.plan, null, 2))}</textarea></div>
    <div class="modal-f"><button class="btn" data-close>Cancel</button><button class="btn" id="plSave">Save</button><button class="btn primary" id="plSaveApprove">Save and approve</button></div>`, 'modal');
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  const parse = () => { try { return JSON.parse(box.querySelector('#planJson').value); } catch (e) { toast(`Invalid JSON: ${e.message}`); return undefined; } };
  const base = { revision: r.planRevision, hash: r.planHash };
  box.querySelector('#plSave').onclick = async () => {
    const plan = parse(); if (plan === undefined) return;
    if (await planAct(`/api/plan/${r.id}/edit`, { ...base, plan })) { closeOverlay(); toast('Plan saved. Approve it again to start a build'); }
  };
  box.querySelector('#plSaveApprove').onclick = async () => {
    const plan = parse(); if (plan === undefined) return;
    const go = async () => { if (await planAct(`/api/plan/${r.id}/approve`, { ...base, plan })) { closeOverlay(); toast('Plan saved and approved'); } };
    if (planChecksOf(plan, 'checks').length) confirmChecks(plan, { title: 'Approve plan with checks', verb: 'Approve and allow checks', go });
    else await go();
  };
}
function openPlanReject(r) {
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">Reject plan</h2>${closeBtn()}</div>
    <div class="modal-b"><label class="label" for="rjNote">Note (optional)</label><textarea class="input" id="rjNote" placeholder="What should change?"></textarea></div>
    <div class="modal-f"><button class="btn" data-close>Cancel</button><button class="btn danger" id="rjGo">Reject plan</button></div>`, 'modal sm');
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  box.querySelector('#rjGo').onclick = async () => {
    const note = box.querySelector('#rjNote').value.trim();
    if (await planAct(`/api/plan/${r.id}/reject`, { revision: r.planRevision, hash: r.planHash, ...(note ? { note } : {}) })) { closeOverlay(); toast('Plan rejected'); }
  };
}
// Start build: one role select per tier; an empty select uses the fallback chain (previewed live, resolved by the server).
const BUILD_ROLES = [['manager', 'Manager', 'bManager'], ['hard', 'Hard', 'bHard'], ['medium', 'Medium', 'bMedium'], ['easy', 'Easy', 'bEasy'], ['reviewer', 'Reviewer', 'bReviewer']];
// Start build (U3, plan 2.4 and 3.3): who builds it, the board team's options, the handoff form and the Codex reason. The
// dialog keeps one draft of every choice, so switching the engine keeps what was set. A written handoff replaces the form
// with its paste prompt.
// Engine labels as the Workflow mode names them (plan 2.4). The server's EngineInfo carries the same words.
const ENGINE_LABEL = { board: 'Board team', 'claude-code': 'Claude Code, you run it', codex: 'Codex, you run it' };
const ENGINE_ORDER = ['board', 'claude-code', 'codex'];
const HANDOFF_NAME = { 'claude-code': 'Claude Code', codex: 'Codex' };
// Suggested models per difficulty for a handoff: the server's defaults (src/engines/handoff.js). The form sends its values
// with the handoff, so the file says what the form showed.
const HANDOFF_TIERS = {
  'claude-code': { easy: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', hard: 'claude-opus-5-5' },
  codex: { easy: 'gpt-6-luna', medium: 'gpt-6-luna', hard: 'gpt-6.1-sol' },
};
const TIER_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const BUILD_MODES = [
  ['auto', 'Automatic: edit files when they are available, else propose'],
  ['write', 'Write: edit in per-item worktrees'],
  ['propose', 'Propose: no file edits, each passing item exports a patch'],
];
let buildDlg = null; // the open Start build dialog: { box, room, draft }; repainted when the engine list changes

// The engines the dialog offers, in plan order: the server's EngineInfo for each one that is not hidden (plan 2.6). Before
// the first snapshot there is no list, so the board team is offered alone.
function engineList() {
  if (!Array.isArray(S.engines)) return [{ id: 'board', available: true, hidden: false, reason: null, note: null, modes: null }];
  return ENGINE_ORDER.map((id) => S.engines.find((e) => e && e.id === id)).filter((e) => e && !e.hidden);
}
// The engine a new dialog starts on: the board team when it can run (plan 2.4), else the first engine that can.
function defaultEngine(list) {
  const on = (list || []).find((e) => e.available !== false);
  return on ? on.id : 'board';
}
// The seat a role builds with: its own choice, else the first seat of its fallback chain. A preview only; the server decides.
const seatFor = (roles, role) => roles[role] || (ROLE_FALLBACK[role] || []).map((x) => roles[x]).find(Boolean) || null;
// "Codex file edits are off ..." as a sentence. The gate's reason begins "off" when it says why; other text is quoted after a colon.
function codexOffText(reason) {
  const t = String(reason || '').trim();
  if (!t) return 'Codex file edits are off.';
  return /^off\b/i.test(t) ? `Codex file edits are ${t}` : `Codex file edits are off: ${t}`;
}
// The Codex state as text: still checking, available, or off with the gate's reason (plan 5.10).
function codexStateText() {
  if (!S.capability) return 'Checking whether Codex file edits are available.';
  const c = S.capability.agents?.codex;
  return c?.available === true ? 'Codex file edits are available.' : codexOffText(c?.reason);
}

// "Who builds it?" (plan 2.4). Hidden engines are not offered. One that cannot run is disabled, and its reason is shown as
// text under the choice (plan 2.6), not only in a tooltip. locked: a handoff is written, so no other engine can be picked.
function engineSegHtml(engines, cur, locked = false) {
  const list = (Array.isArray(engines) ? engines : []).filter((e) => e && typeof e.id === 'string' && !e.hidden);
  if (!list.length) {
    // Nothing is offered: the board team's reason says why (it is read from the server's list, hidden or not).
    const board = (Array.isArray(S.engines) ? S.engines : []).find((e) => e && e.id === 'board');
    return `<p class="pr-why engine-why" role="note">${esc(board?.reason || 'No build engine can run here.')}</p>`;
  }
  const btns = list.map((e) => {
    const on = e.id === cur, off = locked || e.available === false;
    return `<button type="button" role="radio" aria-checked="${on}" data-engine="${esc(e.id)}" class="${on ? 'on' : ''}"${off ? ' disabled' : ''}>${esc(ENGINE_LABEL[e.id] || e.label || e.id)}</button>`;
  }).join('');
  const why = list.filter((e) => e.available === false && e.reason)
    .map((e) => `<p class="pr-why engine-why">${esc(ENGINE_LABEL[e.id] || e.label || e.id)} is unavailable: ${esc(e.reason)}</p>`).join('');
  return `<div class="seg engine-seg" id="engineSeg" role="radiogroup" aria-labelledby="whoL">${btns}</div>${why}`;
}
// The board team's Recommended summary (plan 2.4): who manages and builds, who reviews, how edits happen. Names follow the
// roles as the form shows them (an empty role uses the fallback). A Codex builder gets the Codex reason as text.
function boardSummaryInner(draft) {
  const at = (role) => seatFor(draft.roles, role);
  const who = (role) => (S.seats[at(role)] ? S.seats[at(role)].name : 'no seat yet');
  const team = `Manager: ${who('manager')}. Builders by difficulty: easy ${who('easy')}, medium ${who('medium')}, hard ${who('hard')}. Reviewer: ${who('reviewer')}.`;
  const edits = draft.mode === 'propose' ? 'This build only proposes: each passing item exports a patch file, and no file is edited.'
    : draft.mode === 'write' ? 'Edits happen in per-item worktrees, and you apply each item.'
      : 'Edits happen in per-item worktrees, and you apply each item. If file edits are unavailable, the build only proposes.';
  const codex = ['easy', 'medium', 'hard'].some((role) => S.seats[at(role)]?.agent === 'codex');
  return `<b>Board team (recommended)</b><p>${esc(team)} ${esc(edits)}</p>`
    + (codex ? `<p>Codex builders read only and return a diff. ${esc(codexStateText())}</p>` : '');
}
// Who builds what, one line per role. The server resolves the fallback; this shows the same rule.
function teamPreviewHtml(draft) {
  const name = (id) => (S.seats[id] ? S.seats[id].name : id);
  return BUILD_ROLES.map(([role]) => {
    if (draft.roles[role]) return `<div>${esc(role)} → ${esc(name(draft.roles[role]))}</div>`;
    const via = ROLE_FALLBACK[role].find((x) => draft.roles[x]);
    return `<div>${via ? `${esc(role)} → ${esc(name(draft.roles[via]))} (via ${esc(via)})` : `${esc(role)} → no seat yet`}</div>`;
  }).join('');
}
// The board team's panel: the Recommended summary, and the options under Advanced (roles, rounds, escalation and mode).
function boardPanelHtml(draft, list) {
  const rows = BUILD_ROLES.map(([role, label, id]) => `<div><label class="label" for="${id}">${label}</label>`
    + `<select class="input" id="${id}" data-role="${role}">${roleOptionsHtml(role, draft.roles[role] || '')}</select></div>`).join('');
  const board = list.find((e) => e.id === 'board') || {};
  const writeOk = !Array.isArray(board.modes) || board.modes.includes('write');
  const modes = BUILD_MODES.map(([v, t]) => `<option value="${v}"${draft.mode === v ? ' selected' : ''}${v === 'write' && !writeOk ? ' disabled' : ''}>${esc(t)}</option>`).join('');
  const rounds = [1, 2, 3, 4].map((n) => `<option${n === draft.maxRounds ? ' selected' : ''}>${n}</option>`).join('');
  return `<div class="build-board">
    <div class="build-rec" id="buildRec">${boardSummaryInner(draft)}</div>
    <details class="adv build-adv" id="buildAdv"${draft.adv ? ' open' : ''}><summary>Advanced: roles, rounds, escalate, mode</summary>
      <p class="hint">Each item goes to the seat for its difficulty. A role without a seat falls back to the next one in its chain.</p>
      <div class="grid2">${rows}</div>
      <div class="hint" id="bPreview" role="status" aria-label="Who builds what">${teamPreviewHtml(draft)}</div>
      <div class="grid2">
        <div><label class="label" for="bMax">Max rounds</label><select class="input" id="bMax">${rounds}</select></div>
        <div><label class="check-l"><input type="checkbox" id="bEsc"${draft.escalate ? ' checked' : ''}> Escalate after a FAIL</label></div>
      </div>
      <div><label class="label" for="bMode">Mode</label><select class="input" id="bMode">${modes}</select></div>
      <p class="hint" id="bCapNote" role="status">${esc(buildCapNote())}</p>
    </details>
  </div>`;
}
// The handoff form (plan 2.4, 3.3): what the handoff means, the suggested models (written into the handoff, not enforced) and
// the engine's own note. tiers: the models the form shows (the defaults until the user changes them).
function handoffFormHtml(planRoom, engine, tiers = HANDOFF_TIERS[engine] || {}) {
  const name = HANDOFF_NAME[engine] || engine;
  const info = (Array.isArray(S.engines) ? S.engines : []).find((e) => e && e.id === engine);
  const n = Array.isArray(planRoom?.plan?.items) ? planRoom.plan.items.length : 0;
  const inputs = ['easy', 'medium', 'hard'].map((t) => `<div><label class="label" for="hTier-${t}">${TIER_LABEL[t]}</label>`
    + `<input class="input" id="hTier-${t}" data-tier="${t}" value="${esc(tiers[t] || '')}" placeholder="${esc(HANDOFF_TIERS[engine]?.[t] || '')}" spellcheck="false" autocomplete="off"></div>`).join('');
  return `<div class="build-handoff">
    <p>You run this plan in your own ${esc(name)}, with your own settings. It is outside the board's write gate and can edit your checkout. The board writes a handoff file for the ${n} item${n === 1 ? '' : 's'} of revision ${esc(planRoom?.planRevision ?? '')}, watches the run live and shows what changed when it ends.</p>
    <div class="label">Suggested models (written into the handoff, not enforced)</div>
    <div class="grid3">${inputs}</div>
    ${info?.note ? `<p class="hint">${esc(info.note)}</p>` : ''}
  </div>`;
}
// After a handoff is written (plan 3.3, step 4): the steps and the paste prompt. A prompt, not a shell command, so no quoting applies.
function handedHtml(h) {
  const name = HANDOFF_NAME[h.engine] || h.engine;
  return `<div class="build-handoff">
    <p>The handoff is written. The board does not start the run: run it yourself in ${esc(name)}.</p>
    <ol><li>Open ${esc(name)} in your project folder.</li><li>Paste this prompt.</li></ol>
    <div class="cmd"><code>${esc(h.prompt)}</code><button class="btn sm" data-copy="${esc(h.prompt)}" data-copy-msg="Prompt copied" aria-label="Copy prompt">${icon('copy', 12)}Copy</button></div>
    <p class="hint">The board finds the run by its code once it starts.</p>
  </div>`;
}
// The start bodies. The board team's is POST /api/build: an empty role uses the fallback, and mode is sent only when one is
// chosen (Automatic is the server's own rule). A handoff's is POST /api/run with the tiers the form showed (plan 3.3, step 1).
function boardStartBody(plan, draft) {
  const roles = Object.fromEntries(BUILD_ROLES.map(([role]) => [role, draft.roles[role] || null]));
  return { planRoomId: plan.id, revision: plan.planRevision, hash: plan.planHash, roles, maxRounds: Number(draft.maxRounds),
    escalate: !!draft.escalate, ...(draft.mode === 'auto' ? {} : { mode: draft.mode }) };
}
function handoffStartBody(plan, draft) {
  return { engine: draft.engine, planRoomId: plan.id, revision: plan.planRevision, hash: plan.planHash, options: { tiers: { ...draft.tiers[draft.engine] } } };
}
// A new draft for a plan: the engine the default rule picks, the manager set to the plan's manager, and the server's defaults.
function newBuildDraft(plan) {
  return { engine: defaultEngine(engineList()), handed: null, adv: false, maxRounds: 3, escalate: false, mode: 'auto',
    roles: Object.fromEntries(BUILD_ROLES.map(([role]) => [role, role === 'manager' ? plan.managerId || '' : ''])),
    tiers: { 'claude-code': { ...HANDOFF_TIERS['claude-code'] }, codex: { ...HANDOFF_TIERS.codex } } };
}
// What the dialog body shows for the draft: the paste prompt once a handoff is written, else the chosen engine's form.
function buildPanelHtml(plan, draft, list) {
  if (draft.handed) return handedHtml(draft.handed);
  if (draft.engine === 'board') return boardPanelHtml(draft, list);
  return handoffFormHtml(plan, draft.engine, draft.tiers[draft.engine]);
}
// The footer: Cancel and the start button (disabled when the engine cannot run), or Done once a handoff is written.
function buildFootHtml(draft, list) {
  if (draft.handed) return '<button class="btn primary" data-close>Done</button>';
  const cur = list.find((e) => e.id === draft.engine);
  return `<button class="btn" data-close>Cancel</button><button class="btn primary" id="bGo"${!cur || cur.available === false ? ' disabled' : ''}>${draft.engine === 'board' ? 'Start build' : 'Create handoff'}</button>`;
}
// The whole dialog for a draft. Its parts are repainted one by one (paintBuild).
function buildDialogHtml(plan, draft) {
  const list = engineList();
  return `<div class="modal-h"><h2 class="modal-t" id="dlgTitle">Start build</h2>${closeBtn()}</div>
    <div class="modal-b build-dlg">
      <p class="hint">Plan revision ${esc(plan.planRevision)} · ${esc(shortHash(plan.planHash))}.</p>
      <div class="label" id="whoL">Who builds it?</div>
      <div id="engineSlot">${engineSegHtml(list, draft.engine, !!draft.handed)}</div>
      <div id="buildPanel">${buildPanelHtml(plan, draft, list)}</div>
    </div>
    <div class="modal-f" id="buildFoot">${buildFootHtml(draft, list)}</div>`;
}
// Repaints the parts of the open dialog that follow the draft (engine choice, panel, footer) and binds them again. Focus
// stays on the control the user had (keepFocus).
function paintBuild(box, plan, draft) {
  const list = engineList();
  if (!draft.handed && !list.some((e) => e.id === draft.engine && e.available !== false)) draft.engine = defaultEngine(list);
  keepFocus(box, () => {
    const slot = box.querySelector('#engineSlot'), panel = box.querySelector('#buildPanel'), foot = box.querySelector('#buildFoot');
    if (slot) slot.innerHTML = engineSegHtml(list, draft.engine, !!draft.handed);
    if (panel) panel.innerHTML = buildPanelHtml(plan, draft, list);
    if (foot) foot.innerHTML = buildFootHtml(draft, list);
  });
  bindBuild(box, plan, draft);
}
// Wires the dialog: the engine choice, the board options, the handoff tiers and the footer. An option that only changes the
// summary updates it in place (updateBuildSummary), so the control the user is on keeps its focus.
function bindBuild(box, plan, draft) {
  const latest = () => S.rooms[plan.id] || plan;
  $$('[data-engine]', box).forEach((b) => b.onclick = () => {
    if (b.disabled || draft.handed || b.dataset.engine === draft.engine) return;
    draft.engine = b.dataset.engine; paintBuild(box, latest(), draft);
  });
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  $$('select[data-role]', box).forEach((s) => s.onchange = () => { draft.roles[s.dataset.role] = s.value; updateBuildSummary(box, draft); });
  const max = box.querySelector('#bMax'), escEl = box.querySelector('#bEsc'), mode = box.querySelector('#bMode'), adv = box.querySelector('#buildAdv');
  if (max) max.onchange = () => { draft.maxRounds = Number(max.value); };
  if (escEl) escEl.onchange = () => { draft.escalate = escEl.checked; };
  if (mode) mode.onchange = () => { draft.mode = mode.value; updateBuildSummary(box, draft); };
  if (adv) adv.ontoggle = () => { draft.adv = adv.open; };
  $$('input[data-tier]', box).forEach((i) => i.oninput = () => { const t = draft.tiers[draft.engine]; if (t) t[i.dataset.tier] = i.value.trim(); });
  const go = box.querySelector('#bGo');
  if (go) go.onclick = () => startBuildFrom(box, latest(), draft);
}
// The summary and the preview follow the roles and the mode, without a repaint.
function updateBuildSummary(box, draft) {
  const rec = box.querySelector('#buildRec'); if (rec) rec.innerHTML = boardSummaryInner(draft);
  const pv = box.querySelector('#bPreview'); if (pv) pv.innerHTML = teamPreviewHtml(draft);
}
// POST /api/build or POST /api/run for the draft (plan 3.3). A board build closes the dialog and opens its room. A handoff
// shows its paste prompt in the same dialog. A plan that is no longer approved at this revision reloads the session.
async function startBuildFrom(box, plan, draft) {
  const go = box.querySelector('#bGo');
  if (!go || go.disabled) return;
  const board = draft.engine === 'board', label = board ? 'Start build' : 'Create handoff';
  go.disabled = true; go.textContent = board ? 'Starting…' : 'Creating…';
  try {
    if (board) {
      const j = await api('/api/build', boardStartBody(plan, draft));
      closeOverlay(); openRoom(j.roomId);
    } else {
      const j = await api('/api/run', handoffStartBody(plan, draft));
      draft.handed = { engine: draft.engine, prompt: j.pastePrompt || '' };
      paintBuild(box, plan, draft);
    }
  } catch (e) {
    if (e.code === 'stale' || e.code === 'not-approved') load().catch(() => {});
  } finally {
    const b = box.querySelector('#bGo'); if (b) { b.disabled = false; b.textContent = label; }
  }
}
// The open dialog follows the engine list when it changes (an engine check that finished, a CLI that went away).
function refreshBuildEngines() {
  if (!buildDlg) return;
  if (!buildDlg.box.isConnected) { buildDlg = null; return; }
  const plan = S.rooms[buildDlg.room]; if (plan) paintBuild(buildDlg.box, plan, buildDlg.draft);
}
// Start build for an approved plan (plan 2.4). The draft keeps every choice, so switching the engine keeps what was set.
function openBuild(r) {
  const draft = newBuildDraft(r);
  const box = overlay(buildDialogHtml(r, draft), 'modal');
  buildDlg = { box, room: r.id, draft };
  bindBuild(box, r, draft);
  box.querySelector('[data-engine][aria-checked="true"]')?.focus?.();
}

/* ---------- before you build: the plan card's preflight (U3, plan 2.4) ---------- */
const PREFLIGHT_MS = 15000; // the plan card reads the checkout again after this long while it is shown
const preflightOf = {}; // plan room id -> { key, at, pending, data, error }, for the plan revision it was read for
const planKeyOf = (r) => `${r.planRevision}|${r.planHash}`;
// GET /api/preflight for the plan card. One read at a time per plan. A read that finishes repaints the card when the plan is
// still on screen. A failed read is kept as text, never thrown.
function loadPreflight(r) {
  const key = planKeyOf(r), got = preflightOf[r.id];
  if (got && (got.pending || (got.key === key && Date.now() - got.at < PREFLIGHT_MS))) return;
  const entry = { key, at: Date.now(), pending: true, data: null, error: '' };
  preflightOf[r.id] = entry;
  api(`/api/preflight?planRoomId=${encodeURIComponent(r.id)}`, undefined, { toast: false })
    .then((j) => { entry.data = j || {}; })
    .catch((e) => { if (e.message !== 'unauthorized') entry.error = e.message || 'the checkout could not be read'; })
    .finally(() => { entry.pending = false; if (S.rooms[S.active]?.id === r.id) renderPlanCard(); });
}
// The block for the plan revision on screen: the answer, the error, or "checking" while it is read.
function preflightBlockHtml(r) {
  const got = preflightOf[r.id], cur = got && got.key === planKeyOf(r) ? got : null;
  if (!cur || (!cur.data && !cur.error)) return preflightHtml(null);
  return preflightHtml(cur.error ? { error: cur.error } : cur.data);
}
// The "Before you build" list (plan 2.4). pre: the GET /api/preflight answer, { error } when it could not be read, or null while
// it is read. Each line names its state in words too, for screen readers.
function preflightHtml(pre) {
  const head = '<h3 class="eyebrow pf-h">Before you build</h3>';
  if (!pre) return `<section class="preflight" aria-label="Before you build">${head}<p class="hint" role="status">Checking the checkout…</p></section>`;
  const dot = (t) => `${String(t || '').trim().replace(/\.+$/, '')}.`;
  const lines = [];
  if (pre.error) lines.push(['warn', `The checkout could not be checked: ${dot(pre.error)}`]);
  else {
    const git = pre.git || {};
    if (git.ok) lines.push(['ok', 'Git repository with a commit.']);
    else lines.push(['warn', `No usable git repository: ${dot(git.reason || 'the project cannot be used')} A build that edits files needs one.`]);
    if (git.ok && pre.clean === false) {
      const n = Number(pre.dirtyCount) || 0;
      lines.push(['warn', n ? `${n} uncommitted change${n === 1 ? '' : 's'}: commit or stash before a build that edits files.`
        : 'The checkout has uncommitted changes: commit or stash them before a build that edits files.']);
    }
    if (seatsOn('claude').length) {
      const cl = pre.writes?.claude || {};
      lines.push(cl.available ? ['ok', 'Claude Code file edits are available.']
        : ['warn', `Claude Code file edits are off: ${dot(cl.reason || 'the write check has not passed')} Claude builders propose only.`]);
    }
    if (seatsOn('codex').length) {
      const cx = pre.writes?.codex || {};
      lines.push(cx.available ? ['ok', 'Codex file edits are available.']
        : ['note', `Codex builders read only and return a diff, which the board applies in the item worktree or exports as a patch. ${codexOffText(cx.reason)}`]);
    }
  }
  const stateWord = { ok: 'Done', warn: 'Warning', note: 'Note' }, stateDot = { ok: 'ok', warn: 'warn', note: 'hollow' };
  return `<section class="preflight" aria-label="Before you build">${head}<ul class="pf-list">${lines.map(([st, text]) => `<li class="pf-${st}">`
    + `<span class="dot ${stateDot[st]}" aria-hidden="true"></span><span><span class="sr-only">${stateWord[st]}: </span>${esc(text)}</span></li>`).join('')}</ul></section>`;
}

/* ---------- patch export of a propose item (F10, U3) ---------- */
// The file, its sha256, the git apply check, the two commands to copy and the untested line (plan 2.4). A refused export says
// why, as text, and offers no command.
function exportHtml(item) {
  const ex = item.exported;
  if (!ex || typeof ex !== 'object') return '';
  const id = esc(item.id);
  if (!ex.file) return `<div class="item-export" data-item-export="${id}"><p>No patch was exported: ${esc(ex.check?.reason || 'the proposal was refused')}</p></div>`;
  const n = Array.isArray(ex.files) ? ex.files.length : 0;
  const check = ex.check?.ok ? 'git apply --check ok' : `git apply --check failed: ${ex.check?.reason || 'unknown reason'}`;
  return `<div class="item-export" data-item-export="${id}">
    <p><b>Patch: ${n} file${n === 1 ? '' : 's'}, ${esc(check)}</b></p>
    <p>File <code class="inline">${esc(ex.file)}</code></p>
    <p>sha256 <code class="inline">${esc(ex.hash)}</code></p>
    ${cmdRow(`git apply --check ${ex.file}`)}${cmdRow(`git apply --index ${ex.file}`)}
    <p class="untested">Untested proposal: read the diff before you apply it.</p>
  </div>`;
}

/* ---------- build session: item table, proposal review, apply and discard (the server enforces every rule) ---------- */
const ITEM_STATUS = { pending: 'Waiting', blocked: 'Blocked', building: 'Building', checking: 'Checking', reviewing: 'In review', passed: 'Passed review',
  'needs-you': 'Needs you', failed: 'Failed', quarantined: 'Quarantined', applied: 'Applied', 'apply-failed': 'Apply failed', discarded: 'Discarded' };
const itemText = (st) => ITEM_STATUS[st] || String(st || 'Unknown');
const BUILD_RESUMABLE = ['paused', 'stopped', 'needs-you', 'needs-approval'];
// A finished build is resumable too while an item is apply-failed: Resume rebuilds that item.
const buildResumable = (r) => BUILD_RESUMABLE.includes(r.status) || (r.status === 'done' && Object.values(r.items || {}).some((it) => it.status === 'apply-failed'));
const offerPlan = new Set(); // builds whose resume was refused as not approved: the card then offers the plan
// Items in plan order (r.order lists the ids; r.items holds the records).
const itemsOf = (r) => (r.order && r.order.length ? r.order : Object.keys(r.items || {})).map((id) => r.items?.[id]).filter(Boolean);
// Apply (Retry apply once the checkout is fixed) is offered only for a passed or apply-failed item of a write build that is not running. The server checks everything else.
function canApply(room, item) { return !!room && !!item && room.mode === 'write' && ['passed', 'apply-failed'].includes(item.status) && room.status !== 'running'; }
function canDiscard(room, item) { return !!room && !!item && !['applied', 'discarded'].includes(item.status) && room.status !== 'running'; }
// "x of n passed · y applied". An applied item has passed review too, so it counts as passed.
function buildSummary(room) {
  const items = itemsOf(room);
  const passed = items.filter((it) => it.status === 'passed' || it.status === 'applied').length;
  const applied = items.filter((it) => it.status === 'applied').length;
  return `${passed} of ${items.length} passed · ${applied} applied`;
}
// One escaped row of the item table: id, title, difficulty, seats, status, rounds, proposal hash, error and the actions.
function itemRowHtml(room, item) {
  const who = (id) => (id ? esc(S.seats[id]?.name || id) : 'none');
  const hash = item.proposal?.hash, label = esc(item.title || item.id);
  const acts = [];
  if (item.proposal) acts.push(`<button class="btn sm" data-item-view="${esc(item.id)}" aria-label="View proposal for ${label}">View</button>`);
  if (canApply(room, item) && hash) acts.push(`<button class="btn sm primary" data-item-apply="${esc(item.id)}" aria-label="Apply proposal for ${label}">${item.status === 'apply-failed' ? 'Retry apply' : 'Apply'}</button>`);
  if (canDiscard(room, item)) acts.push(`<button class="btn sm danger" data-item-discard="${esc(item.id)}" aria-label="Discard ${label}">Discard</button>`);
  return `<div class="item-row" data-item-row="${esc(item.id)}">
    <div class="item-main"><code class="inline">${esc(item.id)}</code> <span class="item-title">${esc(item.title || '')}</span> <span class="hint">${esc(item.difficulty || '')}</span></div>
    <span class="chip ${esc(item.status)}">${esc(itemText(item.status))}</span>
    <div class="item-meta"><span>Builder: ${who(item.builderId)}</span><span>Reviewer: ${who(item.reviewerId)}</span>
      <span class="num">Rounds ${esc(item.rounds ?? 0)}</span>${hash ? `<code class="inline" title="Proposal hash">${esc(shortHash(hash))}</code>` : ''}</div>
    ${item.error ? `<p class="item-err">${esc(item.error)}</p>` : ''}
    ${exportHtml(item)}
    ${acts.length ? `<div class="item-f">${acts.join('')}</div>` : ''}
  </div>`;
}
function buildCardHtml(r) {
  const notes = (Array.isArray(r.roleNotes) ? r.roleNotes : []).map((n) => (typeof n === 'string' ? n : (n?.text || n?.note || ''))).filter(Boolean);
  const mode = r.mode === 'write' ? 'Edits in per-item worktrees' : `Proposals only: ${esc(r.modeReason || 'edits are off for this build')}`;
  const needsApproval = r.status === 'needs-approval';
  let banner = '';
  if (r.resumeNeeded || ['stopped', 'paused', 'needs-approval'].includes(r.status)) {
    const text = needsApproval ? 'The plan changed. Approve it in the plan session, then resume.' : 'This build is paused. Resume continues with the next item.';
    const open = (needsApproval || offerPlan.has(r.id)) && r.planRoomId ? `<button class="btn sm" data-open-plan="${esc(r.planRoomId)}">${icon('target', 12)}Open plan</button>` : '';
    banner = `<div class="build-banner"><span>${text}</span>${open}</div>`;
  }
  const items = itemsOf(r);
  return `<section class="build-card" aria-labelledby="buildH">
    <header class="build-h"><h2 id="buildH">Build</h2><span class="num">${esc(buildSummary(r))}</span></header>
    <p class="build-mode">${mode}</p>
    ${notes.length ? `<ul class="hint build-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${banner}
    <div class="item-list">${items.length ? items.map((it) => itemRowHtml(r, it)).join('') : '<div class="hint">No items yet.</div>'}</div>
  </section>`;
}
function bindBuildCard(el, r) {
  const id = r.id;
  $$('[data-item-view]', el).forEach((b) => b.onclick = () => openProposal(id, b.dataset.itemView));
  $$('[data-item-apply]', el).forEach((b) => b.onclick = async () => {
    const it = S.rooms[id]?.items?.[b.dataset.itemApply];
    if (it?.proposal?.hash) await applyItem(id, it.id, it.proposal.hash, (e) => toast(e.message));
  });
  $$('[data-item-discard]', el).forEach((b) => b.onclick = () => discardItem(id, b.dataset.itemDiscard, (e) => toast(e.message)));
  $$('[data-open-plan]', el).forEach((b) => b.onclick = () => openRoom(b.dataset.openPlan));
}
// Re-renders the build card of the active room; a build room without a card is left alone.
function renderBuildCard() {
  if (deferRender(renderBuildCard)) return;
  const el = $('#buildCard'); if (!el) return;
  const r = S.rooms[S.active];
  if (!r || r.kind !== 'build') { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  keepFocus(el, () => { el.innerHTML = buildCardHtml(r); bindBuildCard(el, r); });
}
// Resume. The request names the plan revision and hash the build resumes with, so a plan approved again since the build
// started is adopted; the server refuses any revision that is not approved. A refusal 'not-approved' means the plan must
// be approved again first: the card then offers the plan.
async function resumeBuild(roomId) {
  const build = S.rooms[roomId], pr = build?.planRoomId ? S.rooms[build.planRoomId] : null;
  // Without the plan room in view, the server resumes only if the build's own plan revision is still approved.
  const body = pr ? { revision: pr.planRevision, hash: pr.planHash } : {};
  try { await api(`/api/build/${roomId}/resume`, body, { toast: false }); offerPlan.delete(roomId); }
  catch (e) {
    if (e.message === 'unauthorized') return;
    if (e.code === 'not-approved') offerPlan.add(roomId);
    toast(e.message);
    if (S.active === roomId) renderBuildCard();
  }
}
// Apply one proposal. Success is announced by the 'apply' event; a failure goes to onErr. Returns true on success.
async function applyItem(roomId, itemId, hash, onErr) {
  try { await api(`/api/build/${roomId}/items/${itemId}/apply`, { hash }, { toast: false }); return true; }
  catch (e) { if (e.message !== 'unauthorized') onErr(e); return false; }
}
// Discard an item after the user confirms. Returns true on success.
async function discardItem(roomId, itemId, onErr) {
  if (!confirm('Discard this item and remove its worktree?')) return false;
  try { await api(`/api/build/${roomId}/items/${itemId}/discard`, {}, { toast: false }); toast('Item discarded'); return true; }
  catch (e) { if (e.message !== 'unauthorized') onErr(e); return false; }
}
// Files named by a refused apply or discard, when the server's error body carries them.
const refusedFiles = (err) => (Array.isArray(err?.body?.files) ? err.body.files : Array.isArray(err?.body?.paths) ? err.body.paths : []);
// The reason an apply or discard was refused: the server's message, its code, and for a dirty checkout the files.
function errorBlock(err) {
  const files = refusedFiles(err);
  return `<div class="pv-err" role="alert"><p>${esc(err.message || 'Failed')}${err.code ? ` <code class="inline">${esc(err.code)}</code>` : ''}</p>`
    + (files.length ? `<ul class="pv-files">${files.map((f) => `<li><code class="inline">${esc(f)}</code></li>`).join('')}</ul>` : '') + '</div>';
}
const proposalDialog = (roomId, itemId) => {
  const dlg = $('#overlay [role="dialog"]');
  return dlg && dlg.dataset.room === roomId && dlg.dataset.item === itemId ? dlg : null;
};
// Opens the proposal review for an item. With opts.refresh it only updates a dialog already open on that item.
async function openProposal(roomId, itemId, opts = {}) {
  let j;
  try { j = await api(`/api/build/${roomId}/items/${itemId}/proposal`); } catch { return; }
  const open = proposalDialog(roomId, itemId);
  if (open) { keepFocus(open, () => paintProposal(open, roomId, itemId, j, opts.err || null)); return; }
  if (opts.refresh) return;
  const dlg = overlay('', 'modal');
  paintProposal(dlg, roomId, itemId, j, opts.err || null);
  dlg.querySelector('[data-close]')?.focus();
}
function paintProposal(dlg, roomId, itemId, j, err) {
  dlg.dataset.room = roomId; dlg.dataset.item = itemId;
  const room = S.rooms[roomId] || {}, item = room.items?.[itemId] || { id: itemId, title: itemId };
  const p = j?.proposal || null, rev = j?.review || null, app = j?.applicable || null;
  const files = Array.isArray(p?.files) ? p.files : [];
  const verdict = rev
    ? `<span class="vt ${rev.verdict === 'pass' ? 'pass' : 'fail'}">${rev.verdict === 'pass' ? 'PASS' : 'FAIL'}</span> by ${esc(S.seats[rev.seatId]?.name || rev.seatId || 'the reviewer')}${rev.at ? ` · ${esc(hhmm(rev.at))}` : ''}`
    : 'Not reviewed yet';
  // A refused apply names the files behind the refusal (a dirty main checkout, unsafe paths). An error block that already
  // lists files does not repeat them here.
  const appFiles = app && !app.ok && !refusedFiles(err).length && Array.isArray(app.files) ? app.files : [];
  const appList = appFiles.length ? `<ul class="pv-files">${appFiles.map((f) => `<li><code class="inline">${esc(f)}</code></li>`).join('')}</ul>` : '';
  const appTxt = !app ? 'Unknown' : app.ok ? 'Ready to apply' : `${esc(app.reason || 'Cannot apply yet')}${app.code ? ` <code class="inline">${esc(app.code)}</code>` : ''}${appList}`;
  const lines = (typeof j?.patch === 'string' ? j.patch : '').split('\n').map((l) => {
    const c = l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
    return c ? `<span class="${c}">${esc(l)}</span>` : esc(l);
  }).join('\n');
  const canA = !!p?.hash && canApply(room, item), canD = canDiscard(room, item);
  dlg.innerHTML = `<div class="modal-h"><h2 class="modal-t" id="dlgTitle">${esc(item.title || item.id)}</h2>${closeBtn()}</div>
    <div class="modal-b pv">
      <p class="hint"><code class="inline">${esc(itemId)}</code> · ${esc(item.difficulty || '')} · ${esc(itemText(item.status))}</p>
      <dl class="pv-meta">
        <div><dt class="eyebrow">Hash</dt><dd>${p?.hash ? `<code class="inline">${esc(p.hash)}</code>` : 'No proposal yet'}</dd></div>
        <div><dt class="eyebrow">Review</dt><dd>${verdict}</dd></div>
        <div><dt class="eyebrow">Apply</dt><dd>${appTxt}</dd></div>
      </dl>
      ${err ? errorBlock(err) : ''}
      <h3 class="eyebrow pv-h">Files (${files.length})</h3>
      <ul class="pv-files">${files.map((f) => `<li><code class="inline">${esc(f)}</code></li>`).join('') || '<li class="hint">No files</li>'}</ul>
      ${j?.truncated ? '<p class="hint">The patch is cut short here. The item worktree has the full change.</p>' : ''}
      <pre class="patch" tabindex="0" aria-label="Patch">${lines || '<span class="hint">No patch yet</span>'}</pre>
    </div>
    <div class="modal-f">${canD ? '<button class="btn danger pv-disc" id="pvDiscard">Discard</button>' : ''}<button class="btn" data-close>Close</button>${canA ? `<button class="btn primary" id="pvApply">${item.status === 'apply-failed' ? 'Retry apply' : 'Apply'}</button>` : ''}</div>`;
  dlg.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeOverlay);
  const again = (e) => openProposal(roomId, itemId, { refresh: true, err: e });
  const on = (sel, fn) => { const b = dlg.querySelector(sel); if (b) b.onclick = fn; };
  on('#pvApply', async () => { if (await applyItem(roomId, itemId, p.hash, again)) closeOverlay(); });
  on('#pvDiscard', async () => { if (await discardItem(roomId, itemId, again)) closeOverlay(); });
}
/* ---------- Workflow room: the stepper, the run card of a handoff, Turn into Workflow (U4, plan 2.3, 2.4 and 3.3) ---------- */
// A handoff run has no page of its own: its card lives under its plan, so opening the run opens the plan. A run whose plan
// is gone keeps a page of its own, with the card only.
function homeRoomId(id) {
  const r = id ? S.rooms[id] || S.roomIndex[id] : null;
  if (!r || r.kind !== 'run' || !r.planRoomId) return id;
  return S.rooms[r.planRoomId] || S.roomIndex[r.planRoomId] ? r.planRoomId : id;
}
const isRoomIdUi = (v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v); // the server's room id rule (GET /api/rooms/:id)
const councilTitleOf = (id) => (S.rooms[id] || S.roomIndex[id] || {}).title || 'the council';
const newestFirst = (a, b) => String(b.created).localeCompare(String(a.created));
// The newest build of a plan as the room index lists it: a handoff run (kind run) or a board team build (kind build).
function buildOfPlan(planId) {
  const hits = roomIndexList().filter((x) => x && x.planRoomId === planId && (x.kind === 'run' || x.kind === 'build'));
  return hits.sort(newestFirst)[0] || null;
}
// The handoff runs of a plan, newest first: one per handoff.
const runsUnder = (planId) => roomIndexList().filter((x) => x && x.kind === 'run' && x.planRoomId === planId).sort(newestFirst);

// The steps of a plan (plan 2.4): Plan, Approve and Build. A handoff build is tagged external, the board team's is not.
const STEP_WORD = { done: 'Done', current: 'Current', failed: 'Failed', todo: 'To do' };
function stepperHtml(plan) {
  const st = plan.status, build = buildOfPlan(plan.id);
  const planState = st === 'error' || st === 'stopped' ? 'failed' : PLAN_ACTIVE.includes(st) ? 'done' : 'current';
  const approveState = st === 'approved' || build ? 'done' : st === 'rejected' ? 'failed' : st === 'awaiting-approval' ? 'current' : 'todo';
  let buildState = approveState === 'done' ? 'current' : 'todo', label = 'Build', tag = '';
  if (build) {
    buildState = build.status === 'done' || build.status === 'passed' ? 'done' : build.status === 'error' ? 'failed' : 'current';
    if (build.kind === 'run') { label = `Build: ${HANDOFF_NAME[build.engine] || 'handoff'}`; tag = ' <span class="tag">external</span>'; }
    else label = 'Build: Board team';
  }
  const step = (text, state, extra = '') => `<li class="stepper-step ${state}"${state === 'current' ? ' aria-current="step"' : ''}>`
    + `<span class="sr-only">${STEP_WORD[state]}: </span>${esc(text)}${extra}${state === 'done' ? ` ${icon('check', 12)}` : ''}</li>`;
  return `<ol class="stepper" aria-label="Workflow steps">${step('Plan', planState)}`
    + `${step(st === 'rejected' ? 'Rejected' : 'Approve', approveState)}${step(label, buildState, tag)}</ol>`;
}

// The paste prompt of a handoff run, as the server writes it. The room keeps the handoff file, not the prompt.
function pasteOfRun(room) {
  const f = String(room.handoffFile || '').replace(/\\/g, '/');
  return room.engine === 'codex'
    ? `Read ${f} and run it with sub-agents (spawn_agent), giving each the task_name it lists and following its rules.`
    : `Read ${f} and run it with a Workflow, following its rules.`;
}
// Kept per run room while the room is on screen: the last Find my run answer (and the link being posted), the open
// Details, the full reads in flight, and the last failed read (retried after 5 s, on the next repaint).
const runFind = {};
const runDetailsOpen = new Set();
const runLoading = new Set();
const runLoadErr = {};
const RUN_ENDED = ['done', 'stopped', 'unknown']; // the statuses after which the changes are read (plan 3.3, step 6)

// The candidates after Find my run (plan 3.3, step 5): token matches first. Each row has its Link button.
function candidatesHtml(room, found) {
  if (!found) return '';
  if (found.pending) return '<p class="hint" role="status">Looking for the run…</p>';
  const err = found.error ? `<p class="run-error" role="status">${esc(found.error)}</p>` : '';
  const list = Array.isArray(found.list) ? found.list : [];
  if (!list.length) {
    return err + `<p class="hint" role="status">No run carries the code ${esc(room.token)} yet. Start the prompt in ${esc(HANDOFF_NAME[room.engine] || 'your CLI')}, then press Find my run again.</p>`;
  }
  const rows = list.map((c) => {
    const title = c.title || c.ref;
    const parts = [Number.isFinite(c.startedAt) ? `started ${hhmm(c.startedAt)}` : '',
      Number.isFinite(c.agentCount) ? `${c.agentCount} ${c.agentCount === 1 ? 'agent' : 'agents'}` : '',
      c.tokenMatch ? 'code matches' : c.score ? `${c.score} plan ${c.score === 1 ? 'item' : 'items'} named, no code match` : 'no code match'];
    return `<li class="run-cand"><span class="run-cand-text"><b>${esc(title)}</b> · ${esc(parts.filter(Boolean).join(', '))}</span>`
      + `<button type="button" class="btn sm" data-run-link="${esc(c.ref)}" data-run-of="${esc(room.id)}" aria-label="Link ${esc(title)}">Link</button></li>`;
  }).join('');
  const care = list.some((c) => !c.tokenMatch) ? '<p class="hint">A run without the code may still be yours. Check it before you link it.</p>' : '';
  return err + `<ul class="run-cands" aria-label="Runs that may be this handoff">${rows}</ul>${care}`;
}
// The waiting card (plan 2.4): the steps, the paste prompt with Copy, Find my run, and the candidates once looked for.
function waitingBodyHtml(room) {
  const prompt = pasteOfRun(room), name = HANDOFF_NAME[room.engine] || 'your CLI';
  return '<ol class="run-steps">'
    + `<li>Open ${esc(name)}${S.project ? ` in <code class="inline">${esc(S.project)}</code>` : ' in your project folder'}.</li>`
    + `<li>Paste this prompt.<div class="cmd"><code>${esc(prompt)}</code><button class="btn sm" data-copy="${esc(prompt)}" data-copy-msg="Prompt copied" aria-label="Copy prompt">${icon('copy', 12)}Copy</button></div></li>`
    + `<li>The board finds the run by its code <code class="inline">${esc(room.token)}</code>.<div><button type="button" class="btn sm" data-run-find="${esc(room.id)}">${icon('refresh', 12)}Find my run</button></div></li>`
    + '</ol>' + candidatesHtml(room, runFind[room.id] || null);
}
// What changed since the handoff (plan 3.3, step 6), read once when the run ends. Details is a native disclosure.
function changesHtml(room) {
  const c = room.changes;
  if (!c || typeof c !== 'object') return RUN_ENDED.includes(room.status) ? '' : '<p class="hint">The changes are read when the run ends.</p>';
  if (c.git === false) return '<p class="hint">This folder is not a git repository, so no changes were read.</p>';
  const n = numOf(c.files), wts = Array.isArray(c.newWorktrees) ? c.newWorktrees : [];
  return `<div class="run-changes"><p>Changes since the handoff: ${n} ${n === 1 ? 'file' : 'files'}, ${wts.length} new ${wts.length === 1 ? 'worktree' : 'worktrees'}.</p>`
    + `<details data-run-details="${esc(room.id)}"${runDetailsOpen.has(room.id) ? ' open' : ''}><summary>Details</summary>`
    + `<pre class="run-stat">${esc(c.stat || 'No diff stat: the changes may be new files only.')}</pre>`
    + (wts.length ? `<ul class="run-wts">${wts.map((w) => `<li><code class="inline">${esc(w)}</code></li>`).join('')}</ul>` : '')
    + '</details></div>';
}
// The linked card (plan 2.4): the status and counts, Unlink, the agents (a Codex sandbox per sub-agent) and the changes.
// Codex sub-agents report no phase, so they are grouped by their item.
function linkedBodyHtml(room) {
  const agents = (Array.isArray(room.agents) ? room.agents : []).filter((a) => a && typeof a === 'object' && a.id);
  const run = room.run && typeof room.run === 'object' ? room.run : {};
  const codex = room.engine === 'codex';
  const done = Number.isFinite(run.done) ? run.done : agents.filter((a) => a.status === 'done').length;
  const total = Number.isFinite(run.agentCount) ? run.agentCount : agents.length;
  const tok = Number.isFinite(run.tokens) ? ` · ${fmtTok(run.tokens)} tok` : '';
  const rows = codex ? agents.map((a) => ({ ...a, phase: a.phase || a.itemId || a.role || '' })) : agents;
  const sandbox = codex ? Object.fromEntries(agents.map((a) => [a.id, a.sandbox ?? null])) : null;
  return `<div class="run-linked-h"><span>${esc(STATUS[room.status] || room.status)} · ${done}/${total} agents${esc(tok)}</span>`
    + `<button type="button" class="btn sm" data-run-unlink="${esc(room.id)}">Unlink</button></div>`
    + (agents.length ? agentRowsHtml(rows, { previews: {}, sandbox, prompts: false }) : '<p class="hint">No agents reported yet.</p>')
    + changesHtml(room);
}
// One handoff run as a card under its plan (plan 2.4). Waiting: the steps, the paste prompt and Find my run. Linked: the
// agents and the changes. planChanged: the plan moved on after the handoff. The card holds no prompt or result text: its
// agent rows have no Prompt button (previews belong to the Runs view and are never kept here).
function runCardHtml(room, plan = null) {
  const name = HANDOFF_NAME[room.engine] || 'Handoff';
  const open = `<section class="run-card" data-run-card="${esc(room.id)}" aria-label="${esc(name)} run">`;
  const head = `<header class="run-card-h"><h3 class="run-card-t">${icon('review', 14)}${esc(name)} run <span class="tag">external</span></h3>${statusHtml(room.status)}</header>`;
  if (!Array.isArray(room.agents)) {
    const err = runLoadErr[room.id];
    return `${open}${head}${err ? `<p class="run-error" role="status">Could not read the run: ${esc(err.text)}</p>` : '<p class="hint" role="status">Loading the run…</p>'}</section>`;
  }
  const planNote = room.planChanged
    ? `<p class="run-warn" role="status">${icon('alert', 14)}<span>Plan changed after the handoff${plan ? ` (r${esc(plan.planRevision)})` : ''}. This run follows r${esc(room.planRevision)}.</span></p>`
    : '';
  return `${open}${head}
    <p class="run-card-rev">Plan revision ${esc(room.planRevision)} · run code <code class="inline">${esc(room.token)}</code></p>
    <p class="hint">Outside the board's write gate: this run can edit your checkout with your own settings. The board watches it and never starts or stops it.</p>
    ${planNote}${room.linked ? linkedBodyHtml(room) : waitingBodyHtml(room)}${runRemoveHtml(room)}
  </section>`;
}
// Cancel (a waiting run, which includes a run the user unlinked) or Remove (a linked run that has ended). Both delete the
// run room and nothing else: the plan stays and the user's run is not stopped. A linked run that still goes has no delete
// button, so it is unlinked first and never removed while the board follows it.
function runRemoveHtml(room) {
  if (room.linked && !RUN_ENDED.includes(room.status)) return '';
  const label = room.linked ? 'Remove' : 'Cancel';
  return `<div class="run-card-f"><button type="button" class="btn sm" data-run-delete="${esc(room.id)}" aria-label="${label} ${esc(room.title || 'this run')}">${label}</button></div>`;
}
// The run cards on screen: a plan shows the handoff runs of its own (newest first); a run's own page shows its card.
function renderRunCard() {
  if (deferRender(renderRunCard)) return;
  const el = $('#runCard'); if (!el) return;
  const cur = S.rooms[S.active] || null;
  const index = !cur ? [] : cur.kind === 'plan' ? runsUnder(cur.id) : cur.kind === 'run' ? [cur] : [];
  if (!index.length) { el.hidden = true; el.innerHTML = ''; return; }
  const rooms = index.map((x) => S.rooms[x.id] || x);
  el.hidden = false;
  for (const run of rooms) if (!Array.isArray(run.agents)) loadRunIfNeeded(run.id);
  keepFocus(el, () => { el.innerHTML = rooms.map((run) => runCardHtml(run, cur.kind === 'plan' ? cur : S.rooms[run.planRoomId] || null)).join(''); });
}
// A run room not read in full yet (its agents and linked run come with GET /api/rooms/:id) is read once; a failed read is
// tried again only after 5 s, so a broken server does not turn every repaint into a request.
function loadRunIfNeeded(id) {
  const err = runLoadErr[id];
  if (runLoading.has(id) || (err && Date.now() - err.at < 5000)) return;
  loadRunRoom(id);
}
async function loadRunRoom(id) {
  if (!isRoomIdUi(id) || runLoading.has(id)) return;
  runLoading.add(id);
  try {
    const room = await api(`/api/rooms/${encodeURIComponent(id)}`, undefined, { toast: false });
    // A run deleted while this read was in flight stays gone: the read is kept only for a room the lists still know.
    if (room && room.id === id && (S.rooms[id] || S.roomIndex[id])) S.rooms[id] = { messages: [], ...(S.rooms[id] || {}), ...room, agents: Array.isArray(room.agents) ? room.agents : [] };
    delete runLoadErr[id];
  } catch (e) {
    if (e.message === 'unauthorized') return;
    runLoadErr[id] = { at: Date.now(), text: e.message || 'the request failed' };
  } finally { runLoading.delete(id); }
  renderRunCard();
}
// Find my run (plan 3.3, step 5): the runs the board lists for this handoff's code. The answer stays until the run is linked.
async function findRun(id) {
  if (!isRoomIdUi(id) || (runFind[id] && runFind[id].pending)) return;
  runFind[id] = { pending: true, list: [], error: '', linking: null };
  renderRunCard();
  try {
    const j = await api(`/api/run/${encodeURIComponent(id)}/candidates`, undefined, { toast: false });
    const list = (Array.isArray(j && j.candidates) ? j.candidates : []).filter((c) => c && typeof c.ref === 'string' && c.ref);
    runFind[id] = { pending: false, list, error: '', linking: null };
    if (S.rooms[id] && typeof (j && j.planChanged) === 'boolean') S.rooms[id].planChanged = j.planChanged;
  } catch (e) {
    if (e.message === 'unauthorized') return;
    runFind[id] = { pending: false, list: [], error: e.message || 'the request failed', linking: null };
  }
  renderRunCard();
}
// Link (plan 3.3, step 5): the chosen candidate is followed. The server refuses a run that was not listed (400) and a
// second link (409, which only means the room is linked already).
async function linkRun(id, ref) {
  const f = runFind[id];
  if (!isRoomIdUi(id) || typeof ref !== 'string' || !ref || (f && f.linking)) return;
  runFind[id] = { pending: false, list: f ? f.list : [], error: '', linking: ref };
  renderRunCard();
  try {
    await api(`/api/run/${encodeURIComponent(id)}/link`, { ref }, { toast: false });
    delete runFind[id];
    await loadRunRoom(id);
  } catch (e) {
    if (e.message === 'unauthorized') return;
    if (e.code === 'already-linked') { delete runFind[id]; await loadRunRoom(id); return; }
    runFind[id] = { pending: false, list: f ? f.list : [], error: e.message || 'The run could not be linked.', linking: null };
    renderRunCard();
  }
}
// Unlink: the board stops following the run. The user's own run goes on.
async function unlinkRun(id) {
  if (!isRoomIdUi(id)) return;
  try { await api(`/api/run/${encodeURIComponent(id)}/unlink`, {}, { toast: false }); }
  catch (e) { if (e.message !== 'unauthorized') toast(e.message); return; }
  delete runFind[id];
  await loadRunRoom(id);
}
// The room is deleted: what the card kept for it goes too.
function forgetRun(id) { delete runFind[id]; delete runLoadErr[id]; runDetailsOpen.delete(id); }
// Cancel or Remove (plan 2.4): the board deletes the run room, and the server releases its follower first. The plan stays,
// and the user's own run is never stopped. Each click confirms first. A refused request shows its reason (api() toasts it).
const runDeleting = new Set();
async function deleteRunRoom(id) {
  if (!isRoomIdUi(id) || runDeleting.has(id)) return;
  const room = S.rooms[id] || S.roomIndex[id] || {};
  const name = room.title || (room.linked ? 'this run' : 'this handoff');
  const ask = room.linked
    ? `Remove ${name} from the board? The board forgets it. The run itself is not touched.`
    : `Cancel ${name}? The board forgets it. A run you already started is not stopped or touched.`;
  if (!confirm(ask)) return;
  runDeleting.add(id);
  try { await api(`/api/rooms/${encodeURIComponent(id)}/delete`, {}); }
  catch { return; }
  finally { runDeleting.delete(id); }
  dropRoom(id);
}
// A room that is gone, deleted here or elsewhere: the lists, the open page and the run card let go of it.
function dropRoom(id) {
  delete S.rooms[id]; delete S.roomIndex[id]; forgetRun(id);
  if (S.active === id) openRoom(null);
  else { paintModeNav(); renderSessions(); renderRoomHead(); renderRunCard(); }
}
// One engine event (plan 3.1): the run summary and the agents that changed. A run room that is not read in full yet takes
// them with its read. The card repaints only while it is on screen.
function applyEngineEvent(ev) {
  const r = ev && S.rooms[ev.roomId];
  if (!r || r.kind !== 'run') return;
  if (ev.run !== undefined) r.run = ev.run;
  const changed = (Array.isArray(ev.agents) ? ev.agents : []).filter((a) => a && typeof a === 'object' && a.id);
  if (changed.length && Array.isArray(r.agents)) r.agents = mergeAgents(r.agents, changed);
  if (S.active === r.id || (r.planRoomId && S.active === r.planRoomId)) renderRunCard();
}
// One delegated handler for the run card (Find my run, Link, Unlink, Cancel, Remove). The card repaints on every engine
// event, so no button is bound by hand, and no button is disabled while its request runs (a disabled control would drop
// keyboard focus).
function onRunCardClick(e) {
  const t = e && e.target;
  if (!t || typeof t.closest !== 'function') return;
  const d = (t.closest('[data-run-find],[data-run-link],[data-run-unlink],[data-run-delete]') || {}).dataset;
  if (!d) return;
  if (d.runFind) findRun(d.runFind);
  else if (d.runLink) linkRun(d.runOf, d.runLink);
  else if (d.runUnlink) unlinkRun(d.runUnlink);
  else if (d.runDelete) deleteRunRoom(d.runDelete);
}
document.addEventListener('click', onRunCardClick);
// The open Details of a run card stay open across repaints.
function onRunCardToggle(e) {
  const t = e && e.target, id = t && t.dataset && t.dataset.runDetails;
  if (!id) return;
  if (t.open) runDetailsOpen.add(id); else runDetailsOpen.delete(id);
}
document.addEventListener('toggle', onRunCardToggle, true);

// Turn into Workflow (plan 2.3): a finished council opens a New workflow prefilled with its synthesis. The plan skips the
// debate, because the server reads the council's result instead (F9). The goal stays editable.
function turnIntoWorkflow(council) {
  const room = typeof council === 'string' ? S.rooms[council] : council;
  if (!room || room.kind !== 'meeting' || room.status !== 'done') { toast('Only a finished council can become a workflow'); return; }
  const res = resultInfo(room)?.res || null;
  const goal = (res ? cleanText(res.text) : '') || room.topic || room.title || '';
  setMode('workflow');
  openNew('plan', { goal: String(goal).slice(0, 8000), councilId: room.id });
}
// The POST /api/plan body of the New workflow dialog. A plan made from a council (F9) sends its councilId and no participants.
function planStartBody(x, seatIds, ov) {
  const body = { goal: String(x.goal || '').trim(), managerId: x.manager, rounds: x.rounds, withContext: !!x.ctx, overrides: ov };
  if (x.councilId) return { ...body, councilId: x.councilId, seatIds: [] };
  return { ...body, seatIds, ...(x.scout ? { scoutId: x.scout } : {}), ...(x.facilitator ? { synthId: x.facilitator } : {}) };
}

const cleanText = (t) => (t || '').replace(/\n?\s*\**STANCE:\s*\w+\**\s*$/i, '').replace(/\n?\s*\**VERDICT:\s*\w+\**\s*$/i, '').trim();
function resultMd(r, m) {
  const head = r.kind === 'chain' ? `## Review verdict: ${m.verdict === 'pass' ? 'PASS' : 'FAIL'}: ${r.title}` : `## Synthesis: ${r.title}`;
  return `${head}\n\n_${KIND[r.kind]} · ${m.name} · ${new Date(m.ts).toLocaleString()}_\n\n${cleanText(m.text)}\n`;
}
function transcriptMd(r) {
  const name = (id) => S.seats[id]?.name || id;
  const L = [`# ${r.title}`, '', `- Workflow: ${KIND[r.kind] || r.kind}`, `- Status: ${STATUS[r.status] || r.status}`, `- Started: ${new Date(r.created).toLocaleString()}`];
  if (r.kind === 'meeting') { L.push(`- Participants: ${(r.seatIds || []).map(name).join(', ')}`, `- Rounds: ${r.rounds}`); if (r.scoutId) L.push(`- Scout: ${name(r.scoutId)}`); if (r.synthId) L.push(`- Facilitator: ${name(r.synthId)}`); if (r.topic) L.push('', `**Topic:** ${r.topic}`); }
  else if (r.kind === 'chain') { L.push(`- Proposer: ${name(r.builderId)}`, `- Reviewer: ${name(r.reviewerId)}`, `- Max rounds: ${r.maxRounds}`); if (r.task) L.push('', `**Task:** ${r.task}`); }
  else if (r.kind === 'plan') { L.push(`- Manager: ${name(r.managerId)}`, `- Plan revision: ${r.planRevision ?? 0}`, `- Plan items: ${(r.plan?.items || []).length}`); if (r.plan?.goal) L.push('', `**Goal:** ${r.plan.goal}`); }
  else if (r.kind === 'build') L.push(`- Items: ${Object.keys(r.items || {}).length}`, `- Mode: ${r.mode || 'propose'}`);
  else L.push(`- Agent: ${name(r.seatId)}`);
  if (r.usage?.tokens) L.push('', `_Usage: ${r.usage.tokens} net tokens · ${r.usage.cached || 0} cached · $${(r.usage.cost || 0).toFixed(3)} Claude_`);
  L.push('', '---');
  let lastRound;
  for (const m of r.messages) {
    if (m.seatId === 'system') { L.push('', `> _${m.text}_`); continue; }
    if (isAgentMsg(m) && m.round !== undefined && String(m.round) !== String(lastRound)) { lastRound = m.round; L.push('', `## ${roundLabel(m.round)}`); }
    const who = m.seatId === 'user' ? 'You' : m.name;
    const meta = [m.label, hhmm(m.ts), m.tokens ? `${m.tokens} tokens` : '', m.verdict ? `VERDICT: ${m.verdict.toUpperCase()}` : '', m.id === r.resultId ? (r.kind === 'chain' ? 'RESULT' : 'SYNTHESIS') : ''].filter(Boolean).join(' · ');
    L.push('', `### ${who}${meta ? ` (${meta})` : ''}`, '', m.streaming ? '_(still writing)_' : (m.text || (m.error ? '' : '_(no text)_')));
    if (m.error) L.push('', `_Error: ${m.error}_`);
  }
  return L.join('\n') + '\n';
}
function exportTranscript(r) {
  download(`orchestra-${r.kind}-${slug(r.title)}-${new Date(r.created).toISOString().slice(0, 10)}.md`, transcriptMd(r));
  toast('Transcript downloaded');
}
// Composer for Direct chat and running sessions; a next-step bar for finished Debate / Propose → Review.
// Plan and build sessions have no composer: their actions are the plan card and the build panel.
const composerMode = (r) => r.kind === 'plan' || r.kind === 'build' || r.kind === 'run' ? 'none' : r.kind === 'ask' ? 'ask' : r.kind === 'dm' ? 'dm' : r.status === 'running' ? 'live' : 'done';
const drafts = {}; // unsent note per room: kept across room switches, and when its session ends under the user's cursor
function keepDraft(id, text) { if (!id) return; if (text && text.trim()) drafts[id] = text; else delete drafts[id]; }
function renderComposer() {
  const r = S.rooms[S.active], el = $('#composerArea'); if (!r || !el) return;
  const mode = composerMode(r); el.dataset.mode = mode;
  const typed = $('#compose')?.value.trim() || '';
  if (mode === 'none') { el.innerHTML = ''; return; }
  if (mode === 'done') {
    // A note typed while the session ran is kept: the next bar offers to copy it, so the session ending never drops it.
    if (typed) drafts[r.id] = typed;
    const kept = drafts[r.id] && r.status !== 'running' ? drafts[r.id] : '';
    const hadFocus = el.contains(document.activeElement);
    el.innerHTML = `<div class="nextbar"><span>Session finished</span>${kept ? `<button class="btn" data-copy="${esc(kept)}" data-copy-msg="Unsent note copied" title="Copy the note you were typing">${icon('copy', 14)}Copy unsent note</button>` : ''}<button class="btn" id="nbAgain">Run again</button><button class="btn primary" id="nbDm">Continue in Direct chat</button></div>`;
    $('#nbAgain').onclick = () => openNew(r.kind, roomPreset(r));
    $('#nbDm').onclick = () => continueInDm(r);
    if (hadFocus) $('#nbDm').focus({ preventScroll: true });
    return;
  }
  // What the user is typing survives a re-render (the live textarea) and a room switch (the drafts map); it goes only after a send.
  const live = $('#compose'), draft = live && live.dataset.room === r.id ? live.value : (drafts[r.id] || '');
  const placeholder = mode === 'dm' ? `Message ${S.seats[r.seatId]?.name || 'agent'}…` : mode === 'ask' ? 'Message…' : 'Add a note for the next agent turn…';
  el.innerHTML = `<div class="composer${mode === 'ask' ? ' ask-composer' : ''}">
      <textarea id="compose" rows="1" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" aria-describedby="composeKeys"></textarea>
      <div class="composer-tools">${mode === 'ask' ? `<div class="ask-pick-slot" id="askRoomPick">${askPickerHtml(r)}</div>` : ''}<span class="send-hint" aria-hidden="true"><kbd>Enter</kbd></span><span class="sr-only" id="composeKeys">Enter sends, Shift+Enter adds a new line.</span><button class="btn primary" id="sendBtn">Send</button></div>
    </div>`;
  const ta = $('#compose');
  ta.dataset.room = r.id;
  if (draft) { ta.value = draft; ta.focus(); grow(ta); }
  ta.oninput = () => grow(ta);
  // An IME (Japanese, Chinese, Korean) confirms a candidate with Enter: never send a half-composed message.
  ta.onkeydown = (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('#sendBtn').onclick = send;
  if (mode === 'ask') bindAskPicker($('#askRoomPick'), r);
}
function grow(ta) { ta.style.height = '28px'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; }
// Repaints only the bubbles whose result state changed: a repaint rebuilds the text, which would drop a selection or focus.
function markResult() {
  const r = S.rooms[S.active], inner = $('#feedInner'); if (!r || !inner) return;
  $$('#feedInner .entry.result').forEach((el) => { if (el.dataset.id !== r.resultId) { el.classList.remove('result'); const m = findMsg(el.dataset.id); if (m) paintMsg(m, false); } });
  if (!r.resultId) return;
  const el = inner.querySelector(`[data-id="${CSS.escape(r.resultId)}"]`);
  if (!el || !el.classList.contains('result')) { const m = findMsg(r.resultId); if (m) paintMsg(m, false); }
}
// The jump target keeps a static highlight (no flash animation) until the next jump.
function jumpTo(id) {
  const t = document.querySelector(`#feedInner [data-id="${CSS.escape(id)}"]`); if (!t) return;
  $$('#feedInner .target').forEach((x) => x.classList.remove('target'));
  t.scrollIntoView({ block: 'center' }); t.classList.add('target');
  t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true });
}
function roomPreset(r) {
  if (r.kind === 'meeting') return { topic: r.topic, seatIds: r.seatIds, scoutId: r.scoutId, synthId: r.synthId, rounds: r.rounds, withContext: r.withContext, overrides: r.overrides || {} };
  if (r.kind === 'chain') return { task: r.task, builderId: r.builderId, reviewerId: r.reviewerId, maxRounds: r.maxRounds, escalate: r.escalate, withContext: r.withContext, overrides: r.overrides || {} };
  return { seatId: r.seatId };
}
function continueInDm(r) {
  const seatId = r.synthId || r.builderId || r.seatIds?.[0];
  const res = (r.resultId && r.messages.find((m) => m.id === r.resultId)) || [...r.messages].reverse().find((m) => isAgentMsg(m) && !m.streaming && m.text);
  const body = (res?.text || '').trim().slice(0, 1500);
  openNew('dm', { seatId, message: `About: ${r.topic || r.task || r.title}\n\nResult so far:\n${body}\n\n` });
}
async function send() {
  const r = S.rooms[S.active], ta = $('#compose'), btn = $('#sendBtn'); if (!r || !ta || !btn || btn.disabled) return;
  const text = ta.value.trim(); if (!text) return;
  btn.disabled = true;
  try {
    if (r.kind === 'ask') { if (!await sendAsk(r.id, text, currentPick(r))) return; }
    else if (r.kind === 'dm') await api(`/api/seats/${r.seatId}/send`, { text });
    else { await api(`/api/rooms/${r.id}/say`, { text }); toast('Note added. The next agent turn will read it'); }
    if (S.active === r.id) { const cur = $('#compose'); if (cur && cur.value.trim() === text) { cur.value = ''; grow(cur); } }
    if (drafts[r.id]?.trim() === text) delete drafts[r.id]; // the note that was sent is no longer a draft
  } catch {} finally { const b = $('#sendBtn'); if (b) b.disabled = false; }
}

/* ---------- transcript: a vertical timeline (round markers, round avatars, verdict blocks) ---------- */
const tw = {}; // streaming text buffers: msg id -> { shown, pending }
// Which round a timeline item belongs to (verdict placement); system notes carry it in skip / earlyStop / seatOut.
const itemRound = (m) => m.skip ? m.skip.round : m.seatOut ? m.seatOut.round : m.earlyStop ?? m.round;
const roundTitle = (r, key) => r.kind === 'meeting' ? (key === '1' ? 'Round 1 · Ideas' : /^\d+$/.test(key) ? `Round ${key} · Discussion` : cap(key)) : /^\d+$/.test(key) ? `Round ${key}` : cap(key);
// A round marker sits before the first agent turn of each numbered round (and the synthesis); none for the scout brief or Direct chat.
const wantsMarker = (r, m) => r.kind !== 'dm' && isAgentMsg(m) && m.round !== undefined && m.round !== 'scout' && m.round !== 0 && m.round !== '';
function msgHtml(m) {
  const rd = itemRound(m), rattr = rd !== undefined && rd !== null ? ` data-round="${esc(String(rd))}"` : '';
  if (m.seatId === 'system') return `<div class="note" data-id="${esc(m.id)}"${rattr} role="note"><span class="note-node" aria-hidden="true"></span><span class="note-text">${esc(m.text)}</span></div>`;
  const user = m.seatId === 'user';
  return `<article class="entry ${user ? 'user' : ''} ${m.round === 'scout' ? 'scout' : ''}" data-id="${esc(m.id)}"${rattr} aria-label="${esc(user ? 'You' : m.name)}">
    ${user ? userAvatar('lg') : avatar(m.seatId, 'lg', m.agent)}<div class="entry-body"><header class="msg-head"></header><div class="content md"></div><div class="tools" aria-label="Tool calls"></div></div></article>`;
}
function msgHeadHtml(m, r) {
  if (m.seatId === 'user') return `<span class="who"><span class="name">You</span></span><span class="msg-stat">${hhmm(m.ts)}</span>`;
  const s = S.seats[m.seatId], agent = m.agent || s?.agent, isResult = m.id === r.resultId;
  const who = `<span class="who"><span class="cli">${esc(TOOL[agent] || 'Agent')}</span><span class="sep" aria-hidden="true">·</span><span class="name">${esc(m.name)}</span></span>`;
  const shown = m.model || (s?.agent === agent ? s?.model : ''); // the model the message ran on; the seat's for older messages
  const model = shown ? `<span class="model">${esc(shown)}</span>` : '';
  // In a Debate the round marker already names the step (Ideas, Discussion, Synthesis); only the scout brief keeps its label.
  const role = m.label && !(r.kind === 'meeting' && m.round !== 'scout') ? `<span class="role">${esc(cap(m.label))}</span>` : '';
  const verdict = m.verdict ? `<span class="vt ${m.verdict === 'pass' ? 'pass' : 'fail'}">${icon(m.verdict === 'pass' ? 'check' : 'x', 12)}${m.verdict === 'pass' ? 'PASS' : 'FAIL'}</span>` : '';
  const resTag = isResult ? `<span class="rtag">${r.kind === 'chain' ? 'Result' : 'Synthesis'}</span>` : '';
  let stat;
  const lost = !!(tw[m.id]?.gap || tw[m.id]?.gapped);
  if (m.streaming && lost) stat = `<span class="msg-stat act" title="The connection dropped while this reply was being written. The full text appears when it ends.">Connection lost · full text at the end</span>`;
  else if (m.streaming) stat = `<span class="msg-stat act" title="${esc(s?.activity || '')}">${esc(s?.activity || 'starting')}…</span>`;
  else {
    const parts = [m.tokens ? `${fmtTok(m.tokens)} tok` : '', m.ended ? fmtDur(new Date(m.ended) - new Date(m.ts)) : ''].filter(Boolean);
    const tip = [`Finished ${hhmm(m.ended || m.ts)}`, m.cached ? `${fmtTok(m.cached)} cached` : '', m.cost ? '$' + m.cost.toFixed(3) : '', m.effort ? (EFFORT[m.effort] || m.effort) + ' effort' : '', m.tools === 'none' ? 'no tools' : ''].filter(Boolean).join(' · ');
    stat = `<span class="msg-stat" title="${esc(tip)}">${parts.join(' · ') || hhmm(m.ts)}</span>`;
  }
  const acts = !m.streaming && m.text ? `<span class="mact"><button class="icon-btn" data-copy-msg="${isResult ? 'Result copied as Markdown' : 'Message copied'}" data-copy="${esc(isResult ? resultMd(r, m) : cleanText(m.text))}" title="Copy as Markdown" aria-label="Copy ${esc(m.name)}'s message as Markdown">${icon('copy', 14)}</button></span>` : '';
  return `${who}${model}${role}${verdict}${resTag}${stat}${acts}`;
}
// What a bubble shows for a message: a reconnect skips the repaint of a finished message whose key did not change.
const msgKey = (m, r) => [m.streaming ? 1 : 0, (m.text || '').length, m.error || '', m.verdict || '', m.ended || '', m.tokens || 0, m.id === r.resultId ? 1 : 0].join('|');
function paintMsg(m, scroll = true) {
  const inner = $('#feedInner'), r = S.rooms[S.active]; if (!inner || !r?.messages.some((x) => x.id === m.id)) return;
  inner.querySelector('.thread-empty')?.remove();
  let el = inner.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
  const f = $('#feed');
  if (!el) {
    const msgs = r.messages, i = msgs.findIndex((x) => x.id === m.id), prev = msgs.slice(0, i).reverse().find(isAgentMsg);
    if (wantsMarker(r, m) && (!prev || String(prev.round) !== String(m.round)) && !inner.querySelector(`.round[data-round="${CSS.escape(String(m.round))}"]`)) {
      const key = String(m.round);
      inner.insertAdjacentHTML('beforeend', `<div class="round running" data-round="${esc(key)}" role="separator" aria-label="${esc(roundTitle(r, key))}"><span class="round-node" aria-hidden="true"><span class="dot run"></span></span><div class="round-text"><b>${esc(roundTitle(r, key))}</b><span class="desc"></span><span class="line" aria-hidden="true"></span></div></div>`);
    }
    inner.insertAdjacentHTML('beforeend', msgHtml(m)); el = inner.lastElementChild;
  }
  if (m.seatId === 'system') { if (scroll) decorateSoon(); return; }
  const isResult = m.id === r.resultId;
  el.classList.toggle('streaming', !!m.streaming);
  el.classList.toggle('result', isResult);
  el.querySelector('.msg-head').innerHTML = msgHeadHtml(m, r);
  const c = el.querySelector('.content'), st = tw[m.id];
  if (m.streaming) {
    // Text already revealed (a room switch, a reconnect or a rebuilt feed) comes back from the buffer, not as a blank bubble.
    if (st?.shown) { if (!c.textContent.trim()) { c.classList.add('raw'); c.textContent = st.shown; c.insertAdjacentHTML('beforeend', '<span class="caret" aria-hidden="true"></span>'); } }
    else if (!st || !st.pending) c.innerHTML = '<span class="sr-only">Writing…</span><span class="caret" aria-hidden="true"></span>';
  }
  else if (!st || !st.pending) {
    c.classList.remove('raw'); c.innerHTML = md(cleanText(m.text)) + (m.error ? `<div class="err" role="alert">${icon('x', 12)}<span>${esc(m.error)}</span></div>` : '');
  }
  if (scroll) { follow(); decorateSoon(); }
  el.dataset.k = msgKey(m, r);
}
// Reveal streamed text progressively; Codex delivers whole messages at once.
function twLoop() {
  for (const [id, st] of Object.entries(tw)) {
    if (!st.pending) continue;
    const n = Math.max(3, Math.ceil(st.pending.length / 12));
    st.shown += st.pending.slice(0, n); st.pending = st.pending.slice(n);
    const el = document.querySelector(`#feedInner [data-id="${CSS.escape(id)}"] .content`);
    if (el) { el.classList.add('raw'); el.textContent = st.shown; el.insertAdjacentHTML('beforeend', '<span class="caret" aria-hidden="true"></span>'); follow(); }
    if (!st.pending) { const m = findMsg(id); if (m && !m.streaming) paintMsg(m); }
  }
  requestAnimationFrame(twLoop);
}
const findMsg = (id) => { for (const r of Object.values(S.rooms)) { const m = r.messages?.find((x) => x.id === id); if (m) return m; } return null; };

// Round verdict from STANCE lines: who would sign the current direction (CONVERGED, or a silent agreement) and who is still open.
const stanceOf = (m) => { const x = lastLine(m.text).match(/^STANCE:\s*(\w+)/i); return x ? x[1].toLowerCase() : null; };
const satOut = (r, id, n) => r.messages.some((x) => x.seatOut && x.seatOut.seatId === id && Number(x.seatOut.round) < n);
function roundVerdict(r, n) {
  const agreed = [], open = [], failed = [], waiting = [];
  let stances = 0;
  for (const id of r.seatIds || []) {
    if (satOut(r, id, n)) continue;
    const name = S.seats[id]?.name || id;
    if (r.messages.some((x) => x.skip && x.skip.seatId === id && String(x.skip.round) === String(n))) { agreed.push(`${name} (silently)`); stances++; continue; }
    const m = r.messages.find((x) => x.seatId === id && String(x.round) === String(n));
    if (!m || m.streaming) { waiting.push(name); continue; }
    if (m.error || m.failed) { failed.push(name); continue; }
    const st = stanceOf(m); if (st) stances++;
    (st === 'converged' ? agreed : open).push(name);
  }
  if (!stances) return null;
  const replied = agreed.length + open.length + failed.length, total = replied + waiting.length;
  const overall = agreed.length && !open.length ? 'Agreed' : agreed.length ? 'Contested' : 'Open';
  return { agreed, open, failed, waiting, replied, total, overall, live: r.status === 'running' && waiting.length > 0 };
}
function verdictHtml(v, n) {
  const ov = { Agreed: ['v-ok', 'check'], Contested: ['v-warn', 'half'], Open: ['v-open', 'ring'] }[v.overall];
  const sub = v.live ? `so far · ${v.replied} of ${v.total} replied` : v.waiting.length ? `${v.waiting.length} did not reply` : 'from STANCE lines';
  const row = (cls, ic, label, names) => names.length ? `<li class="vrow ${cls}"><span class="vlabel">${icon(ic, 12)}${label}<span class="n">${names.length}/${v.total}</span></span><span>${names.map(esc).join(', ')}</span></li>` : '';
  return `<span class="round-node" aria-hidden="true">${icon('list', 12)}</span>
    <div class="vblock" role="group" aria-label="Round ${n} verdict: ${v.overall}">
      <div class="vb-head ${v.overall === 'Contested' ? 'v-warn' : ''}"><span class="vb-title">Round ${n} verdict</span><span class="vlabel ${ov[0]}">${icon(ov[1], 12)}${v.overall}</span><span class="vb-sub">${sub}</span></div>
      <ul class="verdicts">${row('v-ok', 'check', 'Agreed', v.agreed)}${row('v-open', 'ring', 'Open', v.open)}${row('v-fail', 'x', 'No stance', v.failed)}</ul>
    </div>`;
}
function roundDesc(r, key, ms, running) {
  const mode = r.kind === 'meeting' ? (key === '1' ? `parallel · ${(r.seatIds || []).length} agents` : key === 'synthesis' ? 'writes BRAINSTORM.md' : 'in order') : r.kind === 'chain' ? 'propose → review' : '';
  if (running || !ms.length) return mode;
  const start = Math.min(...ms.map((m) => new Date(m.ts).getTime())), end = Math.max(...ms.map((m) => new Date(m.ended || m.ts).getTime()));
  return [mode, fmtDur(end - start)].filter(Boolean).join(' · ');
}
// Round markers (running vs done) and verdict blocks, placed after the last item of their round.
let decoT = null;
const decorateSoon = () => { if (decoT) return; decoT = requestAnimationFrame(() => { decoT = null; decorate(); }); };
function decorate() {
  const r = S.rooms[S.active], inner = $('#feedInner'); if (!r || !inner) return;
  $$('.round[data-round]', inner).forEach((el) => {
    const key = el.dataset.round, ms = r.messages.filter((m) => isAgentMsg(m) && String(m.round) === key);
    // Running while a turn streams, or between two turns of the round the workflow is still in.
    const running = ms.some((m) => m.streaming) || (r.status === 'running' && String(r.round) === key);
    if (el.classList.contains('running') !== running || !el.dataset.painted) {
      el.classList.toggle('running', running); el.classList.toggle('done', !running); el.dataset.painted = '1';
      el.querySelector('.round-node').innerHTML = running ? '<span class="dot run"></span>' : icon('check', 12);
    }
    el.querySelector('.desc').textContent = roundDesc(r, key, ms, running);
  });
  if (r.kind === 'meeting') verdictBlocks(r, inner);
  // Inserted blocks and markers grow the feed: a reader who was following the latest turn stays at the bottom.
  follow();
}
function verdictBlocks(r, inner) {
  const rounds = [...new Set(r.messages.filter(isAgentMsg).map((m) => m.round).filter((x) => typeof x === 'number'))];
  for (const n of rounds) {
    const v = roundVerdict(r, n); let el = inner.querySelector(`.vblock-entry[data-verdict="${n}"]`);
    if (!v) { el?.remove(); continue; }
    if (!el) { el = document.createElement('div'); el.className = 'entry vblock-entry'; el.dataset.verdict = String(n); }
    const key = JSON.stringify(v); if (el.dataset.key !== key) { el.innerHTML = verdictHtml(v, n); el.dataset.key = key; }
    const members = $$(`[data-round="${n}"]`, inner); const last = members[members.length - 1];
    if (last && last.nextElementSibling !== el) last.after(el);
  }
}

/* ================= inspector: workflow + usage ================= */
function nodeState(r, seatId, round) {
  const m = r.messages.find((x) => x.seatId === seatId && String(x.round) === String(round));
  if (m) return { m, state: m.streaming ? 'running' : (m.error || m.failed) ? 'failed' : 'done' };
  const silent = r.messages.find((x) => x.skip && x.skip.seatId === seatId && String(x.skip.round) === String(round));
  const early = r.messages.find((x) => x.earlyStop);
  const out = typeof round === 'number' && satOut(r, seatId, round);
  if (silent || out || (early && typeof round === 'number' && round > early.earlyStop)) return { state: 'skipped', why: silent ? 'silent agreement' : out ? 'sat out' : 'converged early' };
  return { state: r.status === 'running' ? 'pending' : 'skipped', why: r.status === 'running' ? '' : 'not run' };
}
function stepHtml(title, kind, nodes, extraState) {
  const states = nodes.map((n) => n.state);
  const settled = states.length && states.every((s) => s === 'done' || s === 'skipped' || s === 'failed');
  const begun = states.includes('pending') && states.some((s) => s === 'done' || s === 'failed' || s === 'skipped');
  const st = extraState || (states.includes('running') || begun ? 'running' : settled && states.includes('done') ? 'done'
    : settled && states.includes('failed') ? 'failed' : settled ? 'skipped' : 'pending');
  const mark = st === 'done' ? icon('check', 10) : st === 'running' ? '<span class="dot run" aria-hidden="true"></span>' : st === 'failed' ? icon('x', 10) : st === 'skipped' ? icon('dash', 10) : '';
  return { st, html: `<li class="wf-step ${st}"><span class="mark-s" title="${esc(cap(st === 'pending' ? 'queued' : st))}">${mark}<span class="sr-only">${esc(st === 'pending' ? 'Queued' : cap(st))}</span></span>
    <div class="step-body"><div class="step-head"><span class="step-name">${esc(title)}</span>${kind ? `<span class="step-kind">${esc(kind)}</span>` : ''}</div>
    ${nodes.length ? `<ul class="nodes">${nodes.map(nodeHtml).join('')}</ul>` : ''}</div></li>` };
}
function nodeHtml(n) {
  const s = S.seats[n.seatId], m = n.m, name = esc(s?.name || m?.name || n.seatId);
  const vt = m?.verdict ? `<span class="vt ${m.verdict === 'pass' ? 'pass' : 'fail'}">${m.verdict === 'pass' ? 'PASS' : 'FAIL'}</span>` : '';
  const label = n.label ? ` <small>${esc(n.label)}</small>` : '';
  let cols, st, tip = '';
  if (n.state === 'running') { cols = `<span class="node-tok"></span><span class="node-time" data-since="${esc(m?.ts || s?.startedAt || '')}">${m ? fmtDur(Date.now() - new Date(m.ts)) : ''}</span>`; st = '<span class="spin" role="img" aria-label="Running"></span>'; tip = s?.activity || 'Running'; }
  else if (n.state === 'done' || n.state === 'failed') {
    cols = `<span class="node-tok">${m?.tokens ? fmtTok(m.tokens) : '–'}</span><span class="node-time">${m?.ended ? fmtDur(new Date(m.ended) - new Date(m.ts)) : ''}</span>`;
    st = n.state === 'done' ? `${icon('check', 10)}<span class="sr-only">Done</span>` : `<span class="fail">${icon('x', 10)}</span><span class="sr-only">Failed</span>`; tip = n.state === 'failed' ? m?.error || 'Failed' : 'Jump to this message';
  } else if (n.state === 'skipped') { cols = `<span class="node-q">Skipped</span>`; st = icon('dash', 10); tip = n.why ? `Skipped: ${n.why}` : 'Skipped'; }
  else { cols = '<span class="node-q">Queued</span>'; st = '<span class="dot hollow" aria-hidden="true"></span>'; tip = 'Queued'; }
  const inner = `${avatar(n.seatId, 'xs', m?.agent)}<span class="node-name">${name}${label}${vt}</span>${cols}<span class="node-st">${st}</span>`;
  return `<li>${m ? `<button class="node ${n.state}" data-jump="${esc(m.id)}" title="${esc(tip)}">${inner}</button>` : `<div class="node ${n.state}" title="${esc(tip)}">${inner}</div>`}</li>`;
}
function renderInspector() {
  if (deferRender(renderInspector)) return;
  keepFocus($('#inspector'), paintInspector);
}
function paintInspector() {
  const ins = $('#inspector'); const r = S.rooms[S.active];
  if (!r || r.kind === 'run') { ins.innerHTML = ''; return; } // Home: no inspector (#app.no-ins); a run page has none either
  const steps = [];
  if (r.kind === 'meeting') {
    const N = (id, round, label) => ({ seatId: id, label, ...nodeState(r, id, round) });
    if (r.scoutId) steps.push(stepHtml('Scout', 'reads the code once', [N(r.scoutId, 'scout')]));
    steps.push(stepHtml('Round 1', 'ideas, parallel', (r.seatIds || []).map((id) => N(id, 1))));
    for (let i = 2; i <= r.rounds; i++) steps.push(stepHtml(`Round ${i}`, 'discussion, in order', (r.seatIds || []).map((id) => N(id, i))));
    if (r.synthId) steps.push(stepHtml('Synthesis', 'writes BRAINSTORM.md', [N(r.synthId, 'synthesis')]));
  } else if (r.kind === 'chain') {
    const passedAt = r.messages.find((m) => m.verdict === 'pass')?.round;
    for (let i = 1; i <= r.maxRounds; i++) {
      const nodes = [{ seatId: r.builderId, label: 'propose', ...nodeState(r, r.builderId, i) }, { seatId: r.reviewerId, label: 'review', ...nodeState(r, r.reviewerId, i) }];
      if (passedAt && i > passedAt) nodes.forEach((n) => { n.state = 'skipped'; n.why = 'passed'; });
      steps.push(stepHtml(`Round ${i}`, 'propose → review', nodes));
    }
    const endSt = r.status === 'passed' ? 'done' : r.status === 'running' ? 'pending' : r.status === 'error' ? 'failed' : 'skipped';
    steps.push(stepHtml(r.status === 'passed' ? 'Passed review' : r.status === 'needs-you' ? 'Your decision' : 'Result', '', [], endSt));
  } else if (r.kind === 'plan') {
    const N = (id, round, label) => ({ seatId: id, label, ...nodeState(r, id, round) });
    if (r.scoutId) steps.push(stepHtml('Scout', 'reads the code once', [N(r.scoutId, 'scout')]));
    for (let i = 1; (r.seatIds || []).length && i <= (r.rounds || 1); i++) steps.push(stepHtml(`Round ${i}`, i === 1 ? 'ideas, parallel' : 'discussion', (r.seatIds || []).map((id) => N(id, i))));
    steps.push(stepHtml('Plan', 'manager writes the plan', [N(r.managerId, 'plan')]));
    steps.push(stepHtml('Approval', 'you decide', [], r.status === 'approved' ? 'done' : r.status === 'rejected' ? 'failed' : 'pending'));
  } else if (r.kind === 'build') {
    // One step per planned item; the states come from the item records (the room event carries them).
    const BS = { pending: 'pending', blocked: 'pending', building: 'running', checking: 'running', reviewing: 'running', passed: 'done', applied: 'done',
      discarded: 'skipped', 'needs-you': 'failed', failed: 'failed', quarantined: 'failed', 'apply-failed': 'failed' };
    for (const it of itemsOf(r)) {
      const st = BS[it.status] || 'pending';
      const nodes = [it.builderId, it.reviewerId].filter(Boolean).map((seatId) => ({ seatId, label: itemText(it.status), state: st }));
      steps.push(stepHtml(it.title || it.id, it.difficulty || '', nodes, st));
    }
  } else {
    const turns = r.messages.filter((m) => (r.kind === 'ask' ? isAgentMsg(m) : m.seatId === r.seatId));
    steps.push(stepHtml('Conversation', `${turns.length} turn${turns.length === 1 ? '' : 's'}`, turns.length ? turns.map((m) => ({ seatId: m.seatId, label: hhmm(m.ts), m, state: m.streaming ? 'running' : (m.error || m.failed) ? 'failed' : 'done' })) : [{ seatId: r.seatId, state: 'pending', label: 'waiting for a message' }]));
  }
  const cur = steps.findIndex((s) => s.st === 'running' || s.st === 'pending');
  const aside = r.status === 'running' && cur >= 0 && r.kind !== 'dm' ? `Step ${cur + 1} of ${steps.length}` : r.kind === 'dm' ? '' : `${steps.length} steps`;
  // Usage in this session (computed by the server after every agent turn).
  const u = r.usage || {}, per = Object.entries(u.perSeat || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]), max = Math.max(1, ...per.map(([, v]) => v));
  const done = r.messages.filter((m) => isAgentMsg(m) && !m.streaming).length;
  const planned = r.kind === 'meeting' ? (r.scoutId ? 1 : 0) + (r.seatIds || []).length * (r.rounds || 1) + (r.synthId ? 1 : 0) : r.kind === 'chain' ? 2 * (r.maxRounds || 1) : 0;
  const turns = r.status === 'running' && planned ? `${done}<small>/${planned}</small>` : String(done);
  const close = `<button class="icon-btn panel-close" data-close-ins aria-label="Close panel">${icon('x', 14)}</button>`;
  ins.innerHTML = `<section class="panel" aria-labelledby="wfH"><header class="panel-head"><h2 id="wfH">Workflow</h2><span class="aside">${esc(aside)}</span>${close}</header>
      <div class="wf-cols eyebrow" aria-hidden="true"><span class="c-tok">Tok</span><span class="c-time">Time</span></div>
      <ol class="wf-steps">${steps.map((s) => s.html).join('')}</ol></section>
    <section class="panel" aria-labelledby="usH"><header class="panel-head"><h2 id="usH">Usage</h2><span class="aside">this session</span></header>
      <div class="tiles">
        <div class="tile" title="Net tokens: uncached input + output"><span class="eyebrow">Tokens</span><span class="tile-val">${fmtTok(u.tokens || 0)}</span></div>
        <div class="tile" title="Claude Code cost reported by the CLI (Codex reports none)"><span class="eyebrow">Cost</span><span class="tile-val">${fmtCost(u.cost || 0)}</span></div>
        <div class="tile" title="${r.status === 'running' && planned ? `${done} finished of up to ${planned} agent turns` : `${done} agent turns`}"><span class="eyebrow">Turns</span><span class="tile-val">${turns}</span></div>
      </div>
      <div class="ulist-head"><span class="eyebrow">By agent</span><span class="note-r">net · ${fmtTok(u.cached || 0)} cached</span></div>
      ${per.length ? `<div class="ulist" role="list" aria-label="Net tokens by agent">${per.map(([id, v]) => `<div class="urow" role="listitem">${avatar(id, 'xs')}<span>${esc(S.seats[id]?.name || id)}</span><span class="meter" aria-hidden="true"><i style="width:${(v / max) * 100}%"></i></span><span class="v">${fmtTok(v)}</span></div>`).join('')}</div>` : '<div class="hint">No usage yet</div>'}
    </section>`;
  $$('[data-jump]', ins).forEach((el) => el.onclick = () => { jumpTo(el.dataset.jump); if (window.innerWidth <= 1023) setPanel('show-ins', false); });
  $('[data-close-ins]', ins).onclick = () => { setPanel('show-ins', false); $('#insBtn')?.focus(); };
  tickTimers();
}
let insTimer = null;
const scheduleInspector = () => { if (insTimer) return; insTimer = setTimeout(() => { insTimer = null; renderInspector(); }, 150); };
function tickTimers() {
  $$('[data-since]').forEach((el) => { if (el.dataset.since) el.textContent = fmtDur(Date.now() - new Date(el.dataset.since)); });
  $$('[data-reset]').forEach((el) => { el.textContent = el.dataset.reset ? 'resets in ' + countdown(Number(el.dataset.reset)) : ''; });
  if (paintedStaleSig !== null && meterStaleSig() !== paintedStaleSig) renderMeters();
}
setInterval(tickTimers, 1000);

/* ================= overlays (dialogs) ================= */
let lastFocus = null, lastFocusKey = null, overlayOpts = {};
function closeOverlay() {
  if (!$('#overlay').children.length) return;
  $('#overlay').innerHTML = ''; overlayOpts = {};
  const f = lastFocus, key = lastFocusKey; lastFocus = null; lastFocusKey = null;
  if (f && f.isConnected && typeof f.focus === 'function') return f.focus();
  // The opener was re-rendered while the dialog was open (e.g. an agent row after an edit): focus its replacement.
  const again = findByKey(document, key);
  if (again) again.focus({ preventScroll: true });
}
// Escape / scrim: never throw away a dialog that has typed text (Cancel / X still close it).
function softClose() { if (overlayOpts.locked) return; const m = $('#overlay [role="dialog"]'); if (m && $$('textarea', m).some((t) => t.value.trim())) return; closeOverlay(); }
function overlay(html, cls = 'modal', opts = {}) {
  lastFocus = document.activeElement; lastFocusKey = focusKey(lastFocus); overlayOpts = opts;
  $('#overlay').innerHTML = `<div class="scrim"></div><div class="${cls}" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">${html}</div>`;
  $('#overlay .scrim').onclick = softClose;
  const box = $('#overlay .' + cls.split(' ')[0]);
  const first = box.querySelector('textarea, input:not([type=hidden]):not([type=checkbox]), select') || box.querySelector('.modal-f .btn.primary, .modal-f .btn') || box.querySelector('button');
  first?.focus();
  return box;
}
const closeBtn = () => `<button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>`;
const focusables = (root) => $$('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])', root).filter((el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null) || el === document.activeElement);
// Grouped toggle buttons (Workflow, Runtime, Effort, Theme) behave as a radio group for assistive tech.
const seg = (id, items, cur, label, attr = 'data-v') => `<div class="seg" id="${id}" role="radiogroup" aria-label="${esc(label)}">${items.map(([v, t]) => `<button type="button" role="radio" aria-checked="${v === cur}" ${attr}="${v}" class="${v === cur ? 'on' : ''}">${t}</button>`).join('')}</div>`;
const segSet = (root, btn) => $$('button', root).forEach((x) => { const on = x === btn; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
const PRESETS = [
  { id: 'quick', kind: 'meeting', name: 'Quick debate', desc: '2 agents · 1 round · scout, no facilitator', min: 2 },
  { id: 'full', kind: 'meeting', name: 'Full debate', desc: 'all agents · scout + facilitator', min: 2 },
  { id: 'review', kind: 'chain', name: 'Propose → Review', desc: 'proposer + reviewer · 2 rounds', min: 2 },
];
const presetById = (id) => PRESETS.find((p) => p.id === id) || null;
const editing = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
function setPanel(cls, on) {
  const app = $('#app'); app.classList.toggle(cls, on);
  const btn = cls === 'show-side' ? $('#menuBtn') : $('#insBtn'); btn?.setAttribute('aria-expanded', String(!!on));
}
// Ctrl/⌘ K: search sessions (opens the sidebar drawer on a phone).
function focusSearch() {
  if (window.innerWidth <= 719) setPanel('show-side', true);
  const s = $('#search'); s.focus(); s.select();
}
function onKey(e) {
  const dlg = $('#overlay [role="dialog"]');
  if (e.key === 'Tab' && dlg) { // keep focus inside the dialog
    const f = focusables(dlg); if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    // Focus on something inside the dialog that the selector does not know: let the browser move on normally.
    if (i === -1 && dlg.contains(document.activeElement)) return;
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    return;
  }
  if (e.key === 'Escape') {
    if (meterPop) { meterPop = false; renderMeters(); $('#metersBtn')?.focus(); }
    else if (dlg) softClose();
    else if (e.target.id === 'search') { if (e.target.value) { e.target.value = ''; S.query = ''; renderSessions(); } else { e.target.blur(); if ($('#app').classList.contains('show-side')) { setPanel('show-side', false); $('#menuBtn')?.focus(); } } }
    else if ($('#app').classList.contains('show-side')) { setPanel('show-side', false); $('#menuBtn')?.focus(); }
    else if ($('#app').classList.contains('show-ins')) { setPanel('show-ins', false); $('#insBtn')?.focus(); }
    else if (editing(e.target) && e.target.id === 'compose') e.target.blur();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!dlg) focusSearch(); return; }
  if (dlg || editing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { const ta = $('#compose') || $('#askText'); if (ta) { e.preventDefault(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } else toast('No composer here. Open Ask, a Direct chat or a running session.'); }
  else if (e.key === '?') { e.preventDefault(); openHelp(); }
  else if (/^[1-4]$/.test(e.key)) { const m = MODES[Number(e.key) - 1]; if (visibleModes().includes(m)) { e.preventDefault(); setMode(m.id); } }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); newInMode(); }
}
document.addEventListener('keydown', onKey);

function openHelp() {
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">${icon('help')}Help</h2>${closeBtn()}</div>
    <div class="modal-b">
      <div class="label">Keyboard shortcuts</div>
      <dl class="keys">
        <dt><kbd>1</kbd> to <kbd>4</kbd></dt><dd>Switch mode: Ask, Council, Workflow, Runs</dd>
        <dt><kbd>N</kbd></dt><dd>New in the current mode: a chat, a council or a workflow</dd>
        <dt><kbd>${MOD}</kbd><kbd>K</kbd></dt><dd>Search sessions (<kbd>Enter</kbd> opens the first match)</dd>
        <dt><kbd>/</kbd></dt><dd>Focus the composer</dd>
        <dt><kbd>?</kbd></dt><dd>Open this help</dd>
        <dt><kbd>Esc</kbd></dt><dd>Close dialogs, popovers and side panels</dd>
        <dt><kbd>Enter</kbd></dt><dd>Send a message · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</dd>
        <dt><kbd>Tab</kbd></dt><dd>Move between sessions, agents and controls</dd>
      </dl>
      <div class="label">How a session works</div>
      <ul class="plain">
        <li><b>Modes</b>: Ask talks to one model, Council is a Debate, Workflow holds Plan → Build and Propose → Review, Runs follows Claude Code workflow runs (read only).</li>
        <li><b>Debate</b>: optional scout brief → parallel round 1 → discussion rounds (stops early when everyone reports <code class="inline">STANCE: CONVERGED</code>; each round ends with a verdict: Agreed, Contested or Open) → optional synthesis, saved to <code class="inline">.orchestra/BRAINSTORM.md</code>.</li>
        <li><b>Propose → Review</b>: the proposer drafts, the reviewer answers <code class="inline">VERDICT: PASS</code> or <code class="inline">FAIL</code>; repeats until PASS or the round limit.</li>
        <li><b>Direct chat</b>: one agent, with memory of earlier messages.</li>
        <li><b>Plan → Build</b>: an optional debate, then a manager writes a plan of items with difficulty tiers. You approve it (or edit it first), then a build works through the items. Nothing is applied to your checkout until you apply an approved item; the result is staged, never committed.</li>
        <li>Agents read your project and never edit it. A Build session may let an agent edit files, each item inside its own git worktree, only when the agent is allowed to (Agent editor, "May edit files in Build worktrees") and its CLI passed the write check in Settings. Every turn uses your own Claude Code / Codex plan quota.</li>
      </ul>
      <div class="label">Setup</div>
      <p class="hint" style="margin:0 0 8px">Each CLI your agents use must be installed and signed in on this machine; one of the two is enough if all your agents use it.</p>
      <button class="btn" id="hDoctor">${icon('refresh', 14)}Run setup check</button>
    </div>
    <div class="modal-f"><button class="btn" data-close>Close</button></div>`, 'modal sm');
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  $('#hDoctor').onclick = () => { closeOverlay(); S.setupOpen = true; goHome(); runDoctor(); };
}

// preset (from "Run again" / "Continue in Direct chat") uses room field names; stored values use form names.
const CHEAP_MODEL = 'claude-haiku-5-5'; // the server runs a Claude scout's brief on this model unless the seat has a session override (config.js)
const PRESET_MAP = { seatIds: 'participants', scoutId: 'scout', synthId: 'facilitator', rounds: 'rounds', withContext: 'ctx', builderId: 'builder', reviewerId: 'reviewer', maxRounds: 'max', escalate: 'escalate', seatId: 'seat', topic: 'topic', task: 'task', message: 'message', overrides: 'ov', goal: 'goal', councilId: 'councilId' };
// source 'mode': opened from a mode (its home, its New button or N). The mode fixes the workflow, so the kind segment
// is hidden and only the presets of that kind are offered.
const NEW_TITLE = { meeting: 'New council', plan: 'New workflow', chain: 'Single task review' };
function openNew(kind, preset, source) {
  if (kind === 'ask') return setMode('ask');
  if (!KIND[kind]) kind = 'meeting';
  // A plan made from a council (U4) is a New workflow with its kind fixed, as one opened from the Workflow mode is.
  const fromCouncil = !!(preset && preset.councilId);
  const locked = (source === 'mode' || fromCouncil) && !!NEW_TITLE[kind];
  if (!S.order.length) { toast('Add an agent first'); return openAgent(null); }
  const seats = S.order.map((id) => S.seats[id]), has = (id) => !!S.seats[id];
  // Defaults and team presets prefer seats whose CLI passed the setup check, so a first run with only one CLI
  // installed starts with a team that can actually run (the picker still offers every seat).
  const ready = seats.filter((s) => cliReady(s.agent)), pool = ready.length ? ready : seats, order = pool.map((s) => s.id);
  const firstClaude = pool.find((s) => s.agent === 'claude')?.id || order[0], firstCodex = pool.find((s) => s.agent === 'codex')?.id || order[1] || order[0];
  const other = (id) => order.find((x) => x !== id) || S.order.find((x) => x !== id) || id;
  // Two participants: one per CLI when both work, else the first two usable seats, else any two.
  const pair = () => { const two = [...new Set([firstClaude, firstCodex].filter(Boolean))]; for (const x of [...order, ...S.order]) { if (two.length >= 2) break; if (!two.includes(x)) two.push(x); } return two; };
  const stored = (k) => { try { const x = JSON.parse(ls.get('ob.new.' + k) || '{}') || {}; delete x.ov; return x; } catch { return {}; } }; // overrides are per session, never remembered
  const P = {}; for (const [from, to] of Object.entries(PRESET_MAP)) if (preset && from in preset) P[to] = preset[from] ?? '';
  const defaults = {
    meeting: { topic: '', participants: pair(), scout: firstCodex || '', facilitator: firstClaude || '', rounds: 2, ctx: false, ov: {} },
    chain: { task: '', builder: firstClaude, reviewer: firstCodex !== firstClaude ? firstCodex : other(firstClaude), max: 2, escalate: false, ctx: false, ov: {} },
    dm: { seat: firstClaude, message: '' },
    // Plan → Build: the debate participants are optional (none = the manager plans alone); the goal is never remembered.
    plan: { goal: '', participants: [], manager: firstClaude || '', scout: '', facilitator: '', rounds: 1, ctx: false, ov: {} },
  };
  // Team presets: fixed setups the user can pick in one click; the choice is remembered (localStorage, per browser).
  const presetValues = (id) => {
    // Quick keeps the scout: one brief read of the code instead of every participant reading it with tools.
    if (id === 'quick') return { participants: pair(), scout: firstCodex || '', facilitator: '', rounds: 1, ctx: false, ov: {} };
    if (id === 'full') return { participants: order.slice(), scout: firstCodex || '', facilitator: firstClaude || '', rounds: 2, ctx: false, ov: {} };
    if (id === 'review') return { builder: firstClaude, reviewer: firstCodex !== firstClaude ? firstCodex : other(firstClaude), max: 2, escalate: true, ctx: false, ov: {} };
    return {};
  };
  // ignore seats that no longer exist
  const norm = (k, x) => {
    const d = defaults[k];
    if ('participants' in x) { x.participants = (Array.isArray(x.participants) ? x.participants : []).filter(has); if (!x.participants.length) x.participants = d.participants; }
    for (const f of ['scout', 'facilitator']) if (f in x && x[f] && !has(x[f])) x[f] = d[f];
    for (const f of ['builder', 'reviewer', 'seat', 'manager']) if (f in x && !has(x[f])) x[f] = d[f];
    return x;
  };
  const v = {};
  for (const k of Object.keys(defaults)) v[k] = norm(k, { ...defaults[k], ...stored(k), ...(k === kind ? P : {}) });
  let presetId = 'custom';
  if (!preset) { const p = presetById(ls.get('ob.new.preset')); if (p && (p.kind === kind || (source !== 'template' && !locked)) && S.order.length >= p.min) { presetId = p.id; kind = p.kind; Object.assign(v[kind], presetValues(p.id)); } }

  const opt = (sel, none) => (none ? '<option value="">None</option>' : '') + seats.map((s) => `<option value="${esc(s.id)}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} · ${esc(TOOL[s.agent] || s.agent)}</option>`).join('');
  const nums = (list, sel) => [...new Set([...list, Number(sel) || list[1]])].sort((a, b) => a - b).map((n) => `<option ${n === (Number(sel) || list[1]) ? 'selected' : ''}>${n}</option>`).join('');
  const ctxBox = (on, style = '') => `<label class="check-l" style="${style}"><input type="checkbox" id="nCtx" ${on ? 'checked' : ''}> Include project notes (.orchestra PLAN / HANDOFF / LOG)</label>`;
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">${esc(locked ? NEW_TITLE[kind] : 'New session')}</h2>${closeBtn()}</div>
    <div class="modal-b">
      <div ${locked && !PRESETS.some((p) => p.kind === kind) ? 'hidden' : ''}><div class="label" id="nPresetL">Team preset</div>
      <div class="presets" id="nPresets" role="radiogroup" aria-labelledby="nPresetL"></div></div>
      <div ${locked ? 'hidden' : ''}><div class="label" id="nKindL">Workflow</div>
      ${seg('nKind', ['meeting', 'plan', 'chain', 'dm'].map((k) => [k, KIND[k]]), kind, 'Workflow', 'data-k')}</div>
      <div id="nForm"></div>
    </div>
    <div class="modal-f"><span class="hint" id="nCost" role="status" style="margin:0 auto 0 0"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="nGo">Start</button></div>`);
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  const cur = () => box.querySelector('#nKind .on').dataset.k, q = (s) => box.querySelector(s);
  const chips = () => {
    q('#nPresets').innerHTML = [...PRESETS.filter((p) => !locked || p.kind === kind), { id: 'custom', name: 'Custom', desc: 'your last settings' }].map((p) => {
      const dis = p.min && S.order.length < p.min;
      return `<button type="button" role="radio" class="preset ${presetId === p.id ? 'on' : ''}" aria-checked="${presetId === p.id}" data-p="${p.id}" ${dis ? `disabled title="Needs at least ${p.min} agents"` : ''}><b>${esc(p.name)}</b><span>${esc(p.desc)}</span></button>`;
    }).join('');
    $$('#nPresets button', box).forEach((b) => b.onclick = () => {
      read(); presetId = b.dataset.p; const p = presetById(presetId);
      if (p) { Object.assign(v[p.kind], presetValues(p.id)); setKind(p.kind); }
      else { const k = cur(); const keepText = k === 'meeting' ? { topic: v[k].topic } : k === 'chain' ? { task: v[k].task } : { message: v[k].message }; v[k] = norm(k, { ...defaults[k], ...stored(k), ...keepText }); }
      chips(); form();
    });
  };
  const setKind = (k) => { const b = box.querySelector(`#nKind [data-k="${k}"]`); if (b) segSet(q('#nKind'), b); };
  // read the visible form into v[k]
  const read = () => {
    const k = cur(), x = v[k];
    if (k === 'meeting') Object.assign(x, { topic: q('#nTopic').value, scout: q('#nScout').value, facilitator: q('#nSynth').value, rounds: Number(q('#nRounds').value), ctx: q('#nCtx').checked });
    else if (k === 'chain') Object.assign(x, { task: q('#nTask').value, builder: q('#nBuilder').value, reviewer: q('#nReviewer').value, max: Number(q('#nMax').value), escalate: q('#nEsc').checked, ctx: q('#nCtx').checked });
    else if (k === 'plan' && x.councilId) Object.assign(x, { goal: q('#nGoal').value, manager: q('#nManager').value, ctx: q('#nCtx').checked });
    else if (k === 'plan') Object.assign(x, { goal: q('#nGoal').value, manager: q('#nManager').value, scout: q('#nScout').value, facilitator: q('#nSynth').value, rounds: Number(q('#nRounds').value), ctx: q('#nCtx').checked });
    else Object.assign(x, { seat: q('#nSeat').value, message: q('#nMsg').value });
    if (k !== 'dm') {
      x.ov ||= {};
      $$('select[data-ov]', box).forEach((sel) => {
        const o = x.ov[sel.dataset.ov] || {};
        if (sel.value) o[sel.dataset.f] = sel.value; else delete o[sel.dataset.f];
        if (Object.keys(o).length) x.ov[sel.dataset.ov] = o; else delete x.ov[sel.dataset.ov];
      });
    }
  };
  // Seats that take part in the session (their overrides are shown and sent).
  const rolesOf = (k, x) => {
    const ids = k === 'meeting' ? [...x.participants, x.scout, x.facilitator] : k === 'plan' ? [...x.participants, x.scout, x.facilitator, x.manager]
      : k === 'chain' ? [x.builder, x.reviewer] : [];
    return S.order.filter((id) => ids.includes(id));
  };
  // Optional per-session model and effort (empty = the seat's own). A Claude scout's brief runs on Haiku unless its
  // model is set here: the server applies that default to the scout's brief only, never to the seat's other turns.
  const isHaiku = (m) => /haiku/i.test(String(m || ''));
  const scoutModel = (x, id) => (id === x.scout && S.seats[id]?.agent === 'claude' && !x.ov?.[id]?.model ? CHEAP_MODEL : '');
  // The model a seat's turns run on in this session (the scout default is shown for its row).
  const effectiveModel = (x, id) => (x.ov || {})[id]?.model || scoutModel(x, id) || S.seats[id]?.model || '';
  const ovHtml = (k, x, roles) => `<details class="ov-box"${roles.some((id) => Object.keys((x.ov || {})[id] || {}).length) ? ' open' : ''}><summary>Model and effort for this session (optional)</summary>
      <div class="hint" style="margin:6px 0 0">Applies to this session only and is not remembered; the seats keep their own settings.</div>
      ${roles.map((id) => {
        const s = S.seats[id], o = (x.ov || {})[id] || {}, sm = scoutModel(x, id);
        const models = [...new Set([...(S.models[s.agent] || []), o.model].filter(Boolean))];
        const efforts = S.efforts[s.agent] || [];
        const modelOpts = [
          `<option value="">${esc(sm ? `${sm} (scout default)` : `Seat default: ${s.model}`)}</option>`,
          ...(sm ? [`<option value="${esc(s.model)}" ${o.model === s.model ? 'selected' : ''}>Seat default: ${esc(s.model)}</option>`] : []),
          ...models.filter((m) => !(sm && m === s.model)).map((m) => `<option value="${esc(m)}" ${o.model === m ? 'selected' : ''}>${esc(m)}</option>`),
        ].join('');
        return `<div class="ov-row"><span class="ov-name">${esc(s.name)}</span>
          <select class="input" data-ov="${esc(id)}" data-f="model" aria-label="Model for ${esc(s.name)}">${modelOpts}</select>
          <select class="input" data-ov="${esc(id)}" data-f="effort" aria-label="Effort for ${esc(s.name)}"><option value="">Seat default: ${esc(s.effort)}</option>${efforts.map((e) => `<option value="${esc(e)}" ${o.effort === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></div>`;
      }).join('')}
    </details>`;
  // Rebuilt only when the session's seats or the scout change, so an open select keeps its place while the user edits it.
  const renderOv = () => {
    const k = cur(), x = v[k], el = q('#nOv'); if (!el) return;
    const roles = rolesOf(k, x), key = k + ':' + x.scout + ':' + roles.join(',');
    if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = roles.length ? ovHtml(k, x, roles) : ''; }
    // Haiku takes no effort setting, so the effort select is off for a turn that runs on Haiku.
    $$('select[data-f="effort"]', el).forEach((sel) => { const no = isHaiku(effectiveModel(x, sel.dataset.ov)); sel.disabled = no; sel.title = no ? 'Haiku takes no effort setting' : ''; });
  };
  // Overrides as the API takes them: only seats in the session, only values that differ from the seat.
  const ovPayload = (k, x) => {
    const out = {};
    for (const id of rolesOf(k, x)) {
      const o = (x.ov || {})[id] || {}, e = {};
      if (o.model) e.model = o.model;
      if (o.effort && !isHaiku(effectiveModel(x, id))) e.effort = o.effort;
      if (Object.keys(e).length) out[id] = e;
    }
    return out;
  };
  const update = () => {
    read(); const k = cur(), x = v[k];
    // A plan's manager takes up to two turns (plan and one repair).
    const n = k === 'meeting' ? (x.scout ? 1 : 0) + x.participants.length * x.rounds + (x.facilitator ? 1 : 0)
      : k === 'plan' && x.councilId ? 2 // a council plan has no debate: the manager's plan and one repair
      : k === 'plan' ? (x.scout ? 1 : 0) + x.participants.length * x.rounds + (x.facilitator ? 1 : 0) + 2
      : k === 'chain' ? 2 * x.max : 1;
    q('#nCost').textContent = `Up to ${n} agent run${n === 1 ? '' : 's'} · uses your Claude Code / Codex quota`;
    if (k === 'dm') { const s = S.seats[x.seat]; q('#nDmHint').textContent = s ? `Continues your existing chat with ${s.name} (memory: ${s.thread ? 'active' : 'empty'})` : ''; }
    renderOv();
  };
  // Any setup change (not the text) turns the selection into "Custom".
  const customise = () => { if (presetId !== 'custom') { presetId = 'custom'; chips(); } };
  const form = () => {
    const k = cur(), f = q('#nForm'), x = v[k];
    // Debate and plan participants: one toggle per seat (zero or two or more for a plan; two or more for a debate).
    const picks = () => `<div class="label" id="nPicksL">Participants</div><div class="picks" id="nPicks" role="group" aria-labelledby="nPicksL">${seats.map((s) => `<button type="button" class="pick ${x.participants.includes(s.id) ? 'on' : ''}" aria-pressed="${x.participants.includes(s.id)}" data-id="${esc(s.id)}">${avatar(s.id, 'xs')}${esc(s.name)}<span class="pk">${icon('check', 12)}</span></button>`).join('')}</div>`;
    // A plan made from a council (U4) has no debate: its goal, its manager and the council it comes from.
    if (k === 'plan' && x.councilId) f.innerHTML = `
      <label class="label" for="nGoal">Goal</label><textarea class="input" id="nGoal" placeholder="What should be planned and built?">${esc(x.goal)}</textarea>
      <p class="hint" role="note">Made from the council "${esc(councilTitleOf(x.councilId))}": the plan starts from its result, and no debate runs again.</p>
      <div class="grid2"><div><label class="label" for="nManager">Manager</label><select class="input" id="nManager" aria-describedby="nManagerH">${opt(x.manager)}</select><div class="hint" id="nManagerH">Writes the plan and its difficulty tiers</div></div></div>
      <div id="nOv"></div>${ctxBox(x.ctx)}`;
    else if (k === 'plan') f.innerHTML = `
      <label class="label" for="nGoal">Goal</label><textarea class="input" id="nGoal" placeholder="What should be planned and built?">${esc(x.goal)}</textarea>
      ${picks()}<div class="hint" id="nPicksH">Optional: pick none to let the manager plan alone</div>
      <div class="grid3"><div><label class="label" for="nManager">Manager</label><select class="input" id="nManager" aria-describedby="nManagerH">${opt(x.manager)}</select><div class="hint" id="nManagerH">Writes the plan and its difficulty tiers</div></div>
        <div><label class="label" for="nScout">Scout</label><select class="input" id="nScout" aria-describedby="nScoutH">${opt(x.scout, true)}</select><div class="hint" id="nScoutH">Reads the code once for the debate (optional)</div></div>
        <div><label class="label" for="nSynth">Facilitator</label><select class="input" id="nSynth" aria-describedby="nSynthH">${opt(x.facilitator, true)}</select><div class="hint" id="nSynthH">Summarizes the debate (optional)</div></div></div>
      <div class="grid2"><div><label class="label" for="nRounds">Rounds</label><select class="input" id="nRounds" aria-describedby="nRoundsH">${nums([1, 2, 3], x.rounds)}</select><div class="hint" id="nRoundsH">Debate rounds before the plan; stops early on consensus</div></div></div>
      <div id="nOv"></div>${ctxBox(x.ctx)}`;
    else if (k === 'meeting') f.innerHTML = `
      <label class="label" for="nTopic">Topic</label><textarea class="input" id="nTopic" placeholder="What should the agents discuss?">${esc(x.topic)}</textarea>
      ${picks()}
      <div class="grid3"><div><label class="label" for="nScout">Scout</label><select class="input" id="nScout" aria-describedby="nScoutH">${opt(x.scout, true)}</select><div class="hint" id="nScoutH">Reads the code once so others don't have to (saves tokens)</div></div>
        <div><label class="label" for="nSynth">Facilitator</label><select class="input" id="nSynth" aria-describedby="nSynthH">${opt(x.facilitator, true)}</select><div class="hint" id="nSynthH">Summarizes at the end; saved to .orchestra/BRAINSTORM.md</div></div>
        <div><label class="label" for="nRounds">Rounds</label><select class="input" id="nRounds" aria-describedby="nRoundsH">${nums([1, 2, 3, 4], x.rounds)}</select><div class="hint" id="nRoundsH">Stops early on consensus</div></div></div>
      <div id="nOv"></div>${ctxBox(x.ctx)}`;
    else if (k === 'chain') f.innerHTML = `
      <label class="label" for="nTask">Task</label><textarea class="input" id="nTask" placeholder="What should be proposed and reviewed?">${esc(x.task)}</textarea>
      <div class="grid3"><div><label class="label" for="nBuilder">Proposer</label><select class="input" id="nBuilder">${opt(x.builder)}</select></div>
        <div><label class="label" for="nReviewer">Reviewer</label><select class="input" id="nReviewer">${opt(x.reviewer)}</select></div>
        <div><label class="label" for="nMax">Max rounds</label><select class="input" id="nMax">${nums([1, 2, 3], x.max)}</select></div></div>
      <label class="check-l"><input type="checkbox" id="nEsc" ${x.escalate ? 'checked' : ''}> Raise proposer effort after a FAIL</label>
      <div id="nOv"></div>${ctxBox(x.ctx, 'margin-top:6px')}`;
    else f.innerHTML = `<label class="label" for="nSeat">Agent</label><select class="input" id="nSeat">${opt(x.seat)}</select>
      <label class="label" for="nMsg">Message</label><textarea class="input" id="nMsg" placeholder="Ask something…" aria-describedby="nDmHint">${esc(x.message)}</textarea><div class="hint" id="nDmHint"></div>`;
    $$('.pick', f).forEach((p) => p.onclick = () => { const id = p.dataset.id, px = v[cur()], l = px.participants; px.participants = l.includes(id) ? l.filter((y) => y !== id) : [...l, id]; const on = px.participants.includes(id); p.classList.toggle('on', on); p.setAttribute('aria-pressed', String(on)); customise(); update(); });
    f.oninput = update;
    f.onchange = (e) => { if (e.target.tagName !== 'TEXTAREA') customise(); update(); };
    const ta = f.querySelector('textarea'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    update();
  };
  $$('#nKind button', box).forEach((b) => b.onclick = () => { read(); segSet(q('#nKind'), b); if (presetById(presetId)?.kind !== b.dataset.k) customise(); form(); });
  chips(); form();
  const go = q('#nGo');
  go.onclick = async () => {
    if (go.disabled) return;
    read(); const k = cur(), x = v[k]; let r;
    if (k === 'dm' && !x.message.trim()) { toast('Write a message first'); return q('#nMsg')?.focus(); }
    if (k === 'meeting' && !x.topic.trim()) { toast('Write a topic first'); return q('#nTopic')?.focus(); }
    if (k === 'chain' && !x.task.trim()) { toast('Write a task first'); return q('#nTask')?.focus(); }
    if (k === 'plan' && !x.goal.trim()) { toast('Write a goal first'); return q('#nGoal')?.focus(); }
    if (k === 'plan' && x.participants.length === 1) { toast('Pick none or at least 2 participants'); return; }
    if (k === 'plan' && !x.manager) { toast('Choose a manager first'); return q('#nManager')?.focus(); }
    go.disabled = true; go.textContent = 'Starting…';
    try {
      if (k === 'meeting') r = await api('/api/meeting', { topic: x.topic, seatIds: S.order.filter((id) => x.participants.includes(id)), scoutId: x.scout, synthId: x.facilitator, rounds: x.rounds, withContext: x.ctx, overrides: ovPayload(k, x) });
      else if (k === 'chain') r = await api('/api/chain', { task: x.task, builderId: x.builder, reviewerId: x.reviewer, maxRounds: x.max, escalate: x.escalate, withContext: x.ctx, overrides: ovPayload(k, x) });
      else if (k === 'plan') r = await api('/api/plan', planStartBody(x, S.order.filter((id) => x.participants.includes(id)), ovPayload(k, x)));
      else r = await api(`/api/seats/${x.seat}/send`, { text: x.message.trim() });
      const { topic, task, message, goal, ov, councilId, ...keep } = x; // remember the setup, never the text, the council or the overrides
      // A workflow made from a council leaves the remembered setup of New workflow alone.
      if (!councilId) { ls.set('ob.new.kind', k); ls.set('ob.new.' + k, JSON.stringify(keep)); ls.set('ob.new.preset', presetId); }
      closeOverlay(); openRoom(r.roomId);
    } catch {} finally { go.disabled = false; go.textContent = 'Start'; }
  };
}

function openAgent(id) {
  const isNew = !id; const s = isNew ? { name: '', role: '', agent: 'codex', model: S.models.codex?.[0] || '', effort: 'medium', perm: 'read', target: '', budget: 0, color: '#14b8a6' } : S.seats[id];
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">${isNew ? 'New agent' : `${avatar(id, 'xl')}${esc(s.name)}`}</h2>${closeBtn()}</div>
    <div class="modal-b">
      <div class="grid2"><div><label class="label" for="aName">Name</label><input class="input" id="aName" maxlength="24" value="${esc(s.name)}" required></div><div><label class="label" for="aRole">Role</label><input class="input" id="aRole" maxlength="40" value="${esc(s.role || '')}" placeholder="e.g. Reviewer"></div></div>
      <div class="hint">Changing name, role, runtime or scope resets this agent's memory.</div>
      <div class="label" id="aAgentL">Runtime</div>${seg('aAgent', [['claude', 'Claude Code'], ['codex', 'Codex']], s.agent, 'Runtime', 'data-a')}
      <label class="label" for="aModel">Model</label><input class="input" id="aModel" list="aModels" value="${esc(s.model || '')}" placeholder="pick or type a model" style="font-family:var(--font-mono);font-size:12px"><datalist id="aModels"></datalist>
      <div class="label" id="aEffortL">Effort</div><div class="seg" id="aEffort" role="radiogroup" aria-labelledby="aEffortL"></div><div class="hint">Discussion rounds are capped at Medium automatically.</div>
      <details class="adv"><summary>Advanced</summary>
        <div class="label" id="aWriteL">Permission</div>
        <label class="check-l"><input type="checkbox" id="aWrite" aria-describedby="aWriteH" ${s.perm === 'write' ? 'checked' : ''}> May edit files in Build worktrees</label>
        <div class="hint" id="aWriteH"></div>
        <label class="label" for="aTarget">Scope</label><input class="input" id="aTarget" value="${esc(s.target || '')}" placeholder="folder or file inside the project (empty = whole project)" style="font-family:var(--font-mono);font-size:12px">
        <label class="label" for="aBudget">Token budget</label><input class="input" id="aBudget" type="number" min="0" step="10000" value="${s.budget || 0}" aria-describedby="aBudgetH" style="max-width:200px"><div class="hint" id="aBudgetH">0 = unlimited</div>
      </details>
      ${isNew ? '' : `<div class="label">Usage</div><dl class="kv"><dt>Net tokens</dt><dd>${fmtTok(s.used)}</dd><dt>Cached</dt><dd>${fmtTok(s.cached)}</dd><dt>Cost</dt><dd>$${(s.cost || 0).toFixed(3)}</dd><dt>Memory</dt><dd>${s.thread ? 'active' : 'empty'}</dd></dl>`}
    </div>
    <div class="modal-f">${isNew ? '' : `<button class="btn danger" id="aDel" style="margin-right:auto">${icon('trash', 14)}Delete</button><button class="btn" id="aReset">Clear memory</button>`}<button class="btn" data-close>Cancel</button><button class="btn primary" id="aSave">${isNew ? 'Add agent' : 'Save'}</button></div>`, 'drawer');
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  let agent = s.agent, effort = s.effort;
  // Runs only when the runtime changes, so a typed model is never reverted.
  const fillRuntime = () => {
    box.querySelector('#aModels').innerHTML = (S.models[agent] || []).map((m) => `<option value="${esc(m)}">`).join('');
    const list = S.efforts[agent] || [];
    if (!list.includes(effort)) effort = list.includes('medium') ? 'medium' : list[0];
    box.querySelector('#aEffort').innerHTML = list.map((e) => `<button type="button" role="radio" aria-checked="${e === effort}" data-e="${e}" class="${e === effort ? 'on' : ''}">${EFFORT[e] || e}</button>`).join('');
    $$('#aEffort button', box).forEach((b) => b.onclick = () => { effort = b.dataset.e; segSet(box.querySelector('#aEffort'), b); });
  };
  // The write checkbox follows seatWriteBox: a Claude seat needs its CLI to pass the gate, a Codex seat builds in patch mode.
  const syncWrite = () => {
    const cb = box.querySelector('#aWrite'), h = box.querySelector('#aWriteH');
    const w = seatWriteBox(agent, S.capability?.agents?.[agent], !!S.capability);
    cb.disabled = w.disabled;
    h.textContent = w.help;
  };
  box.querySelector('#aWrite').__sync = syncWrite;
  $$('#aAgent button', box).forEach((b) => b.onclick = () => {
    if (b.dataset.a === agent) return;
    agent = b.dataset.a; segSet(box.querySelector('#aAgent'), b);
    box.querySelector('#aModel').value = S.models[agent]?.[0] || ''; fillRuntime(); syncWrite();
  });
  fillRuntime(); syncWrite();
  box.querySelector('#aSave').onclick = async () => {
    const model = box.querySelector('#aModel').value.trim() || S.models[agent]?.[0];
    const aw = box.querySelector('#aWrite');
    // A disabled checkbox keeps the stored permission (never downgraded by a save the gate does not allow to change it).
    const perm = aw.disabled ? (s.perm === 'write' ? 'write' : 'read') : aw.checked ? 'write' : 'read';
    try {
      // color is kept as stored: the board shows the tool mark instead of a per-agent colour.
      await api('/api/seats', { id: isNew ? undefined : id, name: box.querySelector('#aName').value || 'Agent', role: box.querySelector('#aRole').value, agent, model, effort, perm, target: box.querySelector('#aTarget').value, budget: Number(box.querySelector('#aBudget').value) || 0, color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : '#14b8a6' });
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
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">Settings</h2>${closeBtn()}</div>
    <div class="modal-b">
      <label class="label" for="sLang">Agents reply in</label><input class="input" id="sLang" value="${esc(S.settings.lang || 'English')}" placeholder="English" aria-describedby="sLangH">
      <div class="hint" id="sLangH">Applies to new conversations (existing memories keep their language). Saved when you leave the field.</div>
      <label class="check-l"><input type="checkbox" id="sCap" ${S.settings.capEffort === false ? '' : 'checked'}> Cap effort in discussion rounds (Debate: medium at most, saves tokens)</label>
      <div class="label" id="sThemeL">Theme</div>${seg('sTheme', ['system', 'light', 'dark'].map((t) => [t, cap(t)]), ls.get('ob.theme') || 'system', 'Theme', 'data-t')}
      <label class="check-l"><input type="checkbox" id="sNotify" ${notify ? 'checked' : ''}> Desktop notification when a session finishes or needs you</label>
      <div class="label">File edits</div>
      ${capCardHtml()}
      <div class="label">Setup</div>
      <button class="btn" id="sDoctor">${icon('refresh', 14)}Run setup check</button>
    </div>
    <div class="modal-f"><button class="btn" data-close>Close</button></div>`, 'modal sm');
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  bindCap(box);
  $$('#sTheme button', box).forEach((b) => b.onclick = () => { segSet(box.querySelector('#sTheme'), b); applyTheme(b.dataset.t); });
  $('#sDoctor').onclick = () => { closeOverlay(); S.setupOpen = true; goHome(); runDoctor(); };
  const cb = box.querySelector('#sNotify');
  cb.onchange = async () => {
    let want = cb.checked;
    if (want && 'Notification' in window && Notification.permission !== 'granted') {
      if (await Notification.requestPermission() !== 'granted') { want = false; cb.checked = false; toast('Notifications are blocked by the browser'); }
    }
    ls.set('ob.notify', want ? '1' : '0');
  };
  const capBox = box.querySelector('#sCap');
  capBox.onchange = async () => {
    try { await api('/api/settings', { capEffort: capBox.checked }); S.settings.capEffort = capBox.checked; toast(capBox.checked ? 'Discussion effort capped at medium' : 'Discussion rounds use each seat’s effort'); } catch { capBox.checked = S.settings.capEffort !== false; }
  };
  const lang = box.querySelector('#sLang'); let savedLang = S.settings.lang || 'English';
  const saveLang = async () => {
    const val = lang.value.trim() || 'English'; if (val === savedLang) return;
    savedLang = val;
    try { await api('/api/settings', { lang: val }); toast('Language saved'); } catch { savedLang = null; }
  };
  lang.onblur = saveLang;
  lang.onkeydown = (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); saveLang(); } };
}
function applyTheme(t) { ls.set('ob.theme', t); if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }
applyTheme(ls.get('ob.theme') || 'system');
// Top-bar toggle: flips the effective theme; Settings > Theme > System follows the OS again.
function toggleTheme() {
  const t = document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark ? 'light' : 'dark');
}

function notify(title, body) {
  if (ls.get('ob.notify') !== '1' || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try { new Notification(title, { body }); } catch {}
}

/* ================= navigation ================= */
function openRoom(id) {
  id = homeRoomId(id); // a handoff run opens under its plan (U4)
  // The room being left keeps its unsent note: its view is about to be replaced, and the note lives only in that textarea.
  const cur = $('#compose'); if (cur?.dataset.room) keepDraft(cur.dataset.room, cur.value);
  // Leaving the Runs view (for a room, another mode or home) stops its polling and drops its previews (U2).
  if (id || S.view !== 'mode' || S.mode !== 'runs') leaveRuns();
  S.active = id; ls.set('ob.room', id || '');
  // A room listed only in the room index is fetched in full; the view shows "Loading" until it arrives.
  if (id && !S.rooms[id] && S.roomIndex[id]) fetchRoom(id);
  if (id) syncModeTo(S.rooms[id] || S.roomIndex[id]);
  const app = $('#app'); setPanel('show-side', false); app.classList.toggle('no-ins', !id); if (!id) setPanel('show-ins', false);
  paintModeNav(); renderSessions(); id ? renderRoom() : S.view === 'mode' ? renderModeHome(S.mode) : renderHome(); renderInspector();
  document.title = id && S.rooms[id] ? `${S.rooms[id].title} · ${APP}` : id ? APP : S.view === 'mode' ? `${modeById(S.mode)?.label || ''} · ${APP}` : APP;
}
// GET /api/rooms/:id for a room the snapshot did not carry in full. A room deleted meanwhile leaves the list.
const fetchingRooms = new Set();
async function fetchRoom(id) {
  if (fetchingRooms.has(id)) return;
  fetchingRooms.add(id);
  try {
    const room = await api(`/api/rooms/${encodeURIComponent(id)}`, undefined, { toast: false });
    if (!room || room.id !== id) return;
    // A room event that arrived first carries no transcript: the fetched room replaces it unless it already has one.
    const have = S.rooms[id];
    S.rooms[id] = have && have.messages?.length ? have : { messages: [], ...room };
    if (S.active !== id) return;
    renderRoom(); renderInspector(); renderSessions();
    document.title = `${S.rooms[id].title} · ${APP}`;
  } catch (e) {
    if (e.status === 404) { delete S.roomIndex[id]; toast('That session no longer exists'); if (S.active === id) openRoom(null); else renderSessions(); }
    else if (e.message !== 'unauthorized') toast(`Could not open the session: ${e.message}`);
  } finally { fetchingRooms.delete(id); }
}
$('#homeBtn').onclick = goHome;
$('#newBtn').onclick = () => newInMode();
$('#addAgent').onclick = () => openAgent(null);
$('#settingsBtn').onclick = openSettings;
$('#helpBtn').onclick = openHelp;
$('#themeBtn').onclick = toggleTheme;
$('#menuBtn').onclick = () => setPanel('show-side', !$('#app').classList.contains('show-side'));
$('#insBtn').onclick = () => setPanel('show-ins', !$('#app').classList.contains('show-ins'));
$('#main').addEventListener('click', () => { if ($('#app').classList.contains('show-side')) setPanel('show-side', false); });
// Phone drawer scrim: a real element (not a pseudo-element) so a tap on the dimmed area closes the drawer.
$('#sideScrim').addEventListener('click', () => { setPanel('show-side', false); $('#menuBtn')?.focus(); });
$('#searchKbd').textContent = `${MOD} K`;
$('#search').addEventListener('input', (e) => { S.query = e.target.value; renderSessions(); });
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = $('#sessions [data-room]'); if (first) { e.preventDefault(); openRoom(first.dataset.room); } } });

/* ================= live events ================= */
let doctorOnce = false;
// Events that arrive while a snapshot is being fetched are held and replayed on top of it, so the older snapshot
// never overwrites a newer event (a final message, a finished room, an idle seat). 'hello' is never held.
let loadBusy = 0; const held = [];
function dispatch(ev) {
  const h = ev && Object.prototype.hasOwnProperty.call(SSE, ev.t) ? SSE[ev.t] : null;
  if (!h) return;
  try { h(ev); } catch (err) { console.warn(`orchestra: could not apply "${ev.t}" event`, err); }
}
async function load() {
  loadBusy++;
  try { await applySnapshot(); }
  finally { loadBusy--; if (!loadBusy) for (const ev of held.splice(0)) dispatch(ev); }
}
async function applySnapshot() {
  const st = await api('/api/state');
  Object.assign(S, { models: st.models || {}, efforts: st.efforts || {}, limits: st.limits || {}, settings: st.settings || {}, capability: st.capability || null });
  S.seats = {}; S.order = []; (st.seats || []).forEach((s) => { S.seats[s.id] = s; S.order.push(s.id); });
  // apiVersion 2: engines, watch (Runs shows when watch.claude) and the room index the sidebar lists from.
  S.engines = Array.isArray(st.engines) ? st.engines : null; S.watch = st.watch && typeof st.watch === 'object' ? st.watch : null;
  S.roomIndex = {}; (Array.isArray(st.roomIndex) ? st.roomIndex : []).forEach((e) => { if (e && e.id) S.roomIndex[e.id] = e; });
  fixMode();
  const before = S.rooms;
  S.rooms = {}; (st.rooms || []).forEach((r) => { S.rooms[r.id] = { messages: [], ...r }; });
  // A reply still streaming that started before this connection lost its earlier deltas: it waits for its final text.
  for (const r of Object.values(S.rooms)) for (const m of r.messages) if (m.streaming && new Date(m.ts) < connectedAt) (tw[m.id] ||= { shown: '', pending: '' }).gap = true;
  // The server lists only the newest 25 sessions: an open session beyond them stays open (its events still update it).
  if (S.active && !S.rooms[S.active] && before[S.active]) S.rooms[S.active] = before[S.active];
  const prev = S.active, saved = ls.get('ob.room'); if (!S.rooms[S.active] && !S.roomIndex[S.active]) S.active = S.rooms[saved] || S.roomIndex[saved] ? saved : null;
  S.project = st.project || '';
  $('#project').textContent = st.project || ''; $('#project').title = st.project ? `Project: ${st.project}` : '';
  renderMeters(); noteLimitErrors(true); paintModeNav(); renderSessions(); renderAgents();
  // Local environment check, once per page load: first run shows it as onboarding; later only problems are shown.
  if (!doctorOnce) { doctorOnce = true; runDoctor(); }
  loadCapability(); refreshCapCards();
  if (!S.active && demoLanding()) return;
  if (S.active !== prev || !$('#feedInner')) return openRoom(S.active);
  // reconnect to the same room: keep the feed (and its scroll), refresh what may have changed
  const r = S.rooms[S.active];
  renderRoomHead(); renderResultBar(); if ($('#composerArea')?.dataset.mode !== composerMode(r)) renderComposer();
  // Repaint only the bubbles whose content changed since they were last painted.
  const inner = $('#feedInner');
  for (const m of r.messages) {
    const el = inner?.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
    if (el && !m.streaming && el.dataset.k === msgKey(m, r)) continue;
    paintMsg(m, false);
  }
  markResult(); decorate(); renderInspector();
}
// One handler per SSE event type. Unknown types (a newer server) are ignored; a bad event never stops the stream.
const SSE = {
  hello: () => { load().catch(() => {}); },
  seat: (ev) => {
    if (!ev.seat?.id) return;
    const old = S.seats[ev.seat.id], isNew = !old; S.seats[ev.seat.id] = ev.seat; if (isNew) S.order.push(ev.seat.id);
    if (old && old.status !== ev.seat.status) {
      if (ev.seat.status === 'working') announce(`${ev.seat.name} started: ${ev.seat.activity || 'working'}`);
      else if (old.status === 'working') announce(`${ev.seat.name} ${ev.seat.status === 'error' ? 'failed' : 'finished'}`);
    } else if (old && ev.seat.status === 'working' && /^retrying/i.test(ev.seat.activity || '') && old.activity !== ev.seat.activity) announce(`${ev.seat.name}: ${ev.seat.activity}`);
    renderAgents(); scheduleInspector();
    const r = S.rooms[S.active], m = r?.messages?.find((x) => x.streaming && x.seatId === ev.seat.id); if (m) paintMsg(m);
  },
  seatGone: (ev) => { delete S.seats[ev.id]; S.order = S.order.filter((x) => x !== ev.id); renderAgents(); },
  room: (ev) => {
    if (!ev.room?.id) return;
    // Room meta carries no transcript: an unseen room starts with an empty one, a known room keeps its messages.
    const old = S.rooms[ev.room.id], r = S.rooms[ev.room.id] = { messages: [], ...(old || {}), ...ev.room };
    const known = !!(old || S.roomIndex[r.id]);
    S.roomIndex[r.id] = { ...(S.roomIndex[r.id] || {}), id: r.id, kind: r.kind, title: r.title, status: r.status, created: r.created,
      ...(r.planRoomId ? { planRoomId: r.planRoomId } : {}), ...(r.engine ? { engine: r.engine } : {}) };
    if (old && old.status === 'running' && r.status !== 'running' && (r.kind !== 'dm' || document.hidden)) {
      const msg = `${r.title}: ${STATUS[r.status] || r.status}`; toast(msg); notify(APP, msg);
    }
    if (r.id === S.active) syncModeTo(r);
    paintModeNav(); renderSessions();
    if (r.id === S.active) {
      // The POST that created a room can return before this event: build the view once it is known.
      if (!$('#main .main-head')) renderRoom();
      else { renderRoomHead(); renderResultBar(); if ($('#composerArea')?.dataset.mode !== composerMode(r)) renderComposer(); markResult(); decorate(); }
      scheduleInspector();
      if (!old) document.title = `${r.title} · ${APP}`;
    } else if (!S.active && !known && S.view === 'home') renderHome(); // first session ever: the home page loses its first-run framing
    // A run or a build of the plan on screen: its stepper and run card follow (U4).
    if (r.id !== S.active && r.planRoomId && r.planRoomId === S.active) { renderRoomHead(); renderRunCard(); }
  },
  roomGone: (ev) => dropRoom(ev.id),
  msg: (ev) => {
    const r = S.rooms[ev.roomId]; if (!r || !ev.msg?.id) return; // unknown room: its 'room' event / next load brings it
    const i = r.messages.findIndex((x) => x.id === ev.msg.id); if (i >= 0) r.messages[i] = ev.msg; else r.messages.push(ev.msg);
    if (!ev.msg.streaming && tw[ev.msg.id] && !tw[ev.msg.id].pending) delete tw[ev.msg.id];
    if (ev.roomId === S.active) { paintMsg(ev.msg); scheduleInspector(); }
  },
  delta: (ev) => {
    if (!ev.runId) return;
    if (ev.reset) { // a retry or a recovered thread starts the message over: drop what was shown of the failed attempt
      tw[ev.runId] = { shown: '', pending: '' };
      const c = document.querySelector(`#feedInner [data-id="${CSS.escape(ev.runId)}"] .content`);
      if (c) { c.classList.add('raw'); c.innerHTML = '<span class="sr-only">Writing…</span><span class="caret" aria-hidden="true"></span>'; }
      return;
    }
    const st = (tw[ev.runId] ||= { shown: '', pending: '' });
    // Text sent before this connection is gone: what was read stays, the rest waits for the final message (no glued fragments).
    if (st.gap) { st.gap = false; st.gapped = true; const m = findMsg(ev.runId); if (m) paintMsg(m, false); }
    if (st.gapped) return;
    st.pending += ev.text || '';
  },
  item: (ev) => {
    const box = ev.runId && document.querySelector(`#feedInner [data-id="${CSS.escape(ev.runId)}"] .tools`);
    if (!box || !ev.text) return;
    const prefix = ev.kind === 'tool' ? '› ' : ev.kind === 'retry' ? '↻ ' : null; // reasoning and other kinds stay out of the transcript
    if (prefix === null) return;
    const d = document.createElement('div'); d.textContent = prefix + ev.text; box.append(d);
    while (box.children.length > 4) box.firstElementChild.remove();
  },
  limits: (ev) => { S.limits = ev.limits || {}; renderMeters(); noteLimitErrors(); renderBanner(); },
  capability: (ev) => setCapability(ev.capability),
  // One item of a build changed: the record replaces the old one; the card and the inspector follow when it is shown.
  build: (ev) => {
    const r = S.rooms[ev.roomId]; if (!r || !ev.itemId || !ev.item) return;
    (r.items ||= {})[ev.itemId] = ev.item;
    if (ev.roomId === S.active) { renderBuildCard(); scheduleInspector(); }
  },
  // The result of an apply. The toast text is set with textContent, so the error is shown as written.
  apply: (ev) => {
    if (ev.ok) toast('Applied (staged, not committed). Review with git diff --cached.');
    else toast(`Apply failed: ${ev.error || ev.code || 'unknown error'}`);
    if (proposalDialog(ev.roomId, ev.itemId)) openProposal(ev.roomId, ev.itemId, { refresh: true, err: ev.ok ? null : { message: ev.error || 'Apply failed', code: ev.code } });
  },
  settings: (ev) => { S.settings = ev.settings || {}; },
  cli: (ev) => { S.cli = ev.cli || null; },
  // The engine list (plan 2.6): an open Start build dialog follows it.
  engines: (ev) => { if (Array.isArray(ev.engines)) { S.engines = ev.engines; refreshBuildEngines(); } },
  // Claude Code runs (U2): the list when it changes, and one run's summary with its changed agents. Previews never arrive here.
  wfRuns: (ev) => { if (Array.isArray(ev.runs)) setRunsList(ev.runs); },
  wfRun: (ev) => applyRunDelta(ev),
  // A handoff run's summary and changed agents (plan 3.1): the run card follows when it is on screen (U4).
  engine: (ev) => applyEngineEvent(ev),
  run: () => {}, end: () => {},
};
let lastAuthCheck = 0, everConnected = false, connectedAt = 0;
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { connectedAt = Date.now(); S.connected = true; renderConn(); if (everConnected) announce('Live updates reconnected'); everConnected = true; };
  es.onerror = () => {
    S.connected = false; renderConn();
    // EventSource hides HTTP status; find out whether the session cookie expired (at most once per 10 s).
    if (!gated && Date.now() - lastAuthCheck > 10000) { lastAuthCheck = Date.now(); fetch('/api/state', { credentials: 'same-origin' }).then((r) => { if (r.status === 401) authGate(); }).catch(() => {}); }
  };
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (loadBusy && ev?.t !== 'hello') { held.push(ev); return; }
    dispatch(ev);
  };
}
renderConn(); paintModeNav(); renderSessions(); connect(); twLoop();
