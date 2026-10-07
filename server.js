// Orchestra control board: persistent agent "seats" (Claude + Codex), live meetings and build/review chains.
// Usage: node server.js [projectDir] [port]   (no dependencies)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const PROJECT = path.resolve(process.argv[2] || process.cwd());
const PORT = Number(process.argv[3] || process.env.PORT || 4317);
const ORCH = path.join(PROJECT, '.orchestra');
const ROOM_DIR = path.join(ORCH, 'rooms');

const MODELS = {
  codex: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'],
};
const EFFORTS = { codex: ['low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'xhigh', 'max'] };
const COLORS = ['#e07a52', '#7aa2ff', '#ffcc4d', '#b48cff', '#4fd1a5', '#ff7aa8', '#5ad1e6'];
const DEFAULT_SEATS = [
  { id: 'claude', name: 'Claude', role: 'Builder', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', color: COLORS[0] },
  { id: 'luna', name: 'Luna', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'medium', color: COLORS[1] },
  { id: 'sol', name: 'Sol', role: 'Architect', agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', color: COLORS[2] },
  { id: 'astra', name: 'Astra', role: "Devil's advocate", agent: 'codex', model: 'gpt-6-astra', effort: 'medium', color: COLORS[3] },
];

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const read = (f) => { try { return fs.readFileSync(path.join(ORCH, f), 'utf8'); } catch { return null; } };
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(ORCH, f)), { recursive: true }); fs.writeFileSync(path.join(ORCH, f), s); };

function appendLog(agent, text) {
  const cur = read('LOG.md') ?? '# Orchestra log\n\n';
  write('LOG.md', cur.replace(/\s*$/, '\n') + `- ${today()} | ${agent} | ${text.replace(/\s+/g, ' ').trim()}\n`);
}

// ---------- live events (SSE) ----------
const clients = new Set();
function broadcast(ev) { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); }

// ---------- usage limits ----------
// Claude: rate_limit_event from every `claude -p` stream. Codex: last rate_limits in the newest ~/.codex session rollout.
let limits = (() => { try { return JSON.parse(read('limits.json')); } catch { return null; } })() || { claude: null, codex: null };
function setLimits(agent, data) {
  limits[agent] = { ...data, updated: now() };
  write('limits.json', JSON.stringify(limits, null, 2)); broadcast({ t: 'limits', limits });
}
function claudeLimits(info) {
  const wins = {};
  for (const [k, v] of Object.entries(info.unifiedWindows || {})) if (v && typeof v.utilization === 'number') wins[k] = { pct: Math.round(v.utilization * 1000) / 10, resetsAt: v.resetsAt ? v.resetsAt * 1000 : null };
  if (!Object.keys(wins).length && info.rateLimitType) wins[info.rateLimitType] = { pct: Math.round((info.utilization || 0) * 1000) / 10, resetsAt: info.resetsAt ? info.resetsAt * 1000 : null };
  setLimits('claude', { windows: wins, status: info.status, overage: !!info.isUsingOverage });
}
function newestFile(dir, depth) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  ents = ents.map((e) => ({ e, p: path.join(dir, e.name) })).sort((a, b) => b.e.name.localeCompare(a.e.name));
  for (const { e, p } of ents) {
    if (depth > 0 && e.isDirectory()) { const f = newestFile(p, depth - 1); if (f) return f; }
    if (depth === 0 && e.isFile() && e.name.endsWith('.jsonl')) return ents.filter((x) => x.e.isFile() && x.e.name.endsWith('.jsonl')).map((x) => x.p).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }
  return null;
}
let codexLimitFile = null, codexLimitMtime = 0;
function readCodexLimits() {
  const f = newestFile(path.join(require('os').homedir(), '.codex', 'sessions'), 3); if (!f) return;
  const mt = fs.statSync(f).mtimeMs; if (f === codexLimitFile && mt === codexLimitMtime) return;
  codexLimitFile = f; codexLimitMtime = mt;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let rl; try { rl = JSON.parse(lines[i]).payload?.rate_limits; } catch { continue; }
    if (!rl) continue;
    const win = (w) => w && { pct: w.used_percent, minutes: w.window_minutes, resetsAt: w.resets_at ? w.resets_at * 1000 : null };
    const wins = {};
    for (const w of [rl.primary, rl.secondary].filter(Boolean)) wins[w.window_minutes >= 10080 ? 'seven_day' : w.window_minutes >= 300 ? 'five_hour' : `${w.window_minutes}m`] = win(w);
    return setLimits('codex', { windows: wins, plan: rl.plan_type, reached: rl.rate_limit_reached_type });
  }
}
setInterval(() => { try { readCodexLimits(); } catch {} }, 30000);
try { readCodexLimits(); } catch {}

// ---------- seats ----------
const PERSISTED = ['id', 'name', 'role', 'agent', 'model', 'effort', 'perm', 'target', 'budget', 'color', 'thread', 'used', 'cached', 'cost'];
let seats = (() => { try { return JSON.parse(read('seats.json')); } catch { return null; } })()
  || DEFAULT_SEATS.map((s) => ({ perm: 'read', target: '', budget: 0, thread: null, used: 0, cost: 0, ...s }));
