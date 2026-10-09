// U2: the Runs view (public/app.js in the VM harness). The list and its scope, one run's detail, Prompt previews, the lease
// timers, the wfRun and wfRuns deltas, and the link into a linked room. Layout and focus are checked by hand in a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, json, flush, hasDash } = require('./ui-harness');

// Names the tests reach (opts.expose). app.js defines them; the shared harness list does not carry them.
const EXPOSE = ['renderRuns', 'runsViewHtml', 'runsListHtml', 'runRowHtml', 'runDetailHtml', 'agentRowsHtml', 'runsReadsBody',
  'openRunDetail', 'togglePreview', 'leaveRuns', 'loadRuns', 'loadRun', 'setWatchScope', 'onRunsClick', 'onRunsChange',
  'modeNavHtml', 'setMode', 'openRoom'];

const T0 = Date.parse('2026-10-08T12:03:00Z');
const RUN = 'wf_b5bbfaa6-3f5';
const OTHER = 'wf_0123abcd-456';
const A1 = 'a1f2e3d4c', A2 = 'a9b8c7d6e', A3 = 'a5e6f7a8b';
const DETAIL = new RegExp(`/api/wf/runs/${RUN}$`);
const PREVIEW = new RegExp(`/api/wf/runs/${RUN}/agents/${A1}/preview$`);
const LIST = /\/api\/wf\/runs$/;

const run = (over = {}) => ({ id: RUN, engine: 'claude-code', title: 'build-v02', project: 'C:/p', sessionId: 's1', status: 'running',
  startedAt: T0, lastActivityAt: T0 + 60000, endedAt: null, agentCount: 47, done: 31, failed: 0, tokens: 1200000,
  phases: ['Build', 'Review'], linkedRoomId: null, ...over });
const agent = (id, over = {}) => ({ id, key: `build:${id}`, label: `build:${id}:haiku`, phase: 'Build', model: 'claude-haiku-5-5',
  status: 'done', attempt: 1, startedAt: T0, lastActivityAt: T0 + 130000, endedAt: T0 + 130000, tokens: 41000, net: 30000,
  toolCalls: 23, lastTool: 'Edit', ...over });
// The visible text of some HTML: tags removed, spaces collapsed.
const visible = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// A click on an element with this dataset (the handler reads only the nearest matching element's dataset).
const clicked = (dataset) => ({ target: { closest: () => ({ dataset }) } });

// Objects made inside the VM have another realm: a plain copy compares with deepStrictEqual.
const plain = (v) => JSON.parse(JSON.stringify(v));

// A fake board server. A route is [pattern, answer]; answer(match, body) returns { status, body }. Every call is kept.
function server(routes = []) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body === undefined ? undefined : JSON.parse(opts.body);
    calls.push({ url, method: opts.method || 'GET', body });
    for (const [re, answer] of routes) {
      const m = url.match(re);
      if (m) { const out = await answer(m, body); return json(out.body, out.status ?? 200); }
    }
    return json({ error: 'no route' }, 404);
  };
  return { fetchImpl, calls, count: (re) => calls.filter((c) => re.test(c.url)).length };
}
// Replaces the harness timers after boot. setInterval records its period, so a test can fire the 30 s or 45 s lease.
function timers(ctx) {
  const live = new Map(); const made = []; let next = 1;
  ctx.setInterval = (fn, ms) => { const id = next++; live.set(id, { fn, ms }); made.push(ms); return id; };
  ctx.clearInterval = (id) => { live.delete(id); };
  return {
    made,
    active: () => [...live.values()].map((t) => t.ms).sort((a, b) => a - b),
    fire: (ms) => { for (const t of [...live.values()]) if (t.ms === ms) t.fn(); },
  };
}
const listRoute = (runs = [], scope = 'project') => [LIST, () => ({ status: 200, body: { runs, scope, experimental: true } })];
const detailRoute = (r = run(), agents = [agent(A1), agent(A2)]) => [DETAIL, () => ({ status: 200, body: { run: r, agents } })];

