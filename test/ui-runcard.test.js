// U4: the Workflow room's stepper, the run card of a handoff run (waiting, candidates, linked, plan changed, changes), the
// link flow, the engine event, Turn into Workflow and its New workflow dialog (public/app.js in the VM harness). Layout and
// focus are checked by hand in a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { el, boot, json, flush, hasDash } = require('./ui-harness');

// Names the tests reach (opts.expose). app.js defines them; the shared harness list does not carry them.
const EXPOSE = ['S', 'SSE', 'STATUS', 'statusHtml', 'stepperHtml', 'runCardHtml', 'candidatesHtml', 'changesHtml', 'pasteOfRun',
  'runFind', 'runDetailsOpen', 'findRun', 'linkRun', 'onRunCardClick', 'onRunCardToggle', 'applyEngineEvent', 'renderRunCard',
  'renderResultBar', 'turnIntoWorkflow', 'planStartBody', 'homeRoomId', 'openNew', 'openRoom', 'roomIndexList', 'sessionRow',
  'composerMode', 'agentRowsHtml', 'buildOfPlan', 'runsUnder', 'renderRoomHead', 'deleteRunRoom', 'dropRoom', 'runRemoveHtml',
  'loadRunRoom'];

const T0 = Date.parse('2026-10-08T12:03:00Z');
const HASH = 'b'.repeat(64);
const CANARY = 'CANARY-PROMPT-7f3a-result'; // stands for prompt and result text, which must never reach a run card
// The visible text of some HTML: tags removed, spaces collapsed.
const visible = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const quiet = async () => json({ checks: [] });
// The button a delegated click came from: the handler reads the nearest matching element's dataset.
const clicked = (dataset) => ({ target: { closest: () => ({ dataset }) } });

const PLAN = { id: 'p1', kind: 'plan', title: 'CSV export', status: 'approved', created: '2026-10-08T10:00:00Z', planRevision: 2,
  planHash: HASH, managerId: 'sol', messages: [], approval: { decision: 'approved', hash: HASH }, plan: { goal: 'Add CSV export', items: [
    { id: 'i1', title: 'Parser', spec: 'parse', owns: ['src/csv.js'], dependsOn: [], difficulty: 'easy' },
    { id: 'i2', title: 'Route', spec: 'route', owns: ['src/route.js'], dependsOn: ['i1'], difficulty: 'medium' } ] } };
// A handoff run room as the server keeps it (plan 3.1), with fields over the defaults.
const RUN = (over = {}) => ({ id: 'r1', kind: 'run', engine: 'claude-code', title: 'Claude Code run: CSV export', created: '2026-10-08T12:00:00Z',
  round: 0, messages: [], status: 'waiting', planRoomId: 'p1', planRevision: 2, planHash: HASH, planChanged: false, token: 'obk7q2mz',
  handoffFile: '.orchestra/handoff/p1-r2-obk7q2mz.md', handoffMs: T0, baseHead: null, worktreesAtHandoff: [], linked: null, run: null,
  agents: [], changes: null, ...over });
const RUN_SUMMARY = { id: 'wf_09d1c243-a39', engine: 'claude-code', title: 'build-v02', status: 'running', startedAt: T0, agentCount: 47,
  done: 31, failed: 0, tokens: 1200000, phases: ['Build'] };
const agent = (id, over = {}) => ({ id, key: `build:${id}`, label: `obk7q2mz:${id}:easy`, phase: 'Build', model: 'claude-haiku-5-5',
  status: 'done', attempt: 1, startedAt: T0, lastActivityAt: T0 + 130000, endedAt: T0 + 130000, tokens: 41000, net: 30000, toolCalls: 23,
  lastTool: 'Edit', ...over });
// A finished council whose synthesis carries a STANCE line (cleaned away in the goal of the plan made from it).
const COUNCIL = { id: 'm1', kind: 'meeting', title: 'Split runner.js?', topic: 'Split runner.js', status: 'done', created: '2026-10-08T09:00:00Z',
  seatIds: ['ada', 'eva'], resultId: 's1', rounds: 2, messages: [
    { id: 's1', seatId: 'ada', name: 'Ada', round: 'synthesis', ts: '2026-10-08T09:30:00Z', text: 'Split into runner-core and runner-io.\nSTANCE: CONVERGED' }] };