const rt = new Map(); // seat id -> runtime { status, activity, startedAt, child, queue, roomId }
const rtOf = (id) => { if (!rt.has(id)) rt.set(id, { status: 'idle', activity: '', startedAt: null, child: null, queue: Promise.resolve() }); return rt.get(id); };
const seatById = (id) => seats.find((s) => s.id === id);
function saveSeats() { write('seats.json', JSON.stringify(seats.map((s) => Object.fromEntries(PERSISTED.map((k) => [k, s[k] ?? null]))), null, 2)); }
function publicSeat(s) { const r = rtOf(s.id); return { ...s, status: r.status, activity: r.activity, startedAt: r.startedAt, roomId: r.roomId || null }; }
function setRt(id, patch) { Object.assign(rtOf(id), patch); const s = seatById(id); if (s) broadcast({ t: 'seat', seat: publicSeat(s) }); }

function upsertSeat(b) {
  const agent = MODELS[b.agent] ? b.agent : 'codex';
  // Listed models are suggestions; any CLI-accepted model name (aliases included) is allowed.
  let s = b.id && seatById(b.id);
  const validModel = /^[\w.:\-\[\]]{1,64}$/.test(b.model || '');
  if (b.model && !validModel) throw new Error('invalid model name');
  const model = validModel ? b.model : s && s.agent === agent ? s.model : MODELS[agent][0];
  const effort = EFFORTS[agent].includes(b.effort) ? b.effort : 'medium';
  if (!s) {
    const base = String(b.name || agent).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'seat';
    let id = base, n = 2; while (seatById(id)) id = `${base}-${n++}`;
    s = { id, thread: null, used: 0, cost: 0, color: COLORS[seats.length % COLORS.length] };
    seats.push(s);
  }
  // A thread belongs to one CLI, and its first message fixed the role, permission and scope: reset on change.
  const perm = b.perm === 'write' ? 'write' : 'read', target = String(b.target ?? s.target ?? '').trim();
  if ((s.agent && s.agent !== agent) || (s.perm && s.perm !== perm) || (s.target ?? '') !== target
    || (b.role !== undefined && s.role !== undefined && b.role !== s.role) || (b.name !== undefined && s.name !== undefined && b.name !== s.name)) s.thread = null;
  Object.assign(s, {
    name: String(b.name ?? s.name ?? agent).slice(0, 24), role: String(b.role ?? s.role ?? '').slice(0, 40),
    agent, model, effort, perm: b.perm === 'write' ? 'write' : 'read',
    target: String(b.target ?? s.target ?? '').trim(), budget: Math.max(0, Number(b.budget ?? s.budget ?? 0) || 0),
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : s.color,
  });
  saveSeats(); broadcast({ t: 'seat', seat: publicSeat(s) });
  return s;
}

function listDir(dir, depth = 2, max = 150) {
  const out = [];
  (function walk(d, pre, lvl) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max || /^(node_modules|\.git|\.venv|dist|build)$/.test(e.name)) continue;
      out.push(pre + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory() && lvl < depth) walk(path.join(d, e.name), pre + '  ', lvl + 1);
    }
  })(dir, '', 1);
  return out.join('\n');
}

// The unelevated Windows sandbox cannot launch the Microsoft Store pwsh alias (CreateProcessAsUserW: access
// denied), so Codex children get a PATH without WindowsApps and fall back to Windows PowerShell.
function codexEnv() {
  if (process.platform !== 'win32') return process.env;
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  if (key) env[key] = env[key].split(';').filter((p) => !/\\WindowsApps\\?$/i.test(p)).join(';');
  return env;
}

// The target is also inlined into the prompt so the agent has it without running commands.
function resolveTarget(seat) {
  if (!seat.target) return { cwd: PROJECT, preface: '' };
  const t = path.resolve(PROJECT, seat.target);
  if (!fs.existsSync(t)) return { cwd: PROJECT, preface: `(Note: target "${seat.target}" does not exist.)\n\n` };
  if (fs.statSync(t).isDirectory()) return { cwd: t, dir: t, preface: `Your scope is the directory ${t}. Stay inside it.\nFiles:\n${listDir(t)}\n\n` };
  const body = fs.readFileSync(t, 'utf8').slice(0, 60000);
  return { cwd: path.dirname(t), dir: path.dirname(t), preface: `Your target is the file ${t}.\n--- ${path.basename(t)} ---\n${body}\n--- end ---\n\n` };
}

// Changes inside the target directory only, including new (untracked) files.
function gitDiff(dir) {
  const git = (args) => { try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 4e6, windowsHide: true }); } catch { return ''; } };
  const diff = git(['diff', 'HEAD', '--', '.']);
  const added = git(['ls-files', '--others', '--exclude-standard', '--', '.']).trim();
  return (diff + (added ? `\nNew files:\n${added}\n` : '')).slice(0, 30000).trim();
}

const shortCmd = (c) => { const m = String(c).match(/-Command\s+'([\s\S]*)'$/); return (m ? m[1] : String(c)).slice(0, 160); };
// Strings are clipped as-is (whitespace collapsed); anything else is JSON-encoded first.
const clip = (o, n = 120) => { try { const s = typeof o === 'string' ? o.replace(/\s+/g, ' ').trim() : JSON.stringify(o); return s.length > n ? s.slice(0, n) + '…' : s; } catch { return ''; } };

function runSeat(seatId, prompt, opts = {}) {
  const r = rtOf(seatId);
  const p = r.queue.then(() => execSeat(seatId, prompt, opts));
  r.queue = p.catch(() => {});
  return p;
}

