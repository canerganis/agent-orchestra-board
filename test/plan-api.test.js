// HTTP surface of the v0.2 routes on a live server (port 4392, fake CLIs, temp project): the security gate on the new
// routes, the capability status and write-check endpoints, plan validation and the approve / edit / reject flow with
// its revision and hash guards, the unchanged Debate and Propose -> Review routes, and a workflow made from a finished
// council (councilId). No real CLI is started.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, waitFor, startApp, request, testWithFake, teardown, sleep } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { validatePlan, planHash } = require('../src/workflows/plan-model');

const GOAL = 'Ship the config loader and its routes';
let dir, project, fake, ctx, ids;

before(async () => {
  dir = tmpDir('ob-plan-api-'); project = path.join(dir, 'project'); fs.mkdirSync(project);
  fake = setupFakeCli(dir);
  ctx = await startApp({ projectDir: project });
  ids = {};
  for (const s of [
    { name: 'Mgr', role: 'Manager', agent: 'claude', model: 'claude-opus-5-5', effort: 'high', perm: 'read' },
    { name: 'Ada', role: 'Architect', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', perm: 'read' },
    { name: 'Bob', role: "Devil's advocate", agent: 'codex', model: 'gpt-6-luna', effort: 'medium', perm: 'read' },
  ]) {
    const res = await ctx.post('/api/seats', s);
    assert.equal(res.status, 200);
    ids[s.name] = res.json.id;
  }
});
after(() => teardown(ctx, dir));

const item = (over = {}) => ({ id: 'config', title: 'Config loader', spec: 'Load the config file.', owns: ['src/config.js'], dependsOn: [], difficulty: 'easy', seatId: null, ...over });
const rawPlan = (over = {}) => ({
  goal: GOAL,
  items: [
    item(),
    item({ id: 'routes', title: 'Plan routes', spec: 'Add the plan routes.', owns: ['src/server.js', 'test/routes.test.js'], dependsOn: ['config'], difficulty: 'medium' }),
  ],
  ...over,
});
const fenced = (obj) => '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
const PLAN_REPLY = fenced(rawPlan());
const finished = (roomId, statuses) => waitFor(async () => {
  const r = await ctx.room(roomId);
  return r && statuses.includes(r.status) ? r : null;
}, { timeout: 20000, what: `room ${roomId} to reach ${statuses.join('/')}` });
const ZERO_HASH = '0'.repeat(64);

test('(a) every new route without the session cookie is 401; a POST without JSON content type is 415', async () => {
  const anon = (method, p, body) => request(ctx.port, method, p, body === undefined ? {} : { body });
  for (const [method, p, body] of [
    ['GET', '/api/capability'],
    ['POST', '/api/capability/verify', { seatId: ids.Ada }],
    ['POST', '/api/plan', { goal: GOAL, managerId: ids.Mgr }],
    ['POST', '/api/plan/abc/approve', { revision: 1, hash: ZERO_HASH }],
    ['POST', '/api/plan/abc/edit', { revision: 1, hash: ZERO_HASH, plan: rawPlan() }],
    ['POST', '/api/plan/abc/reject', { revision: 1, hash: ZERO_HASH }],
  ]) {
    const res = await anon(method, p, body);
    assert.equal(res.status, 401, `${method} ${p} without a cookie`);
  }
  const text = await request(ctx.port, 'POST', '/api/plan', { body: JSON.stringify({ goal: GOAL, managerId: ids.Mgr }), headers: { 'content-type': 'text/plain' }, cookie: ctx.cookie });
  assert.equal(text.status, 415);
  const textVerify = await request(ctx.port, 'POST', '/api/capability/verify', { body: 'seatId=x', headers: { 'content-type': 'text/plain' }, cookie: ctx.cookie });
  assert.equal(textVerify.status, 415);
});

test('(b) GET /api/capability on a folder that is not a git repository: writes unavailable with the repository reason; /api/state carries capability', async () => {
  const res = await ctx.get('/api/capability');
  assert.equal(res.status, 200);
  assert.equal(res.json.writes, 'unavailable');
  assert.equal(res.json.repo.ok, false);
  assert.equal(res.json.repo.reason, 'the project folder is not a git repository');
  assert.equal(res.json.reason, 'the project folder is not a git repository');
  assert.ok(res.json.agents && res.json.agents.claude && res.json.agents.codex, 'per-CLI status is listed');
  assert.ok(res.json.checkedAt);

  const state = await ctx.state();
  assert.ok('capability' in state, '/api/state has a capability field');
  assert.equal(state.capability.writes, 'unavailable');
});

test('(c) POST /api/plan validation: goal, manager, single participant and overrides are refused with 400 and the board messages', async () => {
  const post = (b) => ctx.post('/api/plan', b);
  let r = await post({ managerId: ids.Mgr, seatIds: [] });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Write a goal');
  r = await post({ goal: GOAL, seatIds: [] });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Pick a manager agent');
  r = await post({ goal: GOAL, seatIds: [], managerId: 'nobody-here' });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Pick a manager agent');
  r = await post({ goal: GOAL, seatIds: [ids.Ada], managerId: ids.Mgr });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Pick at least 2 debate participants, or none to let the manager plan alone');
  r = await post({ goal: GOAL, seatIds: [], managerId: ids.Mgr, overrides: 'nope' });
  assert.equal(r.status, 400); assert.match(r.json.error, /overrides must be an object/);
  r = await post({ goal: GOAL, seatIds: [], managerId: ids.Mgr, overrides: { [ids.Mgr]: { model: 'bad model!' } } });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'invalid model name');
  r = await post({ goal: GOAL, seatIds: [], managerId: ids.Mgr, rounds: 9 });
  assert.equal(r.status, 400); assert.match(r.json.error, /rounds must be between 1 and 5/);
});

