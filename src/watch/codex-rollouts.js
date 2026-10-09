// Codex rollout follower (plan F5). Read-only: it reads the rollouts that a lead Codex thread and its sub-agents write
// under $CODEX_HOME/sessions (default ~/.codex) and reports what they did. Nothing is written, sent or stored.
//
// Layout: sessions/YYYY/MM/DD/rollout-*.jsonl, folders in local time, one { timestamp, type, payload } object per
// line. The first line is session_meta. A sub-agent's session_meta has payload.source.subagent.thread_spawn with
// parent_thread_id, depth, agent_path, agent_nickname and agent_role. Guardian review threads carry
// source.subagent.other instead and are never followed. Compressed archives (.jsonl.zst) are not read.
//
// Kept from session_meta: id, timestamp, cwd, cli_version and the thread_spawn fields, nothing else. Creator ids,
// base_instructions, git data, messages, tool arguments and outputs never reach a result.
//
// Status of one thread, from its lines in file order: task_started opens a turn, task_complete closes it as done and
// turn_aborted as stopped. An open turn, or a sub-agent with no turn yet, reads as running. It reads as stopped after
// stop(), and when no line arrived for 15 minutes once the file has been read to its end. A thread whose file is not
// read to its end yet reads as running (as stopped after stop()), so a closed turn is never final before the whole file
// is read: a later task_started may follow it. The lead's turns that closed before sinceMs do not decide its status (a
// turn still open at sinceMs does count as open), and a lead with no turn in the window reads as waiting. The run is
// done when the lead completed and no sub-agent runs.
//
// A resumed session keeps its first rollout in the folder of the day it started. When the window does not hold the
// lead, its rollout is looked up by id in the older day folders, newest first, at most DAYS_MAX folders in all, and
// again no sooner than LEAD_RETRY_MS after the last try.
//
// Tokens of a thread: input_tokens minus cached_input_tokens plus output_tokens, from the newest token_count total,
// with cached_input_tokens reported beside it. For the lead only usage after sinceMs counts, so a session resumed for
// a run does not report the turns before it.
//
// A line over the tail cap is skipped by the tail. It still counts as activity, but its turn events are unknown, so a
// turn that ends with such a line reads as running until the silence rule or stop() ends it.
//
// Fail soft: a missing folder, a link, an unreadable file or a half-written first line reads as absent, and the next
// scan tries again. A first line that parsed is decided once per path, so later scans do not read it again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTail, readFirstLine, under } = require('./tail');

const DAY_MS = 24 * 60 * 60 * 1000;
const SILENCE_MS = 15 * 60 * 1000;   // no line for longer than this ends an open turn as stopped
const DEFAULT_INTERVAL_MS = 2000;
const TAIL_BYTES = 1 << 20;          // bytes read per poll from one rollout (plan 4.3)
const POLL_BYTES = 8 << 20;          // bytes read per poll over all rollouts; the lead is read first
const AGENTS_MAX = 300;              // agents() returns the newest sub-agents up to this count
const THREADS_MAX = 1000;            // sub-agents followed per lead; later ones are never followed
const DAYS_MAX = 400;                // day folders scanned at most, the newest ones
const LEAD_RETRY_MS = 30 * 1000;     // the lead is looked up in the older folders again this long after a try that missed it
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ROLLOUT_RE = /^rollout-.+\.jsonl$/;
const SANDBOX_RE = /^[a-z-]{1,40}$/;
const ROOT = '/root/';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, '0');
const idOf = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const msOf = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const depthOf = (v) => (Number.isInteger(v) && v >= 0 && v <= 100 ? v : null);
const sandboxOf = (policy) => (isObj(policy) && typeof policy.type === 'string' && SANDBOX_RE.test(policy.type) ? policy.type : null);
// One line of text, at most max characters. Null when nothing is left.
function shortText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return s === '' ? null : s;
}
// An item id as a spawned task name carries it: lowercase, [a-z0-9_] only.
const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9_]/g, '');