// The page with the Runs view on screen (Claude Code data present), its first list read done.
async function runsPage(routes, { scope } = {}) {
  const srv = server(routes);
  const { app, ctx } = boot(srv.fetchImpl, { expose: EXPOSE });
  const tm = timers(ctx);
  app.S.watch = { claude: true };
  app.S.settings = scope ? { watchScope: scope } : {};
  app.setMode('runs');
  await flush(); await flush();
  return { app, srv, tm, ctx };
}

test('Runs state: S.wf holds the list, the summaries by id, the open run and its previews', () => {
  const { app } = boot(server().fetchImpl, { expose: EXPOSE });
  assert.deepEqual(plain(app.S.wf), { runs: [], byId: {}, open: null, previews: {} });
});

test('a delta merges into the run: changed agents replace or join the list, the rest stay, the row follows', () => {
  const { app } = boot(server().fetchImpl, { expose: EXPOSE });
  app.S.wf.runs = [run()];
  app.S.wf.byId[RUN] = { run: run(), agents: [agent(A1, { status: 'running', tokens: 10 }), agent(A2, { status: 'running' })] };
  app.SSE.wfRun({ t: 'wfRun', run: run({ done: 32, tokens: 1300000 }), agents: [agent(A1, { status: 'done', tokens: 41000 })] });
  const rec = app.S.wf.byId[RUN];
  assert.deepEqual(rec.agents.map((a) => a.id), [A1, A2], 'the order is kept');
  assert.equal(rec.agents[0].status, 'done');
  assert.equal(rec.agents[0].tokens, 41000);
  assert.equal(rec.agents[1].status, 'running', 'an agent the delta leaves out is unchanged');
  assert.equal(app.S.wf.runs[0].done, 32, 'the list takes the new summary');
  app.SSE.wfRun({ t: 'wfRun', run: run({ done: 33 }), agents: [agent(A3, { status: 'running', phase: 'Review' })] });
  assert.deepEqual(app.S.wf.byId[RUN].agents.map((a) => a.id), [A1, A2, A3], 'a new agent joins at the end');
});

test('a delta cannot be merged without a full detail, so the run is read again instead', async () => {
  const srv = server([detailRoute(run({ done: 40 }))]);
  const { app } = boot(srv.fetchImpl, { expose: EXPOSE });
  app.SSE.wfRun({ t: 'wfRun', run: run({ done: 40 }), agents: [agent(A1, { status: 'done' })] });
  await flush(); await flush();
  assert.equal(srv.count(DETAIL), 1, 'an unknown run is read in full');
  assert.deepEqual(app.S.wf.byId[RUN].agents.map((a) => a.id), [A1, A2], 'the full list, not the partial delta');
  app.SSE.wfRun({ t: 'wfRun', run: run(), agents: [{ status: 'done' }] });
  await flush(); await flush();
  assert.equal(srv.count(DETAIL), 2, 'a delta with an agent that has no id is read again');
});

test('a run is read once at a time, even when two reads start together', async () => {
  const srv = server([detailRoute()]);
  const { app } = boot(srv.fetchImpl, { expose: EXPOSE });
  await Promise.all([app.loadRun(RUN), app.loadRun(RUN)]);
  assert.equal(srv.count(DETAIL), 1);
  assert.equal(app.S.wf.byId[RUN].agents.length, 2);
});

test('no preview is fetched before a Prompt opens; the first press reads it and the second drops the text', async () => {
  const srv = server([detailRoute(), [PREVIEW, () => ({ status: 200, body: { prompt: 'PROMPT-CANARY write the parser', result: 'RESULT-CANARY done' } })]]);
  const { app } = boot(srv.fetchImpl, { expose: EXPOSE });
  app.S.wf.open = RUN;
  app.S.wf.byId[RUN] = { run: run(), agents: [agent(A1)] };
  const collapsed = app.runDetailHtml(run());
  assert.equal(srv.count(/preview/), 0, 'nothing fetched while collapsed');
  assert.ok(!collapsed.includes('PROMPT-CANARY') && !collapsed.includes('RESULT-CANARY'), 'no prompt text while collapsed');
  assert.match(collapsed, /data-run-prev="a1f2e3d4c" aria-expanded="false"/);
  await app.togglePreview(RUN, A1);
  assert.equal(srv.count(/preview/), 1);
  const open = app.runDetailHtml(run());
  assert.ok(open.includes('PROMPT-CANARY write the parser') && open.includes('RESULT-CANARY done'));
  assert.match(open, /aria-expanded="true"/);
  await app.togglePreview(RUN, A1);
  assert.equal(srv.count(/preview/), 1, 'closing fetches nothing');
  assert.ok(!app.runDetailHtml(run()).includes('PROMPT-CANARY'));
  assert.equal(app.S.wf.previews[RUN], undefined, 'the closed preview is dropped from memory');
});

