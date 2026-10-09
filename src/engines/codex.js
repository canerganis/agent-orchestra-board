// The Codex handoff engine (plan 3.2, F7): the user runs the plan in Codex with sub-agents, and the board finds, links
// and follows the lead thread and its sub-agents through the read-only rollout follower (src/watch/codex-rollouts.js).
// Each sub-agent gets task_name '<token>_<item>' (the item id sanitized by sanitizeItemIds), so its agent_path is
// /root/<token>_<item> and the follower maps it back to the item id. Status is the follower's: running, done, stopped,
// unknown or waiting. Each sub-agent's sandbox is reported as Codex recorded it. No message text reaches the room.
const worktree = require('../worktree');
const rollouts = require('../watch/codex-rollouts');
const { createHandoffEngine, sanitizeItemIds, itemIdsOf, mentions, WINDOW_MS } = require('./handoff');

const ROOT = '/root/';
const STATUSES = new Set(['running', 'done', 'stopped', 'unknown', 'waiting']);
const statusOf = (s) => (STATUSES.has(s) ? s : 'unknown');
const short = (id) => String(id).slice(0, 8);

// The run summary a room keeps for a Codex run: the follower's counts, with the engine and a title.
const runOf = (run) => ({ ...run, engine: 'codex', title: `Codex thread ${short(run.id)}` });

// codexHome: () => the Codex home ($CODEX_HOME or ~/.codex). intervalMs: the follower's poll period (0 polls only on
// demand, for tests). The rest goes to createHandoffEngine.
function createCodexEngine({ codexHome = rollouts.codexHome, intervalMs = 2000, ...opts }) {
  const now = opts.now || Date.now;
  const project = opts.project;
  const followers = new Map(); // room id -> follower
  const homeNow = () => (typeof codexHome === 'function' ? codexHome() : codexHome);
  const inProject = (cwd) => typeof cwd === 'string' && !!project && worktree.within(cwd, project);

  const adapter = {
    // Lead threads with sub-agents that started since the window: the one whose sub-agents carry the code first, then
    // the others in this project, scored by the item ids their agent paths name.
    candidates(room, plan, sinceMs) {
      const home = homeNow();
      const t = now();
      const tokenParent = rollouts.findByToken(home, room.token, sinceMs, t);
      const metas = rollouts.scanMeta(home, sinceMs, t);
      const byId = new Map(metas.map((m) => [m.id, m]));
      const groups = new Map(); // lead id -> sub-agent metas
      for (const m of metas) {
        if (m.spawn === null || m.timestamp < sinceMs) continue;
        const parent = byId.get(m.spawn.parentId);
        if (parent && parent.spawn !== null) continue; // a grandchild belongs to its lead's run, not a run of its own
        const g = groups.get(m.spawn.parentId) || [];
        g.push(m);
        groups.set(m.spawn.parentId, g);
      }
      if (tokenParent && !groups.has(tokenParent)) groups.set(tokenParent, []);
      const ids = itemIdsOf(plan);
      const keys = [...sanitizeItemIds(ids).keys()];
      const out = [];
      for (const [leadId, kids] of groups) {
        const tokenMatch = leadId === tokenParent;
        const lead = byId.get(leadId) || null;
        const cwds = [lead && lead.cwd, ...kids.map((k) => k.cwd)].filter((c) => typeof c === 'string');
        if (!tokenMatch && cwds.length && !cwds.some(inProject)) continue;
        const names = kids.map((k) => (k.spawn.agentPath || '').replace(ROOT, '')).join('\n');
        const score = ids.filter((id, i) => mentions(names, [id]) || mentions(names, [keys[i]])).length;
        const starts = kids.map((k) => k.timestamp);
        if (lead && lead.timestamp >= sinceMs) starts.push(lead.timestamp);
        out.push({
          ref: leadId, title: `Codex thread ${short(leadId)}`, status: null,
          startedAt: starts.length ? Math.min(...starts) : null, agentCount: kids.length, tokens: null, tokenMatch, score,
        });
      }
      return out;
    },
    linkOf: (ref) => ({ parentThreadId: ref }),
    refOf: (linked) => (linked && linked.parentThreadId) || null,
    follow(room, plan, update) {
      const parentThreadId = room.linked && room.linked.parentThreadId;
      if (!parentThreadId) return () => {};
      const f = rollouts.createRolloutFollower({
        home: homeNow(),
        parentThreadId,
        sinceMs: (Number.isFinite(room.handoffMs) ? room.handoffMs : 0) - WINDOW_MS,
        token: room.token,
        itemMap: sanitizeItemIds(itemIdsOf(plan)),
        intervalMs,
        now,
        onAgents: (all, changed, run) => update({ run: runOf(run), agents: changed, status: statusOf(run.status) }),
      });
      followers.set(room.id, f);
      try { f.poll(); } catch {}
      return () => {
        f.stop();
        if (followers.get(room.id) === f) followers.delete(room.id);
      };
    },
    derive(room) {
      const f = followers.get(room.id);
      if (!f) return null;
      const run = f.run();
      return { run: runOf(run), agents: f.agents(), status: statusOf(run.status) };
    },
  };
  return createHandoffEngine({ ...opts, id: 'codex', adapter });
}

module.exports = { createCodexEngine, statusOf };
