// The Claude Code handoff engine (plan 3.2, F7): the user runs the plan as a Claude Code Workflow, and the board finds,
// links and follows that run through the read-only runs watcher (src/watch/claude-runs.js). Agents are labelled
// '<token>:<itemId>:<tier>', so a run carrying the code is found first. Status: completed reads as done, killed as
// stopped, running, idle and unknown as they are. Only what the watcher reports reaches the room: labels, phases,
// models, statuses, tokens and tool counts, never prompt or result text.
const { createHandoffEngine, itemIdsOf, mentions } = require('./handoff');

const STATUS = Object.freeze({ completed: 'done', killed: 'stopped', running: 'running', idle: 'idle', unknown: 'unknown' });
const statusOf = (s) => STATUS[s] || 'unknown';
const withId = (agents) => (Array.isArray(agents) ? agents.filter((a) => a && typeof a.id === 'string' && a.id) : []);

// The candidate a runs watcher summary makes. agents: the run's agents, for the item id score.
function candidateOf(run, agents, ids, tokenMatch) {
  const text = [run.title || '', ...agents.map((a) => a.label || '')].join('\n');
  return {
    ref: run.id, title: run.title || run.id, status: statusOf(run.status), startedAt: run.startedAt ?? null,
    agentCount: run.agentCount ?? agents.length, tokens: run.tokens ?? null, tokenMatch, score: mentions(text, ids),
  };
}

// watcher: () => the runs watcher (createClaudeRuns) or null. The rest goes to createHandoffEngine.
function createClaudeCodeEngine({ watcher, ...opts }) {
  const w = () => (typeof watcher === 'function' ? watcher() : watcher) || null;
  const adapter = {
    candidates(room, plan, sinceMs) {
      const runs = w();
      if (!runs) return [];
      const ids = itemIdsOf(plan);
      // findByToken runs a discovery pass of its own when the last one is old, so list() below is fresh too.
      const byToken = runs.findByToken(room.token, sinceMs) || [];
      const seen = new Set(byToken.map((r) => r.id));
      const out = byToken.map((r) => candidateOf(r, withId((runs.get(r.id) || {}).agents), ids, true));
      for (const r of runs.list() || []) {
        if (seen.has(r.id) || typeof r.startedAt !== 'number' || r.startedAt < sinceMs) continue;
        seen.add(r.id);
        out.push(candidateOf(r, withId((runs.get(r.id) || {}).agents), ids, false));
      }
      return out;
    },
    linkOf: (ref) => ({ runId: ref }),
    refOf: (linked) => (linked && linked.runId) || null,
    follow(room, plan, update) {
      const runs = w();
      const runId = room.linked && room.linked.runId;
      if (!runs || !runId) return () => {};
      return runs.follow(runId, ({ run, agents } = {}) => {
        if (!run) return;
        update({ run: { ...run }, agents: withId(agents), status: statusOf(run.status) });
      });
    },
    derive(room) {
      const runs = w();
      const runId = room.linked && room.linked.runId;
      const got = runs && runId ? runs.get(runId) : null;
      if (!got || !got.run) return null;
      return { run: { ...got.run }, agents: withId(got.agents), status: statusOf(got.run.status) };
    },
  };
  return createHandoffEngine({ ...opts, id: 'claude-code', adapter });
}

module.exports = { createClaudeCodeEngine, statusOf };