const SEATS = [
  { id: 'ada', name: 'Ada', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', status: 'idle' },
  { id: 'eva', name: 'Eva', agent: 'codex', model: 'gpt-6-luna', effort: 'medium', status: 'idle' },
  { id: 'sol', name: 'Sol', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', status: 'idle' },
];
const indexOf = (r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, created: r.created,
  ...(r.planRoomId ? { planRoomId: r.planRoomId } : {}), ...(r.engine ? { engine: r.engine } : {}) });
// The room as GET /api/rooms/:id and the room events carry it: the room event leaves out messages and agents.
const metaOf = (r) => { const { agents, messages, ...meta } = r; return meta; };

function setSeats(app, list = SEATS) {
  app.S.seats = Object.fromEntries(list.map((s) => [s.id, { ...s }]));
  app.S.order = list.map((s) => s.id);
}
// A fake board server: a route is [pattern, answer]; answer(match, body) gives { status, body }. Every call is kept.
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
  return { fetchImpl, calls, posts: (re) => calls.filter((c) => c.method === 'POST' && re.test(c.url)) };
}
// A page whose selectors answer the same element each time, so a test reads what the app wrote into it.
function stable(node = el()) {
  const kids = {};
  node.querySelector = (sel) => (kids[sel] ||= stable());
  node.querySelectorAll = () => [];
  node.kids = kids;
  return node;
}
// boot() plus a stable document page: the regions the app paints (#runCard, #resultBar, the dialog) can be read back.
function booted(fetchImpl, opts = {}) {
  const b = boot(fetchImpl, { expose: EXPOSE, ...opts });
  const doc = stable();
  b.ctx.document.querySelector = (sel) => doc.querySelector(sel);
  return { ...b, doc };
}

/* ---------- the waiting card and the candidates ---------- */

test('the waiting card: the steps, the paste prompt for the run code, and Find my run', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  app.S.project = 'C:\\Users\\you\\my-project';
  const html = app.runCardHtml(RUN(), PLAN);
  const text = visible(html);
  assert.match(text, /Waiting for you/);
  assert.match(text, /Outside the board's write gate/);
  assert.ok(html.includes('C:\\Users\\you\\my-project'), 'the steps name the project folder');
  assert.ok(html.includes('Read .orchestra/handoff/p1-r2-obk7q2mz.md and run it with a Workflow, following its rules.'),
    'the paste prompt names the handoff file, as the server writes it');
  assert.equal(app.pasteOfRun(RUN({ engine: 'codex' })), 'Read .orchestra/handoff/p1-r2-obk7q2mz.md and run it with sub-agents (spawn_agent), giving each the task_name it lists and following its rules.');
  assert.match(text, /The board finds the run by its code obk7q2mz ?\./);
  assert.ok(html.includes('data-run-find="r1"'), 'Find my run is offered for this room');
  assert.ok(html.includes('data-copy="Read .orchestra/handoff/p1-r2-obk7q2mz.md'), 'the prompt can be copied');
});

test('the run card holds no prompt or result text: a linked run shows no Prompt button and no agent text', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const room = RUN({ status: 'running', linked: { runId: 'wf_09d1c243-a39' }, run: RUN_SUMMARY,
    agents: [agent('a1a2a3a4a5', { prompt: CANARY, result: CANARY, text: CANARY })] });
  const html = app.runCardHtml(room, PLAN);
  assert.ok(!html.includes(CANARY), 'a prompt or result field never reaches the card');
  assert.ok(!html.includes('data-run-prev'), 'the agent rows have no Prompt button');
  assert.ok(!/>Prompt</.test(html));
  assert.ok(html.includes('agent-row'), 'the agent is still listed');
  assert.ok(app.agentRowsHtml(room.agents, { previews: {}, sandbox: null }).includes('data-run-prev'),
    'the shared rows keep their Prompt button for the Runs view');
});

test('Find my run lists the runs the board found, token matches first, each with a Link button', async () => {
  const srv = server([[/\/api\/run\/r1\/candidates$/, () => ({ body: { planChanged: false, candidates: [
    { ref: 'wf_09d1c243-a39', title: 'build-v02', status: 'running', startedAt: T0, agentCount: 3, tokens: 1200, tokenMatch: true, score: 2 },
    { ref: 'wf_0123abcd-456', title: 'docs-pass', status: 'done', startedAt: T0 - 60000, agentCount: 1, tokens: 300, tokenMatch: false, score: 1 },
  ] } })]]);
  const { app } = booted(srv.fetchImpl);
  app.S.rooms.r1 = RUN();
  await app.findRun('r1'); await flush();
  assert.equal(srv.calls[0].method, 'GET');
  assert.equal(srv.calls[0].url, '/api/run/r1/candidates');
  assert.deepEqual([...app.runFind.r1.list.map((c) => c.ref)], ['wf_09d1c243-a39', 'wf_0123abcd-456']);
  const html = app.candidatesHtml(app.S.rooms.r1, app.runFind.r1);
  assert.ok(html.includes('data-run-link="wf_09d1c243-a39" data-run-of="r1"'), 'the token match has a Link button for this room');
  assert.match(visible(html), /build-v02 · started [^,]+, 3 agents, code matches Link/);
  assert.match(visible(html), /docs-pass · started [^,]+, 1 agent, 1 plan item named, no code match Link/);
  assert.match(visible(html), /A run without the code may still be yours\. Check it before you link it\./);
});

