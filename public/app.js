/* Orchestra Board frontend — plain script, no build step. State, rendering, SSE client, API calls. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, style = '') => `<svg class="i" aria-hidden="true"${style ? ` style="${style}"` : ''}><use href="#i-${id}"/></svg>`;
const fmtTok = (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); };
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const hhmm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const initials = (n) => String(n || '?').trim().charAt(0).toUpperCase();
const EFFORT = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const STATUS = { running: 'Running', done: 'Done', passed: 'Passed', 'needs-you': 'Needs you', stopped: 'Stopped', error: 'Error', idle: 'Idle' };
const lastLine = (t) => (t || '').trim().split(/\r?\n/).pop().replace(/[*`_]/g, '').trim();
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
// The board only answers localhost, so the browser's platform is the server's platform.
const isWin = /^Win/i.test(navigator.userAgentData?.platform || navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
const MOD = isMac ? '⌘' : 'Ctrl';

/* ================= session token =================
   The server signs this browser in with a cookie when the board is opened from the URL it prints; that URL carries the
   board's token (per project, persisted in .orchestra/session). Drop it from the address bar immediately so it is never
   bookmarked, shared or sent again — later requests rely on the cookie only (same-origin fetch and EventSource send it
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
    <div class="modal-b"><p style="margin-top:14px">This board only answers a browser the server has signed in. Go back to the terminal where <code class="inline">orchestra-board</code> is running and open the link it printed: it sets a session cookie for this browser. The link itself is not needed again.</p>
    <p class="hint">This browser's session does not match this board — most likely a different project is running on this port, or the board's <code class="inline">.orchestra/session</code> file was deleted or rotated. A plain server restart keeps the session valid.</p></div>
    <div class="modal-f"><button class="btn primary" id="gReload">Reload</button></div>`, 'modal sm', { locked: true });
  $('#gReload').onclick = () => location.reload();
}

async function api(p, b) {
  const r = await fetch(p, { credentials: 'same-origin', ...(b !== undefined ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {}) });
  if (r.status === 401) { authGate(); throw new Error('unauthorized'); }
  let j; try { j = await r.json(); } catch { j = { error: `HTTP ${r.status}` }; }
  if (j && j.error) { toast(j.error); throw new Error(j.error); }
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
    try { document.execCommand('copy'); } catch { ta.remove(); return toast('Copy failed — select the text and copy it manually'); }
    ta.remove();
  }
  toast(what);
}
function download(name, text, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copyText(b.dataset.copy, b.dataset.copyMsg || 'Copied to clipboard'); });

const S = { seats: {}, order: [], rooms: {}, active: null, models: {}, efforts: {}, limits: {}, settings: {}, connected: false, doctor: null, setupOpen: false };
const roundLabel = (round) => typeof round === 'number' ? `Round ${round}` : round ? String(round).replace(/^./, (c) => c.toUpperCase()) : '';
const seatColor = (id) => S.seats[id]?.color || 'var(--text-3)';
const avatar = (id, cls = '') => { const s = S.seats[id]; return `<span class="av ${cls} ${s?.status === 'working' ? 'working' : ''}" style="--c:${s?.color || 'var(--text-3)'}" aria-hidden="true">${initials(s?.name || id)}</span>`; };
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
// Failures recorded by the limits module (failed Haiku probe, missing CLI, API-key login without usage windows).
const limitErrors = () => Object.entries(S.limits || {}).filter(([, l]) => l && l.error).map(([agent, l]) => ({ agent, error: String(l.error), at: l.errorAt }));
function renderMeters() {
  const groups = meterGroups(), errs = limitErrors(), errOf = (agent) => errs.find((e) => e.agent === agent);
  const meters = groups.map(([agent, ws]) => {
    const m = ws.reduce((a, b) => (b.pct > a.pct ? b : a));
    const col = m.pct >= 90 ? 'var(--bad)' : m.pct >= 75 ? 'var(--warn)' : agent === 'claude' ? 'var(--claude)' : 'var(--codex)';
    const err = errOf(agent);
    return `<span class="meter"><span class="top"><span>${cliName(agent)} <b>${pctTxt(m.pct)}</b> · ${WIN[m.k] || m.k}</span>${err ? `<span class="dot warn" title="${esc(err.error)}"></span><span class="sr-only">last refresh failed</span>` : ''}</span><span class="bar" role="progressbar" aria-label="${cliName(agent)} ${WIN[m.k] || m.k} usage" aria-valuenow="${Math.round(m.pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${m.pct}%;background:${col}"></i></span><span class="sub" data-reset="${m.resetsAt || ''}">resets in ${countdown(m.resetsAt)}</span></span>`;
  }).join('');
  const label = groups.length ? `Updated ${groups[0][1][0].updated ? hhmm(groups[0][1][0].updated) : '—'} · all windows` : errs.length ? 'Usage refresh failed — open for details' : 'No usage data yet — open to refresh';
  // Popover: one section per CLI that has windows or an error; always offers the Claude refresh.
  const agents = [...new Set([...groups.map(([a]) => a), ...errs.map((e) => e.agent)])].sort((a, b) => (a === 'claude' ? 0 : 1) - (b === 'claude' ? 0 : 1));
  const section = (agent, i) => {
    const ws = (groups.find(([a]) => a === agent) || [, []])[1], err = errOf(agent);
    return `<div class="mpop-h" style="margin-top:${i ? 10 : 0}px">${cliName(agent)}</div>
      ${ws.map((m) => `<div class="mpop-r"><span>${WIN[m.k] || m.k}</span><b>${pctTxt(m.pct)}</b><span class="sub" data-reset="${m.resetsAt || ''}">resets in ${countdown(m.resetsAt)}</span></div>`).join('')}
      ${err ? `<div class="mpop-err" role="alert">${icon('alert', 'width:13px;height:13px')}<span><b>Refresh failed${err.at ? ` at ${hhmm(err.at)}` : ''}.</b> ${esc(err.error)}</span></div>` : ''}`;
  };
  const pop = !meterPop ? '' : `<div class="mpop" id="mpop" role="group" aria-label="Usage limits">${agents.map(section).join('') || '<div class="hint" style="margin:0">No usage data yet. Claude usage appears after the first agent run or a refresh; Codex usage is read from the newest Codex session.</div>'}
    <button class="btn sm" id="mProbe">Refresh Claude usage (one Haiku call, under $0.01)</button></div>`;
  const inner = meters || `<span class="hint" style="margin:0;display:inline-flex;align-items:center;gap:6px">${errs.length ? '<span class="dot warn" aria-hidden="true"></span>Usage refresh failed' : 'Usage appears after the first agent run'}</span>`;
  $('#meters').innerHTML = `<button class="meter-btn" id="metersBtn" title="${esc(label)}" aria-expanded="${meterPop}" aria-controls="mpop" aria-label="Usage limits${errs.length ? ' (last refresh failed)' : ''}">${inner}</button>${pop}`;
  $('#metersBtn').onclick = () => { meterPop = !meterPop; renderMeters(); if (meterPop) $('#mProbe')?.focus(); else $('#metersBtn')?.focus(); };
  $('#mProbe') && ($('#mProbe').onclick = async () => { try { await api('/api/limits/refresh', {}); toast('Refreshing usage…'); } catch {} });
}
// A new failure (errorAt changed) gets a short toast; the details live in the meter popover.
const seenErrAt = {};
function noteLimitErrors(silent = false) {
  for (const e of limitErrors()) { if (e.at && seenErrAt[e.agent] !== e.at) { seenErrAt[e.agent] = e.at; if (!silent) toast(`${cliName(e.agent)} usage refresh failed — open the usage meter for details`); } }
}
document.addEventListener('click', (e) => { if (meterPop && !e.composedPath().includes($('#meters'))) { meterPop = false; renderMeters(); } });
function budgetWarning() {
  const c = S.limits?.claude; const w = c?.windows?.seven_day;
  if (!w || !c.updated || Date.now() - new Date(c.updated) > 6 * 3600e3) return null;
  return w.pct >= 80 ? w.pct : null;
}
function renderConn() { $('#conn').innerHTML = `<span class="dot ${S.connected ? 'ok' : 'bad'}" aria-hidden="true"></span><span class="txt">${S.connected ? 'Live' : 'Reconnecting'}</span>`; $('#conn').title = S.connected ? 'Live updates connected' : 'Live updates disconnected — reconnecting'; }

/* ================= sidebar ================= */
function renderSessions() {
  const list = Object.values(S.rooms).sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.created.localeCompare(a.created));
  const TAG = { 'needs-you': 1, error: 1, stopped: 1, passed: 1 };
  // Each row is a native <button> inside its own role="listitem" wrapper, so it stays exposed as a button.
  $('#sessions').innerHTML = list.length ? list.map((r) => `<div role="listitem"><button class="row ${r.id === S.active ? 'on' : ''}" data-room="${r.id}" ${r.id === S.active ? 'aria-current="page"' : ''} title="${esc(new Date(r.created).toLocaleString())}">
      <span class="kind" aria-hidden="true">${icon(kindIcon(r.kind), 'width:14px;height:14px')}</span>
      <span class="t">${esc(r.title)}<span class="sub">${KIND[r.kind] || r.kind}${r.usage?.tokens ? ' · ' + fmtTok(r.usage.tokens) + ' tok' : ''}</span></span>
      ${r.status === 'running' ? '<span class="dot live" aria-label="running"></span>' : TAG[r.status] ? `<span class="pill ${r.status}" style="height:18px;padding:0 7px;font-size:10.5px">${STATUS[r.status]}</span>` : `<span class="m">${ago(r.created)}</span>`}</button></div>`).join('')
    : '<div class="hint" style="padding:4px 8px">No sessions yet</div>';
  $$('#sessions [data-room]').forEach((el) => el.onclick = () => openRoom(el.dataset.room));
}
function renderAgents() {
  $('#agents').innerHTML = S.order.map((id) => { const s = S.seats[id]; return `<div role="listitem"><button class="row" data-seat="${id}" title="${esc([`Effort: ${EFFORT[s.effort] || s.effort}`, s.activity].filter(Boolean).join(' · '))}">
      ${avatar(id)}<span class="t">${esc(s.name)}<span class="sub">${s.status === 'working' ? `<span style="color:var(--warn)">${esc(s.activity || 'working')}…</span>` : s.status === 'error' ? `<span style="color:var(--bad)">error</span>` : esc([s.role, s.model].filter(Boolean).join(' · '))}</span></span>
      <span class="dot ${s.status === 'working' ? 'live' : s.status === 'error' ? 'bad' : ''}" aria-hidden="true"></span></button></div>`; }).join('') || '<div class="hint" style="padding:4px 8px">No agents — add one with +</div>';
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
// a project file shadowing the binary): agents would fail on every turn, so it blocks like a fail.
const CLI_CHECK = (c) => /^(claude|codex)$/i.test(c.id) || /\bCLI\b/.test(c.name);
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
    // Raw verdict for the CLI as found; whether it actually blocks depends on the seats (isBlocking, at render time).
    n.blocking = n.st === 'fail' || (n.st === 'warn' && !n.skipped && CLI_CHECK(n));
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
async function runDoctor() {
  S.doctor = { loading: true, checks: S.doctor?.checks || [], error: null, at: S.doctor?.at };
  renderSetup();
  try { const r = await fetch('/api/doctor', { credentials: 'same-origin' }); if (r.status === 401) { authGate(); return; } const j = await r.json(); if (j?.error) throw new Error(j.error); S.doctor = { loading: false, checks: normChecks(j), error: null, at: Date.now() }; }
  catch (e) { S.doctor = { loading: false, checks: [], error: e.message || String(e), at: Date.now() }; }
  renderSetup();
  const n = doctorProblems().length;
  if (S.doctor.at && !S.doctor.loading) announce(S.doctor.error ? 'Setup check failed to run' : n ? `Setup check: ${n} problem${n === 1 ? '' : 's'} found` : 'Setup check passed');
}
const cmdRow = (cmd, note = '') => `<div class="cmd"><code>${esc(cmd)}</code>${note ? `<span class="hint" style="margin:0;flex:none">${esc(note)}</span>` : ''}<button class="btn sm" data-copy="${esc(cmd)}" data-copy-msg="Command copied" aria-label="Copy command: ${esc(cmd)}">${icon('copy', 'width:13px;height:13px')}Copy</button></div>`;
const stateTxt = (c) => c.st === 'ok' ? 'OK' : c.skipped ? 'Skipped' : c.blocking && !isBlocking(c) ? 'Optional' : c.st === 'fail' ? (/not found|not installed|does not exist/i.test(c.detail) ? 'Missing' : 'Failed') : c.blocking ? 'Blocked' : 'Check';
function checkRow(c) {
  const blocking = isBlocking(c), optional = c.blocking && !blocking, st = optional ? 'warn' : c.st;
  const ic = st === 'ok' ? 'check' : st === 'warn' && !blocking ? 'alert' : 'x';
  // For a CLI problem: who depends on it, and how to go on with the other CLI alone.
  const users = c.cli && c.st !== 'ok' ? seatsOn(c.cli) : null;
  const who = !users ? '' : users.length
    ? `<div class="hint" style="color:var(--text-2)">Used by ${users.map((s) => esc(s.name)).join(', ')}. To go on without ${cliName(c.cli)}, switch ${users.length === 1 ? 'that agent' : 'those agents'} to the other runtime (open the agent and change Runtime) or delete ${users.length === 1 ? 'it' : 'them'}.</div>`
    : `<div class="hint" style="color:var(--text-2)">No agent uses the ${cliName(c.cli)} CLI, so this does not block you. Install it when you add a ${cliName(c.cli)} agent.</div>`;
  return `<div class="check ${st} ${blocking ? 'blocking' : ''}" role="listitem"><span class="check-ic">${icon(ic, 'width:13px;height:13px')}</span>
    <div class="check-b"><b>${esc(c.name)}</b>${c.detail ? `<div class="hint">${esc(c.detail)}</div>` : ''}${who}${c.hint ? `<div class="hint" style="color:var(--text-2)">${esc(c.hint)}</div>` : ''}${c.fix ? cmdRow(c.fix, c.fixNote) : ''}${c.url ? `<div class="hint"><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.url.replace(/^https?:\/\//, ''))}</a></div>` : ''}</div>
    <span class="state">${stateTxt(c)}</span></div>`;
}
const stepHint = (t) => t ? `<div class="hint" style="color:var(--text-2)">${esc(t)}</div>` : '';
const genericSteps = () => `<div class="steps" role="list">
    <div class="step" role="listitem"><b>1. Claude CLI</b>${cmdRow(FIX.claudeInstall, FIX_NOTE.claudeInstall)}${stepHint(FIX_HINT.claudeInstall)}${cmdRow(FIX.claudeLogin, FIX_NOTE.claudeLogin)}</div>
    <div class="step" role="listitem"><b>2. Codex CLI</b>${FIX.codexInstall ? cmdRow(FIX.codexInstall) : ''}${stepHint(FIX_HINT.codexInstall)}${isWin ? `<div class="hint"><a href="${FIX_URL.codexInstall}" target="_blank" rel="noopener noreferrer">github.com/openai/codex/releases</a></div>` : ''}${cmdRow(FIX.codexLogin, FIX_NOTE.codexLogin)}</div>
    <div class="hint">Run these in ${isWin ? 'PowerShell' : 'a terminal'}, then re-check. One CLI is enough if every agent uses it. Both use your own plan quota; the board never calls an API directly.</div></div>`;
function setupHtml(firstRun) {
  const d = S.doctor, problems = doctorProblems();
  const head = firstRun
    ? `<h2 id="setupTitle">Welcome — let's check your setup</h2><p class="lead">Orchestra Board drives the Claude and Codex CLIs installed on this machine. Each CLI your agents use must be installed and signed in; one of the two is enough if all your agents use it.</p>`
    : `<h2 id="setupTitle">Setup check</h2>`;
  let body;
  if (!d || d.loading && !d.checks.length) body = '<div class="hint" style="margin:10px 0">Checking the environment…</div>';
  else if (d.error) body = `<div class="check fail"><span class="check-ic">${icon('x', 'width:13px;height:13px')}</span><div class="check-b"><b>Could not run the check</b><div class="hint">${esc(d.error)}</div></div></div><p class="hint">What a working setup needs:</p>${genericSteps()}`;
  else if (!d.checks.length) body = `<p class="hint" style="margin-top:8px">The environment check reported no results, so nothing could be verified automatically. Make sure both CLIs are installed and signed in:</p>${genericSteps()}`;
  else body = `<div class="checks" role="list">${d.checks.map(checkRow).join('')}</div>${problems.length ? `<p class="hint">Fix the items marked <b>Missing</b>, <b>Failed</b> or <b>Blocked</b>, then re-check. Agents on a CLI the board cannot launch fail on every turn.</p>` : `<div class="ok-line">${icon('check')}Everything looks good — start a session below.</div>`}`;
  return `<section class="setup" aria-labelledby="setupTitle" aria-busy="${!!d?.loading}">${head}${body}
    <div class="setup-f"><button class="btn sm" id="setupRecheck" ${d?.loading ? 'disabled' : ''}>${icon('refresh', 'width:13px;height:13px')}${d?.loading ? 'Checking…' : 'Re-check'}</button>
      ${problems.length ? '' : '<button class="btn sm ghost" id="setupHide">Hide</button>'}
      ${d?.at ? `<span class="hint">Checked ${hhmm(d.at)}</span>` : ''}</div></section>`;
}
function bindSetup() {
  $('#setupRecheck') && ($('#setupRecheck').onclick = runDoctor);
  $('#setupHide') && ($('#setupHide').onclick = () => { ls.set('ob.setup.hide', '1'); S.setupOpen = false; renderHome(); $('#setupOpen')?.focus(); });
}
// Re-renders only the setup card (keeps the rest of the home page and the focused control). A change in whether
// the card is shown at all, or a missing home page, falls back to the full render.
function renderSetup() {
  if (S.active) return;
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
  slot.innerHTML = warn ? `<div class="banner" role="status">${icon('alert')}<span><b>Claude weekly usage is at ${warn.toFixed(0)}%.</b> Consider Codex agents for heavy work.</span></div>` : '';
}

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
  // The permission line reflects the seats as configured (write is opt-in via .orchestra/seats.json, see the agent editor).
  const writers = seats.filter((s) => s.perm === 'write');
  const permTxt = writers.length ? `${esc(writers.map((s) => s.name).join(', '))} ${writers.length === 1 ? 'has' : 'have'} write permission and can edit files; the other agents only read.` : 'Agents can read your project but never edit it.';
  $('#main').innerHTML = `<div id="bannerSlot"></div>
    <div class="home">
      ${showSetup ? setupHtml(firstRun) : ''}
      <h2 id="homeTitle">Start a session</h2><p class="lead">Agents are Claude or Codex CLI runs with a role. Every turn uses your plan quota. ${permTxt}</p>
      <div class="tpls">
        <button class="tpl" data-tpl="meeting"><span class="ic">${icon('users')}</span><b>Debate</b><span>A scout reads the code once, agents give independent ideas, discuss, and a facilitator writes the synthesis.</span></button>
        <button class="tpl" data-tpl="chain"><span class="ic">${icon('loop')}</span><b>Propose → Review</b><span>One agent proposes a change, another reviews it with a PASS/FAIL verdict, looping until it passes.</span></button>
        <button class="tpl" data-tpl="dm"><span class="ic">${icon('chat')}</span><b>Direct chat</b><span>A direct conversation with a single agent that remembers previous messages.</span></button>
      </div>
      <div class="foot-hint">${tok || cost ? `<span class="hint" style="margin:0">This project so far: ${fmtTok(tok)} tokens · $${cost.toFixed(2)} Claude</span>` : ''}
        ${showSetup ? '' : `<button class="btn link" id="setupOpen" style="font-size:12px">Check setup</button>`}<button class="btn link" id="helpOpen" style="font-size:12px">Shortcuts <kbd>?</kbd></button></div>
    </div>`;
  renderBanner();
  $$('#main [data-tpl]').forEach((b) => b.onclick = () => openNew(b.dataset.tpl, null, 'template'));
  bindSetup();
  $('#setupOpen') && ($('#setupOpen').onclick = () => { S.setupOpen = true; runDoctor(); });
  $('#helpOpen') && ($('#helpOpen').onclick = openHelp);
}

/* ================= main: room ================= */
// Full build of the room view. Runs only when the active room changes (openRoom) or the view is missing.
function renderRoom() {
  const r = S.rooms[S.active];
  if (!r) { $('#main').innerHTML = '<div class="empty" role="status">Starting session…</div>'; return; }
  $('#main').innerHTML = `<div class="head"></div><div class="resultbar" id="resultBar" hidden></div>
    <div class="feed" id="feed" aria-label="Transcript"><div class="feed-inner" id="feedInner"></div></div>
    <div class="composer" id="composerArea"></div>`;
  renderRoomHead(); renderResultBar(); renderComposer();
  r.messages.forEach((m) => paintMsg(m, false));
  if (!r.messages.length) $('#feedInner').innerHTML = '<div class="empty">No messages yet.</div>';
  const f = $('#feed'); f.scrollTop = f.scrollHeight;
}
// Repaints only the header: title, pills, Stop, Run again, Export, Delete.
function renderRoomHead() {
  const r = S.rooms[S.active], h = $('#main .head'); if (!r || !h) return;
  const total = r.kind === 'meeting' ? r.rounds : r.kind === 'chain' ? r.maxRounds : null;
  const roundTxt = total ? (typeof r.round === 'number' ? `${roundLabel(r.round)} of ${total}` : roundLabel(r.round)) : '';
  const live = r.status === 'running', dm = r.kind === 'dm';
  const ready = dm && !live && r.status !== 'error';
  const statusTxt = dm ? (live ? 'Replying' : ready ? 'Ready' : STATUS[r.status] || r.status) : STATUS[r.status] || r.status;
  h.innerHTML = `
      <div class="kind" aria-hidden="true">${icon(kindIcon(r.kind), 'width:14px;height:14px')}</div>
      <h1 title="${esc(r.topic || r.task || r.title)}">${esc(r.title)}</h1>
      <span class="pill">${KIND[r.kind] || r.kind}</span>${roundTxt ? `<span class="pill">${esc(roundTxt)}</span>` : ''}<span class="pill ${ready ? 'idle' : r.status}" role="status">${live ? '<span class="dot live" aria-hidden="true"></span>' : ''}${esc(statusTxt)}</span>
      ${live ? `<button class="btn sm danger" id="stopRoom">${icon('stop', 'width:13px;height:13px')}Stop</button>` : ''}
      ${!live && !dm ? '<button class="btn sm" id="againRoom">Run again</button>' : ''}
      ${r.messages.length ? `<button class="btn sm ghost icon" id="exportRoom" title="Export transcript (.md)" aria-label="Export transcript as Markdown">${icon('download', 'width:14px;height:14px')}</button>` : ''}
      <button class="btn sm ghost icon" id="delRoom" title="Delete session" aria-label="Delete session">${icon('trash', 'width:14px;height:14px')}</button>`;
  $('#stopRoom') && ($('#stopRoom').onclick = () => api(`/api/rooms/${r.id}/stop`, {}).catch(() => {}));
  $('#againRoom') && ($('#againRoom').onclick = () => openNew(r.kind, roomPreset(r)));
  $('#exportRoom') && ($('#exportRoom').onclick = () => exportTranscript(r));
  $('#delRoom').onclick = () => { if (confirm('Delete this session and its transcript?')) api(`/api/rooms/${r.id}/delete`, {}).catch(() => {}); };
}
// Result summary for a finished Debate / Propose → Review: where the synthesis or verdict is, and what to do next.
function resultInfo(r) {
  if (!r || r.kind === 'dm' || r.status === 'running') return null;
  const res = (r.resultId && r.messages.find((m) => m.id === r.resultId)) || null;
  const name = (id) => S.seats[id]?.name || id;
  let title, sub;
  if (r.status === 'stopped') { title = 'Stopped'; sub = res ? 'Stopped after a result was written.' : 'The session was stopped before it produced a result.'; }
  else if (r.status === 'error') { title = 'Failed'; sub = 'The session hit an error — see the last line of the transcript.'; }
  else if (r.kind === 'meeting') {
    if (res) { title = 'Synthesis ready'; sub = `Written by ${esc(res.name)} and saved to .orchestra/BRAINSTORM.md.`; }
    else if (r.synthId) { title = 'Debate finished'; sub = `The synthesis turn by ${esc(name(r.synthId))} did not complete; the discussion is still in the transcript.`; }
    else { title = 'Debate finished'; sub = 'No facilitator was set, so there is no synthesis. Export the transcript, or run again with a facilitator.'; }
  } else {
    const rev = esc(name(r.reviewerId)), bld = esc(name(r.builderId));
    const failed = [...r.messages].reverse().find((m) => m.seatId !== 'system' && m.seatId !== 'user' && m.error);
    if (r.status === 'passed') { title = `Passed review${typeof res?.round === 'number' ? ` in round ${res.round}` : ''}`; sub = `${rev} approved ${bld}'s proposal. The verdict is the result.`; }
    else if (failed && !res) { title = 'Needs your decision'; sub = `${esc(failed.name)}'s turn failed: ${esc(failed.error)}`; }
    else { title = 'Needs your decision'; sub = `Round limit reached without a PASS from ${rev}. Read the last review, then run again or continue in Direct chat.`; }
  }
  return { res, title, sub };
}
function renderResultBar() {
  const r = S.rooms[S.active], el = $('#resultBar'); if (!el) return;
  const info = resultInfo(r);
  if (!info) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false; el.className = `resultbar ${r.status}`; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Result');
  const ic = r.status === 'passed' || r.status === 'done' ? 'check' : r.status === 'stopped' ? 'stop' : 'alert';
  el.innerHTML = `<span class="rb-ic">${icon(ic)}</span><div class="rb-t"><b>${info.title}</b><span>${info.sub}</span></div>
    <div class="rb-a">${info.res ? `<button class="btn sm primary" id="rbJump">${icon('target', 'width:13px;height:13px')}Jump to ${r.kind === 'chain' ? 'verdict' : 'synthesis'}</button><button class="btn sm" id="rbCopy">${icon('copy', 'width:13px;height:13px')}Copy as Markdown</button>` : ''}
      <button class="btn sm" id="rbExport">${icon('download', 'width:13px;height:13px')}Export transcript</button></div>`;
  $('#rbJump') && ($('#rbJump').onclick = () => jumpTo(info.res.id));
  $('#rbCopy') && ($('#rbCopy').onclick = () => copyText(resultMd(r, info.res), 'Result copied as Markdown'));
  $('#rbExport').onclick = () => exportTranscript(r);
}
const cleanText = (t) => (t || '').replace(/\n?\s*\**STANCE:\s*\w+\**\s*$/i, '').replace(/\n?\s*\**VERDICT:\s*\w+\**\s*$/i, '').trim();
function resultMd(r, m) {
  const head = r.kind === 'chain' ? `## Review verdict: ${m.verdict === 'pass' ? 'PASS' : 'FAIL'} — ${r.title}` : `## Synthesis — ${r.title}`;
  return `${head}\n\n_${KIND[r.kind]} · ${m.name} · ${new Date(m.ts).toLocaleString()}_\n\n${cleanText(m.text)}\n`;
}
function transcriptMd(r) {
  const name = (id) => S.seats[id]?.name || id;
  const L = [`# ${r.title}`, '', `- Workflow: ${KIND[r.kind] || r.kind}`, `- Status: ${STATUS[r.status] || r.status}`, `- Started: ${new Date(r.created).toLocaleString()}`];
  if (r.kind === 'meeting') { L.push(`- Participants: ${(r.seatIds || []).map(name).join(', ')}`, `- Rounds: ${r.rounds}`); if (r.scoutId) L.push(`- Scout: ${name(r.scoutId)}`); if (r.synthId) L.push(`- Facilitator: ${name(r.synthId)}`); if (r.topic) L.push('', `**Topic:** ${r.topic}`); }
  else if (r.kind === 'chain') { L.push(`- Proposer: ${name(r.builderId)}`, `- Reviewer: ${name(r.reviewerId)}`, `- Max rounds: ${r.maxRounds}`); if (r.task) L.push('', `**Task:** ${r.task}`); }
  else L.push(`- Agent: ${name(r.seatId)}`);
  if (r.usage?.tokens) L.push('', `_Usage: ${r.usage.tokens} net tokens · ${r.usage.cached || 0} cached · $${(r.usage.cost || 0).toFixed(3)} Claude_`);
  L.push('', '---');
  let lastRound;
  for (const m of r.messages) {
    if (m.seatId === 'system') { L.push('', `> _${m.text}_`); continue; }
    if (m.seatId !== 'system' && m.seatId !== 'user' && m.round !== undefined && String(m.round) !== String(lastRound)) { lastRound = m.round; L.push('', `## ${roundLabel(m.round)}`); }
    const who = m.seatId === 'user' ? 'You' : m.name;
    const meta = [m.label, hhmm(m.ts), m.tokens ? `${m.tokens} tokens` : '', m.verdict ? `VERDICT: ${m.verdict.toUpperCase()}` : '', m.id === r.resultId ? (r.kind === 'chain' ? 'RESULT' : 'SYNTHESIS') : ''].filter(Boolean).join(' · ');
    L.push('', `### ${who}${meta ? ` — ${meta}` : ''}`, '', m.streaming ? '_(still writing)_' : (m.text || (m.error ? '' : '_(no text)_')));
    if (m.error) L.push('', `_Error: ${m.error}_`);
  }
  return L.join('\n') + '\n';
}
function exportTranscript(r) {
  download(`orchestra-${r.kind}-${slug(r.title)}-${new Date(r.created).toISOString().slice(0, 10)}.md`, transcriptMd(r));
  toast('Transcript downloaded');
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
      <textarea class="input" id="compose" rows="1" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"></textarea>
      <button class="btn primary icon" id="sendBtn" aria-label="Send" style="height:38px;width:38px">${icon('send')}</button>
    </div><div class="hint">${mode === 'dm' ? `<kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line · <kbd>/</kbd> focuses this box` : 'Interject: your note goes to the next agent turn.'}</div>`;
  const ta = $('#compose');
  if (draft) { ta.value = draft; ta.focus(); }
  ta.oninput = () => { ta.style.height = '38px'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; };
  // An IME (Japanese, Chinese, Korean) confirms a candidate with Enter: never send a half-composed message.
  ta.onkeydown = (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('#sendBtn').onclick = send;
}
function markResult() {
  const r = S.rooms[S.active];
  $$('#feedInner .msg.result').forEach((el) => { if (el.dataset.id !== r?.resultId) { el.classList.remove('result'); const m = findMsg(el.dataset.id); if (m) paintMsg(m, false); } });
  if (r?.resultId) { const m = findMsg(r.resultId); if (m) paintMsg(m, false); }
}
function jumpTo(id) {
  const t = document.querySelector(`#feedInner [data-id="${id}"]`); if (!t) return;
  t.scrollIntoView({ block: 'center' }); t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
  t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true });
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
  if (m.seatId === 'system') return `<div class="sysline" data-id="${m.id}" role="note">${esc(m.text)}</div>`;
  const isUser = m.seatId === 'user';
  return `<article class="msg ${isUser ? 'user' : ''}" data-id="${m.id}" style="--c:${isUser ? 'var(--text-2)' : m.color || seatColor(m.seatId)}">
    ${isUser ? '<div class="av" aria-hidden="true">Y</div>' : `<div class="av" style="--c:${m.color || seatColor(m.seatId)}" aria-hidden="true">${initials(m.name)}</div>`}
    <div class="body"><div class="meta"></div><div class="content"></div><div class="tools" aria-label="Tool calls"></div><div class="foot"></div></div></article>`;
}
function paintMsg(m, scroll = true) {
  const inner = $('#feedInner'), r = S.rooms[S.active]; if (!inner || !r?.messages.some((x) => x.id === m.id)) return;
  inner.querySelector('.empty')?.remove();
  let el = inner.querySelector(`[data-id="${m.id}"]`);
  const f = $('#feed'), near = f.scrollHeight - f.scrollTop - f.clientHeight < 140;
  if (!el) {
    const msgs = r.messages, i = msgs.findIndex((x) => x.id === m.id), prev = msgs.slice(0, i).reverse().find((x) => x.seatId !== 'system' && x.seatId !== 'user');
    if (m.seatId !== 'system' && m.seatId !== 'user' && m.round !== undefined && (!prev || String(prev.round) !== String(m.round))) {
      inner.insertAdjacentHTML('beforeend', `<div class="sysline" role="separator" aria-label="${esc(roundLabel(m.round))}">${esc(roundLabel(m.round))}</div>`);
    }
    inner.insertAdjacentHTML('beforeend', msgHtml(m)); el = inner.lastElementChild;
  }
  if (m.seatId === 'system') return;
  const isResult = m.id === r.resultId;
  el.classList.toggle('streaming', !!m.streaming);
  el.classList.toggle('result', isResult);
  const s = S.seats[m.seatId];
  if (m.seatId === 'user') el.querySelector('.meta').innerHTML = `<b>You</b><span class="tag">${hhmm(m.ts)}</span>`;
  else {
    const stance = !m.streaming && /^STANCE:/i.test(lastLine(m.text)) ? (/CONVERGED/i.test(lastLine(m.text)) ? '<span class="stance yes">Converged</span>' : '<span class="stance">Open</span>') : '';
    const resTag = isResult ? `<span class="res">${r.kind === 'chain' ? 'Verdict' : 'Synthesis'}</span>` : '';
    const acts = !m.streaming && m.text ? `<span class="mact"><button class="btn ghost sm icon tiny" data-copy-msg="${isResult ? 'Result copied as Markdown' : 'Message copied'}" data-copy="${esc(isResult ? resultMd(r, m) : cleanText(m.text))}" title="Copy as Markdown" aria-label="Copy ${esc(m.name)}'s message as Markdown">${icon('copy', 'width:13px;height:13px')}</button></span>` : '';
    el.querySelector('.meta').innerHTML = `<b>${esc(m.name)}</b><span class="tag">${esc(m.label || '')}</span>${m.verdict ? `<span class="verdict ${m.verdict}">${m.verdict === 'pass' ? 'PASS' : 'FAIL'}</span>` : ''}${stance}${resTag}${m.streaming && s?.activity ? `<span class="act" role="status">${esc(s.activity)}…</span>` : ''}${acts}`;
    const foot = el.querySelector('.foot');
    foot.innerHTML = m.streaming ? '' : [hhmm(m.ts), m.ended ? fmtDur(new Date(m.ended) - new Date(m.ts)) : '', m.tokens ? `${fmtTok(m.tokens)} tokens` : ''].filter(Boolean).map(esc).join('<span aria-hidden="true">·</span>');
    foot.title = m.streaming ? '' : [m.cached ? `${fmtTok(m.cached)} cached` : '', m.cost ? '$' + m.cost.toFixed(3) : '', m.effort ? (EFFORT[m.effort] || m.effort) + ' effort' : '', m.tools === 'none' ? 'no tools' : ''].filter(Boolean).join(' · ');
  }
  const c = el.querySelector('.content'), st = tw[m.id];
  if (m.streaming) { if (!st || (!st.shown && !st.pending)) c.innerHTML = '<span class="typing" role="status" aria-label="waiting for text"><i></i><i></i><i></i></span>'; }
  else if (!st || !st.pending) {
    c.classList.remove('raw'); c.innerHTML = md(cleanText(m.text)) + (m.error ? `<div class="err" role="alert">${esc(m.error)}</div>` : '');
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
    if (el) { el.classList.add('raw'); el.textContent = st.shown; el.insertAdjacentHTML('beforeend', '<span class="caret" aria-hidden="true"></span>'); const f = $('#feed'); if (f && f.scrollHeight - f.scrollTop - f.clientHeight < 160) f.scrollTop = f.scrollHeight; }
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
  return `<div class="wf-stage ${st}"><div class="wf-marker" aria-hidden="true"></div><div class="wf-title">${esc(title)}${parallel ? '<span class="pill" style="height:18px;font-size:10.5px">parallel</span>' : ''}<span class="m">${meta}</span></div>
    <div class="wf-nodes ${parallel ? 'par' : ''}">${nodes.map(nodeHtml).join('')}</div></div>`;
}
const STATE_TXT = { done: 'done', failed: 'failed', skipped: 'skipped', running: 'running', pending: 'pending' };
function nodeHtml(n) {
  const s = S.seats[n.seatId], m = n.m;
  const ic = n.state === 'done' ? icon('check', 'width:14px;height:14px;color:var(--ok)') : n.state === 'failed' ? icon('alert', 'width:14px;height:14px;color:var(--bad)') : n.state === 'skipped' ? icon('skip', 'width:14px;height:14px;color:var(--text-3)') : n.state === 'running' ? icon('clock', 'width:14px;height:14px;color:var(--warn)') : icon('clock', 'width:14px;height:14px;color:var(--text-3)');
  const extra = m?.verdict ? `<span class="verdict ${m.verdict}" style="height:16px;font-size:10px">${m.verdict.toUpperCase()}</span>` : '';
  const stat = n.state === 'running' && s?.startedAt ? `<span class="s" data-since="${s.startedAt}"></span>` : m && !m.streaming && m.tokens ? `<span class="s">${fmtTok(m.tokens)}${m.ended ? ' · ' + fmtDur(new Date(m.ended) - new Date(m.ts)) : ''}</span>` : n.why ? `<span class="s">${n.why}</span>` : '';
  const inner = `${avatar(n.seatId, 'xs')}<span class="n">${esc(s?.name || n.seatId)} <small>${esc(n.label || '')}</small></span>${extra}${stat}${ic}<span class="sr-only">${STATE_TXT[n.state] || n.state}</span>`;
  return m ? `<button class="wf-node ${n.state}" data-jump="${m.id}" title="Jump to this message">${inner}</button>` : `<div class="wf-node ${n.state}">${inner}</div>`;
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
    flow += `<div class="wf-stage ${r.status === 'passed' ? 'done' : ''}"><div class="wf-marker" aria-hidden="true"></div><div class="wf-title">${r.status === 'passed' ? 'Passed review' : r.status === 'needs-you' ? 'Your decision' : 'Result'}</div></div>`;
  } else {
    const turns = r.messages.filter((m) => m.seatId === r.seatId);
    flow = stage('Conversation', turns.length ? turns.map((m) => ({ seatId: m.seatId, label: hhmm(m.ts), m, state: m.streaming ? 'running' : m.error ? 'failed' : 'done' })) : [{ seatId: r.seatId, state: 'pending', label: 'waiting for a message' }]);
  }
  // usage in this session (computed by the server after every agent turn)
  const u = r.usage, per = Object.entries(u?.perSeat || {}).filter(([, v]) => v > 0), max = Math.max(1, ...per.map(([, v]) => v));
  ins.innerHTML = `<div class="ins-sec"><h2 class="ins-h">Workflow</h2>${flow}</div>
    <div class="ins-sec"><h2 class="ins-h">Usage ${u?.tokens ? `<span style="text-transform:none;letter-spacing:0">${fmtTok(u.tokens)} net</span>` : ''}</h2>
      ${per.map(([id, v]) => `<div class="usage-row">${avatar(id, 'xs')}<span style="width:56px;overflow:hidden;text-overflow:ellipsis">${esc(S.seats[id]?.name || id)}</span><div class="bar" role="img" aria-label="${esc(S.seats[id]?.name || id)}: ${fmtTok(v)} tokens"><i style="width:${(v / max) * 100}%;background:${seatColor(id)}"></i></div><span class="v">${fmtTok(v)}</span></div>`).join('') || '<div class="hint">No usage yet</div>'}
      <dl class="kv" style="margin-top:10px">${u ? `<dt>Cached input</dt><dd>${fmtTok(u.cached)}</dd><dt>Claude cost</dt><dd>$${(u.cost || 0).toFixed(3)}</dd>` : ''}<dt>Started</dt><dd>${hhmm(r.created)}</dd></dl></div>`;
  $$('[data-jump]', ins).forEach((el) => el.onclick = () => { jumpTo(el.dataset.jump); if (window.innerWidth <= 1180) setPanel('show-ins', false); });
  tickTimers();
}
let insTimer = null;
const scheduleInspector = () => { if (insTimer) return; insTimer = setTimeout(() => { insTimer = null; renderInspector(); }, 150); };
function tickTimers() {
  $$('[data-since]').forEach((el) => { el.textContent = fmtDur(Date.now() - new Date(el.dataset.since)); });
  $$('[data-reset]').forEach((el) => { el.textContent = el.dataset.reset ? 'resets in ' + countdown(Number(el.dataset.reset)) : ''; });
}
setInterval(tickTimers, 1000);

