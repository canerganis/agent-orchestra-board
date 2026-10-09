// Handoff engines (plan 3.3, F7): src/engines/handoff.js, claude-code.js, codex.js and the routes in src/api/handoff.js.
// The Claude Code engine runs against a fake runs watcher, the Codex engine against synthetic rollouts in a temporary
// CODEX_HOME. Rooms are the real createRooms over a temp project, the registry is the real createEngines, and clocks and
// timers are injected so the save and event limits are checked without waiting. One suite runs the routes on a live
// in-process server with the fake CLI. No real CLI is started.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir, rmrf, startApp, teardown, hasGit, gitIn, initRepo } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { createStore } = require('../src/store');
const { createRooms } = require('../src/rooms');
const { createEngines } = require('../src/engines');
const { validatePlan, planHash } = require('../src/workflows/plan-model');
const H = require('../src/engines/handoff');
const { createClaudeCodeEngine } = require('../src/engines/claude-code');
const { createCodexEngine } = require('../src/engines/codex');

const SEAT_CANARY = 'seatcanary7';
const ITEMS = [
  { id: 'parse-config', title: 'Parse the config', spec: 'Read the file.', owns: ['src/config.js'], dependsOn: [], difficulty: 'easy', seatId: SEAT_CANARY },
  { id: 'route', title: 'Add the route', spec: 'Serve it.', owns: ['src/route.js'], dependsOn: ['parse-config'], difficulty: 'medium', seatId: null },
  { id: 'docs', title: 'Write the docs', spec: 'Explain it.', owns: ['docs/x.md'], dependsOn: [], difficulty: 'hard', seatId: null },
];

// A clock with timers that run only when advanced.
function fakeClock(start = Date.parse('2026-10-08T12:00:00Z')) {
  let t = start;
  const timers = new Set();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn }; timers.add(h); return h; },
    clearTimer: (h) => { timers.delete(h); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at;
        timers.delete(due);
        due.fn();
      }
      t = end;
    },
  };
}

// A runs watcher with the interface of createClaudeRuns, driven by the test.
function fakeWatcher() {
  const runs = new Map();
  const followers = new Map();
  return {
    followers,
    add(run, agents) { runs.set(run.id, { run: { engine: 'claude-code', agentCount: agents.length, tokens: 0, ...run }, agents }); },
    findByToken(token, since) {
      return [...runs.values()]
        .filter((x) => x.agents.some((a) => String(a.label).startsWith(`${token}:`)) && x.run.startedAt >= since)
        .map((x) => ({ ...x.run }));
    },
    list: () => [...runs.values()].map((x) => ({ ...x.run })),
    get(id) { const x = runs.get(id); return x ? { run: { ...x.run }, agents: x.agents.map((a) => ({ ...a })) } : null; },
    follow(id, cb) { followers.set(id, cb); return () => followers.delete(id); },
    emit(id, payload) { const cb = followers.get(id); if (cb) cb(payload); },
  };
}

const agent = (id, label, extra = {}) => ({ id, key: label, label, phase: 'Build', model: 'claude-haiku-5-5', status: 'running', attempt: 1, startedAt: null, lastActivityAt: null, endedAt: null, tokens: 0, net: 0, toolCalls: 0, lastTool: null, ...extra });