// Lean launch: no user plugins, MCP servers, skills, hooks or extra tool families. Measured on 2026-10-07:
// Claude baseline 36k → 6.7k tokens (no tools), Codex 24k → 15k.
const CODEX_LEAN = ['--ignore-user-config', ...['apps', 'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'memories', 'plugins', 'hooks']
  .flatMap((f) => ['-c', `features.${f}=false`]), '-c', 'web_search="disabled"'];
const CLAUDE_LEAN = ['--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--exclude-dynamic-system-prompt-sections'];
const CLAUDE_TOOLS = { none: [''], read: ['Read', 'Grep', 'Glob'], write: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] };
let settings = (() => { try { return JSON.parse(read('settings.json')); } catch { return null; } })() || { lang: process.env.ORCHESTRA_LANG || 'English' };

// tools: 'none' (discussion), 'read' (look at code), 'write' (seat must allow it).
// room: meetings/chains keep one thread per seat per room, so old conversations are never re-sent.
function execSeat(seatId, prompt, { effort, runId = newId(), roomId = null, room = null, tools = null, withTarget = true, threadKey = null, cancelled = null } = {}) {
  return new Promise((resolve) => {
    const seat = seatById(seatId);
    if (!seat) return resolve({ ok: false, error: 'no such agent', text: '' });
    if (room?.stopped || cancelled?.()) return resolve({ ok: false, error: 'stopped', text: '' }); // queued before the stop
    if (seat.budget && seat.used >= seat.budget) return resolve({ ok: false, error: `${seat.name} reached its token budget`, text: '' });
    const eff = effort || seat.effort;
    const mode = tools === 'write' && seat.perm !== 'write' ? 'read' : tools || (seat.perm === 'write' ? 'write' : 'read');
    const threads = room ? (room.threads ||= {}) : null;
    const key = threadKey || seat.id;
    const thread = threads ? threads[key] || null : seat.thread;
    const saveThread = (id) => { if (threads) threads[key] = id; else seat.thread = id; };
    const tgt = withTarget ? resolveTarget(seat) : { cwd: PROJECT, preface: '' };
    // Role header and target scope go out once per thread; a resumed thread already has them.
    const header = thread ? '' : `[You are "${seat.name}" (${seat.role || 'agent'}) in a multi-agent orchestra of Claude and Codex seats. Reply in ${settings.lang}. Be concise.${mode !== 'write' ? ' Do not modify files.' : ''}]\n\n`;
    const toolNote = mode === 'none' ? '(No tools or commands this turn: answer from the conversation.)\n\n' : '';
    const stdin = header + (thread ? '' : tgt.preface) + toolNote + prompt;

    let cmd, args, cwd = tgt.cwd, pendingThread = null;
    if (seat.agent === 'codex') {
      const cfg = [...CODEX_LEAN, '-c', `model="${seat.model}"`, '-c', `model_reasoning_effort="${eff}"`, '-c', `sandbox_mode="${mode === 'write' ? 'workspace-write' : 'read-only'}"`];
      if (process.platform === 'win32') cfg.push('-c', 'windows.sandbox="unelevated"');
      cmd = 'codex';
      // Codex always has a shell tool; in a no-tools turn an empty cwd keeps it from re-reading the project.
      if (mode === 'none') { cwd = path.join(ORCH, 'empty'); fs.mkdirSync(cwd, { recursive: true }); }
      args = thread ? ['exec', 'resume', thread, '--skip-git-repo-check', '--json', ...cfg, '-'] : ['exec', '--skip-git-repo-check', '--json', ...cfg, '-'];
    } else {
      cmd = 'claude'; cwd = PROJECT; // Claude sessions are stored per project dir, so resume needs a stable cwd
      args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', seat.model, '--effort', eff, ...CLAUDE_LEAN];
      if (thread) args.push('--resume', thread); else { pendingThread = crypto.randomUUID(); args.push('--session-id', pendingThread); }
      if (tgt.dir && !tgt.dir.startsWith(PROJECT)) args.push('--add-dir', tgt.dir);
      if (mode === 'write') args.push('--permission-mode', 'acceptEdits');
      args.push('--tools', ...CLAUDE_TOOLS[mode]);
    }

    let text = '', final = null, tokens = 0, cached = 0, cost = 0, err = null, gotThread = null, buf = '', stderr = '', completed = false;
    const delta = (s) => { text += s; broadcast({ t: 'delta', seatId, runId, text: s }); };
    const item = (kind, s) => broadcast({ t: 'item', seatId, runId, roomId, kind, text: String(s).slice(0, 200), ts: now() });
    const activity = (a) => { const r = rtOf(seatId); if (r.activity !== a) setRt(seatId, { activity: a }); };

    const onEvent = (ev) => {
      if (seat.agent === 'codex') {
        if (ev.type === 'thread.started') gotThread = ev.thread_id;
        else if (ev.type === 'turn.started') activity('thinking');
        else if (ev.type === 'item.started' && ev.item?.type === 'command_execution') { activity('running a command'); item('tool', shortCmd(ev.item.command)); }
        else if (ev.type === 'item.completed') {
          const it = ev.item || {};
          if (it.type === 'agent_message') { activity('writing'); delta((text ? '\n\n' : '') + it.text); }
          else if (it.type === 'reasoning') { activity('thinking'); item('reasoning', it.text || it.summary || 'reasoning'); }
          else if (it.type === 'file_change') item('tool', 'file change');
          else if (it.type === 'error' && !/ignoring|Under-development|clamping/i.test(it.message || '')) item('error', it.message);
        } else if (ev.type === 'turn.completed') {
          // Net = uncached input + output; cached input is reported separately (much cheaper).
          completed = true; const u = ev.usage || {}; cached = u.cached_input_tokens || 0;
          tokens = (u.input_tokens || 0) - cached + (u.output_tokens || 0);
        }
        else if (ev.type === 'turn.failed' || ev.type === 'error') err = ev.error?.message || ev.message || 'codex error';
      } else {
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info) claudeLimits(ev.rate_limit_info);
        else if (ev.type === 'system' && ev.subtype === 'init') gotThread = ev.session_id;
        else if (ev.type === 'system' && ev.subtype === 'thinking_tokens') activity(`thinking · ~${ev.estimated_tokens} tok`);
        else if (ev.type === 'stream_event') {
          const e = ev.event || {};
          if (e.type === 'message_start' && text) delta('\n\n');
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { activity('writing'); delta(e.delta.text); }
          if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') activity('thinking');
        } else if (ev.type === 'assistant') {
          for (const c of ev.message?.content || []) if (c.type === 'tool_use') { activity(`tool: ${c.name}`); item('tool', `${c.name} ${clip(c.input)}`); }
        } else if (ev.type === 'result' || 'total_cost_usd' in ev) {
          completed = true; final = typeof ev.result === 'string' ? ev.result : null; cost = ev.total_cost_usd || 0;
          const u = ev.usage || {}; cached = u.cache_read_input_tokens || 0;
          tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
          if (ev.is_error) err = final || 'claude error';
        }
      }
    };

    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true, env: cmd === 'codex' ? codexEnv() : process.env }); }
    catch (e) { return resolve({ ok: false, error: e.message, text: '' }); }
    setRt(seatId, { status: 'working', activity: 'starting', startedAt: now(), child, roomId, runId, stopRequested: false });
    broadcast({ t: 'run', seatId, runId, roomId });
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line.startsWith('{')) { try { onEvent(JSON.parse(line)); } catch {} } }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { err = e.message; });
    child.on('close', (code) => {
      const stopped = rtOf(seatId).stopRequested;
      if (gotThread) saveThread(gotThread);
      else if (pendingThread && code === 0) saveThread(pendingThread);
      seat.used = (seat.used || 0) + tokens; seat.cached = (seat.cached || 0) + cached; seat.cost = (seat.cost || 0) + cost;
      saveSeats();
      // A finished turn counts as success even if the CLI exits non-zero afterwards (e.g. a failing notify hook).
      const ok = !err && (completed || (code === 0 && !stopped));
      const out = final ?? text;
      if (!ok && !err) err = stopped ? 'stopped' : (stderr.trim().split('\n').pop() || `exit code ${code}`);
      setRt(seatId, { status: ok ? 'idle' : 'error', activity: ok ? '' : err, startedAt: null, child: null, roomId: null, stopRequested: false });
      broadcast({ t: 'end', seatId, runId, roomId, ok, tokens, cached, cost, error: ok ? null : err });
      if (seat.agent === 'codex') setTimeout(() => { try { readCodexLimits(); } catch {} }, 500);
      resolve({ ok, text: out, tokens, cached, cost, error: ok ? null : err });
    });
    child.stdin.end(stdin);
  });
}