testWithFake(fake, '(d) plan flow: approve with a wrong hash is stale (409); the right hash approves; edit clears the approval; reject; unknown id 404; malformed hash 400', async () => {
  fake.resetCalls();
  fake.scenario({ rules: [{ seat: 'Mgr', reply: PLAN_REPLY }] });
  const start = await ctx.post('/api/plan', { goal: GOAL, seatIds: [], managerId: ids.Mgr, rounds: 1 });
  assert.equal(start.status, 200);
  const roomId = start.json.roomId;
  const room = await finished(roomId, ['awaiting-approval', 'error']);
  assert.equal(room.status, 'awaiting-approval');
  assert.equal(room.kind, 'plan');
  const hash = planHash(validatePlan(rawPlan()));
  assert.equal(room.planHash, hash);
  assert.equal(room.planRevision, 1);

  // Stale: a wrong hash and a wrong revision are both refused, and nothing changes.
  let r = await ctx.post(`/api/plan/${roomId}/approve`, { revision: 1, hash: ZERO_HASH });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'stale');
  r = await ctx.post(`/api/plan/${roomId}/approve`, { revision: 2, hash });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'stale');
  assert.equal((await ctx.room(roomId)).status, 'awaiting-approval');

  // Malformed input: 400 before the room is touched.
  r = await ctx.post(`/api/plan/${roomId}/approve`, { revision: 1, hash: 'not-a-hash' });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'hash must be a sha256 hex string');
  r = await ctx.post(`/api/plan/${roomId}/approve`, { hash });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'revision is required');
  r = await ctx.post(`/api/plan/${roomId}/approve`, { revision: 1, hash, plan: 'text' });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'plan must be an object');

  // Right hash: approved, and the decision is in the state.
  r = await ctx.post(`/api/plan/${roomId}/approve`, { revision: 1, hash });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.approval.decision, 'approved');
  assert.equal(r.json.approval.hash, hash);
  let cur = await ctx.room(roomId);
  assert.equal(cur.status, 'approved');
  assert.equal(cur.approval.decision, 'approved');

  // Edit after approval: a new revision by the user, the approval is cleared, status back to awaiting-approval.
  const edited = rawPlan({ items: [item({ spec: 'Load the config file, strictly.' }), rawPlan().items[1]] });
  r = await ctx.post(`/api/plan/${roomId}/edit`, { revision: 1, hash, plan: edited });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.revision, 2);
  assert.equal(r.json.hash, planHash(validatePlan(edited)));
  cur = await ctx.room(roomId);
  assert.equal(cur.approval, null);
  assert.equal(cur.status, 'awaiting-approval');
  assert.equal(cur.planRevision, 2);
  r = await ctx.post(`/api/plan/${roomId}/edit`, { revision: 2, hash: r.json.hash });
  assert.equal(r.status, 400, 'an edit without a plan body is refused');

  // Reject the current revision with a note.
  r = await ctx.post(`/api/plan/${roomId}/reject`, { revision: 2, hash: planHash(validatePlan(edited)), note: 'not yet' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  cur = await ctx.room(roomId);
  assert.equal(cur.status, 'rejected');
  assert.equal(cur.approval.decision, 'rejected');
  assert.equal(cur.approval.note, 'not yet');

  // Unknown plan id.
  r = await ctx.post('/api/plan/no-such-plan/approve', { revision: 1, hash });
  assert.equal(r.status, 404); assert.equal(r.json.code, 'no-plan');
  r = await ctx.post('/api/plan/no-such-plan/reject', { revision: 1, hash });
  assert.equal(r.status, 404); assert.equal(r.json.code, 'no-plan');
});

