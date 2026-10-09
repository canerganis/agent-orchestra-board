// Runs API (plan F6, section 4.7) on a live in-process server with fake CLIs, a temp project and a temp Claude home
// (CLAUDE_CONFIG_DIR) holding the synthetic fixture run from test/fixtures/claude-wf. Covers the session gate, id checks
// (400) before any lookup, unknown runs (404), the list, detail and preview routes, previews clipped to 400 characters
// with no canary in any SSE event, the watchScope setting, state().watch.claude and the watcher stop on close().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tmpDir, startApp, teardown, waitFor } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { encodeProjectDir } = require('../src/watch/claude-journal');

const FIX = path.join(__dirname, 'fixtures', 'claude-wf');
const FIX_RUN = 'wf_0a1b2c3d-e4f';
const OTHER_RUN = 'wf_44445555-666';
const FIX_END = Date.parse('2026-10-08T10:03:00.000Z');
const AGENT = 'a3f9c2e1b7d4a8e6';
let dir, project, claudeHome, ctx, events, savedConfigDir;

// A session folder for cwd with a main transcript that names it, under <claudeHome>/projects.
function session(cwd) {
  const sid = crypto.randomUUID();
  const fdir = path.join(claudeHome, 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(path.join(fdir, sid), { recursive: true });
  fs.writeFileSync(path.join(fdir, sid + '.jsonl'), JSON.stringify({ type: 'user', cwd, sessionId: sid, message: { role: 'user', content: 'hi' } }) + '\n');
  return path.join(fdir, sid);
}

// The fixture run in a session, dated at its summary's end so it reads as completed. The first agent's summary
// previews are longer than 400 characters and carry a canary.
function fixtureRun(sessDir, runId) {
  const rdir = path.join(sessDir, 'subagents', 'workflows', runId);
  fs.mkdirSync(rdir, { recursive: true });
  for (const f of fs.readdirSync(FIX)) {
    if (f === 'summary.json') continue;
    fs.copyFileSync(path.join(FIX, f), path.join(rdir, f));
    fs.utimesSync(path.join(rdir, f), FIX_END / 1000, FIX_END / 1000);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(FIX, 'summary.json'), 'utf8'));
  const entry = summary.workflowProgress.find((p) => p.agentId === AGENT);
  entry.promptPreview = 'CANARY_' + 'p'.repeat(1000);
  entry.resultPreview = 'CANARY_' + 'r'.repeat(1000);
  const sumDir = path.join(sessDir, 'workflows');
  fs.mkdirSync(sumDir, { recursive: true });
  const file = path.join(sumDir, runId + '.json');
  fs.writeFileSync(file, JSON.stringify({ ...summary, runId }));
  fs.utimesSync(file, FIX_END / 1000, FIX_END / 1000);
}

before(async () => {
  dir = tmpDir('ob-runs-api-');
  setupFakeCli(dir);
  project = path.join(dir, 'project');
  fs.mkdirSync(project);
  claudeHome = path.join(dir, 'claude');
  fixtureRun(session(project), FIX_RUN);
  const elsewhere = path.join(dir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fixtureRun(session(elsewhere), OTHER_RUN);
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  ctx = await startApp({ projectDir: project });
  events = await ctx.sse();
});
after(async () => {
  try { if (events) events.close(); } catch {}
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  await teardown(ctx, dir);
});

const noCanary = (v, what) => assert.ok(!JSON.stringify(v).includes('CANARY'), `${what} holds no canary`);

test('every runs route answers 401 without the session cookie', async () => {
  for (const p of ['/api/wf/runs', `/api/wf/runs/${FIX_RUN}`, `/api/wf/runs/${FIX_RUN}/agents/${AGENT}/preview`]) {
    const r = await ctx.get(p, { cookie: null });
    assert.equal(r.status, 401, p);
    assert.deepEqual(r.json, { error: 'unauthorized: open the URL printed at startup' });
  }
});

test('state: watch.claude is true with a projects folder; the scope reads project until one is saved', async () => {
  const s = await ctx.state();
  assert.equal(s.watch.claude, true);
  assert.equal(s.settings.watchScope, undefined, 'no scope saved yet');
  assert.equal((await ctx.get('/api/wf/runs')).json.scope, 'project');
});

test('GET /api/wf/runs lists this project\'s run only, marked experimental, and holds no canary', async () => {
  const r = await ctx.get('/api/wf/runs');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.experimental, true);
  assert.equal(r.json.scope, 'project');
  assert.deepEqual(r.json.runs.map((x) => x.id), [FIX_RUN]);
  assert.equal(r.json.runs[0].status, 'completed');
  noCanary(r.json, 'the list');
});