test('no run carries the code yet: the card says so and asks for another look', async () => {
  const srv = server([[/\/api\/run\/r1\/candidates$/, () => ({ body: { planChanged: false, candidates: [] } })]]);
  const { app } = booted(srv.fetchImpl);
  app.S.rooms.r1 = RUN();
  await app.findRun('r1');
  assert.match(visible(app.candidatesHtml(app.S.rooms.r1, app.runFind.r1)), /No run carries the code obk7q2mz yet\. Start the prompt in Claude Code, then press Find my run again\./);
});

test('a refused Find my run shows the reason as text', async () => {
  const srv = server([[/\/api\/run\/r1\/candidates$/, () => ({ status: 404, body: { error: 'no such run room' } })]]);
  const { app } = booted(srv.fetchImpl);
  app.S.rooms.r1 = RUN();
  await app.findRun('r1');
  assert.equal(app.runFind.r1.error, 'no such run room');
  assert.match(app.candidatesHtml(app.S.rooms.r1, app.runFind.r1), /no such run room/);
});

/* ---------- the link flow ---------- */

test('Link posts the chosen ref, and the room then reads as linked with its agents', async () => {
  const srv = server([
    [/\/api\/run\/r1\/link$/, (m, body) => ({ body: { ok: true, linked: { runId: body.ref }, status: 'running' } })],
    [/\/api\/rooms\/r1$/, () => ({ body: { ...RUN({ status: 'running', linked: { runId: 'wf_09d1c243-a39' }, run: RUN_SUMMARY,
      agents: [agent('a1a2a3a4a5')] }), messages: [] } })],
  ]);
  const { app } = booted(srv.fetchImpl);
  app.S.rooms.r1 = RUN();
  app.onRunCardClick(clicked({ runLink: 'wf_09d1c243-a39', runOf: 'r1' }));
  await flush(); await flush(); await flush();
  const post = srv.posts(/\/api\/run\/r1\/link$/)[0];
  assert.ok(post, 'the link is posted');
  assert.deepEqual(post.body, { ref: 'wf_09d1c243-a39' });
  assert.equal(app.S.rooms.r1.linked.runId, 'wf_09d1c243-a39');
  assert.equal(app.S.rooms.r1.agents.length, 1, 'the agents of the linked run are read');
});

test('a refused Link shows the server reason as text and keeps the candidates for another pick', async () => {
  const srv = server([
    [/\/api\/run\/r1\/candidates$/, () => ({ body: { planChanged: false, candidates: [
      { ref: 'wf_09d1c243-a39', title: 'build-v02', startedAt: T0, agentCount: 3, tokenMatch: true, score: 0 }] } })],
    [/\/api\/run\/r1\/link$/, () => ({ status: 400, body: { error: 'that run is not one of the candidates: use Find my run again', code: 'not-a-candidate' } })],
  ]);
  const { app } = booted(srv.fetchImpl);
  app.S.rooms.r1 = RUN();
  await app.findRun('r1');
  await app.linkRun('r1', 'wf_nope');
  assert.match(app.runFind.r1.error, /not one of the candidates/);
  assert.equal(app.runFind.r1.linking, null, 'the Link is free again');
  assert.equal(app.runFind.r1.list.length, 1, 'the candidates stay');
  assert.match(app.candidatesHtml(app.S.rooms.r1, app.runFind.r1), /not one of the candidates/);
});

test('Unlink posts to the unlink route and the card reads the room again', async () => {
  const srv = server([
    [/\/api\/run\/r1\/unlink$/, () => ({ body: { ok: true } })],
    [/\/api\/rooms\/r1$/, () => ({ body: { ...RUN(), messages: [] } })],
  ]);
  const { app } = booted(srv.fetchImpl);
  app.S.rooms.r1 = RUN({ status: 'running', linked: { runId: 'w' }, agents: [] });
  app.onRunCardClick(clicked({ runUnlink: 'r1' }));
  await flush(); await flush(); await flush();
  assert.equal(srv.posts(/\/api\/run\/r1\/unlink$/).length, 1);
  assert.equal(app.S.rooms.r1.linked, null);
});