test('(e) POST /api/capability/verify: an unknown seat is 404; a malformed or missing seat id is 400', async () => {
  let r = await ctx.post('/api/capability/verify', { seatId: 'nobody-here' });
  assert.equal(r.status, 404); assert.equal(r.json.error, 'no such agent');
  r = await ctx.post('/api/capability/verify', { seatId: 'bad id!' });
  assert.equal(r.status, 400);
  r = await ctx.post('/api/capability/verify', {});
  assert.equal(r.status, 400); assert.equal(r.json.error, 'seatId is required');
});

testWithFake(fake, '(e2) POST /api/capability/verify: a write check that ends in error is broadcast with its reason and records nothing', async () => {
  fake.resetCalls();
  fake.scenario({ rules: [{ seat: 'Ada', match: 'Board write check', error: 'simulated check failure' }] });
  const stream = await ctx.sse();
  try {
    const r = await ctx.post('/api/capability/verify', { seatId: ids.Ada });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, started: true });
    const ev = await stream.waitFor((e) => e.t === 'capability' && typeof e.error === 'string', { timeout: 20000 });
    assert.ok(ev.error.length > 0, 'the error event carries a reason');
    assert.ok(ev.capability && ev.capability.writes === 'unavailable', 'the event carries the cached capability status');
    // An 'error' never overwrites a verdict: nothing is recorded for the CLI (records are per user, never in the project).
    const file = path.join(ctx.recordsDir, 'capability.json');
    if (fs.existsSync(file)) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents?.claude ?? null, null);
    assert.equal(fs.existsSync(path.join(project, '.orchestra', 'capability.json')), false);
    // The check has ended: a new one is accepted (it errors the same way) instead of 409 busy.
    const again = await ctx.post('/api/capability/verify', { seatId: ids.Ada });
    assert.equal(again.status, 200);
    await waitFor(() => stream.of('capability').filter((e) => typeof e.error === 'string').length >= 2 || null, { timeout: 20000, what: 'second error event' });
  } finally {
    stream.close?.();
  }
});

