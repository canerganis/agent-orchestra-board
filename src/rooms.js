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
    // Per-session overrides (New session modal) live on the room; the seat's own model and effort are the default.
    const ov = room.overrides?.[seatId] || {};
    const effort = meta.effort || ov.effort || seat.effort;
    // The seat's session override applies to every turn it takes; meta.model is a turn-only default (the scout's).
    const model = ov.model || meta.model || null;
    const m = post(room, { seatId, name: seat.name, color: seat.color, agent: seat.agent, round: meta.round || room.round, label: meta.label || '', text: '', streaming: true });
    // Direct messages use the seat's long-lived thread; meetings and chains get a fresh thread per room.
    // recovery/onRecover: if the CLI lost the thread, the runner starts a fresh one with this recap and we note it.
    let res;
    try {
      res = await runner.runSeat(seatId, prompt, {
        effort, model, runId: m.id, roomId: room.id, room: room.kind === 'dm' ? null : room, tools: meta.tools, withTarget: meta.withTarget ?? true, threadKey: meta.threadKey, cancelled: meta.cancelled,
        recovery: () => recoveryPreamble(room, m, prompt), onRecover: (note) => sys(room, note, { recovery: { seatId, msgId: m.id } }),
      });
    } catch (e) { res = { ok: false, error: `internal error: ${(e && e.message) || e}`, text: '', failure: 'other' }; } // a turn never stalls a workflow
    // failed: the workflow view marks this node failed; the meeting/chain continues with the others.
    Object.assign(m, { text: res.text || '', error: res.ok ? null : res.error, failed: !res.ok, failure: res.ok ? null : res.failure || null, streaming: false, ended: now(), tokens: res.tokens, cached: res.cached, cost: res.cost, effort, model: model || seat.model, tools: meta.tools || null });
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
  // Context for a fresh thread that replaces a lost one: the room background (topic or task, plus the scout brief)
  // and a compact recap of the latest messages. The runner prepends the role header; the turn prompt follows.
  const RECAP_MESSAGES = 8, RECAP_CHARS = 600;
  function recoveryPreamble(room, current = null, prompt = '') {
    const parts = ['[Context recovery: your earlier conversation thread for this session could not be resumed. Background and a recap of the latest messages follow; continue from there.]'];
    if (room.kind === 'meeting' && room.topic) parts.push(`Meeting topic:\n${room.topic}`);
    if (room.kind === 'chain' && room.task) parts.push(`Task:\n${room.task}`);
    const brief = room.messages.find((x) => x.round === 'scout' && x.text && !x.error && x.seatId !== 'system');
    if (brief) parts.push(`Shared brief (by ${brief.name}):\n${brief.text}`);
    const recent = room.messages.filter((x) => x !== current && x !== brief && !x.streaming && x.text && x.seatId !== 'system' && x.text !== prompt).slice(-RECAP_MESSAGES);
    if (recent.length) {
      const who = (x) => (x.seatId === 'user' ? 'User' : x.name || x.seatId);
      parts.push(`Recap of the latest messages (oldest first, long ones shortened):\n${recent.map((x) => `${who(x)}${x.round && x.round !== 'scout' ? ` (round ${x.round})` : ''}: ${x.text.length > RECAP_CHARS ? x.text.slice(0, RECAP_CHARS) + '…' : x.text}`).join('\n\n')}`);
    }
    return parts.join('\n\n');
  }
  const NOT_DELIVERED =(m) => `Not delivered (no agent turn left to read it): "${clip(m.text)}"`;
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
  return { rooms, live, saveRoom, roomMeta, pushRoom, newRoom, post, say, recoveryPreamble, roomUsage, NOT_DELIVERED, sys, userMsg, buildContext, stopRoom, deleteRoom, sendDm };
}

module.exports = { createRooms };
