// Seats: persistent agent definitions (seats.json) plus per-seat runtime state (status, activity, child, queue).
const { MODELS, EFFORTS, COLORS, PERSISTED, defaultSeats } = require('./config');

const MODEL_RE = /^[A-Za-z0-9][\w.:\-\[\]]{0,63}$/;

function createSeats({ store, broadcast }) {
  // A missing seats.json means first run (defaults). An unreadable one is NOT silently replaced: it is copied aside
  // (seats.json.corrupt-<time>) first, so threads, budgets and usage can be recovered by hand.
  function loadSeats() {
    const raw = store.read('seats.json');
    if (raw === null) return defaultSeats();
    try { const v = JSON.parse(raw); if (Array.isArray(v)) return v; throw new Error('not a list of agents'); }
    catch (e) {
      const bak = `seats.json.corrupt-${Date.now()}`;
      try { store.write(bak, raw); } catch {}
      console.error(`orchestra-board: seats.json is unreadable (${e.message}); kept a copy as .orchestra/${bak} and started with the default agents.`);
      return defaultSeats();
    }
  }
  let seats = loadSeats();
  const rt = new Map(); // seat id -> runtime { status, activity, startedAt, child, queue, roomId }
  const rtOf = (id) => { if (!rt.has(id)) rt.set(id, { status: 'idle', activity: '', startedAt: null, child: null, queue: Promise.resolve() }); return rt.get(id); };
  const seatById = (id) => seats.find((s) => s.id === id);
  // Persisting must never throw into a turn's completion (a locked file on Windows): the in-memory state stays current.
  function saveSeats() {
    try { store.writeJson('seats.json', seats.map((s) => Object.fromEntries(PERSISTED.map((k) => [k, s[k] ?? null])))); }
    catch (e) { console.error(`orchestra-board: could not save seats.json: ${e.message}`); }
  }
  function publicSeat(s) { const r = rtOf(s.id); return { ...s, status: r.status, activity: r.activity, startedAt: r.startedAt, roomId: r.roomId || null }; }
  function setRt(id, patch) { Object.assign(rtOf(id), patch); const s = seatById(id); if (s) broadcast({ t: 'seat', seat: publicSeat(s) }); }

  function upsertSeat(b) {
    const agent = MODELS[b.agent] ? b.agent : 'codex';
    // Listed models are suggestions; any CLI-accepted model name (aliases included) is allowed.
    let s = b.id && seatById(b.id);
    // The first character is a letter or digit, so a model name can never be read as a CLI flag ('--add-dir', '-x').
    const validModel = MODEL_RE.test(b.model || '');
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
      || (b.role !== undefined && s.role !== undefined && b.role !== s.role) || (b.name !== undefined && s.name !== undefined && b.name !== s.name)) dropThread(s);
    Object.assign(s, {
      name: String(b.name ?? s.name ?? agent).slice(0, 24), role: String(b.role ?? s.role ?? '').slice(0, 40),
      agent, model, effort, perm: b.perm === 'write' ? 'write' : 'read',
      target: String(b.target ?? s.target ?? '').trim(), budget: Math.max(0, Number(b.budget ?? s.budget ?? 0) || 0),
      color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : s.color,
    });
    saveSeats(); broadcast({ t: 'seat', seat: publicSeat(s) });
    return s;
  }

  // threadGen (in memory only, never persisted) changes whenever a seat's thread is dropped. A turn still running then
  // must not write its old thread id back when it ends (runner.js compares the generation it started with).
  function dropThread(seat) { seat.thread = null; seat.threadGen = (seat.threadGen || 0) + 1; }
  function resetThread(seat) { dropThread(seat); saveSeats(); broadcast({ t: 'seat', seat: publicSeat(seat) }); }
  // The runtime entry goes too, unless a turn still runs on it: a recreated seat with the same id must not inherit
  // the old queue, retry wait or stop flag.
  function removeSeat(seat) {
    seats = seats.filter((s) => s !== seat); saveSeats();
    const r = rt.get(seat.id);
    if (r && !r.child && r.status !== 'working' && !r.retryWait) rt.delete(seat.id);
    broadcast({ t: 'seatGone', id: seat.id });
  }

  return { all: () => seats, rtOf, seatById, saveSeats, publicSeat, setRt, upsertSeat, resetThread, removeSeat, dropThread };
}

module.exports = { createSeats, MODEL_RE };
