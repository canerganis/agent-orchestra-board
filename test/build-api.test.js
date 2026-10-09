// HTTP surface of the build workflow on a live server (in-process, fake CLIs that really write files, a
// temp git project): start validation (stale approval, roles, bad input, a dirty checkout), a happy path with reviewed
// proposals and their view, the apply path (dependency order, stale hashes, the user's own commits, base-changed),
// discard, room delete cleanup, reconnect state, pause and resume over HTTP, and the auth and item-id gates of the new
// routes. No real CLI is started; the write check runs against the fake.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, waitFor, startApp, request, teardown, hasGit, initRepo, gitIn, samePath, exitGuard } = require('./helpers');
exitGuard();
const { setupFakeCli } = require('./fake-cli');
const { validatePlan, planHash } = require('../src/workflows/plan-model');

const GOAL = 'Build the a and b modules over HTTP';
const ZERO = '0'.repeat(64);
const COMMIT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q'];
const ITEMS = [
  { id: 'a', title: 'Module a', spec: 'Create the module a file under src/a.', owns: ['src/a'], dependsOn: [], difficulty: 'easy', seatId: null },
  { id: 'b', title: 'Module b', spec: 'Create the module b file under src/b.', owns: ['src/b'], dependsOn: ['a'], difficulty: 'medium', seatId: null },
];
const PLAN_REPLY = '```json\n' + JSON.stringify({ goal: GOAL, items: ITEMS }, null, 2) + '\n```';

// Fake rules (first match wins). The write check and the plan are matched by their prompts. Mgr builds both items
// (the manager role; easy and medium fall back to it) and Rev reviews every item and passes it.
// Writes inside its worktree and reports both outside attempts of the write check as refused (plan 5.8: a pass needs
// proof of an attempt). The paths are relative to the check worktree <scratch>/repo/.orchestra/worktrees/check/item.
const WELL_BEHAVED = {
  match: 'Board write check', writeFiles: [{ path: 'WRITE_CHECK_INSIDE.txt' }], reply: 'STEP 1: done\nSTEP 2: refused\nSTEP 3: refused',
  toolUses: [{ name: 'Write', file_path: '../../../../WRITE_CHECK_OUTSIDE.txt', error: 'refused' }, { name: 'Write', file_path: '../../../../../outside/WRITE_CHECK_SIBLING.txt', error: 'refused' }],
};
const PLAN_RULE = { seat: 'Mgr', match: 'Turn this goal into a build plan', reply: PLAN_REPLY };
const REVIEW_PASS = { seat: 'Rev', reply: 'Looks right.\nVERDICT: PASS' };
// A builder turn for one item that creates one file (its content is unique to the file, so every build changes it).
const writer = (item, file, extra = {}) => ({
  seat: 'Mgr', match: `Build item "${item}"`, writeFiles: [{ path: file, content: `module.exports = ${JSON.stringify(file)};\n` }], reply: `Added ${file}.`, ...extra,
});

let dir, project, fake, ctx, PLAN = null, BUILD = null, BUILD2 = null;

const skipWhy = () => (!hasGit && 'git not available') || fake.skipReason || false;
// Every test needs git and the fake CLI; the fake is only known after before() ran, so it is checked inside.
const t = (name, fn) => test(name, { timeout: 120000, skip: !hasGit && 'git not available' }, async (tc) => {
  const why = skipWhy();
  if (why) { if (process.env.GITHUB_ACTIONS && fake.skipReason) throw new Error(`fake CLI unavailable on CI: ${why}`); tc.skip(why); return; }
  fake.resetCalls();
  await fn(tc);
});

const scenario = (...rules) => fake.scenario([WELL_BEHAVED, PLAN_RULE, REVIEW_PASS, ...rules]);
const waitRoom = (id, statuses) => waitFor(async () => {
  const r = await ctx.room(id);
  return r && statuses.includes(r.status) ? r : null;
}, { timeout: 60000, what: `build ${id} to reach ${statuses.join(' or ')}` });
// POST /api/build body for the approved plan; overrides replace single fields (undefined drops a field).
const body = (over = {}) => ({ planRoomId: PLAN.id, revision: PLAN.revision, hash: PLAN.hash, roles: { manager: 'mgr', reviewer: 'rev' }, maxRounds: 2, ...over });
const startBuild = (over) => ctx.post('/api/build', body(over));
// The user's own commit in the project (what the user does with an applied change).
const commitAll = (msg) => gitIn(project, [...COMMIT, '-m', msg]);