/* ================= overlays (dialogs) ================= */
let lastFocus = null, overlayOpts = {};
function closeOverlay() { if (!$('#overlay').children.length) return; $('#overlay').innerHTML = ''; overlayOpts = {}; const f = lastFocus; lastFocus = null; if (f && f.isConnected && typeof f.focus === 'function') f.focus(); }
// Escape / scrim: never throw away a dialog that has typed text (Cancel / X still close it).
function softClose() { if (overlayOpts.locked) return; const m = $('#overlay [role="dialog"]'); if (m && $$('textarea', m).some((t) => t.value.trim())) return; closeOverlay(); }
function overlay(html, cls = 'modal', opts = {}) {
  lastFocus = document.activeElement; overlayOpts = opts;
  $('#overlay').innerHTML = `<div class="scrim"></div><div class="${cls}" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">${html}</div>`;
  $('#overlay .scrim').onclick = softClose;
  const box = $('#overlay .' + cls.split(' ')[0]);
  const first = box.querySelector('textarea, input:not([type=hidden]):not([type=checkbox]), select') || box.querySelector('.modal-f .btn.primary, .modal-f .btn') || box.querySelector('button');
  first?.focus();
  return box;
}
const closeBtn = () => `<button class="btn ghost icon" data-close aria-label="Close">${icon('x')}</button>`;
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
// Default workflow for Ctrl+K / New session: the remembered team preset, else the last workflow used.
const newKind = () => presetById(ls.get('ob.new.preset'))?.kind || ls.get('ob.new.kind') || 'meeting';
const editing = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
function setPanel(cls, on) {
  const app = $('#app'); app.classList.toggle(cls, on);
  const btn = cls === 'show-side' ? $('#menuBtn') : $('#insBtn'); btn?.setAttribute('aria-expanded', String(!!on));
}
document.addEventListener('keydown', (e) => {
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
    else if ($('#app').classList.contains('show-side')) { setPanel('show-side', false); $('#menuBtn')?.focus(); }
    else if ($('#app').classList.contains('show-ins')) { setPanel('show-ins', false); $('#insBtn')?.focus(); }
    else if (editing(e.target) && e.target.id === 'compose') e.target.blur();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!dlg) openNew(newKind()); return; }
  if (dlg || editing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { const ta = $('#compose'); if (ta) { e.preventDefault(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } else toast('No composer here — open a Direct chat or a running session'); }
  else if (e.key === '?') { e.preventDefault(); openHelp(); }
});