// $CODEX_HOME or ~/.codex: the same home the CLI and the usage meters read.
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

const localDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayFolder = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;

// Day folders (YYYY/MM/DD, local time as Codex names them) from the day before sinceMs through the day of now, oldest
// first. At most DAYS_MAX of them, the newest.
function dayDirs(sinceMs, now = Date.now()) {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(now)) return [];
  const last = localDay(now);
  let first = addDays(localDay(sinceMs), -1);
  if (Math.round((last - first) / DAY_MS) >= DAYS_MAX) first = addDays(last, -(DAYS_MAX - 1));
  const out = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(dayFolder(d));
  return out;
}

// What this module keeps from a session_meta line, or null when the line is not one it can follow.
function keepMeta(line) {
  if (!isObj(line) || line.type !== 'session_meta' || !isObj(line.payload)) return null;
  const p = line.payload;
  const id = idOf(p.id);
  const timestamp = msOf(p.timestamp) ?? msOf(line.timestamp);
  if (id === null || timestamp === null) return null;
  const sub = isObj(p.source) && isObj(p.source.subagent) ? p.source.subagent : null;
  const ts = sub && isObj(sub.thread_spawn) ? sub.thread_spawn : null;
  const parentId = ts ? idOf(ts.parent_thread_id) : null;
  const spawn = parentId === null ? null : {
    parentId,
    depth: depthOf(ts.depth),
    nickname: shortText(ts.agent_nickname, 80),
    role: shortText(ts.agent_role, 40),
    agentPath: typeof ts.agent_path === 'string' ? ts.agent_path.slice(0, 200) : null,
  };
  return {
    id,
    timestamp,
    cwd: typeof p.cwd === 'string' ? p.cwd.slice(0, 4096) : null,
    cliVersion: shortText(p.cli_version, 40),
    spawn,
  };
}

// Decided first lines by rollout path: the kept meta, or null for a rollout this module does not follow. A decision
// never changes, so it is kept until the map is full; then it starts again empty (a few reads more, nothing wrong).
const FIRST_CACHE_MAX = 20000;
const firstCache = new Map();

// The kept meta of one rollout. A first line that is missing, still being written, too long or not JSON is not decided:
// the next scan reads it again. readFirstLine refuses links.
function firstMeta(file) {
  if (firstCache.has(file)) return firstCache.get(file);
  const line = readFirstLine(file);
  if (line === null) return null;
  const meta = keepMeta(line);
  if (firstCache.size >= FIRST_CACHE_MAX) firstCache.clear();
  firstCache.set(file, meta);
  return meta;
}

// Rollouts in the day folders of dayDirs(sinceMs, now), each as its kept meta plus the file path. Not filtered by time:
// callers decide. A folder that is missing, linked or outside sessions/ is skipped.
function scanMeta(home, sinceMs, now = Date.now()) {
  if (typeof home !== 'string' || home === '') return [];
  const root = path.resolve(home, 'sessions');
  const out = [];
  for (const rel of dayDirs(sinceMs, now)) {
    const dir = path.join(root, rel);
    if (!under(root, dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile() || !ROLLOUT_RE.test(ent.name)) continue;
      const file = path.join(dir, ent.name);
      const meta = firstMeta(file);
      if (meta !== null) out.push({ ...meta, spawn: meta.spawn === null ? null : { ...meta.spawn }, file });
    }
  }
  return out;
}

// Day folders older than the window, newest first: from the day before the window's first day back to the newest DAYS_MAX
// folders counted from the day of now. Empty for a bad input.
function olderDayDirs(sinceMs, now = Date.now()) {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(now)) return [];
  const last = localDay(now);
  const floor = addDays(last, -(DAYS_MAX - 1));
  const first = addDays(localDay(sinceMs), -2);
  const out = [];
  for (let d = first > last ? last : first; d >= floor; d = addDays(d, -1)) out.push(dayFolder(d));
  return out;
}