before(async () => {
  dir = tmpDir('ob-build-api-');
  fake = setupFakeCli(dir);
  if (skipWhy()) return;
  project = path.join(dir, 'project');
  initRepo(project, { 'README.md': 'hello\n', 'src/keep.js': 'module.exports = 0;\n' });
  ctx = await startApp({ projectDir: project });
  for (const s of [
    { name: 'Mgr', role: 'Manager', agent: 'claude', effort: 'low', perm: 'write' },
    { name: 'Rev', role: 'Reviewer', agent: 'codex', effort: 'low', perm: 'read' },
  ]) {
    const res = await ctx.post('/api/seats', s);
    assert.equal(res.status, 200, res.text);
  }

  // Write check for Mgr, started from the API: the well-behaved fake writes only inside its worktree.
  const events = await ctx.sse();
  try {
    fake.scenario([WELL_BEHAVED]);
    const r = await ctx.post('/api/capability/verify', { seatId: 'mgr' });
    assert.equal(r.status, 200, r.text);
    const ev = await events.waitFor((e) => e.t === 'capability' && e.capability?.agents?.claude?.available === true, { timeout: 60000 });
    assert.equal(ev.capability.agents.claude.available, true);
  } finally { events.close(); }

  // An approved plan, manager only (no debate): item a, then item b which depends on a.
  fake.scenario([WELL_BEHAVED, PLAN_RULE, REVIEW_PASS]);
  const start = await ctx.post('/api/plan', { goal: GOAL, seatIds: [], managerId: 'mgr', rounds: 1 });
  assert.equal(start.status, 200, start.text);
  const pr = await waitFor(async () => {
    const r = await ctx.room(start.json.roomId);
    return r && ['awaiting-approval', 'error'].includes(r.status) ? r : null;
  }, { timeout: 60000, what: 'the plan' });
  assert.equal(pr.status, 'awaiting-approval', 'the manager produced a plan');
  assert.equal(pr.planHash, planHash(validatePlan({ goal: GOAL, items: ITEMS })));
  const ap = await ctx.post(`/api/plan/${pr.id}/approve`, { revision: pr.planRevision, hash: pr.planHash });
  assert.equal(ap.status, 200, ap.text);
  PLAN = { id: pr.id, revision: pr.planRevision, hash: pr.planHash };
}, { timeout: 240000 });
after(() => teardown(ctx, dir), { timeout: 90000 });

t('(a) start refuses a stale approval (409), bad roles and input (400), a missing plan (404) and a dirty checkout (409)', async () => {
  scenario();
  let r = await startBuild({ hash: ZERO });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'not-approved');
  r = await startBuild({ revision: PLAN.revision + 1 });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'not-approved');
  r = await startBuild({ planRoomId: 'no-such-plan' });
  assert.equal(r.status, 404); assert.equal(r.json.error, 'no such plan');
  r = await startBuild({ roles: {} });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'assign an agent to at least one role');
  r = await startBuild({ roles: undefined });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'assign an agent to at least one role');
  r = await startBuild({ roles: { manager: 'no-such-agent' } });
  assert.equal(r.status, 400); assert.match(r.json.error, /no such agent/);
  r = await startBuild({ roles: 'mgr' });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'roles must be an object of agent ids');
  r = await startBuild({ roles: { manager: 'bad id!' } });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'roles must be an object of agent ids');
  r = await startBuild({ revision: undefined });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'revision is required');
  r = await startBuild({ hash: 'not-a-hash' });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'hash must be a sha256 hex string');
  r = await startBuild({ maxRounds: 9 });
  assert.equal(r.status, 400); assert.match(r.json.error, /maxRounds must be between 1 and 6/);
  r = await startBuild({ mode: 'bogus' });
  assert.equal(r.status, 400); assert.match(r.json.error, /mode must be one of/);
  r = await ctx.post('/api/build', { revision: 1, hash: PLAN.hash, roles: { manager: 'mgr' } });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'planRoomId is required');

  fs.writeFileSync(path.join(project, 'dirty.txt'), 'local edit\n');
  try {
    r = await startBuild();
    assert.equal(r.status, 409, r.text); assert.equal(r.json.code, 'checkout-dirty');
  } finally {
    fs.rmSync(path.join(project, 'dirty.txt'), { force: true });
  }
  assert.deepEqual(fake.calls(), [], 'no agent turn ran');
  assert.equal((await ctx.state()).rooms.some((x) => x.kind === 'build'), false, 'no build room was created');
});