function openHelp() {
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">${icon('help')}Help</h2>${closeBtn()}</div>
    <div class="modal-b">
      <div class="label">Keyboard shortcuts</div>
      <dl class="keys">
        <dt><kbd>${MOD}</kbd><kbd>K</kbd></dt><dd>New session</dd>
        <dt><kbd>/</kbd></dt><dd>Focus the composer</dd>
        <dt><kbd>?</kbd></dt><dd>Open this help</dd>
        <dt><kbd>Esc</kbd></dt><dd>Close dialogs, popovers and side panels</dd>
        <dt><kbd>Enter</kbd></dt><dd>Send a message · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</dd>
        <dt><kbd>Tab</kbd></dt><dd>Move between sessions, agents and controls</dd>
      </dl>
      <div class="label">How a session works</div>
      <ul class="plain">
        <li><b>Debate</b>: optional scout brief → parallel round 1 → discussion rounds (stops early when everyone reports <code class="inline">STANCE: CONVERGED</code>) → optional synthesis, saved to <code class="inline">.orchestra/BRAINSTORM.md</code>.</li>
        <li><b>Propose → Review</b>: the proposer drafts, the reviewer answers <code class="inline">VERDICT: PASS</code> or <code class="inline">FAIL</code>; repeats until PASS or the round limit.</li>
        <li><b>Direct chat</b>: one agent, with memory of earlier messages.</li>
        <li>Agents read your project and never edit it, unless a seat has <code class="inline">perm: write</code> in <code class="inline">.orchestra/seats.json</code> (v0.1 has no toggle for it in the UI). Every turn uses your own Claude / Codex plan quota.</li>
      </ul>
      <div class="label">Setup</div>
      <p class="hint" style="margin:0 0 8px">Each CLI your agents use must be installed and signed in on this machine; one of the two is enough if all your agents use it.</p>
      <button class="btn sm" id="hDoctor">${icon('refresh', 'width:13px;height:13px')}Run setup check</button>
    </div>
    <div class="modal-f"><button class="btn" data-close>Close</button></div>`, 'modal sm');
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  $('#hDoctor').onclick = () => { closeOverlay(); S.setupOpen = true; openRoom(null); runDoctor(); };
}

// preset (from "Run again" / "Continue in Direct chat") uses room field names; stored values use form names.
const PRESET_MAP = { seatIds: 'participants', scoutId: 'scout', synthId: 'facilitator', rounds: 'rounds', withContext: 'ctx', builderId: 'builder', reviewerId: 'reviewer', maxRounds: 'max', escalate: 'escalate', seatId: 'seat', topic: 'topic', task: 'task', message: 'message' };
function openNew(kind, preset, source) {
  if (!KIND[kind]) kind = 'meeting';
  if (!S.order.length) { toast('Add an agent first'); return openAgent(null); }
  const seats = S.order.map((id) => S.seats[id]), has = (id) => !!S.seats[id];
  // Defaults and team presets prefer seats whose CLI passed the setup check, so a first run with only one CLI
  // installed starts with a team that can actually run (the picker still offers every seat).
  const ready = seats.filter((s) => cliReady(s.agent)), pool = ready.length ? ready : seats, order = pool.map((s) => s.id);
  const firstClaude = pool.find((s) => s.agent === 'claude')?.id || order[0], firstCodex = pool.find((s) => s.agent === 'codex')?.id || order[1] || order[0];
  const other = (id) => order.find((x) => x !== id) || S.order.find((x) => x !== id) || id;
  // Two participants: one per CLI when both work, else the first two usable seats, else any two.
  const pair = () => { const two = [...new Set([firstClaude, firstCodex].filter(Boolean))]; for (const x of [...order, ...S.order]) { if (two.length >= 2) break; if (!two.includes(x)) two.push(x); } return two; };
  const stored = (k) => { try { return JSON.parse(ls.get('ob.new.' + k) || '{}') || {}; } catch { return {}; } };
  const P = {}; for (const [from, to] of Object.entries(PRESET_MAP)) if (preset && from in preset) P[to] = preset[from] ?? '';
  const defaults = {
    meeting: { topic: '', participants: pair(), scout: firstCodex || '', facilitator: firstClaude || '', rounds: 2, ctx: false },
    chain: { task: '', builder: firstClaude, reviewer: firstCodex !== firstClaude ? firstCodex : other(firstClaude), max: 2, escalate: false, ctx: false },
    dm: { seat: firstClaude, message: '' },
  };
  // Team presets: fixed setups the user can pick in one click; the choice is remembered (localStorage, per browser).
  const presetValues = (id) => {
    // Quick keeps the scout: one brief read of the code instead of every participant reading it with tools.
    if (id === 'quick') return { participants: pair(), scout: firstCodex || '', facilitator: '', rounds: 1, ctx: false };
    if (id === 'full') return { participants: order.slice(), scout: firstCodex || '', facilitator: firstClaude || '', rounds: 2, ctx: false };
    if (id === 'review') return { builder: firstClaude, reviewer: firstCodex !== firstClaude ? firstCodex : other(firstClaude), max: 2, escalate: true, ctx: false };
    return {};
  };
  // ignore seats that no longer exist
  const norm = (k, x) => {
    const d = defaults[k];
    if ('participants' in x) { x.participants = (Array.isArray(x.participants) ? x.participants : []).filter(has); if (!x.participants.length) x.participants = d.participants; }
    for (const f of ['scout', 'facilitator']) if (f in x && x[f] && !has(x[f])) x[f] = d[f];
    for (const f of ['builder', 'reviewer', 'seat']) if (f in x && !has(x[f])) x[f] = d[f];
    return x;
  };
  const v = {};
  for (const k of Object.keys(defaults)) v[k] = norm(k, { ...defaults[k], ...stored(k), ...(k === kind ? P : {}) });
  let presetId = 'custom';
  if (!preset) { const p = presetById(ls.get('ob.new.preset')); if (p && (p.kind === kind || source !== 'template') && S.order.length >= p.min) { presetId = p.id; kind = p.kind; Object.assign(v[kind], presetValues(p.id)); } }

  const opt = (sel, none) => (none ? '<option value="">None</option>' : '') + seats.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} · ${esc(s.model)}</option>`).join('');
  const nums = (list, sel) => [...new Set([...list, Number(sel) || list[1]])].sort((a, b) => a - b).map((n) => `<option ${n === (Number(sel) || list[1]) ? 'selected' : ''}>${n}</option>`).join('');
  const ctxBox = (on, style = '') => `<label class="check-l" style="${style}"><input type="checkbox" id="nCtx" ${on ? 'checked' : ''}> Include project notes (.orchestra PLAN / HANDOFF / LOG)</label>`;
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">New session</h2>${closeBtn()}</div>
    <div class="modal-b">
      <div class="label" id="nPresetL">Team preset</div>
      <div class="presets" id="nPresets" role="radiogroup" aria-labelledby="nPresetL"></div>
      <div class="label" id="nKindL">Workflow</div>
      ${seg('nKind', ['meeting', 'chain', 'dm'].map((k) => [k, KIND[k]]), kind, 'Workflow', 'data-k')}
      <div id="nForm"></div>
    </div>
    <div class="modal-f"><span class="hint" id="nCost" role="status" style="margin:0 auto 0 0;align-self:center"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="nGo">Start</button></div>`);
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  const cur = () => box.querySelector('#nKind .on').dataset.k, q = (s) => box.querySelector(s);
  const chips = () => {
    q('#nPresets').innerHTML = [...PRESETS, { id: 'custom', name: 'Custom', desc: 'your last settings' }].map((p) => {
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
    else Object.assign(x, { seat: q('#nSeat').value, message: q('#nMsg').value });
  };
  const update = () => {
    read(); const k = cur(), x = v[k];
    const n = k === 'meeting' ? (x.scout ? 1 : 0) + x.participants.length * x.rounds + (x.facilitator ? 1 : 0) : k === 'chain' ? 2 * x.max : 1;
    q('#nCost').textContent = `Up to ${n} agent run${n === 1 ? '' : 's'} · uses your Claude/Codex quota`;
    if (k === 'dm') { const s = S.seats[x.seat]; q('#nDmHint').textContent = s ? `Continues your existing chat with ${s.name} (memory: ${s.thread ? 'active' : 'empty'})` : ''; }
  };
  // Any setup change (not the text) turns the selection into "Custom".
  const customise = () => { if (presetId !== 'custom') { presetId = 'custom'; chips(); } };
  const form = () => {
    const k = cur(), f = q('#nForm'), x = v[k];
    if (k === 'meeting') f.innerHTML = `
      <label class="label" for="nTopic">Topic</label><textarea class="input" id="nTopic" placeholder="What should the agents discuss?">${esc(x.topic)}</textarea>
      <div class="label" id="nPicksL">Participants</div><div class="picks" id="nPicks" role="group" aria-labelledby="nPicksL">${seats.map((s) => `<button type="button" class="pick ${x.participants.includes(s.id) ? 'on' : ''}" aria-pressed="${x.participants.includes(s.id)}" data-id="${s.id}">${avatar(s.id, 'xs')}${esc(s.name)}</button>`).join('')}</div>
      <div class="grid3"><div><label class="label" for="nScout">Scout</label><select class="input" id="nScout" aria-describedby="nScoutH">${opt(x.scout, true)}</select><div class="hint" id="nScoutH">Reads the code once so others don't have to (saves tokens)</div></div>
        <div><label class="label" for="nSynth">Facilitator</label><select class="input" id="nSynth" aria-describedby="nSynthH">${opt(x.facilitator, true)}</select><div class="hint" id="nSynthH">Summarizes at the end; saved to .orchestra/BRAINSTORM.md</div></div>
        <div><label class="label" for="nRounds">Rounds</label><select class="input" id="nRounds" aria-describedby="nRoundsH">${nums([1, 2, 3, 4], x.rounds)}</select><div class="hint" id="nRoundsH">Stops early on consensus</div></div></div>
      ${ctxBox(x.ctx)}`;
    else if (k === 'chain') f.innerHTML = `
      <label class="label" for="nTask">Task</label><textarea class="input" id="nTask" placeholder="What should be proposed and reviewed?">${esc(x.task)}</textarea>
      <div class="grid3"><div><label class="label" for="nBuilder">Proposer</label><select class="input" id="nBuilder">${opt(x.builder)}</select></div>
        <div><label class="label" for="nReviewer">Reviewer</label><select class="input" id="nReviewer">${opt(x.reviewer)}</select></div>
        <div><label class="label" for="nMax">Max rounds</label><select class="input" id="nMax">${nums([1, 2, 3], x.max)}</select></div></div>
      <label class="check-l"><input type="checkbox" id="nEsc" ${x.escalate ? 'checked' : ''}> Raise proposer effort after a FAIL</label>
      ${ctxBox(x.ctx, 'margin-top:6px')}`;
    else f.innerHTML = `<label class="label" for="nSeat">Agent</label><select class="input" id="nSeat">${opt(x.seat)}</select>
      <label class="label" for="nMsg">Message</label><textarea class="input" id="nMsg" placeholder="Ask something…" aria-describedby="nDmHint">${esc(x.message)}</textarea><div class="hint" id="nDmHint"></div>`;
    $$('.pick', f).forEach((p) => p.onclick = () => { const id = p.dataset.id, l = v.meeting.participants; v.meeting.participants = l.includes(id) ? l.filter((y) => y !== id) : [...l, id]; const on = v.meeting.participants.includes(id); p.classList.toggle('on', on); p.setAttribute('aria-pressed', String(on)); customise(); update(); });
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
    go.disabled = true; go.textContent = 'Starting…';
    try {
      if (k === 'meeting') r = await api('/api/meeting', { topic: x.topic, seatIds: S.order.filter((id) => x.participants.includes(id)), scoutId: x.scout, synthId: x.facilitator, rounds: x.rounds, withContext: x.ctx });
      else if (k === 'chain') r = await api('/api/chain', { task: x.task, builderId: x.builder, reviewerId: x.reviewer, maxRounds: x.max, escalate: x.escalate, withContext: x.ctx });
      else r = await api(`/api/seats/${x.seat}/send`, { text: x.message.trim() });
      const { topic, task, message, ...keep } = x; // remember the setup, never the text
      ls.set('ob.new.kind', k); ls.set('ob.new.' + k, JSON.stringify(keep)); ls.set('ob.new.preset', presetId);
      closeOverlay(); openRoom(r.roomId);
    } catch {} finally { go.disabled = false; go.textContent = 'Start'; }
  };
}

function openAgent(id) {
  const isNew = !id; const s = isNew ? { name: '', role: '', agent: 'codex', model: S.models.codex?.[0] || '', effort: 'medium', perm: 'read', target: '', budget: 0, color: '#14b8a6' } : S.seats[id];
  const box = overlay(`<div class="modal-h"><h2 class="modal-t" id="dlgTitle">${isNew ? 'New agent' : `${avatar(id, 'lg')}${esc(s.name)}`}</h2>${closeBtn()}</div>
    <div class="modal-b">
      <div class="grid2"><div><label class="label" for="aName">Name</label><input class="input" id="aName" maxlength="24" value="${esc(s.name)}" required></div><div><label class="label" for="aRole">Role</label><input class="input" id="aRole" maxlength="40" value="${esc(s.role || '')}" placeholder="e.g. Reviewer"></div></div>
      <div class="hint">Changing name, role, runtime or scope resets this agent's memory.</div>
      <div class="label" id="aAgentL">Runtime</div>${seg('aAgent', [['claude', 'Claude CLI'], ['codex', 'Codex CLI']], s.agent, 'Runtime', 'data-a')}
      <label class="label" for="aModel">Model</label><input class="input" id="aModel" list="aModels" value="${esc(s.model || '')}" placeholder="pick or type a model"><datalist id="aModels"></datalist>
      <div class="label" id="aEffortL">Effort</div><div class="seg" id="aEffort" role="radiogroup" aria-labelledby="aEffortL"></div><div class="hint">Discussion rounds are capped at Medium automatically.</div>
      <details class="adv"><summary>Advanced</summary>
        <div class="label">Permission</div>
        <div class="hint" style="margin:0 0 4px">${s.perm === 'write' ? '<b>write</b> — this agent may edit files (Claude: <code class="inline">acceptEdits</code> with Edit/Write; Codex: <code class="inline">workspace-write</code>).' : '<b>read-only</b> — this agent proposes changes but never edits files.'} Saving keeps it as is: v0.1 has no toggle here. To change it, stop the board and set <code class="inline">perm</code> to <code class="inline">read</code> or <code class="inline">write</code> in <code class="inline">.orchestra/seats.json</code>, or POST <code class="inline">/api/seats</code>.</div>
        <label class="label" for="aTarget">Scope</label><input class="input" id="aTarget" value="${esc(s.target || '')}" placeholder="folder or file inside the project (empty = whole project)" style="font-family:var(--mono);font-size:12.5px">
        <div class="grid2"><div><label class="label" for="aBudget">Token budget</label><input class="input" id="aBudget" type="number" min="0" step="10000" value="${s.budget || 0}" aria-describedby="aBudgetH"><div class="hint" id="aBudgetH">0 = unlimited</div></div><div><label class="label" for="aColor">Color</label><input class="input" id="aColor" type="color" value="${s.color || '#14b8a6'}" style="padding:2px 4px"></div></div>
      </details>
      ${isNew ? '' : `<div class="label">Usage</div><dl class="kv"><dt>Net tokens</dt><dd>${fmtTok(s.used)}</dd><dt>Cached</dt><dd>${fmtTok(s.cached)}</dd><dt>Cost</dt><dd>$${(s.cost || 0).toFixed(3)}</dd><dt>Memory</dt><dd>${s.thread ? 'active' : 'empty'}</dd></dl>`}
    </div>
    <div class="modal-f">${isNew ? '' : `<button class="btn danger" id="aDel" style="margin-right:auto">${icon('trash', 'width:14px;height:14px')}Delete</button><button class="btn" id="aReset">Clear memory</button>`}<button class="btn" data-close>Cancel</button><button class="btn primary" id="aSave">${isNew ? 'Add agent' : 'Save'}</button></div>`, 'drawer');
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
  $$('#aAgent button', box).forEach((b) => b.onclick = () => {
    if (b.dataset.a === agent) return;
    agent = b.dataset.a; segSet(box.querySelector('#aAgent'), b);
    box.querySelector('#aModel').value = S.models[agent]?.[0] || ''; fillRuntime();
  });
  fillRuntime();
  box.querySelector('#aSave').onclick = async () => {
    const model = box.querySelector('#aModel').value.trim() || S.models[agent]?.[0];
    try {
      // perm is preserved, never downgraded: a write seat configured in seats.json survives a save (and keeps its thread).
      await api('/api/seats', { id: isNew ? undefined : id, name: box.querySelector('#aName').value || 'Agent', role: box.querySelector('#aRole').value, agent, model, effort, perm: s.perm === 'write' ? 'write' : 'read', target: box.querySelector('#aTarget').value, budget: Number(box.querySelector('#aBudget').value) || 0, color: box.querySelector('#aColor').value });
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
      <div class="label" id="sThemeL">Theme</div>${seg('sTheme', ['system', 'light', 'dark'].map((t) => [t, t[0].toUpperCase() + t.slice(1)]), ls.get('ob.theme') || 'system', 'Theme', 'data-t')}
      <label class="check-l"><input type="checkbox" id="sNotify" ${notify ? 'checked' : ''}> Desktop notification when a session finishes or needs you</label>
      <div class="label">Setup</div>
      <button class="btn sm" id="sDoctor">${icon('refresh', 'width:13px;height:13px')}Run setup check</button>
    </div>
    <div class="modal-f"><button class="btn" data-close>Close</button></div>`, 'modal sm');
  $$('[data-close]', box).forEach((b) => b.onclick = closeOverlay);
  $$('#sTheme button', box).forEach((b) => b.onclick = () => { segSet(box.querySelector('#sTheme'), b); applyTheme(b.dataset.t); });
  $('#sDoctor').onclick = () => { closeOverlay(); S.setupOpen = true; openRoom(null); runDoctor(); };
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
  lang.onkeydown = (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); saveLang(); } };
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
  const app = $('#app'); setPanel('show-side', false); app.classList.toggle('no-ins', !id); if (!id) setPanel('show-ins', false);
  renderSessions(); id ? renderRoom() : renderHome(); renderInspector();
  document.title = id && S.rooms[id] ? `${S.rooms[id].title} · Orchestra Board` : 'Orchestra Board';
}
$('#homeBtn').onclick = () => openRoom(null);
$('#newBtn').onclick = () => openNew(newKind());
$('#addAgent').onclick = () => openAgent(null);
$('#settingsBtn').onclick = openSettings;
$('#helpBtn').onclick = openHelp;
$('#menuBtn').onclick = () => setPanel('show-side', !$('#app').classList.contains('show-side'));
$('#insBtn').onclick = () => setPanel('show-ins', !$('#app').classList.contains('show-ins'));
$('#main').addEventListener('click', () => { if ($('#app').classList.contains('show-side')) setPanel('show-side', false); });
// Phone drawer scrim: a real element (not a pseudo-element) so a tap on the dimmed area closes the drawer.
$('#sideScrim').addEventListener('click', () => { setPanel('show-side', false); $('#menuBtn')?.focus(); });
$('#newKbd').textContent = `${MOD} K`;