test('a handoff run room id that is not well formed is never sent to the server', async () => {
  const srv = server();
  const { app } = booted(srv.fetchImpl);
  app.onRunCardClick(clicked({ runLink: 'wf_x', runOf: '../etc' }));
  app.onRunCardClick(clicked({ runFind: '../etc' }));
  app.onRunCardClick(clicked({ runDelete: '../etc' }));
  await flush();
  assert.equal(srv.calls.length, 0);
});

/* ---------- cancel and remove: the run room is deleted from its card ---------- */

test('Cancel on a waiting run; no delete while a linked run still goes; Remove once it has ended', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const waiting = app.runCardHtml(RUN(), PLAN);
  assert.match(waiting, /data-run-delete="r1"[^>]*>Cancel<\/button>/, 'a waiting run, or one unlinked, can be cancelled');
  const going = app.runCardHtml(RUN({ status: 'running', linked: { runId: 'w' }, run: RUN_SUMMARY, agents: [agent('a1a2a3a4a5')] }), PLAN);
  assert.ok(!going.includes('data-run-delete'), 'a linked run that still goes has no delete: it is unlinked first');
  assert.ok(going.includes('data-run-unlink="r1"'));
  for (const status of ['done', 'stopped', 'unknown']) {
    const ended = app.runCardHtml(RUN({ status, linked: { runId: 'w' }, run: RUN_SUMMARY, agents: [agent('a1a2a3a4a5')] }), PLAN);
    assert.match(ended, /data-run-delete="r1"[^>]*>Remove<\/button>/, `a linked run that is ${status} can be removed`);
    assert.ok(!/>Cancel</.test(ended));
  }
  assert.equal(app.runRemoveHtml(RUN({ status: 'idle', linked: { runId: 'w' } })), '', 'an idle run is still followed');
});

test('Cancel asks first; once confirmed, the run room id goes to its delete route and the run leaves the card and the sidebar', async () => {
  const srv = server([[/\/api\/rooms\/r1\/delete$/, () => ({ body: { ok: true } })]]);
  const { app, doc, ctx } = booted(srv.fetchImpl);
  app.S.rooms.p1 = { messages: [], ...PLAN };
  app.S.rooms.r1 = { messages: [], ...RUN(), agents: [] };
  app.S.active = 'p1';
  app.renderRunCard();
  assert.ok(doc.kids['#runCard'].innerHTML.includes('data-run-delete="r1"'), 'the waiting card offers Cancel');
  const asked = [];
  ctx.confirm = (text) => { asked.push(text); return false; };
  app.onRunCardClick(clicked({ runDelete: 'r1' }));
  await flush(); await flush();
  assert.equal(srv.calls.length, 0, 'nothing is sent while the user has not confirmed');
  ctx.confirm = (text) => { asked.push(text); return true; };
  app.onRunCardClick(clicked({ runDelete: 'r1' }));
  await flush(); await flush(); await flush();
  const posts = srv.posts(/\/api\/rooms\/r1\/delete$/);
  assert.equal(posts.length, 1, 'the delete is posted once');
  assert.deepEqual(posts[0].body, {});
  assert.equal(srv.calls.length, 1, 'no other request goes out');
  assert.equal(app.S.rooms.r1, undefined, 'the room leaves the lists');
  assert.equal(app.S.roomIndex.r1, undefined);
  assert.ok(!doc.kids['#runCard'].innerHTML.includes('data-run-card="r1"'), 'its card is gone');
  assert.match(asked[0], /^Cancel Claude Code run: CSV export\? The board forgets it\./);
  assert.ok(asked.every((text) => !hasDash(text)), 'the confirm texts have no dash');
});

test('a run page whose plan is gone can be cancelled too, and the page closes with the room', async () => {
  const srv = server([[/\/api\/rooms\/r1\/delete$/, () => ({ body: { ok: true } })]]);
  const { app, ctx } = booted(srv.fetchImpl);
  setSeats(app);
  app.S.rooms.r1 = { messages: [], ...RUN({ planRoomId: 'gone' }), agents: [] };
  app.S.active = 'r1';
  ctx.confirm = () => true;
  app.onRunCardClick(clicked({ runDelete: 'r1' }));
  await flush(); await flush(); await flush();
  assert.equal(srv.posts(/\/api\/rooms\/r1\/delete$/).length, 1);
  assert.equal(app.S.active, null, 'the page closes with the room');
  assert.equal(app.S.rooms.r1, undefined);
});