// The rollout of one thread that sits in an older day folder, found by its id. Codex names a rollout
// rollout-<time>-<thread id>.jsonl, so the name is checked first and the first line must then name the thread. A folder
// that is missing or a link is skipped. Null when nothing matches.
function findBeforeWindow(home, id, sinceMs, now = Date.now()) {
  if (typeof home !== 'string' || home === '' || typeof id !== 'string' || !ID_RE.test(id)) return null;
  const root = path.resolve(home, 'sessions');
  const suffix = `-${id}.jsonl`;
  for (const rel of olderDayDirs(sinceMs, now)) {
    const dir = path.join(root, rel);
    if (!under(root, dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile() || !ROLLOUT_RE.test(ent.name) || !ent.name.endsWith(suffix)) continue;
      const file = path.join(dir, ent.name);
      const meta = firstMeta(file);
      if (meta !== null && meta.id === id) return { ...meta, spawn: meta.spawn === null ? null : { ...meta.spawn }, file };
    }
  }
  return null;
}

// The parent thread id of the sub-agent that a run with this token spawned: the newest one that started at or after
// sinceMs and whose agent_path starts with /root/<token>_. A sub-agent whose parent is itself a sub-agent is not a run
// of the lead, so it never counts. Null when nothing matches.
function findByToken(home, token, sinceMs, now = Date.now()) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token) || !Number.isFinite(sinceMs)) return null;
  const prefix = `${ROOT}${token}_`;
  const metas = scanMeta(home, sinceMs, now);
  const byId = new Map(metas.map((m) => [m.id, m]));
  let best = null;
  for (const m of metas) {
    const s = m.spawn;
    if (s === null || m.timestamp < sinceMs || !s.agentPath || !s.agentPath.startsWith(prefix)) continue;
    if (s.agentPath.length <= prefix.length) continue;
    const parent = byId.get(s.parentId);
    if (parent && parent.spawn !== null) continue;
    if (best === null || m.timestamp > best.timestamp || (m.timestamp === best.timestamp && m.id > best.id)) best = m;
  }
  return best === null ? null : best.spawn.parentId;
}

// Item map from a sanitized item id to the item id the board knows. Accepts a Map or a plain object.
function itemMapOf(src) {
  const map = new Map();
  const entries = src instanceof Map ? [...src] : isObj(src) ? Object.entries(src) : [];
  for (const [k, v] of entries) {
    const key = typeof k === 'string' ? sanitize(k) : '';
    const value = shortText(v, 80);
    if (key !== '' && value !== null) map.set(key, value);
  }
  return map;
}

// Run status from the lead and its sub-agents. running while anything runs; done once the lead completed; stopped when
// the lead stopped; waiting while nothing has been seen yet (no lead file, or a lead with no turn in the window); unknown
// otherwise.
function runStatusOf(leadStatus, statuses) {
  if (leadStatus === 'running' || statuses.includes('running')) return 'running';
  if (leadStatus === 'done') return 'done';
  if (leadStatus === 'stopped') return 'stopped';
  return (leadStatus === null || leadStatus === 'waiting') && statuses.length === 0 ? 'waiting' : 'unknown';
}

