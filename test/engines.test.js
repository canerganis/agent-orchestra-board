// Engine registry and availability (plan 2.6 and 3.1): the availability matrix over the doctor's CLI states and the two
// data folders, login checks that never change a state, the cliCheck states, the publish throttle and its trailing save,
// the board engine's guards and the unknown-engine refusal. No CLI is started: cliCheck runs with an injected spawn, and
// its PATH holds only folders this file made.
const { test, after } = require('node:test');
// Fake children own no OS handles, so on Node 20/22 the event loop can drain mid-test (see doctor.test.js).
const keepAlive = setInterval(() => {}, 1 << 30);
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const doctor = require('../src/doctor');
const { engineInfo, createEngines, cliChecks, watchOf, ENGINE_IDS } = require('../src/engines');
const { createBoardEngine, boardOptions } = require('../src/engines/board');

const WIN = process.platform === 'win32';
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-engines-'));
after(() => { clearInterval(keepAlive); try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {} });
let seq = 0;
const dir = (name) => { const d = path.join(BASE, `${name}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };

// Claude and Codex homes, empty or holding the data folders the handoff engines and the Runs view look for.
function homes({ claudeProjects = false, codexSessions = false } = {}) {
  const claudeHome = dir('claude-home'), codexHome = dir('codex-home');
  if (claudeProjects) fs.mkdirSync(path.join(claudeHome, 'projects'));
  if (codexSessions) fs.mkdirSync(path.join(codexHome, 'sessions'));
  return { claudeHome, codexHome };
}
const st = (state, detail) => ({ state, ...(detail ? { detail } : {}) });
const envOf = (claude, codex, h = homes(), extra = {}) => ({ cli: { claude, codex }, capability: null, ...h, ...extra });

test('availability: Claude only shows the board team and Claude Code; Codex is hidden without a CLI or a sessions folder', () => {
  const env = envOf(st('ok'), st('missing'));
  const b = engineInfo('board', env);
  assert.equal(b.available, true); assert.equal(b.hidden, false); assert.equal(b.reason, null);
  const c = engineInfo('claude-code', env);
  assert.equal(c.hidden, false); assert.equal(c.available, true); assert.equal(c.launch, 'handoff');
  const x = engineInfo('codex', env);
  assert.equal(x.hidden, true); assert.equal(x.available, false); assert.match(x.reason, /Codex is not installed/);
});

test('availability: Codex only mirrors it, and the Codex engine carries its own label', () => {
  const env = envOf(st('missing'), st('ok'));
  assert.equal(engineInfo('board', env).available, true);
  assert.equal(engineInfo('claude-code', env).hidden, true);
  const x = engineInfo('codex', env);
  assert.equal(x.hidden, false); assert.equal(x.available, true); assert.equal(x.label, 'Codex, you run it');
});

test('availability: both CLIs usable shows every engine; build modes are propose, plus write once a CLI passed its write check', () => {
  const env = envOf(st('ok'), st('ok'));
  const b = engineInfo('board', env);
  assert.equal(b.available, true); assert.equal(b.note, null);
  assert.deepEqual(b.modes, ['propose']);
  assert.deepEqual(engineInfo('board', { ...env, capability: { agents: { claude: { available: false }, codex: { available: false } } } }).modes, ['propose']);
  assert.deepEqual(engineInfo('board', { ...env, capability: { agents: { claude: { available: true }, codex: { available: false } } } }).modes, ['write', 'propose']);
  for (const id of ['claude-code', 'codex']) {
    const e = engineInfo(id, env);
    assert.equal(e.hidden, false); assert.equal(e.available, true); assert.deepEqual(e.modes, []);
  }
});

test('availability: a usable Codex CLI offers write builds in patch mode once the repository is usable, without a Codex write check', () => {
  const closed = { claude: { available: false }, codex: { available: false } };
  const codexOnly = envOf(st('missing'), st('ok'));
  assert.deepEqual(engineInfo('board', { ...codexOnly, capability: { repo: { ok: true }, agents: closed } }).modes, ['write', 'propose']);
  assert.deepEqual(engineInfo('board', { ...codexOnly, capability: { repo: { ok: false, reason: 'not a git repository' }, agents: closed } }).modes, ['propose'], 'patch mode needs worktrees');
  assert.deepEqual(engineInfo('board', { ...envOf(st('ok'), st('broken')), capability: { repo: { ok: true }, agents: closed } }).modes, ['propose'], 'a broken Codex CLI cannot build');
  assert.deepEqual(engineInfo('board', { ...envOf(st('ok'), st('missing')), capability: { repo: { ok: true }, agents: closed } }).modes, ['propose'], 'Claude still needs its write check');
});

test('availability: no CLI and no data folder hides the board team (unavailable, with a reason) and both handoff engines', () => {
  const env = envOf(st('missing'), st('missing'));
  const b = engineInfo('board', env);
  assert.equal(b.hidden, true); assert.equal(b.available, false); assert.match(b.reason, /Neither Claude Code nor Codex is installed/);
  assert.deepEqual(b.modes, []);
  for (const id of ['claude-code', 'codex']) {
    const e = engineInfo(id, env);
    assert.equal(e.hidden, true); assert.equal(e.available, false); assert.match(e.reason, /not installed/);
  }
});

test('availability: a shim-only (broken) Claude CLI shows the board team unavailable with its reason as text, and Claude Code still runs', () => {
  const detail = 'C:\\bin\\claude.cmd is a .cmd shim, which the board cannot launch (spawn: ENOENT)';
  const env = envOf(st('broken', detail), st('missing'));
  const b = engineInfo('board', env);
  assert.equal(b.hidden, false); assert.equal(b.available, false);
  assert.match(b.reason, /^Claude Code CLI cannot be started by the board: /);
  assert.ok(b.reason.includes(detail), 'the doctor detail is part of the reason');
  const c = engineInfo('claude-code', env);
  assert.equal(c.available, true); assert.match(c.note, /cannot be started by the board/);
});

test('availability: a broken CLI turns off only its own seats while the other CLI keeps the board team enabled', () => {
  const env = envOf(st('broken', 'exe cannot start'), st('ok'));
  const b = engineInfo('board', env);
  assert.equal(b.available, true); assert.equal(b.hidden, false);
  assert.match(b.note, /Claude Code CLI cannot be started, so its seats are off/);
});

test('availability: a Claude home with a projects folder shows Claude Code without the CLI; the Runs view follows that folder', () => {
  const env = envOf(st('missing'), st('missing'), homes({ claudeProjects: true }));
  const c = engineInfo('claude-code', env);
  assert.equal(c.hidden, false); assert.equal(c.available, true);
  assert.equal(engineInfo('codex', env).hidden, true);
  assert.equal(engineInfo('board', env).hidden, true);
  assert.deepEqual(watchOf(env), { claude: true });
  assert.deepEqual(watchOf(envOf(st('missing'), st('missing'), homes())), { claude: false });
});

test('availability: a Codex sessions folder shows Codex without the CLI', () => {
  const env = envOf(st('missing'), st('missing'), homes({ codexSessions: true }));
  const x = engineInfo('codex', env);
  assert.equal(x.hidden, false); assert.equal(x.available, true);
  assert.equal(engineInfo('claude-code', env).hidden, true);
});

test('availability: a warn state keeps the engine enabled and shows the doctor detail as its note', () => {
  const env = envOf(st('warn', "'codex --version' timed out after 10s, /opt/codex"), st('missing'));
  const b = engineInfo('board', env);
  assert.equal(b.available, true);
  assert.match(b.note, /Claude Code CLI: |Codex CLI: /);
  assert.match(engineInfo('board', envOf(st('missing'), st('warn', 'timed out'))).note, /Codex CLI: timed out/);
  assert.deepEqual(b.modes, ['propose']);
});

test('login checks never change an engine state: a skipped Claude login and a Codex keyring warning leave both enabled', () => {
  const checks = [
    { id: 'claude', name: 'Claude CLI', status: 'ok', detail: '2.0.1', state: 'ok' },
    { id: 'claudeLogin', name: 'Claude login', status: 'skip', detail: 'credentials live in the macOS Keychain' },
    { id: 'codex', name: 'Codex CLI', status: 'ok', detail: '0.160.0', state: 'ok' },
    { id: 'codexLogin', name: 'Codex login', status: 'warn', detail: 'no credentials found', hint: 'Run `codex login`' },
  ];
  const env = { cli: cliChecks(checks), capability: null, ...homes() };
  for (const id of ENGINE_IDS) assert.equal(engineInfo(id, env).available, true, id);
  assert.equal(cliChecks(checks).claude.state, 'ok');
  assert.equal(cliChecks(checks).codex.state, 'ok');
  assert.deepEqual(cliChecks([]), { claude: null, codex: null });
});

test('availability: a state outside the four counts as missing; a bare state string works; an empty env offers nothing', () => {
  assert.equal(engineInfo('board', { cli: { claude: st('bogus'), codex: 'missing' } }).hidden, true);
  assert.equal(engineInfo('board', { cli: { claude: 'ok', codex: 'missing' } }).available, true);
  assert.equal(engineInfo('board', { cli: {} }).hidden, true);
  assert.equal(engineInfo('board', {}).available, false);
  assert.throws(() => engineInfo('nope', {}), /unknown engine/);
});

// ---------- cliCheck states (plan 2.6) ----------

// A spawn() stand-in: the child reports `out` on stdout and closes with `code`; `error` fails it the way a missing or
// blocked binary does; `hang` never closes.
function fakeChild({ code = 0, out = '', hang = false, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  if (!hang) {
    setImmediate(() => {
      if (error) { child.emit('error', error); child.emit('close', -2, null); return; }
      if (out) child.stdout.emit('data', out);
      child.emit('close', code, null);
    });
  }
  return child;
}
const envWithPath = (...dirs) => {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'path') e[k] = v;
  e.PATH = dirs.join(path.delimiter);
  return e;
};
// An executable named `name` in folder d (the .exe form on Windows, where PATH lookup needs one).
function exeIn(d, name = 'obfake') {
  const f = path.join(d, WIN ? `${name}.exe` : name);
  fs.writeFileSync(f, '', { mode: 0o755 });
  return f;
}

test('cliCheck state: a CLI that is not on PATH is missing (and nothing is spawned)', async () => {
  const c = await doctor.cliCheck('claude', 'ob-no-such-cli-xyz', envWithPath(dir('empty-path')), 1000, {
    spawnFn: () => { throw new Error('nothing may be spawned for a missing CLI'); },
  });
  assert.equal(c.state, 'missing'); assert.equal(c.status, 'fail');
});

test('cliCheck state: an exe that cannot start is broken; a version check that times out or exits non-zero is warn; a clean version is ok', async () => {
  const d = dir('path-exe');
  exeIn(d);
  const env = envWithPath(d);
  const broken = await doctor.cliCheck('claude', 'obfake', env, 1000, {
    spawnFn: () => fakeChild({ error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) }),
  });
  assert.equal(broken.state, 'broken'); assert.equal(broken.status, 'fail');
  const slow = await doctor.cliCheck('claude', 'obfake', env, 50, { spawnFn: () => fakeChild({ hang: true }) });
  assert.equal(slow.state, 'warn'); assert.match(slow.detail, /timed out/);
  const exited = await doctor.cliCheck('claude', 'obfake', env, 1000, { spawnFn: () => fakeChild({ code: 2 }) });
  assert.equal(exited.state, 'warn'); assert.match(exited.detail, /exited 2/);
  const good = await doctor.cliCheck('claude', 'obfake', env, 1000, { spawnFn: () => fakeChild({ out: 'fake 1.2.3\n' }) });
  assert.equal(good.state, 'ok'); assert.equal(good.status, 'ok');
});

test('cliCheck state (Windows): a .cmd shim with no exe is broken; a project file named like the CLI is warn', { skip: !WIN }, async () => {
  const shimDir = dir('path-shim');
  fs.writeFileSync(path.join(shimDir, 'obshim.cmd'), '@echo off\r\n');
  const shim = await doctor.cliCheck('claude', 'obshim', envWithPath(shimDir), 1000, { spawnFn: () => fakeChild({ out: 'x 1.0\n' }) });
  assert.equal(shim.state, 'broken');
  const bin = dir('path-shadow'), project = dir('project');
  exeIn(bin, 'obshadow'); exeIn(project, 'obshadow');
  const shadow = await doctor.cliCheck('claude', 'obshadow', envWithPath(bin), 1000, { spawnFn: () => fakeChild({ out: 'x 1.0\n' }), projectDir: project });
  assert.equal(shadow.state, 'warn');
});

// ---------- the registry: publish, saves, dispatch ----------

// Rooms as the registry sees them: every room is live unless the test says otherwise; saves are recorded by id.
function fakeRooms(liveFn = () => true) {
  const saves = [];
  return { rooms: new Map(), live: liveFn, saveRoom: (r) => { saves.push(r.id); }, saves };
}
// A clock the test moves by hand: setTimer records the callback, advance(ms) runs the timers that came due.
function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    timers,
    now: () => t,
    setTimer(fn, ms) { const h = { fn, at: t + ms, cleared: false, done: false, unref() {} }; timers.push(h); return h; },
    clearTimer(h) { if (h) h.cleared = true; },
    advance(ms) { t += ms; for (const h of timers) if (!h.cleared && !h.done && h.at <= t) { h.done = true; h.fn(); } },
  };
}

test('publish: one engine event per call; the first call saves at once and calls inside the 5 s window share one trailing save', () => {
  const rooms = fakeRooms(), clock = fakeClock(), events = [];
  const eng = createEngines({ rooms, broadcast: (e) => events.push(e), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const room = { id: 'run1', kind: 'run', engine: 'codex', title: 'Run' };
  eng.publish(room, { status: 'running' }, [{ id: 'a1', status: 'running' }]);
  eng.publish(room, { status: 'running' }, [{ id: 'a1', status: 'done' }]);
  eng.publish(room, { status: 'running' }, []);
  assert.deepEqual(events.map((e) => e.t), ['engine', 'engine', 'engine']);
  assert.deepEqual(events[1], { t: 'engine', roomId: 'run1', run: { status: 'running' }, agents: [{ id: 'a1', status: 'done' }] });
  assert.deepEqual(rooms.saves, ['run1'], 'the first save is immediate');
  assert.equal(clock.timers.length, 1, 'one trailing save is scheduled for the window');
  clock.advance(5000);
  assert.deepEqual(rooms.saves, ['run1', 'run1'], 'the trailing save lands at the end of the window');
  clock.advance(5000);
  assert.equal(rooms.saves.length, 2, 'nothing else is pending');
  eng.publish(room, { status: 'done' }, []);
  assert.equal(rooms.saves.length, 3, 'a publish after the window saves at once');
});

test('publish: agents merge by id (a changed agent keeps its place) and only the last 300 are kept', () => {
  const rooms = fakeRooms(), clock = fakeClock();
  const eng = createEngines({ rooms, broadcast() {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const room = { id: 'run2', kind: 'run', engine: 'codex' };
  eng.publish(room, null, [{ id: 'a1', status: 'running' }, { id: 'a2', status: 'running' }]);
  eng.publish(room, null, [{ id: 'a1', status: 'done' }, { id: 'a3', status: 'running' }]);
  assert.deepEqual(room.agents, [{ id: 'a1', status: 'done' }, { id: 'a2', status: 'running' }, { id: 'a3', status: 'running' }]);
  eng.publish(room, null, Array.from({ length: 305 }, (_, i) => ({ id: `x${i}` })));
  assert.equal(room.agents.length, 300);
  assert.equal(room.agents[0].id, 'x5');
  assert.equal(room.agents[299].id, 'x304');
});

test('publish: a deleted room is neither saved nor announced', () => {
  const rooms = fakeRooms(() => false), events = [];
  const eng = createEngines({ rooms, broadcast: (e) => events.push(e) });
  assert.equal(eng.publish({ id: 'gone', kind: 'run', engine: 'codex' }, null, [{ id: 'a' }]), false);
  assert.deepEqual(events, []);
  assert.deepEqual(rooms.saves, []);
});

test('dispose cancels the trailing save, so nothing is written after the room is gone; close writes a pending save now', () => {
  const rooms = fakeRooms(), clock = fakeClock();
  const eng = createEngines({ rooms, broadcast() {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const room = { id: 'run3', kind: 'run', engine: 'codex' };
  eng.publish(room, null, []); eng.publish(room, null, []);
  assert.equal(rooms.saves.length, 1);
  eng.dispose(room);
  clock.advance(10000);
  assert.equal(rooms.saves.length, 1);
  assert.equal(clock.timers[0].cleared, true);

  const other = { id: 'run4', kind: 'run', engine: 'codex' };
  eng.publish(other, null, []); eng.publish(other, null, []);
  eng.close();
  assert.deepEqual(rooms.saves, ['run3', 'run4', 'run4'], 'close writes the pending save now');
  clock.advance(10000);
  assert.equal(rooms.saves.length, 3, 'and no timer fires afterwards');
});

test('start: an engine name that is not registered is refused with 400 unknown-engine', async () => {
  const eng = createEngines({ rooms: fakeRooms() });
  await assert.rejects(eng.start('claude-code', null, {}), (e) => e.status === 400 && e.code === 'unknown-engine');
  await assert.rejects(eng.start('nope', null, {}), (e) => e.status === 400 && e.code === 'unknown-engine');
});

test('register: only the three engine ids register; list() always shows all three in order', () => {
  const eng = createEngines({ rooms: fakeRooms(), env: () => envOf(st('ok'), st('ok')) });
  assert.throws(() => eng.register({ id: 'other' }), /not an engine id/);
  assert.equal(eng.get('board'), null);
  assert.deepEqual(eng.list().map((i) => i.id), ['board', 'claude-code', 'codex']);
});

test('recover and dispose reach the engine that owns the room; rooms of unregistered engines and plans are skipped', () => {
  const rooms = fakeRooms();
  const run = { id: 'r-codex', kind: 'run', engine: 'codex' }, other = { id: 'r-claude', kind: 'run', engine: 'claude-code' };
  const build = { id: 'b1', kind: 'build' }, plan = { id: 'p1', kind: 'plan' };
  for (const r of [run, other, build, plan]) rooms.rooms.set(r.id, r);
  const calls = [];
  const eng = createEngines({ rooms });
  eng.register({ id: 'codex', start: async () => ({}), dispose: (r) => calls.push(`dispose ${r.id}`), recover: (r) => calls.push(`recover ${r.id}`) });
  eng.recover();
  eng.dispose(run); eng.dispose(other); eng.dispose(plan);
  assert.deepEqual(calls, ['recover r-codex', 'dispose r-codex']);
});

// ---------- the board team engine ----------

const HASH = 'a'.repeat(64);
const planRoomOf = (over = {}) => ({ id: 'p1', kind: 'plan', planRevision: 2, planHash: HASH, approval: { decision: 'approved', hash: HASH }, ...over });
const plan = { isApproved: (r, h) => !!r && r.kind === 'plan' && r.approval?.decision === 'approved' && r.approval.hash === h && r.planHash === h };
function fakeBuild() {
  const calls = [];
  return { calls, startBuild: async (room, opts) => { calls.push({ room, opts }); return { id: 'b1', kind: 'build' }; } };
}
const usableEnv = () => ({ cli: { claude: st('ok'), codex: st('missing') }, capability: null, ...homes() });
const unusableEnv = () => ({ cli: { claude: st('missing'), codex: st('missing') }, capability: null, ...homes() });

test('boardOptions: the fields POST /api/build reads pass; anything else is 400 invalid-options', () => {
  assert.deepEqual(boardOptions(undefined), {});
  assert.deepEqual(boardOptions(null), {});
  assert.deepEqual(
    boardOptions({ roles: { manager: '', reviewer: 'rev' }, maxRounds: 2, escalate: true, mode: 'propose' }),
    { roles: { manager: null, reviewer: 'rev' }, maxRounds: 2, escalate: true, mode: 'propose' },
  );
  for (const bad of [[], 'x', { mode: 'bogus' }, { maxRounds: 0 }, { maxRounds: 7 }, { maxRounds: 1.5 }, { escalate: 'yes' }, { roles: [] }, { roles: { manager: 'bad id!' } }, { unknown: 1 }]) {
    assert.throws(() => boardOptions(bad), (e) => e.status === 400 && e.code === 'invalid-options', JSON.stringify(bad));
  }
});

test('board start: an unapproved plan, a stale revision or a missing plan never starts a build', async () => {
  const b = fakeBuild();
  const eng = createBoardEngine({ build: b, plan, env: usableEnv });
  await assert.rejects(eng.start(planRoomOf({ approval: null }), { revision: 2, hash: HASH }), (e) => e.status === 409 && e.code === 'not-approved');
  await assert.rejects(eng.start(planRoomOf(), { revision: 1, hash: HASH }), (e) => e.status === 409 && e.code === 'not-approved');
  await assert.rejects(eng.start(undefined, { revision: 2, hash: HASH }), (e) => e.status === 404 && e.code === 'no-plan');
  await assert.rejects(eng.start(planRoomOf({ kind: 'build' }), { revision: 2, hash: HASH }), (e) => e.status === 404 && e.code === 'no-plan');
  assert.equal(b.calls.length, 0);
});

test('board start: invalid options are refused before the availability check and before the build', async () => {
  const b = fakeBuild();
  const eng = createBoardEngine({ build: b, plan, env: usableEnv });
  await assert.rejects(eng.start(planRoomOf(), { revision: 2, hash: HASH, options: { mode: 'bogus' } }), (e) => e.code === 'invalid-options');
  assert.equal(b.calls.length, 0);
});

test('board start: with no usable CLI the engine is unavailable (409 with the reason) and no build starts', async () => {
  const b = fakeBuild();
  const eng = createBoardEngine({ build: b, plan, env: unusableEnv });
  await assert.rejects(eng.start(planRoomOf(), { revision: 2, hash: HASH }), (e) => e.status === 409 && e.code === 'engine-unavailable' && /Neither Claude Code nor Codex/.test(e.message));
  assert.equal(b.calls.length, 0);
});

test('board start: an approved plan with a usable CLI starts the build with the fields POST /api/build passes', async () => {
  const b = fakeBuild();
  const eng = createBoardEngine({ build: b, plan, env: usableEnv });
  const out = await eng.start(planRoomOf(), { revision: 2, hash: HASH, options: { maxRounds: 2, mode: 'propose' } });
  assert.equal(out.room.id, 'b1');
  assert.equal(b.calls.length, 1);
  assert.deepEqual(b.calls[0].opts, { revision: 2, hash: HASH, maxRounds: 2, mode: 'propose' });
});