test('a refused delete keeps the run on its card, shows the server reason as a toast, and can be tried again', async () => {
  let refuse = true;
  const srv = server([[/\/api\/rooms\/r1\/delete$/, () => (refuse ? { status: 400, body: { error: 'the room is busy' } } : { body: { ok: true } })]]);
  const { app, doc, ctx } = booted(srv.fetchImpl);
  const toasts = [];
  ctx.toast = (text) => { toasts.push(text); };
  ctx.confirm = () => true;
  app.S.rooms.p1 = { messages: [], ...PLAN };
  app.S.rooms.r1 = { messages: [], ...RUN(), agents: [] };
  app.S.active = 'p1';
  app.renderRunCard();
  app.onRunCardClick(clicked({ runDelete: 'r1' }));
  await flush(); await flush(); await flush();
  assert.deepEqual(toasts, ['the room is busy']);
  assert.ok(app.S.rooms.r1, 'the room stays');
  assert.ok(doc.kids['#runCard'].innerHTML.includes('data-run-card="r1"'), 'the card stays');
  refuse = false;
  app.onRunCardClick(clicked({ runDelete: 'r1' }));
  await flush(); await flush(); await flush();
  assert.equal(srv.posts(/\/api\/rooms\/r1\/delete$/).length, 2, 'a second try is sent');
  assert.equal(app.S.rooms.r1, undefined);
});

test('a run read still in flight when the run is deleted does not bring the run back', async () => {
  let answerRead = () => {};
  const srv = server([
    [/\/api\/rooms\/r1$/, () => new Promise((resolve) => { answerRead = () => resolve({ body: { ...RUN({ status: 'running', linked: { runId: 'w' } }), messages: [] } }); })],
    [/\/api\/rooms\/r1\/delete$/, () => ({ body: { ok: true } })],
  ]);
  const { app, doc, ctx } = booted(srv.fetchImpl);
  app.S.rooms.p1 = { messages: [], ...PLAN };
  app.S.rooms.r1 = { messages: [], ...RUN(), agents: [] };
  app.S.active = 'p1';
  ctx.confirm = () => true;
  app.renderRunCard();
  const read = app.loadRunRoom('r1');
  app.onRunCardClick(clicked({ runDelete: 'r1' }));
  await flush(); await flush(); await flush();
  answerRead();
  await read;
  assert.equal(srv.posts(/\/api\/rooms\/r1\/delete$/).length, 1);
  assert.equal(app.S.rooms.r1, undefined, 'the late read does not add the run back');
  assert.ok(!doc.kids['#runCard'].innerHTML.includes('data-run-card="r1"'));
});

/* ---------- linked runs and what they show ---------- */

test('a linked Codex run shows a sandbox column per sub-agent, and full access reads "full access !"', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const room = RUN({ engine: 'codex', status: 'running', linked: { parentThreadId: 'th-lead-1' },
    run: { id: 'th-lead-1', agentCount: 2, done: 1, tokens: 5000, status: 'running' },
    agents: [
      { id: 'c1a2b3c4d5', label: 'obk7q2mz_i1', itemId: 'i1', status: 'done', model: 'gpt-6-luna', sandbox: 'danger-full-access', tokens: 900, startedAt: T0, endedAt: T0 + 1000 },
      { id: 'c2a2b3c4d5', label: 'obk7q2mz_i2', itemId: 'i2', status: 'running', model: 'gpt-6.1-sol', sandbox: 'read-only', tokens: 300, startedAt: T0 },
    ] });
  const html = app.runCardHtml(room, PLAN);
  assert.match(visible(html), /full access !/);
  assert.match(visible(html), /read-only/);
  assert.ok(html.includes('agent-sb'), 'the sandbox column is shown');
  assert.match(visible(html), /1\/2 agents/);
  assert.ok(html.includes('data-run-unlink="r1"'), 'Unlink is offered');
});

test('planChanged: the plan moved on after the handoff, and the card names the revision the run follows', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const html = app.runCardHtml(RUN({ planChanged: true }), { ...PLAN, planRevision: 3 });
  assert.match(visible(html), /Plan changed after the handoff \(r3\)\. This run follows r2\./);
});

test('changes: the file count, the new worktrees and the stat behind Details; a folder without git says so', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const ended = RUN({ status: 'done', linked: { runId: 'w' }, run: RUN_SUMMARY, agents: [agent('a1a2a3a4a5')],
    changes: { git: true, files: 7, stat: ' src/csv.js | 12 ++++\n 1 file changed', newWorktrees: ['C:/p/.wt/one', 'C:/p/.wt/two'] } });
  const html = app.runCardHtml(ended, PLAN);
  assert.match(visible(html), /Changes since the handoff: 7 files, 2 new worktrees\./);
  assert.ok(html.includes('<summary>Details</summary>'));
  assert.ok(html.includes('src/csv.js | 12'), 'the diff stat is kept for Details');
  assert.ok(html.includes('C:/p/.wt/two'), 'the new worktrees are listed');
  assert.match(app.changesHtml(RUN({ status: 'done', changes: { git: false } })), /not a git repository/);
  assert.match(app.changesHtml(RUN({ status: 'running' })), /read when the run ends/);
  assert.equal(app.changesHtml(RUN({ status: 'done', changes: null })), '', 'an ended run with nothing read shows nothing');
});

