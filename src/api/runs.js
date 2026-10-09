// Claude Code runs (plan F6, section 4.7): read-only routes over the runs watcher (src/watch/claude-runs.js).
//   GET /api/wf/runs                              -> { runs, scope, experimental: true }, renews the list lease
//   GET /api/wf/runs/:runId                       -> { run, agents }, renews that run's detail lease
//   GET /api/wf/runs/:runId/agents/:agentId/preview -> { prompt, result }, each at most 400 characters
// Ids are checked before the watcher is asked for anything, so a bad id never reaches a file path (400). A valid id
// the watcher does not know is 404. Previews are read on demand and returned to this request only: nothing here
// broadcasts or stores them (plan 4.6).
const { httpError } = require('../util');
const { isRunId, isAgentId } = require('../watch/claude-journal');

function runIdOf(raw) {
  if (!isRunId(raw)) throw httpError(400, 'invalid run id', 'bad-run-id');
  return raw;
}
function agentIdOf(raw) {
  if (!isAgentId(raw)) throw httpError(400, 'invalid agent id', 'bad-agent-id');
  return raw;
}
const noRun = () => httpError(404, 'no such run', 'no-run');

module.exports = (ctx) => {
  const watcher = () => ctx.claudeRuns;
  const scope = () => (typeof ctx.watchScope === 'function' ? ctx.watchScope() : 'project');
  return [
    {
      method: 'GET',
      re: /^\/api\/wf\/runs$/,
      run: async () => {
        const w = watcher();
        if (!w) return { runs: [], scope: scope(), experimental: true };
        w.lease('list');
        return { runs: w.list(), scope: scope(), experimental: true };
      },
    },
    {
      method: 'GET',
      re: /^\/api\/wf\/runs\/([^/]+)$/,
      run: async ({ m }) => {
        const runId = runIdOf(m[1]);
        const w = watcher();
        const got = w ? w.get(runId) : null;
        if (!got) throw noRun();
        w.lease(runId); // only a run that exists gets a detail lease, so unknown ids start no polling
        return got;
      },
    },
    {
      method: 'GET',
      re: /^\/api\/wf\/runs\/([^/]+)\/agents\/([^/]+)\/preview$/,
      run: async ({ m }) => {
        const runId = runIdOf(m[1]);
        const agentId = agentIdOf(m[2]);
        const w = watcher();
        const p = w ? w.preview(runId, agentId) : null;
        if (!p) throw httpError(404, 'no such run or agent', 'no-agent');
        w.lease(runId);
        return { prompt: p.prompt, result: p.result };
      },
    },
  ];
};