// A world: temp project, real rooms over it, the registry and one handoff engine, all on one fake clock.
function world(t, { project: given, engine = 'claude-code', clock = fakeClock(), codexHome } = {}) {
  const dir = tmpDir('ob-handoff-');
  t.after(() => rmrf(dir));
  const project = given || path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const store = createStore(project);
  store.ensure();
  const events = [];
  const broadcast = (e) => events.push(e);
  const seats = { seatById: () => null, all: () => [], rtOf: () => ({}) };
  const rooms = createRooms({ store, seats, runner: {}, broadcast });
  let saves = 0;
  const counted = { ...rooms, saveRoom: (r) => { saves += 1; rooms.saveRoom(r); } };
  const engines = createEngines({ rooms: counted, broadcast, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const watcher = fakeWatcher();
  const common = { rooms, engines, store, project, info: () => ({ available: true }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer };
  const eng = engine === 'codex'
    ? createCodexEngine({ ...common, codexHome: () => codexHome, intervalMs: 0 })
    : createClaudeCodeEngine({ ...common, watcher: () => watcher });
  engines.register(eng);
  return { dir, project, store, rooms, engines, eng, watcher, clock, events, saves: () => saves, seats };
}

// A plan room at revision 1 with ITEMS; approve: false leaves it awaiting approval.
function makePlan(rooms, { approve = true, items = ITEMS } = {}) {
  const plan = validatePlan({ goal: 'Add CSV export to the board', items });
  const hash = planHash(plan);
  return rooms.newRoom('plan', 'Add CSV export', {
    goal: plan.goal, plan, planRevision: 1, planHash: hash, revisions: [{ revision: 1, hash, by: 'manager', plan }],
    approval: approve ? { decision: 'approved', revision: 1, hash } : null, status: approve ? 'approved' : 'awaiting-approval', buildIds: [],
  });
}
const startRun = (w, plan, options) => w.eng.start(plan, { revision: plan.planRevision, hash: plan.planHash, options });

test('start: a plan that is not approved, or approved at another revision, is 409 not-approved and writes nothing', async (t) => {
  const w = world(t);
  const plan = makePlan(w.rooms, { approve: false });
  await assert.rejects(startRun(w, plan), (e) => e.status === 409 && e.code === 'not-approved');
  const ok = makePlan(w.rooms);
  await assert.rejects(w.eng.start(ok, { revision: 2, hash: ok.planHash }), (e) => e.status === 409 && e.code === 'not-approved');
  await assert.rejects(w.eng.start(ok, { revision: 1, hash: '0'.repeat(64) }), (e) => e.status === 409 && e.code === 'not-approved');
  await assert.rejects(w.eng.start(null, { revision: 1, hash: ok.planHash }), (e) => e.status === 404);
  await assert.rejects(startRun(w, ok, { tiers: { easy: 'bad model!' } }), (e) => e.status === 400 && e.code === 'invalid-options');
  await assert.rejects(startRun(w, ok, { other: 1 }), (e) => e.status === 400 && e.code === 'invalid-options');
  assert.equal([...w.rooms.rooms.values()].filter((r) => r.kind === 'run').length, 0);
  assert.equal(fs.existsSync(path.join(w.project, '.orchestra', 'handoff')), false);
});

test('start: the handoff holds the hash, the revision, the token and every item id, and no seat data; the room waits', async (t) => {
  const w = world(t);
  const plan = makePlan(w.rooms);
  const { room, pastePrompt } = await startRun(w, plan, { tiers: { hard: 'claude-opus-5-5' } });
  assert.equal(room.kind, 'run');
  assert.equal(room.engine, 'claude-code');
  assert.equal(room.status, 'waiting');
  assert.match(room.token, /^ob[a-z2-7]{6}$/);
  assert.equal(room.planRoomId, plan.id);
  assert.equal(room.planRevision, 1);
  assert.equal(room.planHash, plan.planHash);
  assert.equal(room.planChanged, false);
  assert.equal(room.linked, null);
  assert.deepEqual(room.agents, []);
  assert.equal(room.changes, null);
  assert.equal(room.handoffMs, w.clock.now());
  assert.equal(room.handoffFile, `.orchestra/handoff/${plan.id}-r1-${room.token}.md`);
  assert.ok(pastePrompt.includes(room.handoffFile), pastePrompt);
  assert.match(pastePrompt, /Workflow/);
  const md = fs.readFileSync(path.join(w.project, room.handoffFile), 'utf8');
  assert.ok(md.includes(plan.planHash), 'hash');
  assert.ok(md.includes(room.token), 'token');
  assert.ok(md.includes('revision 1'), 'revision');
  for (const it of ITEMS) assert.ok(md.includes(`"id": "${it.id}"`), it.id);
  assert.ok(md.includes(`${room.token}:<itemId>:<tier>`), 'label rule');
  assert.ok(md.includes(`ob/${room.token}`), 'branch rule');
  assert.ok(!md.includes(SEAT_CANARY), 'no seat id');
  assert.ok(!/seatId|usage|tokens"/i.test(md), 'no seat field or usage');
  assert.ok(!/[–—]/.test(md), 'no em or en dashes');
  // The item JSON carries exactly the six fields.
  const json = JSON.parse(md.split('```json')[1].split('```')[0]);
  assert.deepEqual(Object.keys(json[0]), ['id', 'title', 'spec', 'owns', 'dependsOn', 'difficulty']);
});

test('Codex task names: item ids are sanitized one to one, written into the handoff and mapped back from agent paths', async (t) => {
  const map = H.sanitizeItemIds(['parse-config', 'route', 'A-b']);
  assert.deepEqual([...map], [['parse_config', 'parse-config'], ['route', 'route'], ['a_b', 'A-b']]);
  assert.deepEqual([...H.sanitizeItemIds(['x-1', 'x_1'])], [['x_1', 'x-1'], ['x_1_2', 'x_1']]);

  const base = tmpDir('ob-codex-home-');
  t.after(() => rmrf(base));
  const home = path.join(base, '.codex');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const w = world(t, { engine: 'codex', codexHome: home, clock: { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout } });
  const plan = makePlan(w.rooms);
  const { room, pastePrompt } = await startRun(w, plan);
  assert.match(pastePrompt, /spawn_agent/);
  const md = fs.readFileSync(path.join(w.project, room.handoffFile), 'utf8');
  assert.ok(md.includes(`| parse-config | ${room.token}_parse_config |`), md);

  const LEAD = '019e0b00-0001-7000-8000-00000000000a';
  const CHILD = '019e0b00-0002-7000-8000-00000000000b';
  const OTHER = '019e0b00-0003-7000-8000-00000000000c';
  const OTHER_CHILD = '019e0b00-0004-7000-8000-00000000000d';
  const t0 = room.handoffMs + 1000;
  writeRollout(home, LEAD, t0, { cwd: w.project, lines: [turn(t0 + 10, 'task_started')] });
  writeRollout(home, CHILD, t0 + 100, {
    cwd: w.project, spawn: { parent: LEAD, path: `/root/${room.token}_parse_config` },
    lines: [ctx(t0 + 110, 'read-only', 'gpt-6-luna'), turn(t0 + 120, 'task_started')],
  });
  // Another lead in the project whose sub-agents name all three items, but not the code.
  writeRollout(home, OTHER, t0 + 200, { cwd: w.project, lines: [turn(t0 + 210, 'task_started')] });
  writeRollout(home, OTHER_CHILD, t0 + 300, {
    cwd: w.project, spawn: { parent: OTHER, path: '/root/parse_config_route_docs' }, lines: [turn(t0 + 310, 'task_started')],
  });
  const cands = w.eng.candidates(room);
  assert.deepEqual(cands.map((c) => [c.ref, c.tokenMatch]), [[LEAD, true], [OTHER, false]]);
  assert.equal(cands[1].score, 3);
  w.eng.link(room, LEAD);
  t.after(() => w.eng.dispose(room));
  assert.deepEqual(room.linked, { parentThreadId: LEAD });
  assert.equal(room.status, 'running');
  w.eng.flushAll();
  const kid = room.agents.find((a) => a.id === CHILD);
  assert.ok(kid, JSON.stringify(room.agents));
  assert.equal(kid.itemId, 'parse-config');
  assert.equal(kid.label, `${room.token}_parse_config`);
  assert.equal(kid.sandbox, 'read-only');
  assert.equal(room.run.engine, 'codex');
});

test('candidates: a token match outranks a run with a higher item score; runs started before the window are left out', async (t) => {
  const w = world(t);
  const plan = makePlan(w.rooms);
  const { room } = await startRun(w, plan);
  const h = room.handoffMs;
  w.watcher.add({ id: 'wf_aaaaaaaa-001', title: 'mine', status: 'running', startedAt: h + 5000 }, [agent('a1111111111', `${room.token}:route:medium`)]);
  w.watcher.add({ id: 'wf_bbbbbbbb-002', title: 'parse-config route docs', status: 'running', startedAt: h + 9000 }, [agent('a2222222222', 'build:docs:x')]);
  w.watcher.add({ id: 'wf_cccccccc-003', title: 'old parse-config route docs', status: 'running', startedAt: h - 120000 }, []);
  const c = w.eng.candidates(room);
  assert.deepEqual(c.map((x) => x.ref), ['wf_aaaaaaaa-001', 'wf_bbbbbbbb-002']);
  assert.equal(c[0].tokenMatch, true);
  assert.equal(c[0].score, 1);
  assert.equal(c[1].tokenMatch, false);
  assert.equal(c[1].score, 3);
  assert.equal(c[0].status, 'running');
});

test('link: a run that is not a current candidate is 400 not-a-candidate; a second link is 409; unlink waits again', async (t) => {
  const w = world(t);
  const plan = makePlan(w.rooms);
  const { room } = await startRun(w, plan);
  w.watcher.add({ id: 'wf_cccccccc-003', title: 'old', status: 'running', startedAt: room.handoffMs - 120000 }, []);
  assert.throws(() => w.eng.link(room, 'wf_cccccccc-003'), (e) => e.status === 400 && e.code === 'not-a-candidate');
  assert.throws(() => w.eng.link(room, 'wf_dddddddd-004'), (e) => e.status === 400 && e.code === 'not-a-candidate');
  assert.throws(() => w.eng.link(room, ''), (e) => e.status === 400);
  assert.equal(room.linked, null);
  assert.equal(w.watcher.followers.size, 0);
  w.watcher.add({ id: 'wf_aaaaaaaa-001', title: 'mine', status: 'running', startedAt: room.handoffMs }, [agent('a1111111111', `${room.token}:route:medium`)]);
  w.eng.link(room, 'wf_aaaaaaaa-001');
  assert.throws(() => w.eng.link(room, 'wf_aaaaaaaa-001'), (e) => e.status === 409 && e.code === 'already-linked');
  w.eng.unlink(room);
  assert.equal(room.linked, null);
  assert.equal(room.status, 'waiting');
  assert.equal(w.watcher.followers.size, 0, 'the follower is released');
  assert.equal(w.eng.stop(room), true);
  assert.equal(room.status, 'stopped');
});

test('a watcher event updates the room: agents, run, status; the end computes the changes once; done releases the follower', async (t) => {
  const w = world(t);
  const plan = makePlan(w.rooms);
  const { room } = await startRun(w, plan);
  const id = 'wf_aaaaaaaa-001';
  w.watcher.add({ id, title: 'mine', status: 'running', startedAt: room.handoffMs }, [agent('a1111111111', `${room.token}:route:medium`)]);
  w.eng.link(room, id);
  assert.equal(room.status, 'running');
  w.clock.advance(1000);
  w.watcher.emit(id, { run: { id, status: 'running', agentCount: 2 }, agents: [agent('a2222222222', `${room.token}:docs:hard`, { tokens: 41000 })] });
  w.clock.advance(1000);
  assert.ok(room.agents.some((a) => a.id === 'a2222222222' && a.tokens === 41000), JSON.stringify(room.agents));
  assert.equal(room.run.agentCount, 2);
  const ev = w.events.filter((e) => e.t === 'engine' && e.roomId === room.id);
  assert.ok(ev.some((e) => e.agents.some((a) => a.id === 'a2222222222')), 'an engine event carried the agent');
  w.watcher.emit(id, { run: { id, status: 'killed', agentCount: 2 }, agents: [] });
  assert.equal(room.status, 'stopped');
  assert.deepEqual(room.changes, { git: false }, 'not a repository');
  const onDisk = JSON.parse(fs.readFileSync(path.join(w.project, '.orchestra', 'rooms', `${room.id}.json`), 'utf8'));
  assert.equal(onDisk.status, 'stopped', 'a status change is saved at once');
  assert.ok(w.watcher.followers.has(id), 'a stopped run is still followed for a while');
  room.changes.marker = 1;
  // The last agents of a done run reach the room before the follower goes, even inside the event gap.
  w.watcher.emit(id, { run: { id, status: 'completed', agentCount: 2 }, agents: [agent('a2222222222', `${room.token}:docs:hard`, { tokens: 52000, status: 'done' })] });
  assert.equal(room.status, 'done');
  assert.equal(room.changes.marker, 1, 'computed once');
  assert.ok(room.agents.some((a) => a.id === 'a2222222222' && a.tokens === 52000), JSON.stringify(room.agents));
  assert.equal(w.watcher.followers.size, 0, 'done releases the follower');
  assert.deepEqual(w.eng.followed(), []);
  assert.deepEqual(room.linked, { runId: id }, 'the room stays linked');
  w.eng.dispose(room);
  assert.deepEqual(w.eng.followed(), []);
});

test('release: a stopped run that comes back stays followed; one that stays stopped is released after RELEASE_MS; candidates read it again', async (t) => {
  const w = world(t);
  const plan = makePlan(w.rooms);
  const { room } = await startRun(w, plan);
  const id = 'wf_aaaaaaaa-001';
  w.watcher.add({ id, title: 'mine', status: 'running', startedAt: room.handoffMs }, [agent('a1111111111', `${room.token}:route:medium`)]);
  w.eng.link(room, id);
  w.watcher.emit(id, { run: { id, status: 'killed' }, agents: [] });
  assert.equal(room.status, 'stopped');
  w.clock.advance(H.RELEASE_MS - 1000);
  w.watcher.emit(id, { run: { id, status: 'running' }, agents: [] });
  assert.equal(room.status, 'running');
  w.clock.advance(2000);
  assert.ok(w.watcher.followers.has(id), 'the run came back: the release was called off');
  w.watcher.emit(id, { run: { id, status: 'unknown' }, agents: [] });
  assert.equal(room.status, 'unknown');
  w.clock.advance(H.RELEASE_MS - 1);
  assert.ok(w.watcher.followers.has(id), 'not yet');
  w.clock.advance(1);
  assert.equal(w.watcher.followers.size, 0, 'released');
  assert.deepEqual(w.eng.followed(), []);
  assert.deepEqual(room.linked, { runId: id });

  // On demand: candidates reads a released run once. Still ended: nothing follows it. Running again: followed again.
  w.watcher.add({ id, title: 'mine', status: 'killed', startedAt: room.handoffMs }, [agent('a1111111111', `${room.token}:route:medium`)]);
  w.eng.candidates(room);
  assert.equal(room.status, 'stopped');
  assert.deepEqual(w.eng.followed(), []);
  w.watcher.add({ id, title: 'mine', status: 'running', startedAt: room.handoffMs }, [agent('a1111111111', `${room.token}:route:medium`)]);
  w.eng.candidates(room);
  assert.equal(room.status, 'running');
  assert.ok(w.watcher.followers.has(id), 'following again');
  w.eng.dispose(room);
  assert.equal(w.watcher.followers.size, 0);
});

test('planChanged: an edit or a rejection after the handoff sets it, on candidates and on a watcher event', async (t) => {
  const w = world(t);
  const plan = makePlan(w.rooms);
  const { room } = await startRun(w, plan);
  const id = 'wf_aaaaaaaa-001';
  w.watcher.add({ id, title: 'mine', status: 'running', startedAt: room.handoffMs }, [agent('a1111111111', `${room.token}:route:medium`)]);
  w.eng.link(room, id);
  assert.equal(room.planChanged, false);
  // An edit: a new revision with another hash, awaiting approval.
  const edited = validatePlan({ goal: 'Add CSV export to the board, edited', items: ITEMS });
  Object.assign(plan, { plan: edited, planRevision: 2, planHash: planHash(edited), approval: null, status: 'awaiting-approval' });
  w.watcher.emit(id, { run: { id, status: 'running' }, agents: [] });
  assert.equal(room.planChanged, true, 'on a watcher event');

  const plan2 = makePlan(w.rooms);
  const r2 = (await startRun(w, plan2)).room;
  plan2.approval = { decision: 'rejected', revision: 1, hash: plan2.planHash };
  w.eng.candidates(r2);
  assert.equal(r2.planChanged, true, 'a rejection, on candidates');
  // The handoff's revision is still the one the candidates are scored by.
  assert.deepEqual(H.itemIdsOf(H.handedPlan(r2, plan2)), ITEMS.map((i) => i.id));
});

test('recover: a linked room that rooms.load marked stopped takes its real status again and follows its run', async (t) => {
  const w = world(t);
  const plan = makePlan(w.rooms);
  const { room } = await startRun(w, plan);
  const id = 'wf_aaaaaaaa-001';
  w.watcher.add({ id, title: 'mine', status: 'running', startedAt: room.handoffMs }, [agent('a1111111111', `${room.token}:route:medium`)]);
  w.eng.link(room, id);
  assert.equal(room.status, 'running');
  w.eng.dispose(room); // the board stops; the room file says running

  const rooms2 = createRooms({ store: w.store, seats: w.seats, runner: {}, broadcast: () => {} });
  const loaded = rooms2.rooms.get(room.id);
  assert.equal(loaded.status, 'stopped', 'rooms.load marks a running room stopped');
  const engines2 = createEngines({ rooms: rooms2 });
  const eng2 = createClaudeCodeEngine({ rooms: rooms2, engines: engines2, store: w.store, project: w.project, info: () => ({ available: true }), watcher: () => w.watcher });
  engines2.register(eng2);
  engines2.recover();
  assert.equal(loaded.status, 'running');
  assert.ok(w.watcher.followers.has(id), 'following again');
  assert.ok(loaded.agents.some((a) => a.id === 'a1111111111'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(w.project, '.orchestra', 'rooms', `${room.id}.json`), 'utf8'));
  assert.equal(onDisk.status, 'running', 'saved');
  eng2.dispose(loaded);

  // A run that is no longer found reads as unknown, not as stopped by the board.
  const rooms3 = createRooms({ store: w.store, seats: w.seats, runner: {}, broadcast: () => {} });
  const empty = fakeWatcher();
  const eng3 = createClaudeCodeEngine({ rooms: rooms3, engines: createEngines({ rooms: rooms3 }), store: w.store, project: w.project, info: () => ({ available: true }), watcher: () => empty });
  const r3 = rooms3.rooms.get(room.id);
  eng3.recover(r3);
  assert.equal(r3.status, 'unknown');
  assert.deepEqual(eng3.followed(), [], 'a run that is not found is not polled');
  eng3.dispose(r3);

  // A run that has ended is read once at board start and not followed.
  w.watcher.add({ id, title: 'mine', status: 'completed', startedAt: room.handoffMs }, [agent('a1111111111', `${room.token}:route:medium`, { status: 'done' })]);
  const rooms4 = createRooms({ store: w.store, seats: w.seats, runner: {}, broadcast: () => {} });
  const eng4 = createClaudeCodeEngine({ rooms: rooms4, engines: createEngines({ rooms: rooms4 }), store: w.store, project: w.project, info: () => ({ available: true }), watcher: () => w.watcher });
  const r4 = rooms4.rooms.get(room.id);
  eng4.recover(r4);
  assert.equal(r4.status, 'done');
  assert.ok(r4.agents.some((a) => a.id === 'a1111111111'));
  assert.deepEqual(r4.linked, { runId: id });
  assert.equal(w.watcher.followers.has(id), false, 'a done run is not followed again');
  assert.deepEqual(eng4.followed(), []);
});

test('recover: a linked Codex run that is done is read once at board start and leaves no follower', async (t) => {
  const base = tmpDir('ob-codex-home-');
  t.after(() => rmrf(base));
  const home = path.join(base, '.codex');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const w = world(t, { engine: 'codex', codexHome: home, clock: { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout } });
  const plan = makePlan(w.rooms);
  const { room } = await startRun(w, plan);
  const LEAD = '019e0b00-0005-7000-8000-00000000000e';
  const CHILD = '019e0b00-0006-7000-8000-00000000000f';
  const t0 = room.handoffMs - 30000;
  writeRollout(home, LEAD, t0, { cwd: w.project, lines: [turn(t0 + 10, 'task_started'), turn(t0 + 5000, 'task_complete')] });
  writeRollout(home, CHILD, t0 + 100, {
    cwd: w.project, spawn: { parent: LEAD, path: `/root/${room.token}_route` },
    lines: [turn(t0 + 120, 'task_started'), turn(t0 + 4000, 'task_complete')],
  });
  Object.assign(room, { linked: { parentThreadId: LEAD }, status: 'stopped' });
  w.eng.recover(room);
  t.after(() => w.eng.dispose(room));
  assert.equal(room.status, 'done');
  assert.ok(room.agents.some((a) => a.id === CHILD && a.itemId === 'route'), JSON.stringify(room.agents));
  assert.deepEqual(room.linked, { parentThreadId: LEAD });
  assert.deepEqual(w.eng.followed(), [], 'no follower polls a done run');
});

test('changesSince in a temp repository: an edited file, an untracked file and a new worktree; a plain folder is git false', { skip: !hasGit && 'git not available' }, (t) => {
  const dir = tmpDir('ob-handoff-git-');
  t.after(() => rmrf(dir));
  const project = path.join(dir, 'repo');
  initRepo(project, { 'README.md': 'hello\n', 'src/a.js': 'a\n' });
  const head = H.headOf(project);
  assert.match(head, /^[0-9a-f]{40}/);
  const before = H.worktreeList(project);
  assert.equal(before.length, 1);
  fs.writeFileSync(path.join(project, 'README.md'), 'hello, changed\n');
  fs.writeFileSync(path.join(project, 'new.txt'), 'new\n');
  fs.mkdirSync(path.join(project, '.orchestra', 'handoff'), { recursive: true });
  fs.writeFileSync(path.join(project, '.orchestra', 'handoff', 'h.md'), 'left out\n');
  gitIn(project, ['worktree', 'add', '-q', '-b', 'ob/test', path.join(dir, 'wt')]);
  const c = H.changesSince(project, head, before);
  assert.equal(c.git, true);
  assert.equal(c.files, 2, JSON.stringify(c));
  assert.match(c.stat, /README\.md/);
  assert.ok(c.stat.split('\n').length <= 40);
  assert.equal(c.newWorktrees.length, 1);
  assert.ok(c.newWorktrees[0].replace(/\\/g, '/').endsWith('/wt'), c.newWorktrees[0]);
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(H.changesSince(plain, head, []), { git: false });
  assert.equal(H.headOf(plain), null);
});

test('publish limits: agent-only updates save at most once per 5 s and send at most 2 engine events per second', async (t) => {
  const w = world(t);
  const plan = makePlan(w.rooms);
  const { room } = await startRun(w, plan);
  const id = 'wf_aaaaaaaa-001';
  w.watcher.add({ id, title: 'mine', status: 'running', startedAt: room.handoffMs }, [agent('a1111111111', `${room.token}:route:medium`)]);
  w.eng.link(room, id);
  w.clock.advance(6000);
  const saves0 = w.saves();
  const events0 = w.events.filter((e) => e.t === 'engine').length;
  // 40 agent updates over 4 seconds, 100 ms apart.
  for (let i = 0; i < 40; i++) {
    w.watcher.emit(id, { run: { id, status: 'running' }, agents: [agent('a1111111111', `${room.token}:route:medium`, { tokens: i })] });
    w.clock.advance(100);
  }
  const saves = w.saves() - saves0;
  const events = w.events.filter((e) => e.t === 'engine').length - events0;
  assert.ok(saves <= 1, `saves in 4 s: ${saves}`);
  assert.ok(events <= 9 && events >= 4, `engine events in 4 s: ${events}`);
  w.clock.advance(6000);
  assert.ok(w.saves() - saves0 <= 2, 'one trailing save');
  assert.equal(room.agents.find((a) => a.id === 'a1111111111').tokens, 39, 'the last state lands');
  w.eng.dispose(room);
});

// ---------- rollout writers for the Codex test ----------

const iso = (ms) => new Date(ms).toISOString();
const turn = (ms, type) => JSON.stringify({ timestamp: iso(ms), type: 'event_msg', payload: { type } });
const ctx = (ms, sandbox, model) => JSON.stringify({ timestamp: iso(ms), type: 'turn_context', payload: { sandbox_policy: { type: sandbox }, model } });
function writeRollout(home, id, ms, { cwd, spawn, lines = [] }) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const folder = path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  fs.mkdirSync(folder, { recursive: true });
  const source = spawn
    ? { subagent: { thread_spawn: { parent_thread_id: spawn.parent, depth: 1, agent_path: spawn.path, agent_nickname: 'Nick', agent_role: 'worker' } } }
    : 'cli';
  const meta = JSON.stringify({ timestamp: iso(ms), type: 'session_meta', payload: { id, timestamp: iso(ms), cwd, cli_version: '0.160.0', source } });
  const stamp = iso(ms).slice(0, 19).replace(/:/g, '-');
  fs.writeFileSync(path.join(folder, `rollout-${stamp}-${id}.jsonl`), [meta, ...lines].join('\n') + '\n');
}

// ---------- routes on a live server ----------

let dir, project, fake, app;
before(async () => {
  dir = tmpDir('ob-handoff-api-');
  fake = setupFakeCli(dir);
  project = path.join(dir, 'project');
  fs.mkdirSync(project);
  app = await startApp({ projectDir: project });
});
after(() => teardown(app, dir));

test('routes: POST /api/run claude-code writes the handoff; candidates, link and unlink answer; unknown rooms are 404', { timeout: 60000 }, async (t) => {
  if (fake.skipReason) { t.skip(fake.skipReason); return; }
  assert.ok(app.app.engines.get('claude-code'), 'registered');
  assert.ok(app.app.engines.get('codex'), 'registered');
  const plan = makePlan(app.app.rooms, { approve: false });
  const body = { engine: 'claude-code', planRoomId: plan.id, revision: 1, hash: plan.planHash };
  const no = await app.post('/api/run', body);
  assert.equal(no.status, 409, no.text);
  assert.equal(no.json.code, 'not-approved');
  plan.approval = { decision: 'approved', revision: 1, hash: plan.planHash };
  const r = await app.post('/api/run', { ...body, options: { tiers: { easy: 'claude-haiku-5-5' } } });
  assert.equal(r.status, 200, r.text);
  const room = app.app.rooms.rooms.get(r.json.roomId);
  assert.equal(room.status, 'waiting');
  assert.ok(r.json.pastePrompt.includes(room.handoffFile));
  assert.ok(fs.existsSync(path.join(project, room.handoffFile)));
  const c = await app.get(`/api/run/${room.id}/candidates`);
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(c.json, { candidates: [], planChanged: false });
  const bad = await app.post(`/api/run/${room.id}/link`, { ref: 'wf_aaaaaaaa-001' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'not-a-candidate');
  assert.equal((await app.post(`/api/run/${room.id}/link`, {})).status, 400, 'ref is required');
  const un = await app.post(`/api/run/${room.id}/unlink`, {});
  assert.equal(un.status, 200);
  assert.deepEqual(un.json, { ok: true });
  assert.equal((await app.get('/api/run/no-such-room/candidates')).status, 404);
  assert.equal((await app.get(`/api/run/${plan.id}/candidates`)).status, 404, 'a plan room is not a run room');
  assert.equal((await app.request('GET', `/api/run/${room.id}/candidates`, { cookie: null })).status, 401);
});

test('POST /api/rooms/:id/stop on a run room unlinks through its engine and ends the room stopped; nothing is killed', { timeout: 60000 }, async (t) => {
  if (fake.skipReason) { t.skip(fake.skipReason); return; }
  const plan = makePlan(app.app.rooms);
  const r = await app.post('/api/run', { engine: 'claude-code', planRoomId: plan.id, revision: 1, hash: plan.planHash });
  assert.equal(r.status, 200, r.text);
  const room = app.app.rooms.rooms.get(r.json.roomId);
  // As if a run had been linked: stop must drop the link, as unlink does.
  room.linked = { runId: 'wf_aaaaaaaa-001' };
  room.status = 'running';
  const calls = fake.calls().length;
  const s = await app.post(`/api/rooms/${room.id}/stop`, {});
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(s.json, { ok: true });
  assert.equal(room.status, 'stopped');
  assert.equal(room.linked, null);
  assert.equal(app.app.engines.get('claude-code').followed().includes(room.id), false, 'no follower left');
  assert.equal(fake.calls().length, calls, 'no CLI was started or stopped');
  assert.ok(fs.existsSync(path.join(project, room.handoffFile)), 'the handoff file stays');
});
