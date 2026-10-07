// Seats: persistent agent definitions (seats.json) plus per-seat runtime state (status, activity, child, queue).
const { MODELS, EFFORTS, COLORS, PERSISTED, defaultSeats } = require('./config');

function createSeats({ store, broadcast }) {
  let seats = store.readJson('seats.json') || defaultSeats();
  const rt = new Map(); // seat id -> runtime { status, activity, startedAt, child, queue, roomId }
  const rtOf = (id) => { if (!rt.has(id)) rt.set(id, { status: 'idle', activity: '', startedAt: null, child: null, queue: Promise.resolve() }); return rt.get(id); };
  const seatById = (id) => seats.find((s) => s.id === id);
  function saveSeats() { store.writeJson('seats.json', seats.map((s) => Object.fromEntries(PERSISTED.map((k) => [k, s[k] ?? null])))); }
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

  function resetThread(seat) { seat.thread = null; saveSeats(); broadcast({ t: 'seat', seat: publicSeat(seat) }); }
  function removeSeat(seat) { seats = seats.filter((s) => s !== seat); saveSeats(); broadcast({ t: 'seatGone', id: seat.id }); }

  return { all: () => seats, rtOf, seatById, saveSeats, publicSeat, setRt, upsertSeat, resetThread, removeSeat };
}

module.exports = { createSeats };