test('a Prompt answer that arrives after its Prompt was closed is dropped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = server([[PREVIEW, async () => { await gate; return { status: 200, body: { prompt: 'LATE-CANARY', result: '' } }; }]]);
  const { app } = boot(srv.fetchImpl, { expose: EXPOSE });
  const first = app.togglePreview(RUN, A1);
  await app.togglePreview(RUN, A1); // closes it while the answer is still on its way
  release();
  await first; await flush();
  assert.equal(app.S.wf.previews[RUN], undefined);
  assert.ok(!JSON.stringify(app.S.wf).includes('LATE-CANARY'));
});

test('a Prompt that the server refuses says why as text', async () => {
  const srv = server([[PREVIEW, () => ({ status: 404, body: { error: 'no such run or agent' } })]]);
  const { app } = boot(srv.fetchImpl, { expose: EXPOSE });
  await app.togglePreview(RUN, A1);
  assert.match(visible(app.agentRowsHtml([agent(A1)], { previews: app.S.wf.previews[RUN] })), /Could not load the preview: no such run or agent/);
});

test('ids the server would refuse are never sent: no preview, no run read', async () => {
  const srv = server();
  const { app } = boot(srv.fetchImpl, { expose: EXPOSE });
  await app.togglePreview('../etc', A1);
  await app.togglePreview(RUN, 'x');
  await app.loadRun('wf_../secret');
  app.openRunDetail('wf_../secret');
  await flush();
  assert.equal(srv.calls.length, 0);
});

test('leaving Runs stops both lease timers, closes the open run and drops every preview', async () => {
  const srv = [listRoute([run()]), detailRoute(), [PREVIEW, () => ({ status: 200, body: { prompt: 'p', result: 'r' } })]];
  const { app, tm } = await runsPage(srv);
  assert.deepEqual(tm.made, [30000], 'the list lease is renewed every 30 s while Runs is open');
  app.openRunDetail(RUN);
  await flush(); await flush();
  assert.deepEqual(tm.made, [30000, 45000], 'the open run is renewed every 45 s');
  await app.togglePreview(RUN, A1);
  assert.ok(app.S.wf.previews[RUN], 'a preview is open');
  app.leaveRuns();
  assert.deepEqual(tm.active(), [], 'no timer is left');
  assert.deepEqual(plain(app.S.wf.previews), {});
  assert.equal(app.S.wf.open, null);
});

test('each lease tick is one read: the list on the 30 s tick, the open run on the 45 s tick, nothing after leaving', async () => {
  const { app, srv, tm } = await runsPage([listRoute([run()]), detailRoute()]);
  const before = srv.count(LIST);
  tm.fire(30000); await flush(); await flush();
  assert.equal(srv.count(LIST), before + 1, 'the list lease is renewed');
  app.openRunDetail(RUN); await flush(); await flush();
  const detailBefore = srv.count(DETAIL);
  tm.fire(45000); await flush(); await flush();
  assert.equal(srv.count(DETAIL), detailBefore + 1, 'the run lease is renewed');
  app.leaveRuns();
  assert.deepEqual(tm.active(), []);
});