function stopSeat(id) {
  const r = rtOf(id); if (!r.child) return false;
  r.stopRequested = true;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(r.child.pid), '/T', '/F'], { windowsHide: true });
  else r.child.kill('SIGTERM');
  return true;
}

// ---------- rooms: meetings, chains, direct messages ----------
const rooms = new Map();
(() => {
  try {
    fs.readdirSync(ROOM_DIR).filter((f) => f.endsWith('.json')).forEach((f) => {
      const r = JSON.parse(fs.readFileSync(path.join(ROOM_DIR, f), 'utf8'));
      if (r.status === 'running') r.status = 'stopped';
      // One-time migration of legacy (Turkish) round names and DM titles; saved on the room's next write.
      const ROUND = { 'keşif': 'scout', 'sentez': 'synthesis' };
      if (ROUND[r.round]) r.round = ROUND[r.round];
      r.messages.forEach((m) => { m.streaming = false; if (ROUND[m.round]) m.round = ROUND[m.round]; });
      if (r.kind === 'dm') r.title = `Chat with ${seatById(r.seatId)?.name || r.title}`;
      rooms.set(r.id, r);
    });
  } catch {}
})();
// A deleted room may still be referenced by a running meeting/chain/DM turn: never write or broadcast it again.
const live = (room) => rooms.get(room.id) === room;
function saveRoom(room) { if (!live(room)) return; fs.mkdirSync(ROOM_DIR, { recursive: true }); fs.writeFileSync(path.join(ROOM_DIR, room.id + '.json'), JSON.stringify(room, null, 2)); }
const roomMeta = (r) => { const { messages, ...m } = r; return m; };
function pushRoom(room) { if (!live(room)) return; saveRoom(room); broadcast({ t: 'room', room: roomMeta(room) }); }
function newRoom(kind, title, extra = {}) {
  const room = { id: (kind === 'dm' ? 'dm-' + extra.seatId : newId()), kind, title, status: 'running', created: now(), round: 0, messages: [], ...extra };
  rooms.set(room.id, room); pushRoom(room); return room;
}
function post(room, msg) {
  const m = { id: newId(), ts: now(), streaming: false, ...msg };
  room.messages.push(m); if (live(room)) broadcast({ t: 'msg', roomId: room.id, msg: m }); saveRoom(room); return m;
}
async function say(room, seatId, prompt, meta = {}) {
  const seat = seatById(seatId);
  if (!seat) { sys(room, `Agent "${seatId}" no longer exists; turn skipped.`); return { ok: false, error: 'no such agent', text: '' }; }
  const m = post(room, { seatId, name: seat.name, color: seat.color, agent: seat.agent, round: meta.round || room.round, label: meta.label || '', text: '', streaming: true });
  // Direct messages use the seat's long-lived thread; meetings and chains get a fresh thread per room.
  const res = await runSeat(seatId, prompt, { effort: meta.effort, runId: m.id, roomId: room.id, room: room.kind === 'dm' ? null : room, tools: meta.tools, withTarget: meta.withTarget ?? true, threadKey: meta.threadKey, cancelled: meta.cancelled });
  Object.assign(m, { text: res.text || '', error: res.ok ? null : res.error, streaming: false, ended: now(), tokens: res.tokens, cached: res.cached, cost: res.cost, effort: meta.effort || seat.effort, tools: meta.tools || null });
  if (live(room)) broadcast({ t: 'msg', roomId: room.id, msg: m });
  room.usage = roomUsage(room); pushRoom(room);
  return { ...res, msg: m };
}
function roomUsage(room) {
  const u = { tokens: 0, cached: 0, cost: 0, perSeat: {} };
  for (const m of room.messages) {
    if (!m.tokens) continue;
    u.tokens += m.tokens; u.cached += m.cached || 0; u.cost += m.cost || 0;
    u.perSeat[m.seatId] = (u.perSeat[m.seatId] || 0) + m.tokens;
  }
  return u;
}
const NOT_DELIVERED = (m) => `Not delivered (no agent turn left to read it): "${clip(m.text)}"`;
const sys = (room, text, extra = {}) => post(room, { seatId: 'system', name: 'system', text, ...extra });
const userMsg = (room, text) => post(room, { seatId: 'user', name: 'You', text });

