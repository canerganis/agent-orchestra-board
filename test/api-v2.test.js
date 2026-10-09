// HTTP surface of API v2 and the state fields added with it (plan F1), on a live in-process server with fake CLIs and a
// temp project: the security gate on every v2 route (401 without the cookie, 403 for a foreign Origin), unknown engines
// and the board start over HTTP (approval, options, a real build room), roomIndex and GET /api/rooms/:id, preflight in a
// folder that is not a repository and in one that is, the engine list broadcast after a doctor run, and the engine
// dispose on room delete. No real CLI is started: the doctor and the build call the fake.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, startApp, teardown, initRepo, hasGit } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { validatePlan } = require('../src/workflows/plan-model');

const GOAL = 'Split the config loader into two modules';
const ZERO = '0'.repeat(64);
const ITEMS = [{ id: 'config', title: 'Config loader', spec: 'Load the config file.', owns: ['src/config.js'], dependsOn: [], difficulty: 'easy', seatId: null }];
let dir, project, fake, ctx, mgrId = null;

before(async () => {
  dir = tmpDir('ob-api-v2-');
  fake = setupFakeCli(dir);
  project = path.join(dir, 'project');
  if (hasGit) initRepo(project, { 'README.md': 'hello\n' }); else fs.mkdirSync(project);
  ctx = await startApp({ projectDir: project });
  const res = await ctx.post('/api/seats', { name: 'Mgr', role: 'Manager', agent: 'claude', effort: 'low', perm: 'read' });
  assert.equal(res.status, 200, res.text);
  mgrId = res.json.id;
});
after(() => teardown(ctx, dir));

const skipWhy = () => (!hasGit && 'git not available') || fake.skipReason || false;
// Tests that need git and the fake CLI; the fake is only known after before() ran, so it is checked inside.
const t = (name, fn) => test(name, { timeout: 120000 }, async (tc) => {
  const why = skipWhy();
  if (why) { if (process.env.GITHUB_ACTIONS && fake.skipReason) throw new Error(`fake CLI unavailable on CI: ${why}`); tc.skip(why); return; }
  await fn(tc);
});

// A plan room the way runPlan leaves it, at revision 1. approve: true approves that revision through the plan API.
function makePlan(app, goal, { approve = false } = {}) {
  const room = app.rooms.newRoom('plan', goal.slice(0, 60), {
    goal, topic: goal, seatIds: [], rounds: 1, scoutId: null, synthId: null, managerId: null, withContext: false,
    overrides: {}, phase: 'plan', plan: null, planRevision: 0, planHash: null, revisions: [], approval: null, buildIds: [],
  });
  app.planApi.setRevision(room, validatePlan({ goal, items: ITEMS }), 'manager');
  room.status = 'awaiting-approval';
  if (approve) app.planApi.approvePlan(room, { revision: room.planRevision, hash: room.planHash });
  return room;
}

test('every v2 route sits behind the gate: 401 JSON without the session cookie; 403 for a foreign Origin with the cookie', async () => {
  for (const [method, p, body] of [['GET', '/api/preflight'], ['POST', '/api/run', { engine: 'board' }], ['GET', '/api/runs'], ['POST', '/api/ask', { text: 'x' }]]) {
    // The helper sends the session cookie unless the options say cookie: null.
    const r = await ctx.request(method, p, { cookie: null, ...(body ? { body } : {}) });
    assert.equal(r.status, 401, `${method} ${p} without the cookie`);
    assert.deepEqual(r.json, { error: 'unauthorized: open the URL printed at startup' });
  }
  for (const [method, p, body] of [['GET', '/api/preflight'], ['POST', '/api/run', { engine: 'board' }]]) {
    const r = await ctx.request(method, p, { headers: { origin: 'http://evil.example' }, ...(body ? { body } : {}) });
    assert.equal(r.status, 403, `${method} ${p} from a foreign origin`);
    assert.deepEqual(r.json, { error: 'forbidden origin' });
  }
});