test('a linked run shows Linked to with the room title, and its link opens that room', async () => {
  const plan = { id: 'p1', kind: 'plan', title: 'CSV export', status: 'done', created: '2026-10-07T10:00:00Z', messages: [] };
  const { app, tm } = await runsPage([listRoute([run({ linkedRoomId: 'p1' })]), detailRoute(run({ linkedRoomId: 'p1' })),
    [/\/api\/rooms\/p1$/, () => ({ status: 200, body: plan })]]);
  app.S.roomIndex = { p1: { id: 'p1', kind: 'plan', title: 'CSV export', status: 'done', created: plan.created } };
  app.openRunDetail(RUN);
  await flush(); await flush();
  const html = app.runDetailHtml(run({ linkedRoomId: 'p1' }));
  assert.match(visible(html), /Linked to CSV export/);
  assert.match(html, /data-run-room="p1"/);
  app.onRunsClick(clicked({ runRoom: 'p1' }));
  await flush(); await flush();
  assert.equal(app.S.active, 'p1', 'the room opens');
  assert.equal(app.S.mode, 'workflow', 'in its own mode');
  assert.deepEqual(tm.active(), [], 'Runs stops polling when the room opens');
  assert.equal(app.S.wf.open, null);
});

test('a link to a room the board no longer lists names it without a button', () => {
  const { app } = boot(server().fetchImpl, { expose: EXPOSE });
  const html = app.runDetailHtml(run({ linkedRoomId: 'gone1' }));
  assert.match(visible(html), /Linked to a workflow that is no longer listed\./);
  assert.ok(!html.includes('data-run-room'));
});

test('the click handler: a row opens its detail and a second press closes it; the scope select saves', async () => {
  const { app, srv } = await runsPage([listRoute([run()]), detailRoute(), [/\/api\/settings$/, (m, body) => ({ status: 200, body: { ...body } })]]);
  app.onRunsClick(clicked({ run: RUN }));
  assert.equal(app.S.wf.open, RUN, 'the first press opens the run');
  app.onRunsClick(clicked({ run: RUN }));
  assert.equal(app.S.wf.open, null, 'the second press closes it');
  app.onRunsChange({ target: { id: 'runsScope', value: 'all' } });
  await flush(); await flush();
  const post = srv.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, '/api/settings');
  assert.deepEqual(post.body, { watchScope: 'all' });
  app.onRunsChange({ target: { id: 'something-else', value: 'all' } });
  assert.equal(srv.calls.filter((c) => c.method === 'POST').length, 1, 'other selects are not the scope');
});

test('the scope is saved through POST /api/settings and the list is read again', async () => {
  const srv = server([listRoute([run()]), [/^\/api\/settings$/, (m, body) => ({ status: 200, body: { lang: 'English', ...body } })]]);
  const { app } = boot(srv.fetchImpl, { expose: EXPOSE });
  app.S.settings = {};
  await app.setWatchScope('all');
  const posts = srv.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { watchScope: 'all' });
  assert.equal(app.S.settings.watchScope, 'all');
  assert.ok(srv.count(LIST) >= 1, 'the list is read again');
  await app.setWatchScope('bogus');
  await app.setWatchScope('all');
  assert.equal(srv.calls.filter((c) => c.method === 'POST').length, 1, 'an invalid or unchanged scope sends nothing');
});

test('a scope the server refuses is not kept, and the saved scope stays in place', async () => {
  const srv = server([[/^\/api\/settings$/, () => ({ status: 400, body: { error: 'watchScope must be "project" or "all"' } })]]);
  const { app, ctx } = boot(srv.fetchImpl, { expose: EXPOSE });
  ctx.setTimeout = () => 0; // the refusal shows a toast, whose 4 s timer is not needed here
  app.S.settings = { watchScope: 'project' };
  await app.setWatchScope('all');
  assert.equal(app.S.settings.watchScope, 'project');
});

test('the empty text is the one from the plan, with Show all projects; All projects drops the link', async () => {
  const { app } = await runsPage([listRoute([])]);
  const text = visible(app.runsListHtml());
  assert.ok(text.includes('No Claude Code workflow runs for this project yet. Ask Claude Code to use a Workflow and the run appears here live. The board never starts or stops these runs.'));
  assert.match(app.runsListHtml(), /data-run-scope="all"/);
  assert.match(text, /Show all projects/);
  app.S.settings = { watchScope: 'all' };
  const all = app.runsListHtml();
  assert.ok(visible(all).includes('No Claude Code workflow runs yet. Ask Claude Code to use a Workflow and the run appears here live.'));
  assert.ok(!all.includes('data-run-scope'));
});