function buildContext() {
  const parts = [];
  for (const f of ['PLAN.md', 'HANDOFF.md']) { const s = read(f); if (s) parts.push(`## .orchestra/${f}\n${s}`); }
  const log = read('LOG.md'); if (log) parts.push('## .orchestra/LOG.md (tail)\n' + log.split(/\r?\n/).slice(-20).join('\n'));
  return parts.length ? '\n\n--- ORCHESTRA CONTEXT ---\n' + parts.join('\n\n') : '';
}

// Token-lean meeting:
//  1. optional scout reads the code once and writes a shared brief (the only step with tools),
//  2. round 1: independent ideas from the brief, no tools (avoids N agents re-reading the same files),
//  3. later rounds: each seat gets only messages it has not seen (its room thread remembers the rest),
//  4. stop early when every participant reports STANCE: CONVERGED,
//  5. synthesis gets only what the facilitator has not seen yet.
async function runMeeting(room) {
  const { topic, seatIds, rounds, synthId, scoutId } = room;
  const ctx = room.withContext ? buildContext() : '';
  const everyone = [...new Set([...seatIds, synthId, scoutId].filter(Boolean))];
  // Track seen message ids, not indexes: in the parallel round a placeholder exists before its text arrives.
  const seen = Object.fromEntries(everyone.map((id) => [id, new Set(room.messages.map((m) => m.id))]));
  const markOwn = () => everyone.forEach((id) => room.messages.filter((m) => m.seatId === id).forEach((m) => seen[id].add(m.id)));
  // Messages count as seen only after the seat's turn succeeds, so a failed turn does not lose them.
  const unseen = (id) => room.messages.filter((m) => !m.streaming && m.text && m.seatId !== id && m.seatId !== 'system' && !seen[id].has(m.id));
  const fmt = (ms) => ms.map((m) => `${m.seatId === 'user' ? 'User (the human running this meeting)' : m.name}: ${m.text}`).join('\n\n');
  const hasThread = (id) => !!room.threads?.[id];
  const converged = (text) => /^STANCE:\s*CONVERGED$/i.test(lastLine(text));
  const lastStance = {};

  let brief = '';
  if (scoutId) {
    room.round = 'scout'; pushRoom(room);
    const res = await say(room, scoutId, `Scout task for a meeting. Topic:\n${topic}${ctx}\n\nRead only what is relevant inside your target scope. Write a factual brief for the other participants (max 350 words): key facts, relevant files with file:line, constraints, unknowns. No opinions or recommendations.`, { round: 'scout', label: 'scout brief', tools: 'read', threadKey: scoutId + ':scout' }); // own thread: the files it read must not ride along in later rounds
    if (res.ok && res.text) brief = res.text;
    // The brief goes into round 1 prompts; user notes posted meanwhile stay unseen so round 2 delivers them.
    room.messages.filter((m) => m.seatId !== 'user' || m === room.messages[0]).forEach((m) => everyone.forEach((id) => seen[id].add(m.id)));
  }
  if (room.stopped) return finishMeeting(room, seen);

  // Topic + brief: sent in round 1, and again to any seat whose room thread does not exist (failed turn, facilitator).
  const background = () => `Meeting topic:\n${topic}\n\n${brief ? `Shared brief (facts gathered by ${seatById(scoutId)?.name || 'the scout'}; rely on it instead of re-reading files):\n${brief}\n\n` : ctx ? ctx + '\n\n' : ''}`;

  room.round = 1; pushRoom(room);
  const r1 = `${background()}Round 1 of ${rounds}: your independent ideas, 3-6 concrete bullets, max 180 words. Cite file:line for claims about code or mark them "unverified".`;
  await Promise.all(seatIds.map((id) => say(room, id, r1, { round: 1, label: 'independent ideas', tools: brief ? 'none' : 'read', withTarget: !brief })));
  markOwn();

  for (let r = 2; r <= rounds && !room.stopped; r++) {
    room.round = r; pushRoom(room);
    const stances = [];
    for (const id of seatIds) {
      if (room.stopped) break;
      const fresh = unseen(id);
      // Silent agreement: a converged seat skips its turn when everything new is also converged.
      if (lastStance[id] && fresh.length && fresh.every((m) => converged(m.text))) { sys(room, `✓ ${seatById(id)?.name} agreed silently (turn skipped).`, { skip: { seatId: id, round: r } }); stances.push(true); continue; }
      const res = await say(room, id, `${hasThread(id) ? '' : background()}Round ${r} of ${rounds}. New messages since your last turn:\n\n${fmt(fresh) || '(nothing new)'}\n\nRespond as in a live meeting: build on, challenge (name who and why) or merge. Max 120 words. End with exactly one line: "STANCE: CONVERGED" if you would sign the current direction, otherwise "STANCE: OPEN".`,
        { round: r, label: 'discussion', tools: 'none', withTarget: false, effort: capEffort(id, 'medium') });
      if (res.ok) fresh.forEach((m) => seen[id].add(m.id));
      markOwn();
      lastStance[id] = res.ok && converged(res.text);
      stances.push(lastStance[id]);
    }
    if (r < rounds && stances.length === seatIds.length && stances.every(Boolean)) { sys(room, '✓ Everyone converged: remaining rounds skipped.', { earlyStop: r }); break; }
  }

  if (synthId && !room.stopped) {
    room.round = 'synthesis'; pushRoom(room);
    const participated = seatIds.includes(synthId) && hasThread(synthId);
    const fresh = unseen(synthId), t = fmt(fresh);
    const res = await say(room, synthId, `${participated ? '' : background()}You are the facilitator. ${participated ? 'Messages you have not seen yet' : 'Meeting transcript'}:\n\n${t || '(none)'}\n\nSynthesize for the user: consensus, open disagreements (who vs who), top 3 options each with a first step, one recommendation. Max 350 words.${participated ? ' Treat your own earlier messages as one participant among the others; do not privilege them.' : ''}`, { label: 'synthesis', tools: 'none', withTarget: false });
    if (res.ok) {
      fresh.forEach((m) => seen[synthId].add(m.id)); // the facilitator read these notes: not "not delivered"
      room.resultId = res.msg.id;
      const cur = read('BRAINSTORM.md') ?? '# Brainstorm\n';
      write('BRAINSTORM.md', cur.replace(/\s*$/, '\n') + `\n## Debate (${today()}): ${topic.slice(0, 80)}\nParticipants: ${seatIds.map((id) => seatById(id)?.name).join(', ')} · rounds: ${rounds} · synthesis: ${seatById(synthId).name}\n\n${res.text}\n`);
    }
  }
  finishMeeting(room, seen);
}