test('an open Details stays open across repaints', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const room = RUN({ status: 'done', linked: { runId: 'w' }, run: RUN_SUMMARY, changes: { git: true, files: 1, stat: '', newWorktrees: [] } });
  assert.ok(!app.changesHtml(room).includes(' open>'));
  app.onRunCardToggle({ target: { dataset: { runDetails: 'r1' }, open: true } });
  assert.ok(app.changesHtml(room).includes(' open>'), 'an open Details is kept');
  app.onRunCardToggle({ target: { dataset: { runDetails: 'r1' }, open: false } });
  assert.ok(!app.changesHtml(room).includes(' open>'));
});

/* ---------- engine events and the room views ---------- */

test('an engine event updates a loaded run room: its summary and its changed agents; an unknown room is ignored', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  app.S.rooms.r1 = { messages: [], ...RUN({ status: 'running', linked: { runId: 'wf_09d1c243-a39' }, agents: [agent('a1a2a3a4a5', { status: 'running' })] }) };
  app.SSE.engine({ t: 'engine', roomId: 'r1', run: { ...RUN_SUMMARY, status: 'completed' }, agents: [agent('a1a2a3a4a5', { status: 'done' }), agent('b1b2b3b4b5')] });
  assert.equal(app.S.rooms.r1.agents.length, 2);
  assert.equal(app.S.rooms.r1.agents[0].status, 'done', 'a changed agent keeps its place');
  assert.equal(app.S.rooms.r1.run.status, 'completed');
  assert.doesNotThrow(() => app.SSE.engine({ t: 'engine', roomId: 'nope', run: null, agents: [] }));
  assert.equal(app.S.rooms.nope, undefined);
});

test('a handoff run created while its plan is on screen appears under the plan, with its card read in full', async () => {
  const srv = server([[/\/api\/rooms\/r1$/, () => ({ body: { ...RUN(), messages: [] } })]]);
  const { app, doc } = booted(srv.fetchImpl);
  setSeats(app);
  app.S.rooms.p1 = { messages: [], ...PLAN };
  app.S.active = 'p1';
  app.SSE.room({ t: 'room', room: metaOf(RUN()) });
  await flush(); await flush(); await flush();
  assert.equal(doc.kids['#runCard'].hidden, false, 'the run card is shown under the plan');
  assert.ok(doc.kids['#runCard'].innerHTML.includes('data-run-find="r1"'), 'the waiting card is painted');
  assert.match(doc.kids['#main .main-head'].innerHTML, /class="stepper"/, 'the header carries the stepper');
});

test('a handoff run opens under its plan: the run is not a page of its own, unless its plan is gone', async () => {
  const srv = server([[/\/api\/rooms\/p1$/, () => ({ body: { ...PLAN, messages: [] } })]]);
  const storage = new Map();
  const { app } = booted(srv.fetchImpl, { storage });
  setSeats(app);
  app.S.roomIndex = { p1: indexOf(PLAN), r1: indexOf(RUN()) };
  app.openRoom('r1');
  assert.equal(app.S.active, 'p1');
  assert.equal(storage.get('ob.room'), 'p1');
  assert.equal(app.homeRoomId('r1'), 'p1');
  app.S.roomIndex = { r1: indexOf(RUN({ planRoomId: 'gone' })) };
  assert.equal(app.homeRoomId('r1'), 'r1', 'a run whose plan is gone keeps its page');
  assert.equal(app.composerMode(RUN()), 'none', 'a run page has no composer');
});

test('a waiting run reads "Waiting for you" with a warning dot, on the card and in the sidebar', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  assert.equal(app.STATUS.waiting, 'Waiting for you');
  assert.match(app.statusHtml('waiting'), /dot warn/);
  const row = app.sessionRow(RUN());
  assert.match(row, /srow-acc warn/);
  assert.match(row, /Waiting for you/);
  assert.match(row, /External run · Claude Code/);
  assert.match(app.runCardHtml(RUN(), PLAN), /Waiting for you/);
});

/* ---------- the stepper ---------- */