t('(b) a write build passes both items with reviewed proposals; the proposal view and the SSE build events report it', async () => {
  scenario(writer('a', 'src/a/x.js'), writer('b', 'src/b/y.js'));
  const events = await ctx.sse();
  let room = null;
  try {
    const r = await startBuild();
    assert.equal(r.status, 200, r.text);
    BUILD = r.json.roomId;
    room = await waitRoom(BUILD, ['done', 'needs-you', 'error']);
    assert.equal(room.status, 'done', JSON.stringify(room.messages.slice(-1)));
    assert.equal(room.kind, 'build'); assert.equal(room.mode, 'write'); assert.equal(room.planRoomId, PLAN.id);
    for (const id of ['a', 'b']) {
      assert.equal(room.items[id].status, 'passed');
      assert.equal(room.items[id].review.verdict, 'pass');
      assert.equal(room.items[id].review.hash, room.items[id].proposal.hash);
    }
    assert.deepEqual(room.items.a.proposal.files, ['src/a/x.js']);
    await events.waitFor((e) => e.t === 'build' && e.roomId === BUILD && e.itemId === 'b' && e.item.status === 'passed', { timeout: 30000 });
    assert.ok(events.of('build').some((e) => e.roomId === BUILD && e.itemId === 'a' && e.item.status === 'passed'));
  } finally { events.close(); }
  assert.ok((await ctx.room(PLAN.id)).buildIds.includes(BUILD), 'the plan lists its build');

  const view = await ctx.get(`/api/build/${BUILD}/items/a/proposal`);
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json.itemId, 'a'); assert.equal(view.json.status, 'passed');
  assert.match(view.json.patch, /src\/a\/x\.js/);
  assert.equal(view.json.proposal.hash, room.items.a.proposal.hash);
  assert.equal(view.json.applicable.ok, true, JSON.stringify(view.json.applicable));
  assert.equal(view.json.truncated, false);
  assert.equal(fs.existsSync(path.join(project, 'src', 'a')), false, 'nothing reached the checkout before the user applies');

  assert.deepEqual((await ctx.get(`/api/build/${BUILD}/items/nope/proposal`)).json, { error: 'no such item' });
  const unknown = await ctx.get('/api/build/no-such-room/items/a/proposal');
  assert.equal(unknown.status, 404); assert.deepEqual(unknown.json, { error: 'no such build' });
  const notBuild = await ctx.get(`/api/build/${PLAN.id}/items/a/proposal`);
  assert.equal(notBuild.status, 404); assert.deepEqual(notBuild.json, { error: 'no such build' });
});

t('(c) apply: dependency order, stale hashes, staging a, the user commits, then b applies', async () => {
  const events = await ctx.sse();
  try {
    const room = await ctx.room(BUILD);
    const aHash = room.items.a.proposal.hash, bHash = room.items.b.proposal.hash;
    let r = await ctx.post(`/api/build/${BUILD}/items/b/apply`, { hash: bHash });
    assert.equal(r.status, 409); assert.equal(r.json.code, 'dependency-not-applied');
    r = await ctx.post(`/api/build/${BUILD}/items/a/apply`, { hash: ZERO });
    assert.equal(r.status, 409); assert.equal(r.json.code, 'stale-proposal');
    r = await ctx.post(`/api/build/${BUILD}/items/a/apply`, {});
    assert.equal(r.status, 400); assert.equal(r.json.error, 'hash must be a sha256 hex string');

    r = await ctx.post(`/api/build/${BUILD}/items/a/apply`, { hash: aHash });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.match(r.json.tree, /^[0-9a-f]{40,64}$/);
    assert.equal(gitIn(project, ['diff', '--cached', '--name-only']), 'src/a/x.js');
    await events.waitFor((e) => e.t === 'apply' && e.roomId === BUILD && e.itemId === 'a' && e.ok === true, { timeout: 30000 });
    assert.ok(events.of('apply').some((e) => e.itemId === 'b' && e.ok === false && e.code === 'dependency-not-applied'));

    commitAll('Add module a');
    r = await ctx.post(`/api/build/${BUILD}/items/b/apply`, { hash: bHash });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(gitIn(project, ['diff', '--cached', '--name-only']).split('\n'), ['src/b/y.js']);
    commitAll('Add module b');

    const after = await ctx.room(BUILD);
    assert.equal(after.items.a.status, 'applied'); assert.equal(after.items.b.status, 'applied');
    assert.deepEqual(after.applied, ['a', 'b']);
    assert.equal(fs.existsSync(path.join(project, 'src', 'a', 'x.js')), true);
    assert.equal(fs.existsSync(path.join(project, '.orchestra', 'worktrees', BUILD, 'a')), false, 'an applied worktree is removed');
  } finally { events.close(); }
  const again = await ctx.post(`/api/build/${BUILD}/items/a/discard`, {});
  assert.equal(again.status, 409); assert.equal(again.json.code, 'applied');
});