function finishMeeting(room, seen = {}) {
  const sets = Object.values(seen);
  room.messages.filter((m, i) => i > 0 && m.seatId === 'user' && !sets.some((s) => s.has(m.id))).forEach((m) => sys(room, NOT_DELIVERED(m)));
  room.status = room.stopped ? 'stopped' : 'done';
  room.usage ||= roomUsage(room);
  pushRoom(room);
  appendLog('board', `Debate "${room.topic.slice(0, 80)}" ${room.status} (${room.seatIds.join(', ')}; net ${room.usage.tokens} tok, cached ${room.usage.cached}).`);
}

const bump = (agent, e) => { const l = EFFORTS[agent]; return l[Math.min(l.indexOf(e) + 1, l.length - 1)]; };
// Short replies from context do not need deep reasoning; reasoning tokens dominate output cost.
const capEffort = (seatId, cap) => { const s = seatById(seatId); if (!s) return cap; const l = EFFORTS[s.agent]; return l[Math.min(l.indexOf(s.effort), l.indexOf(cap))] || cap; };
const lastLine = (text) => (text || '').trim().split(/\r?\n/).pop().replace(/[*`_]/g, '').trim();

async function runChain(room) {
  const { task, builderId, reviewerId, maxRounds, escalate } = room;
  const builder = seatById(builderId), reviewer = seatById(reviewerId);
  const ctx = room.withContext ? buildContext() : '';
  let effort = builder.effort, feedback = null, passed = false;
  for (let r = 1; r <= maxRounds && !room.stopped; r++) {
    room.round = r; pushRoom(room);
    // A read-only builder proposes (v0.1 default); only a write seat edits files.
    const propose = builder.perm !== 'write';
    const doIt = propose ? 'You cannot modify files: propose the change concretely (files, exact edits or a patch). End with a short summary.' : 'Do the task. End with a short summary of what you changed.';
    // Notes the user posted into the room since the builder's last turn.
    const notes = room.messages.filter((m) => m.seatId === 'user' && !m.consumed && m !== room.messages[0]);
    notes.forEach((m) => { m.consumed = true; });
    const noteText = notes.length ? `\n\nNotes from the user:\n${notes.map((m) => '- ' + m.text).join('\n')}` : '';
    const b = await say(room, builderId, r === 1
      ? `Task:\n${task}${ctx}${noteText}\n\n${doIt}`
      : `Review feedback from ${reviewer.name} (round ${r - 1}):\n${feedback}${noteText}\n\nAddress the BLOCKER and SHOULD-FIX items only, then summarize.`, { round: r, effort, label: `${propose ? 'proposal' : 'implementation'} · ${effort}` });
    if (room.stopped) break;
    if (!b.ok) { sys(room, `${builder.name} failed: ${b.error}`); break; }
    const diff = propose ? '' : gitDiff(resolveTarget(builder).cwd);
    // Notes posted while the builder worked go to the reviewer.
    const rNotes = room.messages.filter((m) => m.seatId === 'user' && !m.consumed && m !== room.messages[0]);
    rNotes.forEach((m) => { m.consumed = true; });
    const rNoteText = rNotes.length ? `\n\nNotes from the user:\n${rNotes.map((m) => '- ' + m.text).join('\n')}` : '';
    const rv = await say(room, reviewerId, `Review ${builder.name}'s latest ${propose ? 'proposal' : 'work'} on this task:\n${task}\n\n--- ${builder.name} output ---\n${b.text}\n---${diff ? `\n\n--- changes ---\n${diff}\n---` : ''}${rNoteText}\n\nList at most 3 BLOCKER, 3 SHOULD-FIX and 3 NIT findings. FAIL only if a BLOCKER exists. The last line must be exactly "VERDICT: PASS" or "VERDICT: FAIL".`,
      { round: r, label: 'review', withTarget: !diff });
    if (room.stopped) break;
    // Only a successful review whose last non-empty line is exactly the verdict counts as PASS.
    passed = rv.ok && /^VERDICT:\s*PASS$/i.test(lastLine(rv.text));
    if (rv.msg) { // absent only when the reviewer was deleted mid-chain
      rv.msg.verdict = passed ? 'pass' : 'fail';
      room.resultId = rv.msg.id; // the latest review is the result
      if (live(room)) broadcast({ t: 'msg', roomId: room.id, msg: rv.msg }); saveRoom(room);
    }
    if (passed) break;
    feedback = rv.text;
    if (escalate && r < maxRounds) { const next = bump(builder.agent, effort); if (next !== effort) { effort = next; sys(room, `⚡ ${builder.name} effort raised → ${effort}`); } }
  }
  room.status = room.stopped ? 'stopped' : passed ? 'passed' : 'needs-you';
  if (room.status === 'needs-you') sys(room, 'Round limit reached without a PASS. Use "Run again" to retry, or "Continue in Direct chat" to settle it with one agent.');
  room.messages.filter((m) => m.seatId === 'user' && !m.consumed && m !== room.messages[0]).forEach((m) => sys(room, NOT_DELIVERED(m)));
  pushRoom(room);
  appendLog('board', `Propose→Review ${builder.name}→${reviewer.name} "${task.slice(0, 80)}": ${room.status} after ${room.round} round(s).`);
}