test('POST /api/run: a missing or unknown engine is 400 (unknown-engine carries its code); a malformed revision, hash or options is 400', async () => {
  assert.equal((await ctx.post('/api/run', { planRoomId: 'x', revision: 1, hash: ZERO })).status, 400, 'no engine');
  const unknown = await ctx.post('/api/run', { engine: 'nope', planRoomId: 'x', revision: 1, hash: ZERO });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.json, { error: 'unknown engine: nope', code: 'unknown-engine' });
  assert.equal((await ctx.post('/api/run', { engine: 'board', planRoomId: 'x', hash: ZERO })).status, 400, 'no revision');
  assert.equal((await ctx.post('/api/run', { engine: 'board', planRoomId: 'x', revision: 1, hash: 'abc' })).status, 400, 'short hash');
  assert.equal((await ctx.post('/api/run', { engine: 'board', planRoomId: 'x', revision: 1, hash: ZERO, options: [] })).status, 400, 'options are an array');
});

test('POST /api/run board: a plan that is not approved at this revision is 409 not-approved; an unknown plan is 404 no-plan; nothing starts', async () => {
  const room = makePlan(ctx.app, 'Not approved yet');
  const r = await ctx.post('/api/run', { engine: 'board', planRoomId: room.id, revision: room.planRevision, hash: room.planHash });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'not-approved');
  const stale = await ctx.post('/api/run', { engine: 'board', planRoomId: room.id, revision: room.planRevision + 1, hash: room.planHash });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, 'not-approved');
  const missing = await ctx.post('/api/run', { engine: 'board', planRoomId: 'no-such-plan', revision: 1, hash: ZERO });
  assert.equal(missing.status, 404); assert.equal(missing.json.code, 'no-plan');
  assert.deepEqual(room.buildIds || [], []);
});

test('POST /api/run board: an approved plan with invalid options is 400 invalid-options before any build starts', async () => {
  const room = makePlan(ctx.app, 'Approved, bad options', { approve: true });
  const r = await ctx.post('/api/run', { engine: 'board', planRoomId: room.id, revision: room.planRevision, hash: room.planHash, options: { mode: 'bogus' } });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'invalid-options');
  assert.deepEqual(room.buildIds || [], []);
});

t('POST /api/run board: an approved plan starts a build room, the same build POST /api/build starts', async () => {
  fake.scenario({ rules: [], default: { reply: 'Looks right.\nVERDICT: PASS' } });
  const room = makePlan(ctx.app, GOAL, { approve: true });
  const r = await ctx.post('/api/run', {
    engine: 'board', planRoomId: room.id, revision: room.planRevision, hash: room.planHash, options: { roles: { manager: mgrId }, maxRounds: 2 },
  });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.roomId, /^[\w-]+$/);
  const build = await ctx.room(r.json.roomId);
  assert.equal(build.kind, 'build');
  assert.equal(build.planRoomId, room.id);
  assert.equal(build.mode, 'propose', 'the seat is read-only, so the build proposes');
  assert.ok(room.buildIds.includes(r.json.roomId));
  // Deleting the build stops its loop and removes what it owns, as the build routes do.
  const del = await ctx.post(`/api/rooms/${r.json.roomId}/delete`, {});
  assert.equal(del.status, 200, del.text);
});

test('state: apiVersion 2, the three engines, watch.claude, roomIndex as metadata (every room, up to 500) and rooms as the 25 newest in full', async () => {
  for (let i = 0; i < 30; i++) ctx.app.rooms.newRoom('meeting', `Room ${i}`, { topic: `Topic ${i}`, seatIds: [], rounds: 1, scoutId: null, synthId: null, withContext: false, overrides: {} });
  const st = await ctx.state();
  assert.equal(st.apiVersion, 2);
  assert.deepEqual(st.engines.map((e) => e.id), ['board', 'claude-code', 'codex']);
  assert.equal(typeof st.watch.claude, 'boolean');
  const total = ctx.app.rooms.rooms.size;
  assert.ok(total >= 30, `${total} rooms exist`);
  assert.equal(st.roomIndex.length, Math.min(500, total));
  assert.equal(st.rooms.length, Math.min(25, total));
  const entry = st.roomIndex.find((x) => x.title === 'Room 0');
  assert.ok(entry, 'an old room is in the index');
  assert.deepEqual(Object.keys(entry).sort(), ['created', 'id', 'kind', 'status', 'title']);
  assert.ok(!('messages' in st.roomIndex[0]) && !('agents' in st.roomIndex[0]));
});

