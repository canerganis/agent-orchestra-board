// Rooms: meetings, chains and direct messages. Persistence (rooms/*.json), posting, seat turns (say), stop/delete.
const fs = require('fs');
const path = require('path');
const { now, newId, clip } = require('./util');

function createRooms({ store, seats, runner, broadcast }) {
  const { seatById } = seats;
  const ROOM_DIR = store.roomDir;
  const rooms = new Map();

  // One bad file (truncated, hand-edited, no `messages`) is skipped and logged; the rooms after it still load.
  function load() {
    let files = []; try { files = fs.readdirSync(ROOM_DIR).filter((f) => f.endsWith('.json')); } catch { return; }
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(ROOM_DIR, f), 'utf8'));
        if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !Array.isArray(r.messages)) throw new Error('not a room (missing id or messages)');
        if (r.status === 'running') r.status = 'stopped';
        r.messages.forEach((m) => { m.streaming = false; });
        if (r.kind === 'dm') r.title = `Chat with ${seatById(r.seatId)?.name || r.title}`;
        rooms.set(r.id, r);
      } catch (e) {
        console.error(`orchestra-board: skipping unreadable room file ${path.join(ROOM_DIR, f)}: ${e.message}`);
      }
    }
  }

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
    const res = await runner.runSeat(seatId, prompt, { effort: meta.effort, runId: m.id, roomId: room.id, room: room.kind === 'dm' ? null : room, tools: meta.tools, withTarget: meta.withTarget ?? true, threadKey: meta.threadKey, cancelled: meta.cancelled });
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
    for (const f of ['PLAN.md', 'HANDOFF.md']) { const s = store.read(f); if (s) parts.push(`## .orchestra/${f}\n${s}`); }
    const log = store.read('LOG.md'); if (log) parts.push('## .orchestra/LOG.md (tail)\n' + log.split(/\r?\n/).slice(-20).join('\n'));
    return parts.length ? '\n\n--- ORCHESTRA CONTEXT ---\n' + parts.join('\n\n') : '';
  }

  function stopRoom(id) {
    const room = rooms.get(id); if (!room) return false;
    // A DM stop cancels only this chat's turns (running or queued), never the seat's work in other sessions.
    if (room.kind === 'dm') room.stopGen = (room.stopGen || 0) + 1; else room.stopped = true;
    for (const s of seats.all()) if (seats.rtOf(s.id).roomId === id) runner.stopSeat(s.id);
    return true;
  }
  function deleteRoom(id) {
    stopRoom(id); rooms.delete(id); try { fs.unlinkSync(path.join(ROOM_DIR, id + '.json')); } catch {}
    broadcast({ t: 'roomGone', id });
  }

  // Direct chat: one long-lived DM room per seat; the reply runs on the seat's own thread.
  function sendDm(seat, text) {
    let room = rooms.get('dm-' + seat.id);
    if (!room) room = newRoom('dm', `Chat with ${seat.name}`, { seatId: seat.id });
    room.title = `Chat with ${seat.name}`; room.status = 'running'; pushRoom(room);
    userMsg(room, text);
    const gen = room.stopGen || 0;
    say(room, seat.id, text, { cancelled: () => (room.stopGen || 0) !== gen }).then(() => { room.status = 'idle'; pushRoom(room); });
    return room;
  }

  load();
  return { rooms, live, saveRoom, roomMeta, pushRoom, newRoom, post, say, roomUsage, NOT_DELIVERED, sys, userMsg, buildContext, stopRoom, deleteRoom, sendDm };
}

module.exports = { createRooms };
