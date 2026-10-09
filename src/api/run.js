// POST /api/run {engine, planRoomId, revision, hash, options} (plan 3.3, step 1): an engine starts a run for an approved
// plan. Only registered engines can start: the board team (server.js) and the two handoff engines, Claude Code and
// Codex (src/api/handoff.js). Approval, option and availability checks belong to the engine. A handoff engine answers
// with the run room and the prompt the user pastes into their CLI.
const { v } = require('../security');
const { httpError } = require('../util');

const SHA256 = /^[0-9a-f]{64}$/;

module.exports = (ctx) => [{
  method: 'POST',
  re: /^\/api\/run$/,
  run: async ({ body }) => {
    const engine = v.str(body.engine, 'engine', { required: true, max: 40 });
    if (!ctx.engines.get(engine)) throw httpError(400, `unknown engine: ${engine}`, 'unknown-engine');
    const planRoomId = v.id(body.planRoomId, 'planRoomId', { required: true });
    const revision = v.int(body.revision, 'revision', { min: 1, max: 1e6 });
    if (revision === undefined) throw httpError(400, 'revision is required');
    const hash = v.str(body.hash, 'hash', { max: 64 });
    if (!hash || !SHA256.test(hash)) throw httpError(400, 'hash must be a sha256 hex string');
    if (body.options !== undefined && body.options !== null && (typeof body.options !== 'object' || Array.isArray(body.options))) {
      throw httpError(400, 'options must be an object', 'invalid-options');
    }
    // The CLI checks behind engine availability are read before the engine decides (a fresh start has none yet).
    await ctx.ensureDoctor();
    const out = await ctx.engines.start(engine, ctx.rooms.rooms.get(planRoomId), { revision, hash, options: body.options });
    return { roomId: out.room.id, ...(out.pastePrompt ? { pastePrompt: out.pastePrompt } : {}) };
  },
}];