test('the stepper: a plan awaiting approval, a plan built by a handoff run (external), and one built by the board team', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  app.S.roomIndex = {};
  const waiting = app.stepperHtml({ ...PLAN, status: 'awaiting-approval' });
  assert.match(waiting, /aria-current="step"[^>]*><span class="sr-only">Current: <\/span>Approve/);
  assert.match(waiting, /Done: <\/span>Plan/);
  assert.match(waiting, /To do: <\/span>Build/, 'no build yet');
  assert.ok(!waiting.includes('external'));

  app.S.roomIndex = { r1: indexOf(RUN()) };
  const handoff = app.stepperHtml(PLAN);
  assert.match(handoff, /Build: Claude Code <span class="tag">external<\/span>/, 'a handoff build is tagged external');
  assert.match(handoff, /Done: <\/span>Approve/);

  app.S.roomIndex = { b1: { id: 'b1', kind: 'build', title: 'Build', status: 'running', created: '2026-10-08T13:00:00Z', planRoomId: 'p1' } };
  const board = app.stepperHtml(PLAN);
  assert.match(board, /Build: Board team/);
  assert.ok(!board.includes('external'), 'the board team build is not external');

  app.S.roomIndex = {};
  assert.match(app.stepperHtml({ ...PLAN, status: 'rejected' }), /Failed: <\/span>Rejected/);
});

/* ---------- Turn into Workflow and its New workflow dialog ---------- */

test('a finished council shows Turn into Workflow; a running one shows no result bar action', () => {
  const { app, doc } = booted(quiet);
  setSeats(app);
  app.S.rooms.m1 = COUNCIL; app.S.active = 'm1';
  app.renderResultBar();
  assert.ok(doc.kids['#resultBar'].innerHTML.includes('id="rbWorkflow"'), 'the button is painted in the result bar');
  assert.equal(typeof doc.kids['#rbWorkflow'].onclick, 'function', 'the button is wired');
  app.S.rooms.m1 = { ...COUNCIL, status: 'running' };
  app.renderResultBar();
  assert.equal(doc.kids['#resultBar'].innerHTML, '', 'a running council has no result bar');
});

test('Turn into Workflow opens a New workflow prefilled with the synthesis and the council id, in the Workflow mode', () => {
  const { app, ctx } = booted(quiet);
  setSeats(app);
  app.S.rooms.m1 = COUNCIL;
  const calls = [];
  ctx.openNew = (kind, preset, source) => { calls.push({ kind, preset, source }); };
  app.turnIntoWorkflow(app.S.rooms.m1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'plan');
  assert.equal(calls[0].preset.councilId, 'm1');
  assert.equal(calls[0].preset.goal, 'Split into runner-core and runner-io.', 'the synthesis, without its STANCE line');
  assert.equal(app.S.mode, 'workflow');
  app.turnIntoWorkflow(app.S.rooms.m1.id);
  assert.equal(calls.length, 2, 'a council id works too');
});

test('a council that is not finished cannot become a workflow', () => {
  const { app, ctx } = booted(quiet);
  let opened = false;
  ctx.openNew = () => { opened = true; };
  app.turnIntoWorkflow({ ...COUNCIL, status: 'running' });
  app.turnIntoWorkflow({ ...PLAN });
  assert.equal(opened, false);
});

test('planStartBody: a plan from a council sends its id and no participants; a debate plan keeps its participants and roles', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const council = app.planStartBody({ goal: ' Ship it ', councilId: 'm1', manager: 'sol', rounds: 1, ctx: false, scout: 'ada', facilitator: 'eva' }, ['ada', 'eva'], {});
  assert.equal(council.councilId, 'm1');
  assert.deepEqual([...council.seatIds], []);
  assert.equal(council.goal, 'Ship it');
  assert.equal('scoutId' in council, false, 'no debate roles are sent');
  assert.equal('synthId' in council, false);
  const debate = app.planStartBody({ goal: 'G', manager: 'sol', rounds: 2, ctx: true, scout: 'ada', facilitator: 'eva' }, ['ada', 'eva'], {});
  assert.equal(debate.councilId, undefined);
  assert.deepEqual([...debate.seatIds], ['ada', 'eva']);
  assert.equal(debate.scoutId, 'ada');
  assert.equal(debate.synthId, 'eva');
  assert.equal(debate.withContext, true);
});

