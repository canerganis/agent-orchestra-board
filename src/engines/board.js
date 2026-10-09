// The board team engine (plan 3.2): the build workflow behind the engine interface. POST /api/build stays the canonical
// route; POST /api/run {engine: 'board'} starts the same build through here, after the same approval check.
const { httpError } = require('../util');
const { engineInfo } = require('./index');

const ID_RE = /^[\w-]{1,64}$/;
const BOARD_OPTIONS = ['roles', 'maxRounds', 'escalate', 'mode'];
const invalid = (message) => httpError(400, message, 'invalid-options');

// The options of a board start, as POST /api/build reads them: roles (role -> agent id, '' or null when unassigned),
// maxRounds (1 to 6), escalate (true or false) and mode ('write' or 'propose'). Any other key is refused. startBuild
// checks that the named agents exist.
function boardOptions(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('options must be an object');
  for (const k of Object.keys(raw)) if (!BOARD_OPTIONS.includes(k)) throw invalid(`unknown option "${k}"`);
  const out = {};
  if (raw.roles !== undefined) {
    const roles = raw.roles;
    if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) throw invalid('roles must be an object of agent ids');
    out.roles = {};
    for (const [role, val] of Object.entries(roles)) {
      if (val === '' || val === null || val === undefined) { out.roles[role] = null; continue; }
      if (typeof val !== 'string' || !ID_RE.test(val)) throw invalid('roles must be an object of agent ids');
      out.roles[role] = val;
    }
  }
  if (raw.maxRounds !== undefined) {
    if (!Number.isInteger(raw.maxRounds) || raw.maxRounds < 1 || raw.maxRounds > 6) throw invalid('maxRounds must be a whole number from 1 to 6');
    out.maxRounds = raw.maxRounds;
  }
  if (raw.escalate !== undefined) {
    if (typeof raw.escalate !== 'boolean') throw invalid('escalate must be true or false');
    out.escalate = raw.escalate;
  }
  if (raw.mode !== undefined && raw.mode !== null) {
    if (raw.mode !== 'write' && raw.mode !== 'propose') throw invalid('mode must be write or propose');
    out.mode = raw.mode;
  }
  return out;
}

// The board team engine. build: createBuild(); plan: createPlan() (isApproved); env: returns the current engineInfo env.
function createBoardEngine({ build, plan, env }) {
  return {
    id: 'board',
    info: (e) => engineInfo('board', e || env()),
    // Same approval rule as POST /api/build: the plan must be approved at this revision and hash. Then the options are
    // checked, the board team must be usable (409 engine-unavailable), and only then does the build start.
    async start(planRoom, { revision, hash, options } = {}) {
      if (!planRoom || planRoom.kind !== 'plan') throw httpError(404, 'no such plan', 'no-plan');
      if (revision !== planRoom.planRevision || !plan.isApproved(planRoom, hash)) {
        throw httpError(409, 'the plan is not approved at this revision', 'not-approved');
      }
      const opts = boardOptions(options);
      const info = engineInfo('board', env());
      if (!info.available) throw httpError(409, info.reason || 'the board team cannot run: no CLI is usable', 'engine-unavailable');
      const room = await build.startBuild(planRoom, { revision, hash, ...opts });
      return { room };
    },
    // The board team holds no state outside its build room: deleting a build is handled by the build routes.
    dispose() {},
    recover() {},
  };
}

module.exports = { createBoardEngine, boardOptions };