/* ================= live events ================= */
let doctorOnce = false;
async function load() {
  const st = await api('/api/state');
  Object.assign(S, { models: st.models, efforts: st.efforts, limits: st.limits || {}, settings: st.settings || {} });
  S.seats = {}; S.order = []; st.seats.forEach((s) => { S.seats[s.id] = s; S.order.push(s.id); });
  S.rooms = {}; st.rooms.forEach((r) => { S.rooms[r.id] = r; });
  const prev = S.active, saved = ls.get('ob.room'); if (!S.rooms[S.active]) S.active = S.rooms[saved] ? saved : null;
  $('#project').textContent = st.project; $('#project').title = st.project;
  renderMeters(); noteLimitErrors(true); renderSessions(); renderAgents();
  // Local environment check, once per page load: first run shows it as onboarding; later only problems are shown.
  if (!doctorOnce) { doctorOnce = true; runDoctor(); }
  if (S.active !== prev || !$('#feedInner')) return openRoom(S.active);
  // reconnect to the same room: keep the feed (and its scroll), refresh what may have changed
  const r = S.rooms[S.active];
  renderRoomHead(); renderResultBar(); if ($('#composerArea')?.dataset.mode !== composerMode(r)) renderComposer();
  r.messages.forEach((m) => paintMsg(m, false)); markResult(); renderInspector();
}
let lastAuthCheck = 0, everConnected = false;
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { S.connected = true; renderConn(); if (everConnected) announce('Live updates reconnected'); everConnected = true; };
  es.onerror = () => {
    S.connected = false; renderConn();
    // EventSource hides HTTP status; find out whether the session cookie expired (at most once per 10 s).
    if (!gated && Date.now() - lastAuthCheck > 10000) { lastAuthCheck = Date.now(); fetch('/api/state', { credentials: 'same-origin' }).then((r) => { if (r.status === 401) authGate(); }).catch(() => {}); }
  };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    switch (ev.t) {
      case 'hello': return load().catch(() => {});
      case 'seat': {
        const old = S.seats[ev.seat.id], isNew = !old; S.seats[ev.seat.id] = ev.seat; if (isNew) S.order.push(ev.seat.id);
        if (old && old.status !== ev.seat.status) {
          if (ev.seat.status === 'working') announce(`${ev.seat.name} started: ${ev.seat.activity || 'working'}`);
          else if (old.status === 'working') announce(`${ev.seat.name} ${ev.seat.status === 'error' ? 'failed' : 'finished'}`);
        }
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
          else { renderRoomHead(); renderResultBar(); if ($('#composerArea')?.dataset.mode !== composerMode(r)) renderComposer(); markResult(); }
          scheduleInspector();
          if (!old) document.title = `${r.title} · Orchestra Board`;
        } else if (!S.active && !old) renderHome(); // first session ever: the home page loses its first-run framing
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
      case 'limits': S.limits = ev.limits; renderMeters(); noteLimitErrors(); renderBanner(); break;
      case 'settings': S.settings = ev.settings; break;
    }
  };
}
renderConn(); connect(); twLoop();
