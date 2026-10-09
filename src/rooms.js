// Rooms: meetings, chains, direct messages and Ask conversations. Persistence (rooms/*.json), posting, seat turns (say),
// stop/delete.
const fs = require('fs');
const path = require('path');
const { now, newId, clip, httpError } = require('./util');
const { EFFORTS } = require('./config');
const { MODEL_RE } = require('./seats');

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
        // An Ask room has no turn running after a restart: it is idle (its interrupted turn is failed below).
        if (r.status === 'running') r.status = r.kind === 'ask' ? 'idle' : 'stopped';
        // A turn that was still streaming when the board stopped or crashed never finished: it is a failed turn, not an
        // empty success (no usage was recorded for it either).
        r.messages.forEach((m) => {
          if (m.streaming) Object.assign(m, { streaming: false, failed: true, error: m.error || 'interrupted: the board stopped during this turn', failure: 'stopped' });
          m.streaming = false;
        });
        if (r.kind === 'dm') r.title = `Chat with ${seatById(r.seatId)?.name || r.title}`;
        rooms.set(r.id, r);
      } catch (e) {
        console.error(`orchestra-board: skipping unreadable room file ${path.join(ROOM_DIR, f)}: ${e.message}`);
      }
    }
  }

  // A deleted room may still be referenced by a running meeting/chain/DM turn: never write or broadcast it again.
  const live = (room) => rooms.get(room.id) === room;
  // A failed save (locked file, full disk) is logged; it must not throw into a turn that already finished.
  function saveRoom(room) {
    if (!live(room)) return;
    try { store.write(path.join('rooms', room.id + '.json'), JSON.stringify(room, null, 2)); }
    catch (e) { console.error(`orchestra-board: could not save room ${room.id}: ${e.message}`); }
  }
  // Like saveRoom, but a failed save throws: for state the caller must not report as done unless it reached the disk.
  function saveRoomStrict(room) {
    if (!live(room)) throw new Error(`room ${room.id} no longer exists`);
    store.write(path.join('rooms', room.id + '.json'), JSON.stringify(room, null, 2));
  }
  // Each room has an AbortController: stopping or deleting it aborts the turns still waiting in a seat's queue.
  const ctls = new WeakMap();
  function signalOf(room) { let c = ctls.get(room); if (!c) { c = new AbortController(); ctls.set(room, c); } return c.signal; }
  function abortRoom(room) { const c = ctls.get(room); if (c) { ctls.delete(room); c.abort(); } }
  // DM turns in flight per DM room (not persisted): the chat is idle only when the last one finishes.
  const dmPending = new Map();
  // Ask conversations (not persisted): the last queued turn of each room, and how many turns are queued or running.
  // The turns of one room run one at a time, so each turn starts after the one before it has settled.
  const askTail = new Map();
  const askPending = new Map();
  // The room without its messages and agents (SSE room events and the room index carry metadata only).
  const roomMeta = (r) => { const { messages, agents, ...m } = r; return m; };
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
        worktree: meta.worktree || null,
        recovery: () => recoveryPreamble(room, m, prompt), onRecover: (note) => sys(room, note, { recovery: { seatId, msgId: m.id } }),
        signal: signalOf(room),
      });
    } catch (e) { res = { ok: false, error: `internal error: ${(e && e.message) || e}`, text: '', failure: 'other' }; } // a turn never stalls a workflow
    // failed: the workflow view marks this node failed; the meeting/chain continues with the others.
    Object.assign(m, { text: res.text || '', error: res.ok ? null : res.error, failed: !res.ok, failure: res.ok ? null : res.failure || null, streaming: false, ended: now(), tokens: res.tokens, cached: res.cached, cost: res.cost, effort, model: model || seat.model, tools: meta.tools || null, mode: res.mode || null });
    if (live(room)) broadcast({ t: 'msg', roomId: room.id, msg: m });
    room.usage = roomUsage(room); pushRoom(room);
    return { ...res, mode: res.mode || null, msg: m };
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
  const recapWho = (x) => (x.seatId === 'user' ? 'User' : x.name || x.seatId);
  const clipRecap = (s) => (s.length > RECAP_CHARS ? s.slice(0, RECAP_CHARS) + '…' : s);
  function recoveryPreamble(room, current = null, prompt = '') {
    const parts = ['[Context recovery: your earlier conversation thread for this session could not be resumed. Background and a recap of the latest messages follow; continue from there.]'];
    // Text the turn prompt already carries (the topic, the task, the brief, fresh messages, feedback) is not repeated.
    const inPrompt = (s) => !!s && prompt.includes(s);
    if (room.kind === 'meeting' && room.topic && !inPrompt(room.topic)) parts.push(`Meeting topic:\n${room.topic}`);
    if (room.kind === 'chain' && room.task && !inPrompt(room.task)) parts.push(`Task:\n${room.task}`);
    const brief = room.messages.find((x) => x.round === 'scout' && x.text && !x.error && x.seatId !== 'system');
    if (brief && !inPrompt(brief.text)) parts.push(`Shared brief (by ${brief.name}):\n${brief.text}`);
    // A meeting's or chain's first message is the topic/task, already in the background above (a direct chat's first
    // message is a real conversation turn and stays). Failed turns carry no usable text.
    const topicMsg = room.kind === 'meeting' || room.kind === 'chain' ? room.messages[0] : null;
    const recent = room.messages.filter((x) => x !== current && x !== brief && x !== topicMsg && !x.streaming && x.text && !x.error && x.seatId !== 'system' && !inPrompt(x.text)).slice(-RECAP_MESSAGES);
    if (recent.length) {
      parts.push(`Recap of the latest messages (oldest first, long ones shortened):\n${recent.map((x) => `${recapWho(x)}${x.round && x.round !== 'scout' ? ` (round ${x.round})` : ''}: ${clipRecap(x.text)}`).join('\n\n')}`);
    }
    return parts.join('\n\n');
  }
  // Messages a seat's thread has not seen. room.seen[seatId] is the id of the reply the seat gave last in this conversation;
  // everything posted after it counts, except the seat's own messages, system lines, failed or empty turns and streams still
  // in progress. Without a mark, the whole conversation counts.
  function unseenMessages(room, seatId) {
    const mark = room.seen && room.seen[seatId];
    const from = mark ? room.messages.findIndex((x) => x.id === mark) + 1 : 0;
    return room.messages.slice(from).filter((x) => x.seatId !== seatId && x.seatId !== 'system' && x.text && !x.error && !x.streaming);
  }
  // The update a resumed thread gets in front of its new message: only what it has not seen. A long gap keeps its latest
  // RECAP_MESSAGES messages and says how many earlier ones are left out.
  function unseenPreamble(unseen) {
    const shown = unseen.slice(-RECAP_MESSAGES);
    const left = unseen.length - shown.length;
    return [
      '[Context update: these messages were posted in this conversation since your last reply. Your thread has not seen them yet.]',
      `Messages since your last reply (oldest first, long ones shortened${left ? `; ${left} earlier not shown` : ''}):\n${shown.map((x) => `${recapWho(x)}: ${clipRecap(x.text)}`).join('\n\n')}`,
    ].join('\n\n');
  }
  const NOT_DELIVERED =(m) => `Not delivered (no agent turn left to read it): "${clip(m.text)}"`;
  const sys = (room, text, extra = {}) => post(room, { seatId: 'system', name: 'system', text, ...extra });
  const userMsg = (room, text) => post(room, { seatId: 'user', name: 'You', text });

  // Every turn that gets the context pays for it: each file is clipped, with a pointer to the rest.
  const CONTEXT_FILE_CHARS = 6000;
  function buildContext() {
    const parts = [];
    for (const f of ['PLAN.md', 'HANDOFF.md']) {
      const s = store.read(f);
      if (s) parts.push(`## .orchestra/${f}\n${s.length > CONTEXT_FILE_CHARS ? s.slice(0, CONTEXT_FILE_CHARS) + `\n…(truncated: read .orchestra/${f} for the rest)` : s}`);
    }
    const log = store.read('LOG.md'); if (log) parts.push('## .orchestra/LOG.md (tail)\n' + log.split(/\r?\n/).slice(-20).join('\n'));
    return parts.length ? '\n\n--- ORCHESTRA CONTEXT ---\n' + parts.join('\n\n') : '';
  }

  function stopRoom(id) {
    const room = rooms.get(id); if (!room) return false;
    // A DM or Ask stop cancels only this conversation's turns (running or queued), never the seat's work in other sessions.
    if (room.kind === 'dm' || room.kind === 'ask') room.stopGen = (room.stopGen || 0) + 1; else room.stopped = true;
    abortRoom(room); // queued turns of this room resolve now, even behind another room's long turn
    for (const s of seats.all()) if (seats.rtOf(s.id).roomId === id) runner.stopSeat(s.id);
    return true;
  }
  function deleteRoom(id) {
    stopRoom(id); rooms.delete(id); dmPending.delete(id); askPending.delete(id); askTail.delete(id);
    try { fs.unlinkSync(path.join(ROOM_DIR, id + '.json')); } catch {}
    broadcast({ t: 'roomGone', id });
  }
  // Board shutdown: every room stops, so meetings and chains break out instead of starting new turns.
  function stopAll() { for (const id of [...rooms.keys()]) { try { stopRoom(id); } catch {} } }

  // Direct chat: one long-lived DM room per seat; the reply runs on the seat's own thread.
  function sendDm(seat, text) {
    let room = rooms.get('dm-' + seat.id);
    if (!room) room = newRoom('dm', `Chat with ${seat.name}`, { seatId: seat.id });
    room.title = `Chat with ${seat.name}`; room.status = 'running'; pushRoom(room);
    userMsg(room, text);
    const gen = room.stopGen || 0;
    dmPending.set(room.id, (dmPending.get(room.id) || 0) + 1);
    say(room, seat.id, text, { cancelled: () => (room.stopGen || 0) !== gen }).then(() => {
      // Idle only when no other DM turn of this chat is still queued or running (the second send).
      const left = (dmPending.get(room.id) || 1) - 1;
      if (left > 0) { dmPending.set(room.id, left); return; }
      dmPending.delete(room.id);
      room.status = 'idle'; pushRoom(room);
    });
    return room;
  }

  // Ask (plan F8): one conversation with one or more seats. Each seat keeps its own thread in room.threads. A seat's first
  // turn in a conversation that already has replies carries the recap in its prompt, so a switch costs one CLI call.
  const ASK_TEXT_MAX = 20000;
  // The model and effort a turn asks for, validated like the session overrides of a meeting or chain (server.js
  // overridesOf). undefined keeps the room's override for the seat; null or '' clears it, so the seat's own setting applies.
  function askPick(seat, { model, effort }) {
    const pick = {};
    if (model !== undefined) {
      if (model === null || model === '') pick.model = '';
      else if (typeof model === 'string' && MODEL_RE.test(model)) pick.model = model;
      else throw httpError(400, 'invalid model name');
    }
    if (effort !== undefined) {
      if (effort === null || effort === '') pick.effort = '';
      else if (typeof effort === 'string' && (EFFORTS[seat.agent] || []).includes(effort)) pick.effort = effort;
      else throw httpError(400, `effort "${String(effort).slice(0, 40)}" is not supported by ${seat.name}`);
    }
    return pick;
  }
  // One Ask turn, started once the conversation's earlier turns have settled. The user's message is posted here, not when
  // the request arrives, so the room keeps the order in which the turns actually ran.
  async function runAskTurn(room, seatId, text, pick, cancelled) {
    if (!live(room)) return; // the room was deleted while this turn waited
    // Read before this turn's message is posted: the message travels in the prompt itself, so it is not a missed one.
    const hasThread = !!(room.threads && room.threads[seatId]);
    const replied = room.messages.some((x) => x.seatId !== 'user' && x.seatId !== 'system' && x.text && !x.error && !x.streaming);
    const unseen = hasThread ? unseenMessages(room, seatId) : [];
    userMsg(room, text);
    if (pick.model !== undefined || pick.effort !== undefined) {
      const ov = { ...(room.overrides?.[seatId] || {}) };
      if (pick.model !== undefined) { if (pick.model) ov.model = pick.model; else delete ov.model; }
      if (pick.effort !== undefined) { if (pick.effort) ov.effort = pick.effort; else delete ov.effort; }
      room.overrides = room.overrides || {};
      if (Object.keys(ov).length) room.overrides[seatId] = ov; else delete room.overrides[seatId];
    }
    // A seat with no thread in a conversation that already has replies gets recoveryPreamble in the same prompt: no resume
    // is tried first, so the turn is one CLI call. A resumed thread gets only the messages it has not seen, in the same
    // prompt, so a switch back to an earlier seat keeps the conversation.
    let recap = '';
    if (!hasThread && replied) recap = recoveryPreamble(room, null, text).trim();
    else if (unseen.length) recap = unseenPreamble(unseen).trim();
    const res = await say(room, seatId, recap ? `${recap}\n\n${text}` : text, { cancelled });
    // The thread has seen the conversation up to this reply. A turn that failed or was stopped leaves the mark where it was,
    // so the next turn sends those messages again: a repeat costs a few tokens, a gap would lose context.
    if (res.ok && res.msg) { (room.seen ||= {})[seatId] = res.msg.id; saveRoom(room); }
  }
  // Idle only when no other turn of this conversation is still queued or running.
  function endAskTurn(room) {
    const left = (askPending.get(room.id) || 1) - 1;
    if (left > 0) { askPending.set(room.id, left); return; }
    askPending.delete(room.id); askTail.delete(room.id);
    room.status = 'idle'; pushRoom(room);
  }
  // POST /api/ask (src/api/ask.js). target: an Ask room, or null to start one. seat: a seat id or a seat object. Returns the
  // room at once and runs the turn in the background. Every check throws (400 or 404) before anything is created.
  function sendAsk(target, seat, text, { model, effort } = {}) {
    const s = seatById(typeof seat === 'string' ? seat : seat && seat.id);
    if (!s) throw httpError(404, 'no such agent');
    if (target && target.kind !== 'ask') throw httpError(400, 'not an Ask room');
    if (typeof text !== 'string') throw httpError(400, 'text must be a string');
    const msg = text.trim();
    if (!msg) throw httpError(400, 'empty message');
    if (msg.length > ASK_TEXT_MAX) throw httpError(400, `text is too long (max ${ASK_TEXT_MAX} characters)`);
    const pick = askPick(s, { model, effort });
    const room = target || newRoom('ask', msg.replace(/\s+/g, ' ').slice(0, 60), { seatId: s.id, overrides: {}, threads: {}, seen: {} });
    room.seatId = s.id; room.status = 'running';
    // A stop cancels the turns that were queued or running when it was pressed; later turns run normally.
    const gen = room.stopGen || 0;
    const cancelled = () => (room.stopGen || 0) !== gen;
    askPending.set(room.id, (askPending.get(room.id) || 0) + 1);
    pushRoom(room);
    const turn = (askTail.get(room.id) || Promise.resolve())
      .then(() => runAskTurn(room, s.id, msg, pick, cancelled))
      .catch((e) => { if (live(room)) sys(room, `Ask turn failed: ${(e && e.message) || e}`); })
      .finally(() => endAskTurn(room))
      .catch((e) => console.error(`orchestra-board: Ask room ${room.id}: ${(e && e.message) || e}`));
    askTail.set(room.id, turn);
    return room;
  }

  load();
  return { rooms, live, saveRoom, saveRoomStrict, roomMeta, pushRoom, newRoom, post, say, recoveryPreamble, roomUsage, NOT_DELIVERED, sys, userMsg, buildContext, stopRoom, stopAll, deleteRoom, sendDm, sendAsk };
}

module.exports = { createRooms };
