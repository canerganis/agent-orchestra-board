// HTTP server: static files from public/, SSE, security gate (Host/Origin allowlist, session cookie from the
// per-project token persisted in .orchestra/session, JSON-only POST, validated bodies, security headers) and API
// routes. Threat model: see security.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MODELS, EFFORTS, DEFAULT_PORT, defaultSettings, naive } = require('./config');
const { createStore } = require('./store');
const { createLimits } = require('./limits');
const { createSeats } = require('./seats');
const { createRunner } = require('./runner');
const { createRooms } = require('./rooms');
const { createMeeting } = require('./workflows/meeting');
const { createChain } = require('./workflows/chain');
const { confineTarget } = require('./target');
const sec = require('./security');
const doctor = require('./doctor');
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

function createServer({ projectDir, port = DEFAULT_PORT } = {}) {
  const PORT = Number(port) || DEFAULT_PORT;
  const store = createStore(projectDir);
  store.ensure();
  const PROJECT = store.project;
  // Session secret: printed in the start URL, exchanged once for an HttpOnly cookie, required on /api/*.
  // Persisted per project (.orchestra/session, 0600) so a restart keeps open tabs and the dev preview valid.
  const TOKEN = sec.loadOrCreateToken(path.join(store.orch, 'session'));
  const COOKIE = sec.cookieName(PORT);

  // ---------- live events (SSE) ----------
  const clients = new Set();
  function broadcast(ev) { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); }

  const limits = createLimits({ store, broadcast });
  const settings = store.readJson('settings.json') || defaultSettings();
  const seats = createSeats({ store, broadcast });
  const runner = createRunner({ store, seats, limits, settings, broadcast });
  const rooms = createRooms({ store, seats, runner, broadcast });
  const { runMeeting } = createMeeting({ store, seats, rooms, settings });
  const { runChain } = createChain({ store, seats, rooms, broadcast });
  const { seatById, publicSeat, rtOf } = seats;
  const { pushRoom, sys, userMsg, newRoom } = rooms;

  function state() {
    return {
      project: PROJECT, models: MODELS, efforts: EFFORTS,
      seats: seats.all().map(publicSeat),
      rooms: [...rooms.rooms.values()].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 25),
      limits: limits.get(), settings, naive: naive(),
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
        if (typeof o.model !== 'string' || !/^[\w.:\-\[\]]{1,64}$/.test(o.model)) throw new Error('invalid model name');
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
        if (!sec.tokenEquals(url.searchParams.get('t'), TOKEN)) return json(res, 403, { error: 'bad session token' });
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
      if (req.method === 'GET' && p === '/api/doctor') return json(res, 200, await doctor.run({ projectDir: PROJECT }));
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
          if (rtOf(seat.id).child) return json(res, 400, { error: 'cannot delete while running' });
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
      if (p === '/api/settings') {
        const lang = v.str(b.lang, 'lang', { max: 30 });
        if (lang !== undefined) {
          if (!/^[\p{L} ()-]{2,30}$/u.test(lang)) return json(res, 400, { error: 'lang must be a language name (2-30 letters)' });
          settings.lang = lang;
        }
        if (b.capEffort !== undefined) settings.capEffort = v.bool(b.capEffort, 'capEffort');
        store.writeJson('settings.json', settings); broadcast({ t: 'settings', settings });
        return json(res, 200, settings);
      }
      const rm = p.match(/^\/api\/rooms\/([\w-]+)\/(stop|delete|say)$/);
      if (rm) {
        if (rm[2] === 'stop') return json(res, 200, { ok: rooms.stopRoom(rm[1]) });
        if (rm[2] === 'say') {
          // Interject: the next speaker in a running meeting/chain reads it; finished rooms only record it.
          const room = rooms.rooms.get(rm[1]), text = v.str(b.text, 'text', { max: 20000 }) || '';
          if (!room || !text) return json(res, 400, { error: 'room and text are required' });
          if (room.kind === 'dm') return json(res, 400, { error: 'use the seat send endpoint for direct messages' });
          if (room.status !== 'running') return json(res, 400, { error: 'This session has finished. Use Run again or Continue in Direct chat.' });
          userMsg(room, text); return json(res, 200, { ok: true });
        }
        rooms.deleteRoom(rm[1]); return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (res.destroyed) return;
      if (res.headersSent) return res.end();
      json(res, e.status === 413 ? 413 : 400, { error: e.message });
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
      server.listen(PORT, '127.0.0.1', () => { limits.start(); resolve({ port: PORT, project: PROJECT, url: `http://localhost:${PORT}/?t=${TOKEN}` }); });
    });
  }
  function close() {
    limits.stop();
    for (const c of clients) c.end();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, start, close, state, handle: safeHandle, store, settings, seats, runner, rooms, limits, broadcast, token: TOKEN };
}

module.exports = { createServer, serveStatic };
