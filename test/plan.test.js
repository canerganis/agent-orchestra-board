// Plan workflow on a temp project with fake CLIs: debate -> manager plan -> approve / edit / reject,
// the revision and hash guards, and what the room file keeps. No real CLI is started.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, startApp, testWithFake, teardown } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { createMeeting } = require('../src/workflows/meeting');
const { createPlan } = require('../src/workflows/plan');
const { validatePlan, planHash } = require('../src/workflows/plan-model');

const GOAL = 'Ship the config loader and its routes';
let dir, project, fake, ctx, plans, ids;

before(async () => {
  dir = tmpDir('ob-plan-'); project = path.join(dir, 'project'); fs.mkdirSync(project);
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
  const meeting = createMeeting({ store: ctx.app.store, seats: ctx.app.seats, rooms: ctx.app.rooms, settings: ctx.app.settings });
  plans = createPlan({ store: ctx.app.store, seats: ctx.app.seats, rooms: ctx.app.rooms, meeting });
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

// A plan room with the same shape the server creates for POST /api/plan.
function newPlanRoom(over = {}) {
  return ctx.app.rooms.newRoom('plan', 'Plan test', {
    goal: GOAL, topic: GOAL, seatIds: [], rounds: 1, scoutId: null, synthId: null, managerId: ids.Mgr,
    withContext: false, overrides: {}, phase: 'debate', plan: null, planRevision: 0, planHash: null,
    revisions: [], approval: null, buildIds: [], ...over,
  });
}
const throwsStatus = async (fn, status, code) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected an error');
  assert.equal(err.status, status);
  if (code !== undefined) assert.equal(err.code, code);
  return err;
};

testWithFake(fake, '(a) a debate of two seats, then a valid fenced plan: awaiting-approval, revision 1, hash of the validated plan', async () => {
  fake.resetCalls();
  fake.scenario({
    rules: [
      { seat: 'Ada', match: 'Round 1 of 1', reply: 'Idea A: split the loader from the routes.' },
      { seat: 'Bob', match: 'Round 1 of 1', reply: 'Idea B: keep the loader in one file.' },
      { seat: 'Mgr', match: 'Turn this goal', reply: PLAN_REPLY },
    ],
  });
  const room = newPlanRoom({ seatIds: [ids.Ada, ids.Bob] });
  await plans.runPlan(room);

  assert.equal(room.status, 'awaiting-approval');
  assert.equal(room.planRevision, 1);
  assert.equal(room.planHash, planHash(validatePlan(rawPlan())));
  assert.equal(room.planHash, planHash(room.plan));
  assert.equal(room.revisions.length, 1);
  assert.equal(room.revisions[0].by, 'manager');
  assert.equal(room.round, 'plan');

  const calls = fake.calls();
  assert.equal(calls.filter((c) => /Round 1 of 1/.test(c.stdin)).length, 2, 'both seats debated');
  const mgr = calls.filter((c) => c.seat === 'Mgr');
  assert.equal(mgr.length, 1, 'the manager is called once when the plan is valid');
  assert.ok(mgr[0].stdin.includes('difficulty'), 'the manager prompt carries the plan format');
  assert.ok(mgr[0].stdin.includes('Debate notes'), 'the manager prompt carries the debate notes');
  assert.ok(mgr[0].stdin.includes('Idea A: split the loader from the routes.'));
});

testWithFake(fake, '(b) seatIds [] runs no debate: only the manager is called', async () => {
  fake.resetCalls();
  fake.scenario({ rules: [{ seat: 'Mgr', reply: PLAN_REPLY }] });
  const room = newPlanRoom({ seatIds: [] });
  await plans.runPlan(room);

  assert.equal(room.status, 'awaiting-approval');
  assert.equal(room.planRevision, 1);
  const calls = fake.calls();
  assert.equal(calls.length, 1, 'one call in total');
  assert.equal(calls[0].seat, 'Mgr');
  assert.ok(!room.messages.some((m) => m.seatId === ids.Ada || m.seatId === ids.Bob), 'no debate messages');
});

testWithFake(fake, '(c) first reply invalid, second valid: two manager calls, revision 1; invalid twice: status error', async () => {
  fake.resetCalls();
  fake.scenario({
    rules: [
      { seat: 'Mgr', nth: 1, reply: 'Here is my plan in prose, with no JSON.' },
      { seat: 'Mgr', nth: 2, reply: PLAN_REPLY },
    ],
  });
  const room = newPlanRoom({ seatIds: [] });
  await plans.runPlan(room);

  assert.equal(room.status, 'awaiting-approval');
  assert.equal(room.planRevision, 1);
  const mgr = fake.calls().filter((c) => c.seat === 'Mgr');
  assert.equal(mgr.length, 2, 'the repair turn is the second manager call');
  assert.ok(mgr[1].stdin.includes('Your plan could not be used:'), 'the repair prompt explains the failure');
  assert.ok(mgr[1].stdin.includes('no JSON object found in the reply'));

  fake.resetCalls();
  fake.scenario({
    rules: [{ seat: 'Mgr', reply: fenced({ goal: 'g', items: [] }) }],
  });
  const bad = newPlanRoom({ seatIds: [] });
  await plans.runPlan(bad);
  assert.equal(bad.status, 'error');
  assert.equal(bad.planRevision, 0);
  assert.equal(bad.plan, null);
  assert.equal(fake.calls().filter((c) => c.seat === 'Mgr').length, 2, 'exactly MAX_PLAN_TURNS tries');
  assert.ok(bad.messages.some((m) => /still invalid after 2 tries/.test(m.text)));
});

testWithFake(fake, '(d) approve: a wrong hash is stale (409); the current hash approves the revision', async () => {
  fake.resetCalls();
  fake.scenario({ rules: [{ seat: 'Mgr', reply: PLAN_REPLY }] });
  const room = newPlanRoom({ seatIds: [] });
  await plans.runPlan(room);

  const wrong = '0'.repeat(64);
  await throwsStatus(() => plans.approvePlan(room, { revision: 1, hash: wrong }), 409, 'stale');
  await throwsStatus(() => plans.approvePlan(room, { revision: 2, hash: room.planHash }), 409, 'stale');
  assert.equal(room.status, 'awaiting-approval', 'a stale approval changes nothing');
  assert.equal(room.approval, null);

  const approval = plans.approvePlan(room, { revision: 1, hash: room.planHash });
  assert.equal(room.status, 'approved');
  assert.equal(approval.decision, 'approved');
  assert.equal(approval.revision, 1);
  assert.equal(approval.hash, room.planHash);
  assert.equal(plans.isApproved(room, room.planHash), true);
  assert.equal(plans.isApproved(room, wrong), false);
});

testWithFake(fake, '(e) edit after approval: new revision by the user, approval cleared; approve an edited body: a new approved revision', async () => {
  fake.resetCalls();
  fake.scenario({ rules: [{ seat: 'Mgr', reply: PLAN_REPLY }] });
  const room = newPlanRoom({ seatIds: [] });
  await plans.runPlan(room);
  const oldHash = room.planHash;
  plans.approvePlan(room, { revision: 1, hash: oldHash });
  assert.equal(plans.isApproved(room, oldHash), true);

  const edited = rawPlan({ items: [item({ spec: 'Load the config file, strictly.' }), rawPlan().items[1]] });
  const edit = plans.editPlan(room, { revision: 1, hash: oldHash, plan: edited });
  assert.equal(edit.revision, 2);
  assert.equal(room.planRevision, 2);
  assert.notEqual(room.planHash, oldHash);
  assert.equal(room.approval, null);
  assert.equal(room.status, 'awaiting-approval');
  assert.equal(room.revisions[1].by, 'user');
  assert.equal(plans.isApproved(room, oldHash), false, 'the old approval no longer counts');

  await throwsStatus(() => plans.editPlan(room, { revision: 2, hash: room.planHash, plan: edited }), 400, 'no-changes');
  await throwsStatus(() => plans.editPlan(room, { revision: 2, hash: room.planHash }), 400);

  const edited2 = rawPlan({ items: [item({ spec: 'Load the config file, strictly and fast.' }), rawPlan().items[1]] });
  const approval = plans.approvePlan(room, { revision: 2, hash: room.planHash, plan: edited2 });
  assert.equal(room.planRevision, 3, 'approving an edited body saves it as a new revision');
  assert.equal(room.revisions[2].by, 'user');
  assert.equal(room.status, 'approved');
  assert.equal(approval.revision, 3);
  assert.equal(plans.isApproved(room, room.planHash), true);
});

testWithFake(fake, '(f) reject records decision rejected with the note and blocks approval', async () => {
  fake.resetCalls();
  fake.scenario({ rules: [{ seat: 'Mgr', reply: PLAN_REPLY }] });
  const room = newPlanRoom({ seatIds: [] });
  await plans.runPlan(room);

  assert.deepEqual(plans.rejectPlan(room, { revision: 1, hash: room.planHash, note: 'too big' }), { ok: true });
  assert.equal(room.status, 'rejected');
  assert.equal(room.approval.decision, 'rejected');
  assert.equal(room.approval.note, 'too big');
  assert.equal(room.approval.revision, 1);
  assert.equal(plans.isApproved(room, room.planHash), false);
  assert.ok(room.messages.some((m) => m.text === 'You rejected this plan. Note: too big'));
});

testWithFake(fake, '(g) the room file keeps plan, planHash and approval', async () => {
  fake.resetCalls();
  fake.scenario({ rules: [{ seat: 'Mgr', reply: PLAN_REPLY }] });
  const room = newPlanRoom({ seatIds: [] });
  await plans.runPlan(room);
  plans.approvePlan(room, { revision: 1, hash: room.planHash });

  const file = path.join(ctx.app.store.roomDir, room.id + '.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.kind, 'plan');
  assert.equal(saved.planRevision, 1);
  assert.equal(saved.planHash, room.planHash);
  assert.deepEqual(saved.plan, validatePlan(rawPlan()));
  assert.equal(saved.approval.decision, 'approved');
  assert.equal(saved.approval.hash, room.planHash);
  assert.equal(saved.status, 'approved');
});

testWithFake(fake, '(h) a plan that is still running cannot be approved (409 not-ready)', async () => {
  const room = newPlanRoom({ seatIds: [] });
  assert.equal(room.status, 'running');
  await throwsStatus(() => plans.approvePlan(room, { revision: 0, hash: null }), 409, 'not-ready');
  await throwsStatus(() => plans.editPlan(room, { revision: 0, hash: null, plan: rawPlan() }), 409, 'not-ready');
  await throwsStatus(() => plans.rejectPlan(room, { revision: 0, hash: null }), 409, 'not-ready');
});

