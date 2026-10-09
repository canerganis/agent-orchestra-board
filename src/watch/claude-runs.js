// Claude Code runs watcher (plan F4, sections 4.1 to 4.7). Read-only: it finds the Workflow runs that Claude Code
// records under <claudeHome>/projects, follows them by polling, and reports them through the reducer in
// claude-journal.js. Nothing is written, renamed or deleted, and no process is started.
//
// Layout under <claudeHome>/projects/<folder>/ (claudeHome is $CLAUDE_CONFIG_DIR or ~/.claude):
//   <session>.jsonl                                   main transcript, read once for its first cwd (256 KB window)
//   <session>/subagents/workflows/<runId>/journal.jsonl
//   <session>/subagents/workflows/<runId>/agent-<id>.meta.json and agent-<id>.jsonl
//   <session>/workflows/<runId>.json                  the summary, written when the run ends
//
// Membership (scope 'project'): folder names are prefiltered (the encoded project path, an encoded ancestor below
// the home folder, or the encoded project path plus '-'), then each session is confirmed by the canonical cwd of its
// main transcript: equal to the project, under it, or an ancestor of it below the home folder. A session with no cwd
// in its first 256 KB counts when its folder name is the encoded project path or starts with it plus '-'. Scope 'all'
// takes every folder and session and reads no cwd, so a run's project is null there unless an earlier project scope
// pass read it.
//
// Polling, no fs.watch: one unref'd timer runs a tick every intervals.tick while something is leased or followed,
// and no timer exists otherwise. Discovery runs every intervals.discover under the list lease (60 s, renewed by
// lease('list')), or while a leased or followed run is still unknown. Live runs (running or idle) have their journal
// read every intervals.live; running agents' transcripts are read every intervals.agentsList under the list lease and
// every intervals.live under a detail lease (90 s, lease(runId)) or a follow. Finished runs are read once and read
// again only when their (summary mtime, journal size) changes. One file gives at most 1 MB per tick and all files
// together at most 8 MB, so a big file catches up over several ticks. The list keeps the 100 runs with the newest
// activity, plus leased and followed runs.
//
// Run status uses the newest mtime of the journal and of the transcripts of agents not yet done. The main session
// transcript is left out on purpose: it keeps growing after a run ends, so it would hold a finished run at running
// (see deriveRunStatus in claude-journal.js). A run with no journal uses its summary's mtime.
//
// Events: broadcast({ t: 'wfRuns', runs }) when the list changes while the list lease is active, and
// broadcast({ t: 'wfRun', run, agents }) with only the changed agents, at most every 500 ms per run, while that run
// has a detail lease. follow(runId, cb) gets the same { run, agents } objects; its first call carries every agent and
// can come before follow() returns. findByToken(token, sinceMs) and get(runId) run a discovery pass of their own when
// the last one is older than the discovery interval, so they work without a lease.
//
// Privacy: previews are read on demand by preview() and never kept, broadcast or cached. Ids are checked before any
// file access, folders are checked with under() against <claudeHome>/projects, and links are never followed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createTail, readFirstMatching, statSafe, under } = require('./tail');
const J = require('./claude-journal');

const DEFAULT_INTERVALS = Object.freeze({ tick: 1000, discover: 15000, live: 2000, agentsList: 10000 });
const LIST_LEASE_MS = 60 * 1000;
const DETAIL_LEASE_MS = 90 * 1000;
const FILE_BYTES = 1 << 20;          // read per file per tick (plan 4.3)
const TICK_BYTES = 8 << 20;          // read over all files per tick (plan 4.3)
const LINE_MAX = 4 << 20;            // a longer line is skipped, its head is kept
const HEAD_BYTES = 512;
const CWD_BYTES = 256 << 10;         // window searched for the session cwd (plan 4.1)
const META_MAX = 256 << 10;          // a larger agent meta file is ignored
const SUMMARY_MAX = 4 << 20;         // a larger summary is ignored
const RUNS_MAX = 100;                // runs in the list (plan 4.3)
const SEND_GAP_MS = 500;             // wfRun at most this often per run (plan 4.7)
const PREVIEW_MAX = 400;             // characters per preview field (plan 4.6)
const PREVIEW_POLLS = 64;            // journal megabytes scanned at most for a preview result
const DIR_SETTLE_MS = 2000;          // a folder listed this soon after its mtime is listed again next time
const SESSION_RE = /^[A-Za-z0-9_-]{1,100}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WIN = process.platform === 'win32';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const realpath = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
const fold = (s) => (WIN ? s.toLowerCase() : s);
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const maxOf = (a, b) => (a === null || a === undefined ? (b === undefined ? null : b) : b === null || b === undefined ? a : Math.max(a, b));
const isDirent = (d) => d.isDirectory() && !d.isSymbolicLink();
const isFileEnt = (d) => d.isFile() && !d.isSymbolicLink();