t('(d) a commit made after a build passed makes its approved change stale: base-changed, the item stays passed', async () => {
  scenario(writer('a', 'src/a/z.js'), writer('b', 'src/b/z.js'));
  const r = await startBuild();
  assert.equal(r.status, 200, r.text);
  BUILD2 = r.json.roomId;
  const room = await waitRoom(BUILD2, ['done', 'needs-you', 'error']);
  assert.equal(room.status, 'done');

  // The user commits after the build started: the approved base no longer matches the checkout.
  fs.appendFileSync(path.join(project, 'README.md'), 'changed by the user\n');
  gitIn(project, ['add', 'README.md']);
  commitAll('Edit the readme');
  const stale = await ctx.post(`/api/build/${BUILD2}/items/a/apply`, { hash: room.items.a.proposal.hash });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.code, 'base-changed');
  const after = await ctx.room(BUILD2);
  assert.equal(after.items.a.status, 'passed');
  assert.ok(fs.existsSync(path.join(ctx.app.store.orch, after.items.a.proposal.file)), 'the frozen proposal is kept');
});

t('(e) discard removes only that item worktree; git no longer lists it; the checkout is intact', async () => {
  const room = await ctx.room(BUILD2);
  const rel = room.items.a.worktree.rel;
  const abs = path.join(project, rel);
  assert.equal(fs.existsSync(abs), true, "a's worktree exists before the discard");
  const r = await ctx.post(`/api/build/${BUILD2}/items/a/discard`, {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(fs.existsSync(abs), false, "a's worktree is gone");
  const listed = gitIn(project, ['worktree', 'list', '--porcelain']).split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  assert.equal(listed.some((p) => samePath(p, abs)), false, 'git no longer lists it');
  assert.equal(listed.some((p) => samePath(p, path.join(project, room.items.b.worktree.rel))), true, "b's worktree is untouched");
  assert.equal((await ctx.room(BUILD2)).items.a.status, 'discarded');
  assert.equal(fs.existsSync(path.join(project, 'src', 'a', 'x.js')), true, 'the applied module is still there');
  assert.equal(fs.existsSync(path.join(project, 'src', 'keep.js')), true);
  assert.equal(fs.existsSync(path.join(project, 'README.md')), true);
});

t('(f0) deleting a build whose loop is still stopping answers 409 and removes nothing', async () => {
  const wtRoom = path.join(project, '.orchestra', 'worktrees', BUILD2);
  const propRoom = path.join(ctx.app.store.orch, 'proposals', BUILD2);
  const original = ctx.app.build.whenIdle;
  ctx.app.build.whenIdle = async () => false;
  try {
    const r = await ctx.post(`/api/rooms/${BUILD2}/delete`, {});
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'build-busy');
    assert.equal(fs.existsSync(wtRoom), true, 'the worktree is kept');
    assert.equal(fs.existsSync(propRoom), true, 'the proposals are kept');
    assert.notEqual(await ctx.room(BUILD2), undefined, 'the room is kept');
  } finally {
    ctx.app.build.whenIdle = original;
  }
});

t('(f) deleting a build removes its worktrees and proposals from .orchestra', async () => {
  const room = await ctx.room(BUILD2);
  const wtRoom = path.join(project, '.orchestra', 'worktrees', BUILD2);
  const propRoom = path.join(ctx.app.store.orch, 'proposals', BUILD2);
  assert.equal(fs.existsSync(wtRoom), true, "b's worktree is still there");
  assert.equal(fs.existsSync(propRoom), true, 'the frozen proposals are there');
  const r = await ctx.post(`/api/rooms/${BUILD2}/delete`, {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(fs.existsSync(wtRoom), false, 'the room worktrees are removed');
  assert.equal(fs.existsSync(propRoom), false, 'the room proposals are removed');
  assert.equal(await ctx.room(BUILD2), undefined, 'the room is gone from the state');
  assert.equal(room.status, 'done');
});

t('(g) reconnect: a new event stream starts with hello and /api/state carries the build with its items and the capability', async () => {
  const first = await ctx.sse();
  first.close();
  const again = await ctx.sse();
  try {
    assert.equal(again.events[0].t, 'hello');
    const st = await ctx.state();
    const room = st.rooms.find((x) => x.id === BUILD);
    assert.ok(room, 'the build room is in the snapshot');
    assert.equal(room.kind, 'build'); assert.equal(room.status, 'done');
    assert.deepEqual(Object.keys(room.items).sort(), ['a', 'b']);
    assert.equal(room.items.b.status, 'applied');
    assert.ok('capability' in st, '/api/state has a capability field');
    assert.equal(st.capability.agents.claude.available, true);
  } finally { again.close(); }
});

t('(h) pause and resume over HTTP while a builder waits on a gate', async () => {
  scenario(writer('a', 'src/a/h.js', { gate: 'h-a' }), writer('b', 'src/b/h.js'));
  const r = await startBuild();
  assert.equal(r.status, 200, r.text);
  const id = r.json.roomId;
  await fake.waitCalls((c) => c.seat === 'Mgr' && c.stdin.includes('Build item "a"'), 1, 30000);

  const paused = await ctx.post(`/api/build/${id}/pause`, {});
  assert.equal(paused.status, 200, paused.text);
  assert.deepEqual(paused.json, { ok: true });
  fake.openGate('h-a');
  const stopped = await waitRoom(id, ['paused']);
  assert.equal(stopped.items.a.status, 'passed');
  assert.equal(stopped.items.b.status, 'pending');

  const resumed = await ctx.post(`/api/build/${id}/resume`, {});
  assert.equal(resumed.status, 200, resumed.text);
  assert.deepEqual(resumed.json, { ok: true });
  const done = await waitRoom(id, ['done']);
  assert.equal(done.items.b.status, 'passed');

  const late = await ctx.post(`/api/build/${id}/pause`, {});
  assert.equal(late.status, 409); assert.equal(late.json.code, 'not-running');
});

t('(i) every new route is 401 without the session cookie; malformed item ids and unknown rooms are 404', async () => {
  const anon = (method, p, b) => request(ctx.port, method, p, b === undefined ? {} : { body: b });
  const pb = `/api/build/${BUILD}`;
  const cases = [
    ['GET', `${pb}/items/a/proposal`],
    ['POST', '/api/build', body()],
    ['POST', `${pb}/pause`, {}],
    ['POST', `${pb}/resume`, {}],
    ['POST', `${pb}/items/a/apply`, { hash: ZERO }],
    ['POST', `${pb}/items/a/discard`, {}],
  ];
  for (const [m, p, b] of cases) assert.equal((await anon(m, p, b)).status, 401, `${m} ${p} without a cookie`);

  for (const bad of ['Bad_Item', '-a', 'A', 'a'.repeat(33)]) {
    assert.equal((await ctx.get(`${pb}/items/${bad}/proposal`)).status, 404, `GET proposal of ${bad}`);
    assert.equal((await ctx.post(`${pb}/items/${bad}/apply`, { hash: ZERO })).status, 404, `apply of ${bad}`);
    assert.equal((await ctx.post(`${pb}/items/${bad}/discard`, {})).status, 404, `discard of ${bad}`);
  }
  for (const p of ['/api/build/no-such-room/pause', '/api/build/no-such-room/resume', `/api/build/${PLAN.id}/pause`]) {
    const res = await ctx.post(p, {});
    assert.equal(res.status, 404, p);
    assert.deepEqual(res.json, { error: 'no such build' }, p);
  }
});
