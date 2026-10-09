// HTTP server: static files from public/, SSE, security gate (Host/Origin allowlist, session cookie from the
// per-project token persisted in .orchestra/session, JSON-only POST, validated bodies, security headers) and API
// routes. Threat model: see security.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MODELS, EFFORTS, DEFAULT_PORT, defaultSettings, naive } = require('./config');
const { createStore } = require('./store');
const { createLimits } = require('./limits');
const { createSeats, MODEL_RE } = require('./seats');
const { createRunner } = require('./runner');
const { createRooms } = require('./rooms');
const { createMeeting } = require('./workflows/meeting');
const { createChain } = require('./workflows/chain');
const { createCapability } = require('./capability');
const { createPlan } = require('./workflows/plan');
const patch = require('./patch');
const worktree = require('./worktree');
const { createBuild } = require('./workflows/build');
const { confineTarget } = require('./target');
const sec = require('./security');
const doctor = require('./doctor');
const { createEngines, cliChecks, homesOf, watchOf } = require('./engines');
const { createBoardEngine } = require('./engines/board');
const { createApiV2 } = require('./api');
const { createClaudeRuns } = require('./watch/claude-runs');
const { v } = sec;

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};
const MAX_BODY = 1e6;

// Serves only regular files inside public/ ("/" -> index.html); returns false when nothing matched.
function serveStatic(res, pathname) {
  let rel; try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return false; }
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return false;
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
  return true;
}

// Reads a JSON object body; rejects oversized (413) and malformed (400) bodies. An oversized body is drained
// (discarded) so the client receives the 413 instead of a connection reset; past a hard cap the socket is cut.
// Chunks are concatenated as bytes and decoded once, so a multi-byte character split across TCP reads survives.
function body(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    const fail = (status, m) => reject(Object.assign(new Error(m), { status }));
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { chunks = []; if (size > 16 * MAX_BODY) req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return fail(413, 'body too large');
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(v.object(s ? JSON.parse(s) : {})); } catch (e) { fail(400, e.status ? e.message : 'invalid JSON body'); }
    });
    req.on('error', (e) => fail(400, e.message));
    req.on('close', () => fail(400, 'request closed'));
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const UNAUTH_HTML = '<!doctype html><meta charset="utf-8"><title>Agent Orchestra Board</title><body style="font:15px system-ui;padding:40px;max-width:560px"><h2>Session required</h2><p>This board accepts one browser session per project. Open the link printed in the terminal where Agent Orchestra Board was started (it ends in <code>/?t=&hellip;</code>), or restart the board with <code>--open</code>.</p></body>';
// A ?t= link from another board session (another project, or the session file was deleted): same help, specific cause.
const BAD_TOKEN_HTML = '<!doctype html><meta charset="utf-8"><title>Agent Orchestra Board</title><body style="font:15px system-ui;padding:40px;max-width:560px"><h2>This link is out of date</h2><p>This link belongs to another Agent Orchestra Board session (another project, or the session file was reset). Open the URL printed in the terminal where the board is running now, or restart the board with <code>--open</code>.</p></body>';