test('before the first read the list says it is loading; a failed read keeps the rows it had', async () => {
  let fail = false;
  const srv = server([[LIST, () => (fail
    ? { status: 500, body: { error: 'disk unplugged' } }
    : { status: 200, body: { runs: [run()], scope: 'project' } })]]);
  const { app } = boot(srv.fetchImpl, { expose: EXPOSE });
  assert.match(app.runsListHtml(), /Loading runs…/);
  await app.loadRuns();
  assert.match(visible(app.runsListHtml()), /build-v02/);
  fail = true;
  await app.loadRuns();
  const html = app.runsListHtml();
  assert.match(visible(html), /Could not read the Claude Code runs: disk unplugged/);
  assert.match(visible(html), /build-v02/, 'the last good rows stay on screen');
});

test('a run that is no longer listed says so in its detail', async () => {
  const srv = server([[DETAIL, () => ({ status: 404, body: { error: 'no such run' } })]]);
  const { app } = boot(srv.fetchImpl, { expose: EXPOSE });
  app.S.wf.runs = [run()];
  app.S.wf.open = RUN;
  await app.loadRun(RUN);
  assert.match(visible(app.runDetailHtml(run())), /That run is no longer listed\./);
});

test('rows: status words, the run name, phases, agents, tokens and the time', () => {
  const { app } = boot(server().fetchImpl, { expose: EXPOSE });
  const row = visible(app.runRowHtml(run({ status: 'completed', endedAt: T0 + 490000, done: 47, agentCount: 47 })));
  for (const part of ['Done', 'build-v02', 'Build, Review', '47/47 agents', '1.20M', '8m 10s']) assert.ok(row.includes(part), part);
  for (const [status, word] of [['running', 'Running'], ['idle', 'Idle'], ['killed', 'Killed'], ['unknown', 'Ended without a summary']]) {
    assert.ok(visible(app.runRowHtml(run({ status }))).includes(word), word);
  }
  const nameless = app.runRowHtml(run({ status: 'unknown', title: null, endedAt: null }));
  assert.ok(visible(nameless).includes('wf_b5bb..'), 'a run without a title shows its short id');
  assert.match(nameless, /aria-expanded="false"/);
});

test('a run title is shown as text, never as markup', () => {
  const { app } = boot(server().fetchImpl, { expose: EXPOSE });
  const row = app.runRowHtml(run({ title: '<img src=x onerror=alert(1)>', phases: ['<b>x</b>'] }));
  assert.ok(!row.includes('<img') && !row.includes('<b>x'));
  assert.ok(row.includes('&lt;img') && row.includes('&lt;b&gt;x'));
  const agents = app.agentRowsHtml([agent(A1, { label: '<script>1</script>', model: '"><script>' })]);
  assert.ok(!agents.includes('<script>'));
});

test('agents are grouped by phase with done over total; a retried attempt is shown as retried', () => {
  const { app } = boot(server().fetchImpl, { expose: EXPOSE });
  const text = visible(app.agentRowsHtml([
    agent(A1, { status: 'done' }),
    agent(A2, { status: 'running', lastTool: 'Edit', toolCalls: 7 }),
    agent(A3, { status: 'retried', phase: 'Review', tokens: 0, toolCalls: 0 }),
  ]));
  assert.match(text, /Build 1\/2/);
  assert.match(text, /Review 0\/1/);
  assert.match(text, /Retried/);
  assert.match(text, /7 tools · Edit/);
});

test('the sandbox column appears only with a sandbox map, and full access is marked with an exclamation mark', () => {
  const { app } = boot(server().fetchImpl, { expose: EXPOSE });
  assert.ok(!app.agentRowsHtml([agent(A1)]).includes('agent-sb'));
  const full = app.agentRowsHtml([agent(A1)], { sandbox: { [A1]: 'danger-full-access' } });
  assert.ok(full.includes('has-sb'));
  assert.match(visible(full), /full access !/);
  assert.match(visible(app.agentRowsHtml([agent(A2)], { sandbox: { [A2]: 'read-only' } })), /read-only/);
});