// createRolloutFollower({ home, parentThreadId, sinceMs, token, itemMap, onAgents, intervalMs, now }) follows the lead
// thread and its sub-agents that started at or after sinceMs. intervalMs is the timer period (0 means polls only, by
// hand). now is the clock, Date.now by default. Returns:
//   poll()          one read of every rollout; the timer calls it every intervalMs
//   agents()        the newest AGENTS_MAX sub-agents: { id, parentId, label, itemId, depth, role, nickname, status,
//                   model, sandbox, tokens, cached, startedAt, lastActivityAt, endedAt }
//   run()           { id, status, leadStatus, startedAt, lastActivityAt, endedAt, agentCount, done, running, stopped,
//                   tokens } where status is running, done, stopped, unknown or waiting
//   lastActivity()  the newest activity of any followed thread in ms, or null
//   stop()          clears the timer; running threads read as stopped from now on, and poll() does nothing
// onAgents(agents, changed, run) runs after a poll that changed an agent or the run status. changed lists the agents
// whose fields differ from the last call. An error thrown by onAgents is ignored, so the timer never stops the board.
function createRolloutFollower(opts = {}) {
  const o = isObj(opts) ? opts : {};
  const parentThreadId = idOf(o.parentThreadId);
  if (parentThreadId === null) throw new TypeError('parentThreadId must be a thread id');
  if (typeof o.home !== 'string' || o.home === '') throw new TypeError('home must be a folder path');
  if (!Number.isFinite(o.sinceMs)) throw new TypeError('sinceMs must be a finite number');
  const intervalMs = o.intervalMs === undefined ? DEFAULT_INTERVAL_MS : o.intervalMs;
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError('intervalMs must be a number of 0 or more');
  }
  const { home, sinceMs } = o;
  const token = typeof o.token === 'string' && TOKEN_RE.test(o.token) ? o.token : null;
  const itemMap = itemMapOf(o.itemMap);
  const onAgents = typeof o.onAgents === 'function' ? o.onAgents : null;
  const clock = typeof o.now === 'function' ? o.now : Date.now;

  const threads = new Map();  // thread id -> state of the lead and of every sub-agent followed
  let sigs = new Map();       // agent id -> JSON of the agent as last passed to onAgents
  let lastRunStatus = null;
  let stopped = false;
  let polls = 0;
  let leadLookupAt = -Infinity; // the lead may be looked up in the older folders from this time on
  let timer = null;

  function addThread(meta, lead, depth) {
    const th = {
      id: meta.id,
      meta,
      lead,
      depth,
      tail: createTail(meta.file, { maxBytes: TAIL_BYTES }),
      behind: true,            // a read returned a full chunk, or nothing has been read yet: the file may have more
      turnOpen: false,         // a task_started with no task_complete or turn_aborted after it
      last: null,              // 'done' or 'stopped': how the newest closed turn ended (the lead: a turn in the window)
      endedMs: null,
      firstMs: null,           // the lead: start of its first turn in the window, where the run starts
      lastMs: meta.timestamp,  // newest activity: a line's timestamp, or the poll time for an oversized line
      sandbox: null,
      model: null,
      cur: null,               // newest token_count total at or after sinceMs
      base: null,              // newest token_count total before sinceMs
    };
    threads.set(meta.id, th);
    return th;
  }

  // The file was truncated: whatever was derived from its earlier lines is discarded.
  function resetDerived(th) {
    Object.assign(th, {
      turnOpen: false, last: null, endedMs: null, firstMs: null, lastMs: th.meta.timestamp,
      sandbox: null, model: null, cur: null, base: null,
    });
  }

  function takeTotals(th, p, ms) {
    const info = isObj(p.info) ? p.info : null;
    const u = info && isObj(info.total_token_usage) ? info.total_token_usage : null;
    const input = u ? count(u.input_tokens) : null;
    const output = u ? count(u.output_tokens) : null;
    if (input === null || output === null) return;
    const snap = { input, cached: count(u.cached_input_tokens) ?? 0, output };
    if (ms !== null && ms < sinceMs) th.base = snap;
    else th.cur = snap;
  }

  function applyLine(th, line) {
    const ms = msOf(line.timestamp);
    if (ms !== null && ms > th.lastMs) th.lastMs = ms;
    const p = isObj(line.payload) ? line.payload : null;
    if (p === null) return;
    if (line.type === 'turn_context') {
      const sandbox = sandboxOf(p.sandbox_policy);
      if (sandbox !== null) th.sandbox = sandbox;
      const model = shortText(p.model, 80);
      if (model !== null) th.model = model;
    } else if (line.type === 'event_msg') {
      if (p.type === 'task_started') {
        th.turnOpen = true;
        if (th.lead && th.firstMs === null && ms !== null && ms >= sinceMs) th.firstMs = ms;
      } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        th.turnOpen = false;
        // The lead's turns that closed before the window do not decide its outcome, as its usage before the window does
        // not count (takeTotals). A turn that was open at sinceMs still reads as running until it closes.
        if (!(th.lead && ms !== null && ms < sinceMs)) {
          th.last = p.type === 'task_complete' ? 'done' : 'stopped';
          th.endedMs = ms;
        }
      } else if (p.type === 'token_count') {
        takeTotals(th, p, ms);
      }
    }
  }

  const formula = (s) => (s === null ? 0 : s.input - s.cached + s.output);
  function usageOf(th) {
    if (th.cur === null && th.base === null) return { tokens: null, cached: null };
    return {
      tokens: Math.max(0, formula(th.cur) - formula(th.base)),
      cached: Math.max(0, (th.cur ? th.cur.cached : 0) - (th.base ? th.base.cached : 0)),
    };
  }

  // A thread still behind its file reads as running, or as stopped once stop() has been called: a long rollout is read a
  // megabyte per poll, and a closed turn is not final until the whole file has been read. A closed turn keeps its
  // outcome. An open turn is stopped by stop(), and by silence only once the thread has caught up with its file: its old
  // lines must not read as silence. The lead with no turn in the window reads as waiting.
  function statusOf(th, t) {
    if (th.behind) return stopped ? 'stopped' : 'running';
    if (!th.turnOpen && th.last !== null) return th.last;
    if (stopped) return 'stopped';
    if (th.lead && !th.turnOpen) return 'waiting';
    return t - th.lastMs > SILENCE_MS ? 'stopped' : 'running';
  }

  function agentOf(th, t) {
    const status = statusOf(th, t);
    const usage = usageOf(th);
    const sp = th.meta.spawn;
    const full = sp.agentPath || '';
    const name = shortText(full.startsWith(ROOT) ? full.slice(ROOT.length) : full, 200);
    const key = token !== null && name !== null && name.startsWith(`${token}_`) ? sanitize(name.slice(token.length + 1)) : '';
    return {
      id: th.id,
      parentId: sp.parentId,
      label: name,
      itemId: key === '' ? null : (itemMap.get(key) ?? null),
      depth: th.depth,
      role: sp.role,
      nickname: sp.nickname,
      status,
      model: th.model,
      sandbox: th.sandbox,
      tokens: usage.tokens,
      cached: usage.cached,
      startedAt: th.meta.timestamp,
      lastActivityAt: th.lastMs,
      endedAt: status === 'running' ? null : (th.endedMs ?? th.lastMs),
    };
  }

  function agentsAt(t) {
    return [...threads.values()]
      .filter((th) => !th.lead)
      .sort((a, b) => a.meta.timestamp - b.meta.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(-AGENTS_MAX)
      .map((th) => agentOf(th, t));
  }

  function runAt(t) {
    const lead = threads.get(parentThreadId) || null;
    const subs = [...threads.values()].filter((th) => !th.lead);
    const leadStatus = lead ? statusOf(lead, t) : null;
    const statuses = subs.map((th) => statusOf(th, t));
    const status = runStatusOf(leadStatus, statuses);
    let tokens = null;
    let lastActivityAt = null;
    for (const th of threads.values()) {
      const n = usageOf(th).tokens;
      if (n !== null) tokens = (tokens ?? 0) + n;
      if (lastActivityAt === null || th.lastMs > lastActivityAt) lastActivityAt = th.lastMs;
    }
    // A resumed session keeps the day it started, so its run starts with its first turn in the window.
    const leadStart = lead === null ? null : (lead.meta.timestamp >= sinceMs ? lead.meta.timestamp : lead.firstMs);
    const starts = subs.map((th) => th.meta.timestamp);
    if (leadStart !== null) starts.push(leadStart);
    const startedAt = starts.length > 0 ? Math.min(...starts) : null;
    return {
      id: parentThreadId,
      status,
      leadStatus,
      startedAt,
      lastActivityAt,
      endedAt: status === 'done' && lead ? (lead.endedMs ?? lead.lastMs) : null,
      agentCount: subs.length,
      done: statuses.filter((s) => s === 'done').length,
      running: statuses.filter((s) => s === 'running').length,
      stopped: statuses.filter((s) => s === 'stopped').length,
      tokens,
    };
  }

  // Scans the day folders and adds the lead and every sub-agent that descends from it through thread_spawn links. The
  // lead is looked up in the older folders when the window does not hold it.
  function discover(t) {
    const metas = scanMeta(home, sinceMs, t);
    const byId = new Map();
    const children = new Map();  // parent id -> the sub-agent metas that started in the window
    for (const m of metas) {
      if (!byId.has(m.id)) byId.set(m.id, m);
      if (m.spawn !== null && m.timestamp >= sinceMs) {
        const list = children.get(m.spawn.parentId) || [];
        list.push(m);
        children.set(m.spawn.parentId, list);
      }
    }
    let lead = byId.get(parentThreadId) || null;
    if (lead === null && !threads.has(parentThreadId) && t >= leadLookupAt) {
      leadLookupAt = t + LEAD_RETRY_MS;
      lead = findBeforeWindow(home, parentThreadId, sinceMs, t);
    }
    if (lead && !threads.has(parentThreadId)) addThread(lead, true, 0);
    const level = new Map([[parentThreadId, 0]]);
    const queue = [parentThreadId];
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i];
      for (const m of children.get(parent) || []) {
        if (level.has(m.id) || (!threads.has(m.id) && threads.size >= THREADS_MAX)) continue;
        level.set(m.id, level.get(parent) + 1);
        queue.push(m.id);
        if (!threads.has(m.id)) addThread(m, false, m.spawn.depth ?? level.get(m.id));
      }
    }
  }

  // Reads each followed rollout from its offset. The lead comes first; the sub-agents take turns at the front, so a
  // long backlog on one of them cannot starve the others.
  function readAll(t) {
    const lead = threads.get(parentThreadId);
    const subs = [...threads.values()].filter((th) => !th.lead);
    const k = subs.length > 0 ? polls % subs.length : 0;
    const order = [...(lead ? [lead] : []), ...subs.slice(k), ...subs.slice(0, k)];
    let budget = POLL_BYTES;
    for (const th of order) {
      if (budget <= 0) break;
      const before = th.tail.offset;
      const r = th.tail.poll();
      const read = r.reset ? th.tail.offset : th.tail.offset - before;
      budget -= read;
      if (!r.gone) th.behind = read >= TAIL_BYTES;
      if (r.reset) resetDerived(th);
      for (const line of r.lines) applyLine(th, line);
      if (r.heads.length > 0 && t > th.lastMs) th.lastMs = t;
    }
  }

  function publish(t) {
    const list = agentsAt(t);
    const run = runAt(t);
    const next = new Map();
    const changed = [];
    for (const a of list) {
      const sig = JSON.stringify(a);
      next.set(a.id, sig);
      if (sigs.get(a.id) !== sig) changed.push(a);
    }
    sigs = next;
    const runChanged = run.status !== lastRunStatus;
    lastRunStatus = run.status;
    if ((changed.length > 0 || runChanged) && onAgents !== null) {
      try { onAgents(list, changed, run); } catch {}
    }
  }

  function poll() {
    if (stopped) return;
    polls += 1;
    const t = clock();
    discover(t);
    readAll(t);
    publish(t);
  }

  function agents() { return agentsAt(clock()); }
  function run() { return runAt(clock()); }
  function lastActivity() {
    let newest = null;
    for (const th of threads.values()) if (newest === null || th.lastMs > newest) newest = th.lastMs;
    return newest;
  }
  function stop() {
    stopped = true;
    if (timer !== null) { clearInterval(timer); timer = null; }
  }

  if (intervalMs > 0) {
    timer = setInterval(() => { try { poll(); } catch {} }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  return { poll, stop, agents, run, lastActivity };
}

module.exports = {
  codexHome, dayDirs, scanMeta, findByToken, createRolloutFollower, SILENCE_MS, AGENTS_MAX, DAYS_MAX, LEAD_RETRY_MS,
};
