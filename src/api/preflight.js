// GET /api/preflight?planRoomId= (plan F1, step 4): what a build needs right now, read without starting anything. The git
// state of the checkout comes from worktree.repoInfo and mainState; the write status of each CLI comes from the cached
// capability status. planRoomId is optional, and when it is given it must name a plan.
const { v } = require('../security');
const { httpError } = require('../util');
const worktree = require('../worktree');

const LABEL = { claude: 'Claude Code', codex: 'Codex' };

// The checkout as the board sees it. A folder that is not a usable repository is not ok, and it is never clean.
function checkoutOf(project) {
  try {
    const info = worktree.repoInfo(project);
    if (!info.ok) return { git: { ok: false, reason: info.reason || 'the project is not a usable git repository' }, clean: false, dirtyCount: 0 };
    const st = worktree.mainState(project);
    return {
      git: { ok: true, reason: null },
      clean: st.clean === true,
      dirtyCount: new Set([...st.staged, ...st.unstaged, ...st.untracked]).size,
    };
  } catch (e) {
    return { git: { ok: false, reason: `git could not be checked: ${(e && e.message) || e}` }, clean: false, dirtyCount: 0 };
  }
}

// One CLI's write status from the cached capability: available, or the reason as text. Unknown counts as unavailable.
function writeOf(cap, agent) {
  const a = cap && cap.agents ? cap.agents[agent] : null;
  if (!a) return { available: false, reason: 'the write status has not been checked yet' };
  if (a.available === true) return { available: true, reason: null };
  return { available: false, reason: a.reason || `${LABEL[agent]} file edits are off` };
}

module.exports = (ctx) => [{
  method: 'GET',
  re: /^\/api\/preflight$/,
  run: async ({ query }) => {
    const planRoomId = v.id(query.planRoomId, 'planRoomId');
    if (planRoomId) {
      const pr = ctx.rooms.rooms.get(planRoomId);
      if (!pr || pr.kind !== 'plan') throw httpError(404, 'no such plan', 'no-plan');
    }
    const checkout = checkoutOf(ctx.project);
    let cap = ctx.capability.cached();
    if (!cap) { try { cap = await ctx.capability.status(); } catch { cap = null; } }
    return { ...checkout, writes: { claude: writeOf(cap, 'claude'), codex: writeOf(cap, 'codex') } };
  },
}];