function stopRoom(id) {
  const room = rooms.get(id); if (!room) return false;
  // A DM stop cancels only this chat's turns (running or queued), never the seat's work in other sessions.
  if (room.kind === 'dm') room.stopGen = (room.stopGen || 0) + 1; else room.stopped = true;
  for (const s of seats) if (rtOf(s.id).roomId === id) stopSeat(s.id);
  return true;
}

fs.mkdirSync(ORCH, { recursive: true });

function state() {
  return {
    project: PROJECT, models: MODELS, efforts: EFFORTS,
    seats: seats.map(publicSeat),
    rooms: [...rooms.values()].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 25),
    limits, settings,
  };
}

// ---------- http ----------
function body(req) {
  return new Promise((res, rej) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch (e) { rej(e); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const ids = (arr) => (Array.isArray(arr) ? arr : []).filter((id) => seatById(id));

http.createServer(async (req, res) => {
  // Block DNS rebinding and cross-site requests: Host must be local, and any Origin must be this board.
  const host = String(req.headers.host || '');
  const localHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`];
  if (!localHosts.includes(host)) return json(res, 403, { error: 'forbidden host' });
  const origin = req.headers.origin;
  if (origin && !localHosts.some((h) => origin === `http://${h}`)) return json(res, 403, { error: 'forbidden origin' });
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json required' });
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ t: 'hello' })}\n\n`);
      clients.add(res); const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      return req.on('close', () => { clients.delete(res); clearInterval(hb); });
    }
    if (req.method === 'GET' && p === '/api/state') return json(res, 200, state());
    const sm = p.match(/^\/api\/seats\/([\w-]+)\/(send|stop|reset|delete)$/);
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const b = await body(req);
    if (p === '/api/seats') return json(res, 200, publicSeat(upsertSeat(b)));
    if (p === '/api/limits/refresh') {
      try { readCodexLimits(); } catch {}
      // A tiny Haiku call is the only way to get Claude's rate_limit_event; it costs a few cents at most.
      const probe = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-haiku-4-5-20251001', '--effort', 'low', '--no-session-persistence', ...CLAUDE_LEAN, '--tools', ''], { cwd: require('os').tmpdir(), windowsHide: true });
      let pb = ''; probe.stdout.on('data', (d) => { pb += d; let i; while ((i = pb.indexOf('\n')) >= 0) { const l = pb.slice(0, i); pb = pb.slice(i + 1); try { const ev = JSON.parse(l); if (ev.type === 'rate_limit_event') claudeLimits(ev.rate_limit_info); } catch {} } });
      probe.on('error', () => {}); probe.stdin.end('Reply with: ok');
      return json(res, 200, { ok: true });
    }
    if (sm) {
      const seat = seatById(sm[1]); if (!seat) return json(res, 404, { error: 'no such agent' });
      if (sm[2] === 'stop') return json(res, 200, { ok: stopSeat(seat.id) });
      if (sm[2] === 'reset') { seat.thread = null; saveSeats(); broadcast({ t: 'seat', seat: publicSeat(seat) }); return json(res, 200, { ok: true }); }
      if (sm[2] === 'delete') {
        if (rtOf(seat.id).child) return json(res, 400, { error: 'cannot delete while running' });
        seats = seats.filter((s) => s !== seat); saveSeats(); broadcast({ t: 'seatGone', id: seat.id }); return json(res, 200, { ok: true });
      }
      if (sm[2] === 'send') {
        const text = String(b.text || '').trim(); if (!text) return json(res, 400, { error: 'empty message' });
        let room = rooms.get('dm-' + seat.id);
        if (!room) room = newRoom('dm', `Chat with ${seat.name}`, { seatId: seat.id });
        room.title = `Chat with ${seat.name}`; room.status = 'running'; pushRoom(room);
        userMsg(room, text);
        const gen = room.stopGen || 0;
        say(room, seat.id, text, { cancelled: () => (room.stopGen || 0) !== gen }).then(() => { room.status = 'idle'; pushRoom(room); });
        return json(res, 200, { roomId: room.id });
      }
    }
    if (p === '/api/meeting') {
      const seatIds = ids(b.seatIds), topic = String(b.topic || '').trim();
      if (seatIds.length < 2 || !topic) return json(res, 400, { error: 'Pick at least 2 participants and write a topic' });
      const room = newRoom('meeting', topic.slice(0, 60), { topic, seatIds, rounds: Math.min(Math.max(Number(b.rounds) || 2, 1), 5), synthId: seatById(b.synthId) ? b.synthId : null, scoutId: seatById(b.scoutId) ? b.scoutId : null, withContext: !!b.withContext });
      userMsg(room, topic); runMeeting(room).catch((e) => { sys(room, '⚠ ' + e.message); room.status = 'error'; pushRoom(room); });
      return json(res, 200, { roomId: room.id });
    }
    if (p === '/api/chain') {
      const task = String(b.task || '').trim();
      if (!seatById(b.builderId) || !seatById(b.reviewerId) || b.builderId === b.reviewerId || !task) return json(res, 400, { error: 'Pick two different agents and write a task' });
      const room = newRoom('chain', task.slice(0, 60), { task, builderId: b.builderId, reviewerId: b.reviewerId, maxRounds: Math.min(Math.max(Number(b.maxRounds) || 3, 1), 6), escalate: !!b.escalate, withContext: !!b.withContext });
      userMsg(room, task); runChain(room).catch((e) => { sys(room, '⚠ ' + e.message); room.status = 'error'; pushRoom(room); });
      return json(res, 200, { roomId: room.id });
    }
    if (p === '/api/settings') {
      if (typeof b.lang === 'string' && /^[\p{L} ()-]{2,30}$/u.test(b.lang)) settings.lang = b.lang.trim();
      write('settings.json', JSON.stringify(settings, null, 2)); broadcast({ t: 'settings', settings });
      return json(res, 200, settings);
    }
    const rm = p.match(/^\/api\/rooms\/([\w-]+)\/(stop|delete|say)$/);
    if (rm) {
      if (rm[2] === 'stop') return json(res, 200, { ok: stopRoom(rm[1]) });
      if (rm[2] === 'say') {
        // Interject: the next speaker in a running meeting/chain reads it; finished rooms only record it.
        const room = rooms.get(rm[1]), text = String(b.text || '').trim();
        if (!room || !text) return json(res, 400, { error: 'room and text are required' });
        if (room.kind === 'dm') return json(res, 400, { error: 'use the seat send endpoint for direct messages' });
        if (room.status !== 'running') return json(res, 400, { error: 'This session has finished. Use Run again or Continue in Direct chat.' });
        userMsg(room, text); return json(res, 200, { ok: true });
      }
      stopRoom(rm[1]); rooms.delete(rm[1]); try { fs.unlinkSync(path.join(ROOM_DIR, rm[1] + '.json')); } catch {}
      broadcast({ t: 'roomGone', id: rm[1] }); return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 400, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`Orchestra board: http://localhost:${PORT}  (project: ${PROJECT})`));