testWithFake(fake, '(e3) POST /api/capability/verify for a Codex seat: 409 unsupported-platform, no fake call, nothing recorded', async () => {
  fake.resetCalls();
  fake.scenario({ default: { reply: 'should never run' } });
  const file = path.join(ctx.recordsDir, 'capability.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const stream = await ctx.sse();
  try {
    const r = await ctx.post('/api/capability/verify', { seatId: ids.Bob });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'unsupported-platform');
    assert.match(r.json.error, /^off: /, 'the platform reason is returned');
    await sleep(300);
    assert.equal(fake.calls().length, 0, 'no CLI was started');
    assert.equal(stream.of('capability').filter((e) => typeof e.error === 'string').length, 0, 'no check ran, so no check error is broadcast');
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before, 'nothing recorded');
    const cap = (await ctx.get('/api/capability')).json;
    assert.equal(cap.agents.codex.available, false);
    assert.equal(cap.agents.codex.verifiable, false);
    assert.equal(cap.agents.codex.code, 'repo', 'this project is not a git repository: the repository check comes first in the status');
  } finally {
    stream.close?.();
  }
});

const ADA = { name: 'Ada', role: 'Architect', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', perm: 'read' };
test('(e4) model names that look like flags are refused on the seat and the session override routes', async () => {
  for (const model of ['--add-dir', '-x']) {
    let r = await ctx.post('/api/seats', { name: 'Flag', agent: 'claude', model, perm: 'read' });
    assert.equal(r.status, 400, model); assert.equal(r.json.error, 'invalid model name');
    r = await ctx.post('/api/plan', { goal: GOAL, seatIds: [], managerId: ids.Mgr, overrides: { [ids.Mgr]: { model } } });
    assert.equal(r.status, 400, model); assert.equal(r.json.error, 'invalid model name');
  }
  for (const model of ['claude-haiku-5-5', 'opus[1m]']) {
    const r = await ctx.post('/api/seats', { ...ADA, id: ids.Ada, model });
    assert.equal(r.status, 200, model); assert.equal(r.json.model, model);
  }
  assert.equal((await ctx.post('/api/seats', { ...ADA, id: ids.Ada })).json.model, 'claude-sonnet-5-5');
});

testWithFake(fake, '(f) Debate and Propose -> Review still run end to end through the HTTP routes', async () => {
  fake.resetCalls();
  fake.scenario({
    rules: [
      { seat: 'Ada', match: 'Round 1 of 1', reply: 'Idea A: split the loader.' },
      { seat: 'Bob', match: 'Round 1 of 1', reply: 'Idea B: one file.' },
      { seat: 'Ada', nth: 2, reply: 'Proposal: add the loader in src/config.js.' },
      { seat: 'Bob', nth: 2, reply: 'No blockers.\nVERDICT: PASS' },
    ],
  });
  const debate = await ctx.post('/api/meeting', { seatIds: [ids.Ada, ids.Bob], topic: 'Where should the loader live?', rounds: 1 });
  assert.equal(debate.status, 200);
  const d = await finished(debate.json.roomId, ['done', 'error', 'stopped']);
  assert.equal(d.status, 'done');

  const chain = await ctx.post('/api/chain', { task: 'Add the config loader', builderId: ids.Ada, reviewerId: ids.Bob, maxRounds: 1 });
  assert.equal(chain.status, 200);
  const c = await finished(chain.json.roomId, ['passed', 'needs-you', 'error', 'stopped']);
  assert.equal(c.status, 'passed');
});

// Council to Workflow (F9): a plan made from a finished council takes the council's synthesis as its context and runs no
// debate of its own.
const COUNCIL_SYNTHESIS = 'Synthesis: keep the loader in src/config.js and give the routes their own file.';
testWithFake(fake, '(g) Council to Workflow: the synthesis is in the manager prompt, zero debate turns run, and seatIds is ignored', async () => {
  fake.resetCalls();
  fake.scenario({
    rules: [
      { seat: 'Ada', match: 'Round 1 of 1', reply: 'Idea A: split the loader from the routes.' },
      { seat: 'Bob', match: 'Round 1 of 1', reply: 'Idea B: keep the loader in one file.' },
      { seat: 'Ada', match: 'You are the facilitator', reply: COUNCIL_SYNTHESIS },
      { seat: 'Mgr', match: 'Turn this goal', reply: PLAN_REPLY },
    ],
  });
  const council = await ctx.post('/api/meeting', { seatIds: [ids.Ada, ids.Bob], topic: 'How should the loader be split?', rounds: 1, synthId: ids.Ada });
  assert.equal(council.status, 200);
  const done = await finished(council.json.roomId, ['done', 'error', 'stopped']);
  assert.equal(done.status, 'done');
  assert.ok(done.resultId, 'the council has its synthesis');

  // Participants are sent on purpose: a workflow from a council has none, so no debate turn can run.
  const before = fake.calls().length;
  const start = await ctx.post('/api/plan', { goal: GOAL, seatIds: [ids.Ada, ids.Bob], managerId: ids.Mgr, councilId: council.json.roomId });
  assert.equal(start.status, 200);
  const room = await finished(start.json.roomId, ['awaiting-approval', 'error']);
  assert.equal(room.status, 'awaiting-approval');
  assert.equal(room.councilId, council.json.roomId);
  assert.deepEqual(room.seatIds, []);
  assert.equal(room.planRevision, 1);
  assert.ok(!room.messages.some((m) => m.seatId === ids.Ada || m.seatId === ids.Bob), 'no debate messages in the workflow');

  const calls = fake.calls().slice(before);
  assert.deepEqual(calls.map((c) => c.seat), ['Mgr'], 'only the manager is called: zero debate turns');
  assert.ok(calls[0].stdin.includes('Debate synthesis:\n' + COUNCIL_SYNTHESIS), 'the council synthesis is in the manager prompt');
});

testWithFake(fake, '(h) Council to Workflow refusals: no-council (400) for a missing, non-council or deleted council; council-not-done (409) while it runs; refused requests create no room', async () => {
  fake.resetCalls();
  fake.scenario({
    rules: [
      { seat: 'Ada', match: 'Round 1 of 1', reply: 'Idea A: held until the gate opens.', gate: 'council-hold' },
      { seat: 'Bob', match: 'Round 1 of 1', reply: 'Idea B: quick.' },
      { seat: 'Mgr', match: 'Turn this goal', reply: PLAN_REPLY },
    ],
  });
  const council = await ctx.post('/api/meeting', { seatIds: [ids.Ada, ids.Bob], topic: 'A council that is still running', rounds: 1 });
  assert.equal(council.status, 200);
  const councilId = council.json.roomId;
  await waitFor(() => fake.calls().some((c) => c.seat === 'Ada') || null, { what: 'Ada to reach its held turn' });

  const workflowCount = async () => (await ctx.state()).roomIndex.filter((r) => r.kind === 'plan').length;
  const fromCouncil = (id) => ctx.post('/api/plan', { goal: GOAL, seatIds: [], managerId: ids.Mgr, councilId: id });
  const before = await workflowCount();

  // The council still runs: 409, and nothing is created.
  let r = await fromCouncil(councilId);
  assert.equal(r.status, 409); assert.equal(r.json.code, 'council-not-done');
  assert.equal(r.json.error, 'Only a finished council can become a workflow');
  // Missing, malformed or non-string ids: 400 no-council.
  for (const bad of ['no-such-council', 'bad id!', 42]) {
    r = await fromCouncil(bad);
    assert.equal(r.status, 400, String(bad)); assert.equal(r.json.code, 'no-council', String(bad));
    assert.equal(r.json.error, 'No such council');
  }
  assert.equal(await workflowCount(), before, 'refused requests create no workflow room');

  fake.openGate('council-hold');
  await finished(councilId, ['done', 'error', 'stopped']);

  // A workflow id is not a council.
  const plan = await ctx.post('/api/plan', { goal: GOAL, seatIds: [], managerId: ids.Mgr });
  assert.equal(plan.status, 200);
  await finished(plan.json.roomId, ['awaiting-approval', 'error']);
  r = await fromCouncil(plan.json.roomId);
  assert.equal(r.status, 400); assert.equal(r.json.code, 'no-council');

  // A deleted council is no council any more.
  assert.equal((await ctx.post(`/api/rooms/${councilId}/delete`)).status, 200);
  r = await fromCouncil(councilId);
  assert.equal(r.status, 400); assert.equal(r.json.code, 'no-council');
});
