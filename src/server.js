// HTTP server: static files from public/, SSE, security gate (Host/Origin allowlist, JSON-only POST) and API routes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MODELS, EFFORTS, DEFAULT_PORT, defaultSettings } = require('./config');
const { createStore } = require('./store');
const { createLimits } = require('./limits');
const { createSeats } = require('./seats');
const { createRunner } = require('./runner');
const { createRooms } = require('./rooms');
const { createMeeting } = require('./workflows/meeting');
const { createChain } = require('./workflows/chain');
const doctor = require('./doctor');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

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

function body(req) {
  return new Promise((res, rej) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch (e) { rej(e); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

function createServer({ projectDir, port = DEFAULT_PORT } = {}) {
  const PORT = Number(port) || DEFAULT_PORT;
  const store = createStore(projectDir);
  store.ensure();
  const PROJECT = store.project;

  // ---------- live events (SSE) ----------
  const clients = new Set();
  function broadcast(ev) { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); }

  const limits = createLimits({ store, broadcast });
  const settings = store.readJson('settings.json') || defaultSettings();
  const seats = createSeats({ store, broadcast });
  const runner = createRunner({ store, seats, limits, settings, broadcast });
  const rooms = createRooms({ store, seats, runner, broadcast });
  const { runMeeting } = createMeeting({ store, seats, rooms });
  const { runChain } = createChain({ store, seats, rooms, broadcast });
  const { seatById, publicSeat, rtOf } = seats;
  const { pushRoom, sys, userMsg, newRoom } = rooms;

  function state() {
    return {
      project: PROJECT, models: MODELS, efforts: EFFORTS,
      seats: seats.all().map(publicSeat),
      rooms: [...rooms.rooms.values()].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 25),
      limits: limits.get(), settings,
    };
  }
  const ids = (arr) => (Array.isArray(arr) ? arr : []).filter((id) => seatById(id));

  // ---------- http ----------
  async function handle(req, res) {
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
      if (p === '/api/seats') return json(res, 200, publicSeat(seats.upsertSeat(b)));
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
          const text = String(b.text || '').trim(); if (!text) return json(res, 400, { error: 'empty message' });
          const room = rooms.sendDm(seat, text);
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
        store.writeJson('settings.json', settings); broadcast({ t: 'settings', settings });
        return json(res, 200, settings);
      }
      const rm = p.match(/^\/api\/rooms\/([\w-]+)\/(stop|delete|say)$/);
      if (rm) {
        if (rm[2] === 'stop') return json(res, 200, { ok: rooms.stopRoom(rm[1]) });
        if (rm[2] === 'say') {
          // Interject: the next speaker in a running meeting/chain reads it; finished rooms only record it.
          const room = rooms.rooms.get(rm[1]), text = String(b.text || '').trim();
          if (!room || !text) return json(res, 400, { error: 'room and text are required' });
          if (room.kind === 'dm') return json(res, 400, { error: 'use the seat send endpoint for direct messages' });
          if (room.status !== 'running') return json(res, 400, { error: 'This session has finished. Use Run again or Continue in Direct chat.' });
          userMsg(room, text); return json(res, 200, { ok: true });
        }
        rooms.deleteRoom(rm[1]); return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 400, { error: e.message }); }
  }

  const server = http.createServer(handle);

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, '127.0.0.1', () => { limits.start(); resolve({ port: PORT, project: PROJECT, url: `http://localhost:${PORT}` }); });
    });
  }
  function close() {
    limits.stop();
    for (const c of clients) c.end();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, start, close, state, handle, store, settings, seats, runner, rooms, limits, broadcast };
}

module.exports = { createServer, serveStatic };