test('GET /api/rooms/:id: one room in full (messages included); an unknown id is 404 no such room', async () => {
  const room = ctx.app.rooms.newRoom('meeting', 'One room', { topic: 'One', seatIds: [], rounds: 1, scoutId: null, synthId: null, withContext: false, overrides: {} });
  const ok = await ctx.get(`/api/rooms/${room.id}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id, room.id);
  assert.ok(Array.isArray(ok.json.messages));
  const missing = await ctx.get('/api/rooms/no-such-room');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'no such room' });
});

test('GET /api/preflight in a folder that is not a git repository: git not ok with its reason, not clean, no dirty count, writes unavailable', async () => {
  // The route module runs on its own: a second server here would hold a second app port for the life of this suite.
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  const capability = { cached: () => null, status: async () => null };
  const [route] = require('../src/api/preflight')({ rooms: ctx.app.rooms, project: plain, capability });
  const r = await route.run({ m: '/api/preflight'.match(route.re), body: null, query: {} });
  assert.equal(r.git.ok, false);
  assert.match(r.git.reason, hasGit ? /not a git repository/ : /git was not found/);
  assert.equal(r.clean, false);
  assert.equal(r.dirtyCount, 0);
  for (const agent of ['claude', 'codex']) {
    assert.equal(r.writes[agent].available, false, agent);
    assert.equal(typeof r.writes[agent].reason, 'string', agent);
  }
});

t('GET /api/preflight in a repository: ok and clean; one untracked file makes it dirty; a plan id must name a plan', async () => {
  const r0 = await ctx.get('/api/preflight');
  assert.equal(r0.status, 200, r0.text);
  assert.equal(r0.json.git.ok, true, JSON.stringify(r0.json.git));
  assert.equal(r0.json.clean, true);
  assert.equal(r0.json.dirtyCount, 0);
  assert.equal(r0.json.writes.claude.available, false, 'not verified yet');
  assert.equal(typeof r0.json.writes.claude.reason, 'string');
  const meeting = ctx.app.rooms.newRoom('meeting', 'Not a plan', { topic: 'x', seatIds: [], rounds: 1, scoutId: null, synthId: null, withContext: false, overrides: {} });
  assert.equal((await ctx.get(`/api/preflight?planRoomId=${meeting.id}`)).status, 404);
  const plan = makePlan(ctx.app, 'Preflight plan');
  assert.equal((await ctx.get(`/api/preflight?planRoomId=${plan.id}`)).status, 200);
  const file = path.join(project, 'notes.txt');
  fs.writeFileSync(file, 'draft\n');
  try {
    const r1 = await ctx.get('/api/preflight');
    assert.equal(r1.json.clean, false);
    assert.equal(r1.json.dirtyCount, 1);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

t('GET /api/doctor: the CLI checks carry their state, and the engine list is broadcast on the event stream', async () => {
  const events = await ctx.sse();
  try {
    const r = await ctx.get('/api/doctor');
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
    assert.equal(by.claude.state, 'ok', JSON.stringify(by.claude));
    assert.equal(by.codex.state, 'ok', JSON.stringify(by.codex));
    const ev = await events.waitFor((e) => e.t === 'engines', { timeout: 20000 });
    assert.deepEqual(ev.engines.map((e) => e.id), ['board', 'claude-code', 'codex']);
    assert.equal(ev.engines[0].available, true);
    assert.equal((await ctx.state()).engines[0].available, true);
  } finally {
    events.close();
  }
});

test('deleting a room calls its engine dispose before the room goes', async () => {
  const calls = [];
  ctx.app.engines.register({ id: 'codex', start: async () => ({ room: null }), dispose: (r) => calls.push(r.id), recover() {} });
  const run = ctx.app.rooms.newRoom('run', 'A run', { engine: 'codex', planRoomId: null, agents: [] });
  const r = await ctx.post(`/api/rooms/${run.id}/delete`, {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(calls, [run.id]);
  assert.equal(ctx.app.rooms.rooms.has(run.id), false);
});