test('the New workflow dialog from a council has no debate fields, and Start sends the council id with no participants', async () => {
  const srv = server([[/\/api\/plan$/, () => ({ body: { roomId: 'p9' } })]]);
  const storage = new Map();
  const { app, doc } = booted(srv.fetchImpl, { storage });
  setSeats(app);
  app.S.rooms.m1 = COUNCIL;
  // The kind segment reads plan, as the dialog renders it for the chosen kind.
  doc.querySelector('#overlay .modal').kids['#nKind .on'] = Object.assign(stable(), { dataset: { k: 'plan' } });
  app.openNew('plan', { goal: 'Split into runner-core and runner-io.', councilId: 'm1' });
  const box = doc.querySelector('#overlay .modal');
  assert.match(doc.querySelector('#overlay').innerHTML, /New workflow/, 'the dialog is titled as a workflow');
  const form = box.kids['#nForm'].innerHTML;
  assert.match(form, /Made from the council &quot;Split runner\.js\?&quot;|Made from the council "Split runner\.js\?"/);
  assert.ok(!form.includes('id="nPicks"'), 'no participants');
  assert.ok(!form.includes('id="nScout"'), 'no scout');
  assert.ok(!form.includes('id="nSynth"'), 'no facilitator');
  assert.ok(!hasDash(visible(form)), 'the council note has no dash');
  // The page holds what the user typed (the stub keeps values only where the test sets them).
  box.kids['#nGoal'].value = 'Split into runner-core and runner-io.';
  box.kids['#nManager'].value = 'sol';
  await box.kids['#nGo'].onclick();
  await flush();
  const post = srv.posts(/\/api\/plan$/)[0];
  assert.ok(post, 'the plan is posted');
  assert.equal(post.body.councilId, 'm1');
  assert.deepEqual([...post.body.seatIds], []);
  assert.equal(post.body.managerId, 'sol');
  assert.equal('scoutId' in post.body || 'synthId' in post.body, false);
  assert.equal(storage.has('ob.new.plan'), false, 'the remembered New workflow setup is not overwritten');
});

test('the New workflow dialog for a debate keeps the participants and roles', () => {
  const { app, doc } = booted(quiet);
  setSeats(app);
  doc.querySelector('#overlay .modal').kids['#nKind .on'] = Object.assign(stable(), { dataset: { k: 'plan' } });
  app.openNew('plan', { goal: 'Plan it' });
  const form = doc.querySelector('#overlay .modal').kids['#nForm'].innerHTML;
  assert.ok(form.includes('id="nPicks"'), 'the participants are offered');
  assert.ok(form.includes('id="nScout"'));
  assert.ok(!form.includes('Made from the council'));
});

test('a handoff run page has no Stop button: the board never stops or kills the user\'s run', () => {
  const { app, doc } = booted(quiet, { expose: EXPOSE });
  app.S.rooms.r1 = { messages: [], ...RUN({ status: 'running' }) };
  app.S.active = 'r1';
  app.renderRoomHead();
  const head = doc.kids['#main .main-head'].innerHTML;
  assert.ok(head.includes('External run'), 'the header names the run');
  assert.ok(!head.includes('id="stopRoom"'), 'no Stop button for a handoff run');
});

/* ---------- the room page: the card under the plan, and the dash rule ---------- */

test('the card is hidden when the plan has no run, and shown for a run page without its plan', () => {
  const { app, doc } = booted(quiet);
  app.S.rooms.p1 = { messages: [], ...PLAN };
  app.S.active = 'p1';
  app.renderRunCard();
  assert.equal(doc.kids['#runCard'].hidden, true);
  app.S.rooms.r1 = { messages: [], ...RUN(), agents: [] };
  app.S.active = 'r1';
  app.renderRunCard();
  assert.equal(doc.kids['#runCard'].hidden, false, 'the run page shows its card');
  assert.ok(doc.kids['#runCard'].innerHTML.includes('data-run-card="r1"'));
});

test('new strings: no em or en dash in the stepper, the run card, the candidates or the changes', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  app.S.roomIndex = { r1: indexOf(RUN()) };
  const texts = [
    app.stepperHtml(PLAN),
    app.runCardHtml(RUN(), PLAN),
    app.runCardHtml(RUN({ status: 'running', planChanged: true, linked: { runId: 'w' }, run: RUN_SUMMARY, agents: [agent('a1a2a3a4a5')] }), PLAN),
    app.candidatesHtml(RUN(), { pending: false, list: [{ ref: 'w', title: 't', startedAt: T0, agentCount: 1, tokenMatch: false, score: 0 }], error: '' }),
    app.changesHtml(RUN({ status: 'done', changes: { git: true, files: 2, stat: '', newWorktrees: ['x'] } })),
    app.runCardHtml(RUN({ status: 'done', linked: { runId: 'w' }, run: RUN_SUMMARY, agents: [agent('a1a2a3a4a5')] }), PLAN),
  ];
  for (const t of texts) assert.equal(hasDash(visible(t)), false, visible(t).slice(0, 120));
});