test('GET /api/wf/runs/:id: the run and its agents; 404 for an unknown run; 400 for a bad id', async () => {
  const r = await ctx.get(`/api/wf/runs/${FIX_RUN}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.run.id, FIX_RUN);
  assert.ok(r.json.agents.some((a) => a.id === AGENT));
  noCanary(r.json, 'the detail');
  const unknown = await ctx.get('/api/wf/runs/wf_deadbeef-123');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'no-run');
  for (const bad of ['nope', 'wf_a.b', 'wf_' + 'x'.repeat(50), 'wf_%2E%2E', '%00']) {
    const b = await ctx.get(`/api/wf/runs/${bad}`);
    assert.equal(b.status, 400, bad);
    assert.equal(b.json.code, 'bad-run-id', bad);
  }
});

test('preview: each field at most 400 characters; bad ids 400; unknown agent 404; no canary reaches SSE', async () => {
  const r = await ctx.get(`/api/wf/runs/${FIX_RUN}/agents/${AGENT}/preview`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['prompt', 'result']);
  assert.equal(r.json.prompt.length, 400);
  assert.ok(r.json.prompt.startsWith('CANARY_ppp'));
  assert.ok(r.json.result.length <= 400);
  const badRun = await ctx.get(`/api/wf/runs/nope/agents/${AGENT}/preview`);
  assert.equal(badRun.status, 400);
  assert.equal(badRun.json.code, 'bad-run-id');
  const badAgent = await ctx.get(`/api/wf/runs/${FIX_RUN}/agents/zz/preview`);
  assert.equal(badAgent.status, 400);
  assert.equal(badAgent.json.code, 'bad-agent-id');
  const missing = await ctx.get(`/api/wf/runs/${FIX_RUN}/agents/a1234567890abcdef/preview`);
  assert.equal(missing.status, 404);
  const missingRun = await ctx.get(`/api/wf/runs/wf_deadbeef-123/agents/${AGENT}/preview`);
  assert.equal(missingRun.status, 404);
  // Only a detail lease (or a follow, none here) makes the watcher send wfRun, and the list lease sends only wfRuns.
  // So a wfRun for this run with its agent proves the detail lease took effect. Wait for it, with a deadline.
  const sent = await events.waitFor((e) => e.t === 'wfRun' && e.run && e.run.id === FIX_RUN && e.agents.some((a) => a.id === AGENT), { timeout: 10000 });
  assert.equal(sent.run.id, FIX_RUN);
  noCanary(events.events, 'every SSE event');
});

test('settings: watchScope accepts project or all, rejects anything else with 400 and leaves settings as they were', async () => {
  for (const bad of ['bogus', 5, null, '', 'ALL']) {
    const r = await ctx.post('/api/settings', { watchScope: bad, lang: 'German' });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  let s = (await ctx.state()).settings;
  assert.equal(s.watchScope, undefined, 'a rejected scope is never saved');
  assert.notEqual(s.lang, 'German', 'a rejected request changes nothing');
  const ok = await ctx.post('/api/settings', { watchScope: 'all' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.watchScope, 'all');
  assert.equal(ctx.app.store.readJson('settings.json').watchScope, 'all', 'persisted');
  await events.waitFor((e) => e.t === 'settings' && e.settings.watchScope === 'all');
  const all = await ctx.get('/api/wf/runs');
  assert.equal(all.json.scope, 'all');
  await waitFor(async () => (await ctx.get('/api/wf/runs')).json.runs.some((x) => x.id === OTHER_RUN), { timeout: 5000, what: 'the other project\'s run under scope all' });
  const back = await ctx.post('/api/settings', { watchScope: 'project' });
  assert.equal(back.status, 200);
  assert.equal((await ctx.get('/api/wf/runs')).json.scope, 'project');
  s = (await ctx.state()).settings;
  assert.equal(s.watchScope, 'project');
});

test('close() stops the runs watcher', async () => {
  const app = ctx.app;
  assert.equal(app.claudeRuns.lease('list'), true);
  await ctx.stop();
  ctx = null;
  assert.equal(app.claudeRuns.lease('list'), false, 'a stopped watcher takes no lease');
  assert.equal(app.claudeRuns.get(FIX_RUN), null, 'a stopped watcher answers nothing');
});