// platform and recordsDir are for tests only (a simulated OS, a temp folder for write-check records); the CLI never
// passes them and no env var or flag sets them.
function createServer({ projectDir, port = DEFAULT_PORT, platform, recordsDir } = {}) {
  // port 0 asks the OS for a free port (tests); start() then reports the real one and PORT/COOKIE follow it.
  let PORT = Number(port) === 0 && port !== undefined && port !== null && port !== '' ? 0 : (Number(port) || DEFAULT_PORT);
  const store = createStore(projectDir);
  store.ensure();
  const PROJECT = store.project;
  // Session secret: printed in the start URL, exchanged once for an HttpOnly cookie, required on /api/*.
  // Persisted per project (.orchestra/session, 0600) so a restart keeps open tabs and the dev preview valid.
  const TOKEN = sec.loadOrCreateToken(path.join(store.orch, 'session'));
  let COOKIE = sec.cookieName(PORT);

  // ---------- live events (SSE) ----------
  const clients = new Set();
  function broadcast(ev) { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); }

  const limits = createLimits({ store, broadcast });
  // Saved settings (Settings panel) are merged over the defaults. ORCHESTRA_LANG, when set, overrides the saved language:
  // settings.json keeps the whole object once any setting is saved, so the environment variable would otherwise
  // never apply again.
  const savedSettings = store.readJson('settings.json');
  const settings = { ...defaultSettings(), ...(savedSettings && typeof savedSettings === 'object' && !Array.isArray(savedSettings) ? savedSettings : {}) };
  if (process.env.ORCHESTRA_LANG && process.env.ORCHESTRA_LANG.trim()) settings.lang = process.env.ORCHESTRA_LANG.trim();
  // Runs scope (plan 2.5, 4.2): 'project' unless 'all' was saved. The key is kept only once a valid scope is saved;
  // any other saved value is dropped and reads as 'project'.
  if (settings.watchScope !== 'all' && settings.watchScope !== 'project') delete settings.watchScope;
  const watchScope = () => (settings.watchScope === 'all' ? 'all' : 'project');
  const seats = createSeats({ store, broadcast });
  // The capability gate is created after the runner (it probes through it); the runner reads it lazily, so a turn
  // can never run in write mode before the gate exists.
  let capability = null;
  // onContainment: the runner stopped a write turn whose CLI reported an unsafe setup at its start (writes off for
  // that CLI for the rest of this session).
  const runner = createRunner({
    store, seats, limits, settings, broadcast, platform,
    writeGate: (seat, dir) => !!capability && capability.allowsWrite(seat, dir),
    onContainment: (agent, detail) => capability && capability.recordViolation(agent, detail, 'startup'),
  });
  const rooms = createRooms({ store, seats, runner, broadcast });
  capability = createCapability({ store, runner, seats, broadcast, platform, recordsDir });
  const meeting = createMeeting({ store, seats, rooms, settings }); const { runMeeting } = meeting;
  const chain = createChain({ store, seats, rooms, broadcast, capability, patch }); const { runChain } = chain;
  const planApi = createPlan({ store, seats, rooms, meeting });
  const build = createBuild({ store, seats, rooms, chain, capability, patch, worktree, plan: planApi, broadcast });
  build.recover(); // builds that were running when the board stopped wait for an explicit resume
  const { seatById, publicSeat, rtOf } = seats;
  const { pushRoom, sys, userMsg, newRoom } = rooms;

  // ---------- CLI checks and engines (plan 2.6, 3.1) ----------
  // The doctor's CLI checks feed engine availability. One run starts in the background at start() and another on each
  // GET /api/doctor; every finished run broadcasts the engine list. Only `<cli> --version` is spawned (no model call).
  let doctorCache = null, doctorRun = null;
  const engineEnv = () => ({ cli: cliChecks(doctorCache && doctorCache.checks), capability: capability ? capability.cached() : null, ...homesOf(process.env) });
  function refreshDoctor() {
    if (!doctorRun) {
      doctorRun = doctor.run({ projectDir: PROJECT }).then((r) => {
        doctorCache = r;
        broadcast({ t: 'engines', engines: engines.list(engineEnv()) });
        return r;
      }).finally(() => { doctorRun = null; });
    }
    return doctorRun;
  }
  const ensureDoctor = async () => { if (!doctorCache) await refreshDoctor(); };
  const engines = createEngines({ rooms, broadcast, env: engineEnv });
  engines.register(createBoardEngine({ build, plan: planApi, env: engineEnv }));
  engines.recover(); // rooms of engines that follow outside work resume watching (none before F7)
  // Claude Code runs watcher (plan 4, F4): read-only polling under <claudeHome>/projects, idle until a lease or follow.
  const claudeRuns = createClaudeRuns({ project: PROJECT, broadcast, home: homesOf(process.env).claudeHome, scope: watchScope });
  const apiV2 = createApiV2({ rooms, engines, capability, project: PROJECT, ensureDoctor, claudeRuns, watchScope });

  // state(): `rooms` keeps the 25 newest rooms in full; `roomIndex` lists the newest 500 by metadata only, so the sidebar
  // can show every room of a mode. apiVersion 2 marks the fields added with it (engines, watch, roomIndex).
  const byNewest = (a, b) => String(b.created || '').localeCompare(String(a.created || ''));
  const indexEntry = (r) => ({
    id: r.id, kind: r.kind, title: r.title, status: r.status, created: r.created,
    ...(r.planRoomId ? { planRoomId: r.planRoomId } : {}), ...(r.engine ? { engine: r.engine } : {}),
  });
  function state() {
    const env = engineEnv();
    const newest = [...rooms.rooms.values()].sort(byNewest);
    return {
      project: PROJECT, models: MODELS, efforts: EFFORTS,
      seats: seats.all().map(publicSeat),
      rooms: newest.slice(0, 25),
      roomIndex: newest.slice(0, 500).map(indexEntry),
      limits: limits.get(), settings, naive: naive(), capability: capability.cached(),
      apiVersion: 2, engines: engines.list(env), watch: { ...watchOf(env), claude: claudeRuns.available() },
    };
  }
  const ids = (arr) => arr.filter((id) => seatById(id));
  // Per-session overrides from the New session modal: { seatId: { model?, effort? } }, validated like seats (a CLI
  // model name, an effort the seat's CLI supports). Empty values mean the seat's own setting. Only real seats.
  function overridesOf(raw) {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('overrides must be an object keyed by agent id');
    const out = {};
    for (const [id, o] of Object.entries(raw)) {
      const seat = seatById(id); if (!seat) throw new Error('no such agent');
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('each override must be an object');
      const e = {};
      if (o.model !== undefined && o.model !== null && o.model !== '') {
        if (typeof o.model !== 'string' || !MODEL_RE.test(o.model)) throw new Error('invalid model name');
        e.model = o.model;
      }
      if (o.effort !== undefined && o.effort !== null && o.effort !== '') {
        if (!EFFORTS[seat.agent].includes(o.effort)) throw new Error(`effort "${o.effort}" is not supported by ${seat.name}`);
        e.effort = o.effort;
      }
      if (Object.keys(e).length) out[id] = e;
    }
    return out;
  }
  const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
  // Build routes: an unknown room or one that is not a build is 404 'no such build'; an item the build does not have is
  // 404 'no such item'. Both bodies are exactly { error }, without a code.
  const buildRoom = (id) => { const r = rooms.rooms.get(id); return r && r.kind === 'build' ? r : null; };
  const hasItem = (room, item) => !!room.items && Object.prototype.hasOwnProperty.call(room.items, item);
  const sha256Of = (x) => {
    const h = v.str(x, 'hash', { max: 64 });
    if (!h || !/^[0-9a-f]{64}$/.test(h)) throw new Error('hash must be a sha256 hex string');
    return h;
  };
  // roles: undefined, or a plain object whose values are '' (role unassigned) or an agent id.
  function rolesOf(raw) {
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('roles must be an object of agent ids');
    const out = {};
    for (const [role, val] of Object.entries(raw)) {
      if (val === '' || val === null || val === undefined) { out[role] = null; continue; }
      if (typeof val !== 'string' || !/^[\w-]{1,64}$/.test(val)) throw new Error('roles must be an object of agent ids');
      out[role] = val;
    }
    return out;
  }

  // ---------- http ----------
  // Everything, including the security gate, runs inside one try: a hostile request must never raise past
  // this function (an unhandled rejection would take the board and its running agent children down).
  async function handle(req, res) {
    try {
      sec.applyHeaders(res);
      // Block DNS rebinding and cross-site requests: Host must be local, and any Origin must be this board.
      const host = String(req.headers.host || '');
      const localHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`];
      if (!localHosts.includes(host)) return json(res, 403, { error: 'forbidden host' });
      const origin = req.headers.origin;
      if (origin && !localHosts.some((h) => origin === `http://${h}`)) return json(res, 403, { error: 'forbidden origin' });
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json required' });
      // Request targets like "//[" make the base-relative parse throw; that is a 400, not a crash.
      let url; try { url = new URL(req.url, 'http://x'); } catch { return json(res, 400, { error: 'bad request' }); }
      const p = url.pathname;
      // Session: the token travels in the URL exactly once (first load), then only in the HttpOnly cookie.
      const authed = sec.tokenEquals(sec.cookieValue(req.headers.cookie, COOKIE), TOKEN);
      if (req.method === 'GET' && p === '/' && url.searchParams.has('t')) {
        if (!sec.tokenEquals(url.searchParams.get('t'), TOKEN)) { res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }); return res.end(BAD_TOKEN_HTML); }
        res.writeHead(303, { location: '/', 'set-cookie': sec.setCookie(COOKIE, TOKEN) }); return res.end();
      }
      if (!authed && p.startsWith('/api/')) return json(res, 401, { error: 'unauthorized: open the URL printed at startup' });
      if (!authed && req.method === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); return res.end(UNAUTH_HTML); }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ t: 'hello' })}\n\n`);
        clients.add(res); const hb = setInterval(() => res.write(': hb\n\n'), 15000);
        return req.on('close', () => { clients.delete(res); clearInterval(hb); });
      }
      if (req.method === 'GET' && p === '/api/state') return json(res, 200, state());
      if (req.method === 'GET' && p === '/api/capability') return json(res, 200, await capability.status({ detect: true }));
      if (req.method === 'GET' && p === '/api/doctor') return json(res, 200, await refreshDoctor());
      const gp = p.match(/^\/api\/build\/([\w-]+)\/items\/([a-z0-9][a-z0-9-]{0,31})\/proposal$/);
      if (req.method === 'GET' && gp) {
        const room = buildRoom(gp[1]); if (!room) return json(res, 404, { error: 'no such build' });
        if (!hasItem(room, gp[2])) return json(res, 404, { error: 'no such item' });
        return json(res, 200, build.proposalOf(room, gp[2]));
      }
      // One room in full (the sidebar lists rooms from roomIndex and opens one by id).
      const rg = p.match(/^\/api\/rooms\/([\w-]{1,64})$/);
      if (req.method === 'GET' && rg) { const room = rooms.rooms.get(rg[1]); return room ? json(res, 200, room) : json(res, 404, { error: 'no such room' }); }
      if (req.method === 'GET' && await apiV2.handle(req, res, p, null)) return;
      if (req.method === 'GET') return serveStatic(res, p) || json(res, 404, { error: 'not found' });
      const sm = p.match(/^\/api\/seats\/([\w-]+)\/(send|stop|reset|delete)$/);
      if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
      const b = await body(req);
      if (p === '/api/seats') {
        const sb = defined({
          id: v.id(b.id, 'id'), name: v.str(b.name, 'name', { max: 24 }), role: v.str(b.role, 'role', { max: 40 }),
          agent: v.oneOf(b.agent, 'agent', Object.keys(MODELS)), model: v.str(b.model, 'model', { max: 64 }), effort: v.str(b.effort, 'effort', { max: 16 }),
          perm: v.oneOf(b.perm, 'perm', ['read', 'write']), target: v.str(b.target, 'target', { max: 1024 }),
          budget: v.num(b.budget, 'budget', { min: 0, max: 1e12 }), color: v.str(b.color, 'color', { max: 7 }),
        });
        if (sb.id !== undefined && !seatById(sb.id)) return json(res, 404, { error: 'no such agent' });
        if (sb.target !== undefined) sb.target = confineTarget(sb.target, PROJECT).rel; // stored relative to the project
        return json(res, 200, publicSeat(seats.upsertSeat(sb)));
      }
      if (p === '/api/limits/refresh') {
        limits.refreshCodex();
        limits.probeClaude();
        return json(res, 200, { ok: true });
      }
      if (sm) {
        const seat = seatById(sm[1]); if (!seat) return json(res, 404, { error: 'no such agent' });
        if (sm[2] === 'stop') return json(res, 200, { ok: runner.stopSeat(seat.id) });
        if (sm[2] === 'reset') { seats.resetThread(seat); return json(res, 200, { ok: true }); }
        if (sm[2] === 'delete') {
          // Running, between attempts, or waiting to retry: the turn would keep spawning CLI work on a seat the board can
          // no longer reach, so the seat is kept until its turn has ended.
          const srt = rtOf(seat.id);
          if (srt.child || srt.status === 'working' || srt.retryWait) return json(res, 400, { error: 'cannot delete while running' });
          const used = build.seatInUse(seat.id);
          if (used) return json(res, 409, { error: `${seat.name} is used by item "${used.itemId}" of an unfinished build (${used.title}): finish or discard that item first`, code: 'busy' });
          seats.removeSeat(seat); return json(res, 200, { ok: true });
        }
        if (sm[2] === 'send') {
          const text = v.str(b.text, 'text', { max: 20000 }) || ''; if (!text) return json(res, 400, { error: 'empty message' });
          const room = rooms.sendDm(seat, text);
          return json(res, 200, { roomId: room.id });
        }
      }
      if (p === '/api/meeting') {
        const seatIds = ids(v.idList(b.seatIds, 'seatIds')), topic = v.str(b.topic, 'topic', { max: 4000 }) || '';
        if (seatIds.length < 2 || !topic) return json(res, 400, { error: 'Pick at least 2 participants and write a topic' });
        const rounds = v.int(b.rounds, 'rounds', { min: 1, max: 5, def: 2 });
        const synthId = v.id(b.synthId, 'synthId'), scoutId = v.id(b.scoutId, 'scoutId');
        let overrides; try { overrides = overridesOf(b.overrides); } catch (e) { return json(res, 400, { error: e.message }); }
        const room = newRoom('meeting', topic.slice(0, 60), { topic, seatIds, rounds, synthId: seatById(synthId) ? synthId : null, scoutId: seatById(scoutId) ? scoutId : null, withContext: v.bool(b.withContext, 'withContext'), overrides });
        userMsg(room, topic); runMeeting(room).catch((e) => { sys(room, '⚠ ' + e.message); room.status = 'error'; pushRoom(room); });
        return json(res, 200, { roomId: room.id });
      }
      if (p === '/api/chain') {
        const task = v.str(b.task, 'task', { max: 8000 }) || '';
        const builderId = v.id(b.builderId, 'builderId'), reviewerId = v.id(b.reviewerId, 'reviewerId');
        if (!seatById(builderId) || !seatById(reviewerId) || builderId === reviewerId || !task) return json(res, 400, { error: 'Pick two different agents and write a task' });
        const maxRounds = v.int(b.maxRounds, 'maxRounds', { min: 1, max: 6, def: 3 });
        let overrides; try { overrides = overridesOf(b.overrides); } catch (e) { return json(res, 400, { error: e.message }); }
        const room = newRoom('chain', task.slice(0, 60), { task, builderId, reviewerId, maxRounds, escalate: v.bool(b.escalate, 'escalate'), withContext: v.bool(b.withContext, 'withContext'), overrides });
        userMsg(room, task); runChain(room).catch((e) => { sys(room, '⚠ ' + e.message); room.status = 'error'; pushRoom(room); });
        return json(res, 200, { roomId: room.id });
      }
      if (p === '/api/capability/verify') {
        const seatId = v.id(b.seatId, 'seatId', { required: true });
        if (!seatById(seatId)) return json(res, 404, { error: 'no such agent' });
        // A CLI the platform gate refuses (Codex in v0.2) is never checked: nothing is spawned, created or saved.
        const pg = capability.platformGate(seatById(seatId));
        if (!pg.ok) return json(res, 409, { error: pg.reason, code: 'unsupported-platform' });
        if (capability.isVerifying()) return json(res, 409, { error: 'a write check is already running', code: 'busy' });
        // pass/fail is persisted and published by verify(); an 'error' result is neither, so it is broadcast here, or
        // the UI would never learn that the check ended or why.
        capability.verify(seatId).then(
          (r) => { if (!r || r.result === 'error') broadcast({ t: 'capability', capability: capability.cached(), error: (r && r.detail) || 'the write check ended without a result' }); },
          (e) => broadcast({ t: 'capability', capability: capability.cached(), error: (e && e.message) || String(e) }),
        );
        return json(res, 200, { ok: true, started: true });
      }
      if (p === '/api/plan') {
        const goal = v.str(b.goal, 'goal', { max: 8000 }) || '';
        if (!goal) return json(res, 400, { error: 'Write a goal' });
        // councilId (F9): the plan starts from a finished council instead of a debate, so it has no participants: seatIds is []
        // whatever the request sent. The council must be a meeting room that is done.
        const hasCouncil = b.councilId !== undefined && b.councilId !== null && b.councilId !== '';
        const seatIds = hasCouncil ? [] : ids(v.idList(b.seatIds, 'seatIds'));
        const managerId = v.id(b.managerId, 'managerId');
        if (!managerId || !seatById(managerId)) return json(res, 400, { error: 'Pick a manager agent' });
        const council = hasCouncil && typeof b.councilId === 'string' ? rooms.rooms.get(b.councilId) : null;
        if (hasCouncil && (!council || council.kind !== 'meeting')) return json(res, 400, { error: 'No such council', code: 'no-council' });
        if (hasCouncil && council.status !== 'done') return json(res, 409, { error: 'Only a finished council can become a workflow', code: 'council-not-done' });
        if (!hasCouncil && seatIds.length === 1) return json(res, 400, { error: 'Pick at least 2 debate participants, or none to let the manager plan alone' });
        const rounds = v.int(b.rounds, 'rounds', { min: 1, max: 5, def: 1 });
        const synthId = v.id(b.synthId, 'synthId'), scoutId = v.id(b.scoutId, 'scoutId');
        let overrides; try { overrides = overridesOf(b.overrides); } catch (e) { return json(res, 400, { error: e.message }); }
        const room = newRoom('plan', goal.slice(0, 60), {
          goal, topic: goal, seatIds, rounds, scoutId: seatById(scoutId) ? scoutId : null, synthId: seatById(synthId) ? synthId : null,
          managerId, withContext: v.bool(b.withContext, 'withContext'), overrides, phase: seatIds.length >= 2 ? 'debate' : 'plan',
          councilId: council ? council.id : null,
          plan: null, planRevision: 0, planHash: null, revisions: [], approval: null, buildIds: [],
        });
        userMsg(room, goal); planApi.runPlan(room).catch((e) => { sys(room, '⚠ ' + e.message); room.status = 'error'; pushRoom(room); });
        return json(res, 200, { roomId: room.id });
      }
      const pm = p.match(/^\/api\/plan\/([\w-]+)\/(approve|edit|reject)$/);
      if (pm) {
        const revision = v.int(b.revision, 'revision', { min: 1, max: 1e6 });
        if (revision === undefined) return json(res, 400, { error: 'revision is required' });
        const hash = v.str(b.hash, 'hash', { max: 64 });
        if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return json(res, 400, { error: 'hash must be a sha256 hex string' });
        if (b.plan !== undefined && (b.plan === null || typeof b.plan !== 'object' || Array.isArray(b.plan))) return json(res, 400, { error: 'plan must be an object' });
        const note = v.str(b.note, 'note', { max: 2000 });
        const room = rooms.rooms.get(pm[1]);
        if (pm[2] === 'approve') return json(res, 200, { ok: true, approval: planApi.approvePlan(room, { revision, hash, plan: b.plan }) });
        if (pm[2] === 'edit') return json(res, 200, { ok: true, ...planApi.editPlan(room, { revision, hash, plan: b.plan }) });
        return json(res, 200, planApi.rejectPlan(room, { revision, hash, note }));
      }
      if (p === '/api/build') {
        const planRoomId = v.id(b.planRoomId, 'planRoomId', { required: true });
        const revision = v.int(b.revision, 'revision', { min: 1, max: 1e6 });
        if (revision === undefined) return json(res, 400, { error: 'revision is required' });
        const hash = sha256Of(b.hash);
        const roles = rolesOf(b.roles);
        const maxRounds = v.int(b.maxRounds, 'maxRounds', { min: 1, max: 6, def: 3 });
        const escalate = v.bool(b.escalate, 'escalate');
        const mode = v.oneOf(b.mode, 'mode', ['write', 'propose']);
        const room = await build.startBuild(rooms.rooms.get(planRoomId), { revision, hash, roles, maxRounds, escalate, mode });
        return json(res, 200, { roomId: room.id });
      }
      const bm = p.match(/^\/api\/build\/([\w-]+)\/(pause|resume)$/);
      if (bm) {
        const room = buildRoom(bm[1]); if (!room) return json(res, 404, { error: 'no such build' });
        if (bm[2] === 'pause') return json(res, 200, build.pauseBuild(room));
        const revision = v.int(b.revision, 'revision', { min: 1, max: 1e6 });
        const hash = b.hash === undefined || b.hash === null ? undefined : sha256Of(b.hash);
        return json(res, 200, await build.resumeBuild(room, { revision, hash }));
      }
      const im = p.match(/^\/api\/build\/([\w-]+)\/items\/([a-z0-9][a-z0-9-]{0,31})\/(apply|discard)$/);
      if (im) {
        const room = buildRoom(im[1]); if (!room) return json(res, 404, { error: 'no such build' });
        if (!hasItem(room, im[2])) return json(res, 404, { error: 'no such item' });
        if (im[3] === 'discard') return json(res, 200, build.discardItem(room, im[2]));
        return json(res, 200, await build.applyItem(room, im[2], sha256Of(b.hash)));
      }
      if (p === '/api/settings') {
        // Checked before anything changes, so a bad scope leaves every setting as it was.
        if (b.watchScope !== undefined && b.watchScope !== 'project' && b.watchScope !== 'all') return json(res, 400, { error: 'watchScope must be "project" or "all"' });
        const lang = v.str(b.lang, 'lang', { max: 30 });
        if (lang !== undefined) {
          if (!/^[\p{L} ()-]{2,30}$/u.test(lang)) return json(res, 400, { error: 'lang must be a language name (2-30 letters)' });
          settings.lang = lang;
        }
        if (b.capEffort !== undefined) settings.capEffort = v.bool(b.capEffort, 'capEffort');
        if (b.watchScope !== undefined) settings.watchScope = b.watchScope; // the watcher reads it on its next pass
        store.writeJson('settings.json', settings); broadcast({ t: 'settings', settings });
        return json(res, 200, settings);
      }
      const rm = p.match(/^\/api\/rooms\/([\w-]+)\/(stop|delete|say)$/);
      if (rm) {
        if (rm[2] === 'stop') {
          // A handoff run room: stop means the board stops watching (its engine unlinks and the room ends stopped). The
          // user's own Claude Code or Codex run is never touched.
          const target = rooms.rooms.get(rm[1]);
          if (target && target.kind === 'run') {
            const eng = engines.get(target.engine);
            return json(res, 200, { ok: !!(eng && typeof eng.stop === 'function' && eng.stop(target)) });
          }
          return json(res, 200, { ok: rooms.stopRoom(rm[1]) });
        }
        if (rm[2] === 'say') {
          // Interject: the next speaker in a running meeting/chain reads it; finished rooms only record it.
          const room = rooms.rooms.get(rm[1]), text = v.str(b.text, 'text', { max: 20000 }) || '';
          if (!room || !text) return json(res, 400, { error: 'room and text are required' });
          if (room.kind === 'dm') return json(res, 400, { error: 'use the seat send endpoint for direct messages' });
          if (room.status !== 'running') return json(res, 400, { error: 'This session has finished. Use Run again or Continue in Direct chat.' });
          userMsg(room, text); return json(res, 200, { ok: true });
        }
        // A build owns worktrees and frozen proposals on disk: its loop is stopped and awaited (bounded), then both are
        // removed before the room itself goes.
        const doomed = rooms.rooms.get(rm[1]);
        if (doomed && doomed.kind === 'build') {
          rooms.stopRoom(rm[1]);
          // The room stays stopped, so a retry succeeds once the loop has exited.
          if (!(await build.whenIdle(doomed, 10000))) return json(res, 409, { error: 'The build is still stopping. Try again in a moment.', code: 'build-busy' });
          build.cleanupRoom(doomed);
        }
        // The room's engine releases its followers and timers before the room itself goes.
        if (doomed) engines.dispose(doomed);
        rooms.deleteRoom(rm[1]); return json(res, 200, { ok: true });
      }
      if (await apiV2.handle(req, res, p, b)) return;
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (res.destroyed) return;
      if (res.headersSent) return res.end();
      const st = [400, 404, 409, 413].includes(e.status) ? e.status : 400;
      json(res, st, e.expose && e.code ? { error: e.message, code: e.code } : { error: e.message });
    }
  }
  // Last line of defence: nothing thrown while handling a request may reach process level.
  const safeHandle = (req, res) => handle(req, res).catch(() => {
    try { if (res.destroyed) return; if (!res.headersSent) json(res, 400, { error: 'bad request' }); else res.destroy(); } catch {}
  });

  const server = http.createServer(safeHandle);

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, '127.0.0.1', () => {
        PORT = server.address().port; COOKIE = sec.cookieName(PORT);
        limits.start(); capability.status().catch(() => {});
        refreshDoctor().catch(() => {}); // CLI checks for engine availability, in the background
        resolve({ port: PORT, project: PROJECT, url: `http://localhost:${PORT}/?t=${TOKEN}` });
      });
    });
  }
  // Board shutdown, in this order: no new CLI turn can start, every room stops (meetings and chains break out),
  // then every running seat's process tree is killed. Returns how many seat turns were running.
  function stopWork() {
    runner.shutdown();
    rooms.stopAll();
    let killed = 0;
    for (const s of seats.all()) { try { if (runner.stopSeat(s.id)) killed++; } catch {} }
    return killed;
  }
  function close() {
    stopWork();
    engines.close(); // pending run saves are written before the server goes
    claudeRuns.stop(); // no runs timer outlives the server
    limits.stop();
    for (const c of clients) c.end();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, start, close, stopWork, state, handle: safeHandle, store, settings, seats, runner, rooms, limits, broadcast, token: TOKEN, capability, planApi, chain, build, engines, refreshDoctor, claudeRuns };
}

module.exports = { createServer, serveStatic };
