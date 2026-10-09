// The handoff engines and their routes (plan 3.3, F7).
//   GET  /api/run/:id/candidates  -> { candidates, planChanged }   runs that may be the user's, token matches first
//   POST /api/run/:id/link {ref}  -> { ok, linked, status }        ref must be a current candidate (else 400)
//   POST /api/run/:id/unlink      -> { ok }                        the board stops following; the user's run goes on
// The Claude Code and Codex engines are registered here, when the v2 API is built: server.js builds it once, after the
// engine registry and the runs watcher exist. The registry's recover() ran before that, so the rooms of these two
// engines are recovered here, once. Room ids are checked before any lookup.
const { httpError } = require('../util');
const { v } = require('../security');
const { createStore } = require('../store');
const { createClaudeCodeEngine } = require('../engines/claude-code');
const { createCodexEngine } = require('../engines/codex');
const { homesOf } = require('../engines');

const HANDOFF_ENGINES = ['claude-code', 'codex'];

// Registers both handoff engines on ctx.engines (once per registry) and recovers their rooms. A ctx without the
// registry, the rooms or the project (a route test of its own) registers nothing.
const registered = new WeakSet();
function registerHandoffEngines(ctx) {
  const { engines, rooms, project } = ctx || {};
  if (!engines || !rooms || !project || registered.has(engines)) return;
  registered.add(engines);
  const store = ctx.store || createStore(project);
  const infoOf = (id) => () => engines.list().find((i) => i.id === id) || null;
  const common = { rooms, engines, store, project };
  const made = [
    createClaudeCodeEngine({ ...common, info: infoOf('claude-code'), watcher: () => ctx.claudeRuns || null }),
    createCodexEngine({ ...common, info: infoOf('codex'), codexHome: () => homesOf(process.env).codexHome }),
  ];
  for (const eng of made) {
    engines.register(eng);
    for (const room of [...rooms.rooms.values()]) {
      if (!room || room.kind !== 'run' || room.engine !== eng.id) continue;
      try { eng.recover(room); } catch (e) { console.error(`orchestra-board: could not recover room ${room.id}: ${e.message}`); }
    }
  }
}

module.exports = (ctx) => {
  registerHandoffEngines(ctx);
  // The run room and its engine; 404 for anything that is not a handoff run room.
  function runRoom(raw) {
    const id = v.id(raw, 'room id', { required: true });
    const room = ctx.rooms && ctx.rooms.rooms.get(id);
    if (!room || room.kind !== 'run' || !HANDOFF_ENGINES.includes(room.engine)) throw httpError(404, 'no such run room', 'no-run');
    const eng = ctx.engines.get(room.engine);
    if (!eng || typeof eng.candidates !== 'function') throw httpError(404, 'no such run room', 'no-run');
    return { room, eng };
  }
  return [
    {
      method: 'GET',
      re: /^\/api\/run\/([^/]+)\/candidates$/,
      run: async ({ m }) => {
        const { room, eng } = runRoom(m[1]);
        const candidates = eng.candidates(room);
        return { candidates, planChanged: !!room.planChanged };
      },
    },
    {
      method: 'POST',
      re: /^\/api\/run\/([^/]+)\/link$/,
      run: async ({ m, body }) => {
        const { room, eng } = runRoom(m[1]);
        const ref = v.str(body && body.ref, 'ref', { required: true, max: 200 });
        const out = eng.link(room, ref);
        return { ok: true, ...out };
      },
    },
    {
      method: 'POST',
      re: /^\/api\/run\/([^/]+)\/unlink$/,
      run: async ({ m }) => {
        const { room, eng } = runRoom(m[1]);
        eng.unlink(room);
        return { ok: true };
      },
    },
  ];
};
module.exports.registerHandoffEngines = registerHandoffEngines;