test('What the board reads names the four kinds of files and what is never kept', () => {
  const { app } = boot(server().fetchImpl, { expose: EXPOSE });
  const text = visible(app.runsReadsBody());
  for (const kind of ['Session transcripts', 'Workflow journals', 'Agent files', 'Workflow summaries']) assert.ok(text.includes(kind), kind);
  assert.match(text, /Never kept: prompts, results, logs, arguments, errors and attachments\./);
  assert.match(text, /CLAUDE_CONFIG_DIR/);
});

test('the header counts the runs and the live ones, and the nav row gets a dot only for a running run', async () => {
  const { app } = await runsPage([listRoute([])]);
  app.SSE.wfRuns({ t: 'wfRuns', runs: [run(), run({ id: OTHER, status: 'completed' })] });
  assert.match(visible(app.runsViewHtml()), /2 runs · 1 live/);
  assert.match(app.modeNavHtml(), /data-mode="runs"[\s\S]*?dot run/);
  app.SSE.wfRuns({ t: 'wfRuns', runs: [run({ status: 'idle' })] });
  assert.ok(!/data-mode="runs"[\s\S]*?dot run/.test(app.modeNavHtml()), 'an idle run gets no dot');
});

test('without a Claude Code folder the view says why, and starts no timer and no read', async () => {
  const srv = server([listRoute([run()])]);
  const { app, ctx } = boot(srv.fetchImpl, { expose: EXPOSE });
  const tm = timers(ctx);
  app.S.watch = { claude: false };
  app.renderRuns();
  await flush();
  assert.match(visible(app.runsViewHtml()), /No Claude Code data folder was found, so there are no runs to read\./);
  assert.deepEqual(tm.active(), []);
  assert.equal(srv.count(LIST), 0);
});

test('when Claude Code data appears while the view is open, the list is read and polled; a repaint adds no timer', async () => {
  const srv = server([listRoute([run()])]);
  const { app, ctx } = boot(srv.fetchImpl, { expose: EXPOSE });
  const tm = timers(ctx);
  app.S.watch = { claude: false };
  app.renderRuns();
  await flush();
  assert.deepEqual(tm.active(), []);
  app.S.watch = { claude: true };
  app.renderRuns(); // a snapshot repaints the open view
  assert.deepEqual(tm.active(), [30000]);
  await flush(); await flush();
  assert.equal(srv.count(LIST), 1, 'the list is read at once');
  app.renderRuns();
  assert.deepEqual(tm.active(), [30000], 'a repaint does not start a second timer');
  app.leaveRuns();
  assert.deepEqual(tm.active(), []);
});

test('clicking the Show all projects link saves the scope', async () => {
  const { app, srv } = await runsPage([listRoute([]), [/^\/api\/settings$/, (m, body) => ({ status: 200, body: { ...body } })]]);
  app.onRunsClick(clicked({ runScope: 'all' }));
  await flush(); await flush();
  assert.deepEqual(srv.calls.find((c) => c.method === 'POST').body, { watchScope: 'all' });
});

test('the Runs strings use no em or en dash', async () => {
  const { app } = await runsPage([listRoute([run({ linkedRoomId: 'p1' })])]);
  app.S.roomIndex = { p1: { id: 'p1', kind: 'plan', title: 'CSV export' } };
  app.S.wf.open = RUN;
  app.S.wf.byId[RUN] = { run: run({ linkedRoomId: 'p1' }), agents: [agent(A1), agent(A2, { status: 'running', lastTool: 'Edit' })] };
  app.S.wf.previews[RUN] = { [A1]: { seq: 1, loading: false, error: '', prompt: 'a prompt', result: 'a result' } };
  const texts = [app.runsViewHtml(), app.runsReadsBody(), app.runDetailHtml(run({ linkedRoomId: 'p1' })),
    app.runRowHtml(run({ status: 'unknown', title: null })), app.agentRowsHtml([agent(A1)], { sandbox: { [A1]: 'read-only' } })];
  app.S.watch = { claude: false };
  texts.push(app.runsViewHtml());
  for (const t of texts) assert.equal(hasDash(t), false, t.slice(0, 120));
});