// Absolute, resolved and, when it exists, real path, folded for comparison on Windows. Null for anything else.
function canon(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || !path.isAbsolute(p)) return null;
  let abs = path.resolve(p);
  try { abs = realpath(abs); } catch {}
  return fold(abs);
}
const strictlyUnder = (child, root) => {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return child.length > prefix.length && child.startsWith(prefix);
};

// Clips a preview to PREVIEW_MAX UTF-16 units without leaving half a surrogate pair.
function clip(s) {
  if (typeof s !== 'string') return null;
  let out = s.slice(0, PREVIEW_MAX);
  const last = out.charCodeAt(out.length - 1);
  if (out.length === PREVIEW_MAX && last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

// The first user text of a transcript line, or null.
function userText(o) {
  if (!isObj(o) || o.type !== 'user' || !isObj(o.message)) return null;
  const c = o.message.content;
  if (typeof c === 'string') return c || null;
  if (Array.isArray(c)) {
    for (const b of c) if (isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text) return b.text;
  }
  return null;
}

// A small JSON file: an object, or null when missing, a link, not a file, larger than max or not an object.
function readJsonFile(file, max) {
  const st = statSafe(file);
  if (!st || !st.isFile() || st.size > max) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(v) ? { value: v, stat: st } : null;
  } catch { return null; }
}

function createClaudeRuns({
  project,
  broadcast = () => {},
  home,
  scope = () => 'project',
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  intervals = {},
  userHome = os.homedir(),
} = {}) {
  const iv = { ...DEFAULT_INTERVALS, ...(isObj(intervals) ? intervals : {}) };
  const claudeHome = home || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const root = path.resolve(claudeHome, 'projects');

  // Project identity: canonical path, its encoded folder names, and its encoded ancestors below the home folder.
  const projectCanon = canon(project);
  const homeCanon = canon(userHome);
  const variants = [];
  if (typeof project === 'string' && path.isAbsolute(project)) {
    variants.push(path.resolve(project));
    try { variants.push(realpath(path.resolve(project))); } catch {}
  }
  const encNames = new Set(variants.map((v) => J.encodeProjectDir(v).toLowerCase()));
  const ancestorNames = new Set();
  for (const v of variants) {
    const h = homeCanon;
    for (let d = path.dirname(v); d !== path.dirname(d); d = path.dirname(d)) {
      if (h && strictlyUnder(fold(d), h)) ancestorNames.add(J.encodeProjectDir(d).toLowerCase());
    }
  }
  const nameMatch = (name) => {
    const n = name.toLowerCase();
    if (encNames.has(n)) return true;
    for (const e of encNames) if (n.startsWith(e + '-')) return true;
    return false;
  };
  const prefilter = (name) => nameMatch(name) || ancestorNames.has(name.toLowerCase());
  const related = (c) => {
    if (!c || !projectCanon) return false;
    if (c === projectCanon || strictlyUnder(c, projectCanon)) return true;
    return strictlyUnder(projectCanon, c) && !!homeCanon && strictlyUnder(c, homeCanon);
  };

  let stopped = false;
  let timer = null;
  let listUntil = 0;
  const details = new Map();    // runId -> lease end
  const followers = new Map();  // runId -> Set of callbacks
  const runs = new Map();       // runId -> run record
  const folders = new Map();    // folder name -> { list, ok }
  const sessions = new Map();   // folder/session -> session record
  const rootCache = newDirCache();
  let lastDiscover = null;
  let nextDiscover = 0;
  let lastScope = null;
  let lastListHash = null;

  function newDirCache() { return { mtime: null, listedAt: 0, names: [], ok: undefined }; }

  // Names in a folder, listed again only when its mtime changes (or changed too recently to trust). The folder must
  // lie under the projects root without links; it is checked once, when first seen.
  function listDir(dir, cache, keep, budget) {
    const st = statSafe(dir);
    if (!st || !st.isDirectory()) { cache.mtime = null; cache.names = []; cache.ok = undefined; return cache.names; }
    if (cache.ok === undefined) cache.ok = dir === root ? true : under(root, dir);
    if (!cache.ok) return [];
    if (cache.mtime === st.mtimeMs && cache.listedAt - st.mtimeMs >= DIR_SETTLE_MS) return cache.names;
    try {
      cache.names = fs.readdirSync(dir, { withFileTypes: true }).filter(keep).map((d) => d.name);
    } catch { cache.names = []; }
    cache.mtime = st.mtimeMs;
    cache.listedAt = Date.now(); // wall clock: compared with file system times
    if (budget) budget.left -= 4096;
    return cache.names;
  }

  const scopeNow = () => {
    let s = 'project';
    try { s = scope(); } catch {}
    return s === 'all' ? 'all' : 'project';
  };
  const listActive = (t) => listUntil > t;
  const detailActive = (id, t) => (details.get(id) || 0) > t;
  const pinned = (id, t) => detailActive(id, t) || followers.has(id);
  const active = () => !stopped && (listUntil > now() || details.size > 0 || followers.size > 0);

  // ---- membership ---------------------------------------------------------------------------------------------------

  function member(sess, budget) {
    if (sess.final) return sess.member;
    const st = statSafe(sess.transcript);
    if (!st || !st.isFile()) return nameMatch(sess.folder);
    if (st.size === sess.cwdSize) return sess.member;
    if (budget.left < Math.min(st.size, CWD_BYTES)) return sess.member === null ? false : sess.member;
    budget.left -= Math.min(st.size, CWD_BYTES);
    const hit = readFirstMatching(sess.transcript, (o) => typeof o.cwd === 'string' && o.cwd !== '', CWD_BYTES);
    sess.cwdSize = st.size;
    if (hit) {
      sess.cwd = hit.cwd.slice(0, 4096);
      sess.member = related(canon(hit.cwd));
      sess.final = true;
    } else {
      sess.member = nameMatch(sess.folder);
      sess.final = st.size >= CWD_BYTES;
    }
    return sess.member;
  }

  // ---- discovery ----------------------------------------------------------------------------------------------------

  function discover(t, sc, budget) {
    lastDiscover = t;
    nextDiscover = t + iv.discover;
    lastScope = sc;
    const found = new Map();
    const names = listDir(root, rootCache, isDirent, budget);
    const seenFolders = new Set();
    const seenSessions = new Set();
    for (const name of names) {
      if (sc === 'project' && !prefilter(name)) continue;
      seenFolders.add(name);
      const fdir = path.join(root, name);
      let fc = folders.get(name);
      if (!fc) { fc = newDirCache(); folders.set(name, fc); }
      const sids = listDir(fdir, fc, (d) => isDirent(d) && SESSION_RE.test(d.name), budget);
      for (const sid of sids) {
        const key = name + '/' + sid;
        seenSessions.add(key);
        let sess = sessions.get(key);
        if (!sess) {
          const dir = path.join(fdir, sid);
          sess = {
            key, folder: name, id: sid, dir, transcript: path.join(fdir, sid + '.jsonl'),
            cwd: null, member: null, final: false, cwdSize: -1, wf: newDirCache(), sums: newDirCache(),
          };
          sessions.set(key, sess);
        }
        if (sc === 'project' && !member(sess, budget)) continue;
        const wfDir = path.join(sess.dir, 'subagents', 'workflows');
        const sumDir = path.join(sess.dir, 'workflows');
        const wf = listDir(wfDir, sess.wf, (d) => isDirent(d) && J.isRunId(d.name), budget);
        const sums = listDir(sumDir, sess.sums, (d) => isFileEnt(d) && d.name.endsWith('.json') && J.isRunId(d.name.slice(0, -5)), budget);
        for (const id of wf) if (!found.has(id)) found.set(id, { sess, dir: path.join(wfDir, id), summary: null });
        for (const n of sums) {
          const id = n.slice(0, -5);
          const f = found.get(id);
          if (!f) found.set(id, { sess, dir: null, summary: path.join(sumDir, n) });
          else if (f.sess === sess) f.summary = path.join(sumDir, n);
        }
      }
    }
    for (const k of folders.keys()) if (!seenFolders.has(k)) folders.delete(k);
    for (const k of sessions.keys()) if (!seenSessions.has(k)) sessions.delete(k);

    // Cheap activity estimate from two stats per run; the newest RUNS_MAX are kept, and every pinned run.
    const cands = [];
    for (const [id, f] of found) {
      const js = f.dir ? statSafe(path.join(f.dir, 'journal.jsonl')) : null;
      const ss = f.summary ? statSafe(f.summary) : null;
      const estimate = Math.max(js && js.isFile() ? js.mtimeMs : 0, ss && ss.isFile() ? ss.mtimeMs : 0);
      const key = `${ss && ss.isFile() ? ss.mtimeMs : '-'}:${js && js.isFile() ? js.size : '-'}`;
      cands.push({ id, f, estimate, key });
    }
    cands.sort((a, b) => b.estimate - a.estimate);
    const keep = new Set();
    cands.forEach((c, i) => {
      if (i >= RUNS_MAX && !pinned(c.id, t)) return;
      keep.add(c.id);
      let run = runs.get(c.id);
      if (!run || run.session !== c.f.sess) { run = newRun(c.id, c.f.sess, c.f.dir, c.f.summary); runs.set(c.id, run); }
      else {
        if (c.f.dir && !run.dir) setRunDir(run, c.f.dir);
        if (c.f.summary) run.summaryFile = c.f.summary;
      }
      run.estimate = c.estimate;
      if (run.readKey !== c.key) run.stale = true;
    });
    for (const id of [...runs.keys()]) if (!keep.has(id)) runs.delete(id);
  }

  // ---- runs ---------------------------------------------------------------------------------------------------------

  function newRun(id, sess, dir, summaryFile) {
    const run = {
      id, session: sess, dir: null, journal: null, tail: null, summaryFile, summaryMtime: null,
      state: J.newRunState({ id, project: sess.cwd, sessionId: sess.id }),
      trackers: new Map(), lastChange: null, journalSize: null, journalBorn: null, caughtUp: false,
      readKey: null, stale: true, polled: false, estimate: 0, nextLive: 0, nextAgents: 0, nextProbe: 0,
      agentJson: [], runJson: null, pending: new Set(), runDirty: false, sendAll: false, lastSent: -Infinity,
    };
    if (dir) setRunDir(run, dir);
    return run;
  }
  function setRunDir(run, dir) {
    run.dir = dir;
    run.journal = path.join(dir, 'journal.jsonl');
    run.tail = createTail(run.journal, { maxBytes: FILE_BYTES, maxLine: LINE_MAX, headBytes: HEAD_BYTES });
  }
  // A journal that shrank: everything derived from it is dropped and read again.
  function resetRun(run) {
    run.state = J.newRunState({ id: run.id, project: run.session.cwd, sessionId: run.session.id });
    run.trackers = new Map();
    run.summaryMtime = null;
    run.agentJson = [];
    run.sendAll = true;
  }

  const isLive = (run) => run.state.status === 'running' || run.state.status === 'idle';
  const agentFile = (run, id, ext) => path.join(run.dir, `agent-${id}${ext}`);
  const trackerOf = (run, id) => {
    let tr = run.trackers.get(id);
    if (!tr) { tr = { meta: false, tail: null, complete: false }; run.trackers.set(id, tr); }
    return tr;
  };

  // Claude Code writes <session>/workflows/<runId>.json when a run ends, usually after the run was found. Discovery
  // sees it only under a list lease, so a run read without one looks for it here. True when it was adopted.
  function probeSummary(run) {
    if (run.summaryFile) return false;
    const file = path.join(run.session.dir, 'workflows', run.id + '.json');
    const st = statSafe(file);
    if (!st || !st.isFile() || !under(root, file)) return false;
    run.summaryFile = file;
    return true;
  }

  function readSummary(run, budget) {
    if (!run.summaryFile) return;
    const st = statSafe(run.summaryFile);
    if (!st || !st.isFile() || st.mtimeMs === run.summaryMtime) return;
    if (st.size > SUMMARY_MAX) { run.summaryMtime = st.mtimeMs; return; }
    if (budget.left < st.size) return; // next tick
    budget.left -= st.size;
    const got = readJsonFile(run.summaryFile, SUMMARY_MAX);
    run.summaryMtime = st.mtimeMs;
    if (got) J.applySummary(run.state, got.value);
  }

  function readJournal(run, budget) {
    if (!run.tail) { run.caughtUp = true; return; }
    if (budget.left < FILE_BYTES) return;
    const before = run.tail.offset;
    const r = run.tail.poll();
    if (r.gone) { run.caughtUp = true; return; }
    if (r.reset) resetRun(run);
    budget.left -= r.reset ? run.tail.offset : run.tail.offset - before;
    let h = 0;
    for (let i = 0; i <= r.lines.length; i++) {
      while (h < r.heads.length && r.heads[h].after <= i) J.reduceJournal(run.state, r.heads[h++]);
      if (i < r.lines.length) J.reduceJournal(run.state, r.lines[i]);
    }
    const st = statSafe(run.journal);
    run.journalSize = st ? st.size : null;
    if (st && run.journalBorn === null) run.journalBorn = st.birthtimeMs > 0 ? st.birthtimeMs : null;
    run.caughtUp = !st || run.tail.offset >= st.size;
  }

  function readMetas(run, budget) {
    if (!run.dir) return;
    for (const agent of run.state.agents) {
      if (!agent.id) continue;
      const tr = trackerOf(run, agent.id);
      if (tr.meta || budget.left < META_MAX) continue;
      const got = readJsonFile(agentFile(run, agent.id, '.meta.json'), META_MAX);
      if (!got) continue; // not written yet; tried again on the next read
      budget.left -= got.stat.size;
      tr.meta = true;
      J.applyMeta(agent, got.value, run.state.defaultModel, got.stat.mtimeMs);
    }
  }

  // Newest change of the journal and of the transcripts of agents not yet done (summary mtime without a journal).
  function lastChangeOf(run) {
    let last = null;
    const js = run.journal ? statSafe(run.journal) : null;
    if (js && js.isFile()) last = js.mtimeMs;
    else if (run.summaryFile) { const ss = statSafe(run.summaryFile); if (ss && ss.isFile()) last = ss.mtimeMs; }
    if (run.dir) {
      for (const agent of run.state.agents) {
        if (!agent.id || agent.status === 'done') continue;
        const st = statSafe(agentFile(run, agent.id, '.jsonl'));
        if (st && st.isFile()) last = maxOf(last, st.mtimeMs);
      }
    }
    return last;
  }

  // Transcripts of running agents, and of agents that stopped running but are not read to their end yet.
  function readTranscripts(run, budget) {
    if (!run.dir) return;
    for (const agent of run.state.agents) {
      if (!agent.id) continue;
      const tr = trackerOf(run, agent.id);
      const running = agent.status === 'running';
      if (!running && tr.complete) continue;
      if (budget.left < FILE_BYTES) return;
      const file = agentFile(run, agent.id, '.jsonl');
      if (!tr.tail) tr.tail = createTail(file, { maxBytes: FILE_BYTES, maxLine: LINE_MAX, headBytes: HEAD_BYTES });
      const before = tr.tail.offset;
      const r = tr.tail.poll();
      if (r.gone) { if (!running) tr.complete = true; continue; }
      budget.left -= r.reset ? tr.tail.offset : tr.tail.offset - before;
      for (const line of r.lines) J.applyTranscriptLine(agent, line);
      const st = statSafe(file);
      tr.complete = !running && (!st || tr.tail.offset >= st.size);
    }
  }

  function pollRun(run, t, budget, withAgents) {
    if (run.session.cwd && !run.state.project) run.state.project = run.session.cwd;
    probeSummary(run);
    readSummary(run, budget);
    readJournal(run, budget);
    readMetas(run, budget);
    run.lastChange = lastChangeOf(run);
    J.setRunStatus(run.state, J.deriveRunStatus({ summary: run.state.summary, lastChangeMs: run.lastChange, now: t }));
    if (withAgents) readTranscripts(run, budget);
    run.polled = true;
    const summaryRead = !run.summaryFile || run.summaryMtime !== null;
    if (run.caughtUp && summaryRead) {
      const ss = run.summaryFile ? statSafe(run.summaryFile) : null;
      run.readKey = `${ss && ss.isFile() ? ss.mtimeMs : '-'}:${run.journalSize === null ? '-' : run.journalSize}`;
      run.stale = false;
    }
    noteChanges(run);
  }

  function noteChanges(run) {
    const runJson = JSON.stringify(summaryOf(run));
    if (runJson !== run.runJson) { run.runJson = runJson; run.runDirty = true; }
    run.state.agents.forEach((a, i) => {
      const s = JSON.stringify(a);
      if (run.agentJson[i] !== s) { run.agentJson[i] = s; run.pending.add(i); }
    });
  }

  function summaryOf(run) {
    const s = J.runSummary(run.state);
    s.lastActivityAt = maxOf(s.lastActivityAt, run.lastChange);
    return s;
  }
  const activityOf = (run) => {
    const s = summaryOf(run);
    return s.lastActivityAt !== null ? s.lastActivityAt : run.estimate;
  };

  // Whether a run is read on this tick, and whether its transcripts are.
  function pollIfDue(run, t, budget) {
    const pin = pinned(run.id, t);
    if (!pin && !listActive(t)) return;
    // A followed or detail-leased run without a summary checks for one at the live pace, between discovery passes.
    if (pin && !run.summaryFile && t >= run.nextProbe) {
      run.nextProbe = t + iv.live;
      if (probeSummary(run)) run.stale = true;
    }
    const live = isLive(run);
    if (run.stale || !run.polled) {
      pollRun(run, t, budget, pin || live);
      run.nextLive = t + iv.live;
      // A run that turned out live on its first read gets its transcripts on the next tick.
      run.nextAgents = !pin && !live && isLive(run) ? t : t + (pin ? iv.live : iv.agentsList);
      return;
    }
    if (live) {
      if (t < run.nextLive && t < run.nextAgents) return;
      const withAgents = t >= run.nextAgents;
      pollRun(run, t, budget, withAgents);
      run.nextLive = t + iv.live;
      if (withAgents) run.nextAgents = t + (pin ? iv.live : iv.agentsList);
      return;
    }
    if (pin && t >= run.nextLive) {
      // A finished run under a detail lease or a follow: check its key, and read its transcripts once.
      run.nextLive = t + iv.live;
      const js = run.journal ? statSafe(run.journal) : null;
      const ss = run.summaryFile ? statSafe(run.summaryFile) : null;
      const key = `${ss && ss.isFile() ? ss.mtimeMs : '-'}:${js && js.isFile() ? js.size : '-'}`;
      const incomplete = run.state.agents.some((a) => a.id && !trackerOf(run, a.id).complete);
      if (key !== run.readKey || incomplete) pollRun(run, t, budget, true);
    }
  }

  // ---- events -------------------------------------------------------------------------------------------------------

  function flush(run, t) {
    const pin = detailActive(run.id, t);
    const fl = followers.get(run.id);
    if (!pin && !fl) { run.pending.clear(); run.runDirty = false; return; }
    if (!run.polled || (!run.pending.size && !run.runDirty && !run.sendAll)) return;
    if (t - run.lastSent < SEND_GAP_MS) return;
    const idx = run.sendAll ? run.state.agents.map((_, i) => i) : [...run.pending].sort((a, b) => a - b);
    const agents = idx.map((i) => run.state.agents[i]).filter(Boolean).map((a) => ({ ...a }));
    const summary = summaryOf(run);
    run.lastSent = t;
    run.pending.clear();
    run.runDirty = false;
    run.sendAll = false;
    if (pin) safeSend({ t: 'wfRun', run: summary, agents });
    if (fl) for (const cb of [...fl]) { try { cb({ run: { ...summary }, agents: agents.map((a) => ({ ...a })) }); } catch {} }
  }

  function safeSend(msg) { try { broadcast(msg); } catch {} }

  function emit(t) {
    for (const run of runs.values()) flush(run, t);
    if (listActive(t)) {
      const runsNow = list();
      const h = hash(JSON.stringify(runsNow));
      if (h !== lastListHash) { lastListHash = h; safeSend({ t: 'wfRuns', runs: runsNow }); }
    }
  }

  // ---- loop ---------------------------------------------------------------------------------------------------------

  function expire(t) {
    if (listUntil && listUntil <= t) { listUntil = 0; lastListHash = null; }
    for (const [id, end] of details) if (end <= t) details.delete(id);
  }

  function needDiscovery(t, sc) {
    if (lastDiscover === null) return true;
    if (listActive(t)) return t >= nextDiscover || sc !== lastScope;
    const unknownPin = [...details.keys(), ...followers.keys()].some((id) => !runs.has(id));
    return unknownPin && t >= nextDiscover;
  }

  function work(t) {
    try {
      const budget = { left: TICK_BYTES };
      const sc = scopeNow();
      if (needDiscovery(t, sc)) discover(t, sc, budget);
      const order = [...runs.values()].sort((a, b) => (pinned(b.id, t) - pinned(a.id, t)) || (b.estimate - a.estimate));
      for (const run of order) pollIfDue(run, t, budget);
      emit(t);
    } catch {}
  }

  function tick() {
    timer = null;
    if (stopped) return;
    const t = now();
    expire(t);
    if (!active()) return;
    work(t);
    schedule();
  }

  function schedule() {
    if (stopped || timer !== null || !active()) return;
    timer = setTimer(tick, iv.tick);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // Starts the loop with an immediate pass when it is not running.
  function kick() {
    if (stopped || timer !== null) return;
    const t = now();
    expire(t);
    if (!active()) return;
    work(t);
    schedule();
  }

  // ---- public -------------------------------------------------------------------------------------------------------

  function available() {
    const st = statSafe(root);
    return !!st && st.isDirectory();
  }

  function list() {
    return [...runs.values()]
      .filter((r) => r.polled)
      .map((r) => ({ r, a: activityOf(r) }))
      .sort((x, y) => (y.a || 0) - (x.a || 0))
      .slice(0, RUNS_MAX)
      .map((x) => summaryOf(x.r));
  }

  // A known run, or one found by a discovery pass when the last one is older than the discovery interval.
  function locate(runId) {
    if (stopped || !J.isRunId(runId)) return null;
    let run = runs.get(runId);
    const t = now();
    if (!run && (lastDiscover === null || t - lastDiscover >= iv.discover)) {
      try { discover(t, scopeNow(), { left: TICK_BYTES }); } catch {}
      run = runs.get(runId);
    }
    if (run && !run.polled) {
      try { pollRun(run, t, { left: TICK_BYTES }, true); } catch {}
    }
    return run || null;
  }

  function get(runId) {
    const run = locate(runId);
    if (!run) return null;
    return { run: summaryOf(run), agents: run.state.agents.map((a) => ({ ...a })) };
  }

  function lease(kind) {
    if (stopped) return false;
    const t = now();
    if (kind === 'list') listUntil = t + LIST_LEASE_MS;
    else if (J.isRunId(kind)) {
      details.set(kind, t + DETAIL_LEASE_MS);
      const run = runs.get(kind);
      if (run) { run.nextLive = 0; run.nextAgents = 0; }
    } else return false;
    kick();
    return true;
  }

  function follow(runId, cb) {
    if (stopped || !J.isRunId(runId) || typeof cb !== 'function') return () => {};
    let set = followers.get(runId);
    if (!set) { set = new Set(); followers.set(runId, set); }
    const own = (payload) => cb(payload);
    set.add(own);
    const run = runs.get(runId);
    if (run) { run.sendAll = true; run.nextLive = 0; run.nextAgents = 0; }
    kick();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const s = followers.get(runId);
      if (!s) return;
      s.delete(own);
      if (!s.size) followers.delete(runId);
    };
  }

  // Runs with an agent whose started label begins with '<token>:' and that started at or after sinceMs, newest first.
  function findByToken(token, sinceMs) {
    if (stopped || typeof token !== 'string' || !TOKEN_RE.test(token)) return [];
    if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return [];
    const t = now();
    const budget = { left: TICK_BYTES };
    try {
      if (lastDiscover === null || t - lastDiscover >= iv.discover) discover(t, scopeNow(), budget);
      for (const run of runs.values()) {
        if (!run.polled || run.stale || isLive(run)) pollRun(run, t, budget, false);
      }
    } catch {}
    const prefix = token + ':';
    const out = [];
    for (const run of runs.values()) {
      const s = summaryOf(run);
      // The run's start: the summary's startTime, else its first agent's meta file, else the journal's birth time.
      const start = s.startedAt !== null ? s.startedAt : run.journalBorn;
      if (start === null || start < sinceMs) continue;
      if (run.state.agents.some((a) => typeof a.label === 'string' && a.label.startsWith(prefix))) out.push(s);
    }
    return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  // { prompt, result } for one agent, each clipped to 400 characters, read now and never kept.
  function preview(runId, agentId) {
    if (stopped || !J.isRunId(runId) || !J.isAgentId(agentId)) return null;
    const run = locate(runId);
    if (!run || !J.agentById(run.state, agentId)) return null;
    let prompt = null;
    let result = null;
    if (run.summaryFile && under(root, run.summaryFile)) {
      const got = readJsonFile(run.summaryFile, SUMMARY_MAX);
      const wp = got && Array.isArray(got.value.workflowProgress) ? got.value.workflowProgress : [];
      const entry = wp.find((p) => isObj(p) && p.agentId === agentId);
      if (entry) {
        if (typeof entry.promptPreview === 'string') prompt = entry.promptPreview;
        if (typeof entry.resultPreview === 'string') result = entry.resultPreview;
      }
    }
    if (prompt === null && run.dir) {
      const file = agentFile(run, agentId, '.jsonl');
      if (under(root, file)) {
        const hit = readFirstMatching(file, (o) => userText(o) !== null, CWD_BYTES);
        if (hit) prompt = userText(hit);
      }
    }
    if (result === null && run.journal && under(root, run.journal)) {
      const tail = createTail(run.journal, { maxBytes: FILE_BYTES, maxLine: LINE_MAX, headBytes: HEAD_BYTES });
      for (let i = 0; i < PREVIEW_POLLS; i++) {
        const before = tail.offset;
        const r = tail.poll();
        for (const l of r.lines) {
          if (l.type === 'result' && l.agentId === agentId && 'result' in l) {
            if (typeof l.result === 'string') result = l.result;
            else { try { result = JSON.stringify(l.result); } catch {} }
          }
        }
        if (r.gone || tail.offset === before) break;
      }
    }
    return { prompt: clip(prompt), result: clip(result) };
  }

  function stop() {
    stopped = true;
    if (timer !== null) { try { clearTimer(timer); } catch {} timer = null; }
    listUntil = 0;
    details.clear();
    followers.clear();
  }

  return { available, list, get, lease, follow, findByToken, preview, stop };
}

module.exports = { createClaudeRuns, DEFAULT_INTERVALS, LIST_LEASE_MS, DETAIL_LEASE_MS, RUNS_MAX, PREVIEW_MAX };
