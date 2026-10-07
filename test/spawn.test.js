// Spawn safety: every child process of the board starts from the file resolved on PATH, never from the child's cwd.
// On Windows, libuv looks for a bare program name in the child's cwd before PATH unless NoDefaultCurrentDirectoryInExePath
// is set (a normal terminal does not set it), so a claude.exe at the root of an untrusted repository would have run as
// the CLI on the first turn, even for a read-only seat. These tests plant such files and prove they never run.
// No real CLI is ever started: the planted files are copies of cmd.exe / sh scripts / the fake CLI, or plain garbage.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');
const { tmpDir, rmrf, waitFor, testWithFake, samePath } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const platform = require('../src/platform');

const WIN = process.platform === 'win32';
const NO_CWD_VAR = 'NoDefaultCurrentDirectoryInExePath';
const exeName = (name) => (WIN ? `${name}.exe` : name);

// A harmless executable that prints "ran": a copy of cmd.exe on Windows (args below), a sh script elsewhere.
const PLANT_ARGS = WIN ? ['/d', '/c', 'echo ran'] : [];
function plant(dir, name = 'obplant') {
  const f = path.join(dir, exeName(name));
  if (WIN) fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), f);
  else fs.writeFileSync(f, '#!/bin/sh\necho ran\n', { mode: 0o755 });
  return f;
}
// A file named like an executable that cannot run (if it were started, the spawn fails or prints nothing).
const garbage = (dir, name) => { const f = path.join(dir, exeName(name)); fs.writeFileSync(f, 'MZ this is not a program\n', { mode: 0o755 }); return f; };

// Runs a spawn function to completion: {error, code, signal, out, spawnfile, closedAfterError}.
function run(spawnFn, cmd, args, opts) {
  return new Promise((resolve) => {
    const r = { error: null, code: null, signal: null, out: '', spawnfile: null, closedAfterError: false };
    let child;
    try { child = spawnFn(cmd, args, opts); } catch (e) { r.error = e; return resolve(r); }
    r.spawnfile = child.spawnfile || null;
    child.stdout?.on('data', (d) => { r.out += d; });
    child.on('error', (e) => { r.error = e; });
    child.on('close', (code, signal) => { r.code = code; r.signal = signal; r.closedAfterError = !!r.error; resolve(r); });
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(); }
  });
}

const envWithPath = (...dirs) => {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'path') e[k] = v;
  e.PATH = dirs.join(path.delimiter);
  return e;
};

let root, binDir, cwdDir, emptyDir;
const saved = {};
const SAVE = ['PATH', 'Path', NO_CWD_VAR, 'ORCHESTRA_CLAUDE_BIN', 'ORCHESTRA_CODEX_BIN'];
const restoreEnv = () => { for (const k of SAVE) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
const startCwd = process.cwd();

before(() => {
  for (const k of SAVE) saved[k] = process.env[k];
  root = tmpDir('ob-spawn-');
  binDir = path.join(root, 'bin'); cwdDir = path.join(root, 'cwd'); emptyDir = path.join(root, 'empty');
  for (const d of [binDir, cwdDir, emptyDir]) fs.mkdirSync(d);
});
after(() => { process.chdir(startCwd); restoreEnv(); rmrf(root); });

test('resolveExe: bare names are looked up on PATH only (never the process cwd); explicit paths are taken as given', () => {
  const onPath = plant(binDir);
  plant(cwdDir);
  assert.equal(platform.resolveExe('obplant', envWithPath(binDir)), onPath);
  assert.ok(path.isAbsolute(platform.resolveExe('obplant', envWithPath(binDir))));
  assert.equal(platform.resolveExe('obplant', envWithPath(emptyDir)), null);
  process.chdir(cwdDir);
  try {
    assert.equal(platform.resolveExe('obplant', envWithPath(emptyDir)), null, 'the process cwd is not searched');
    assert.equal(platform.resolveExe('obplant', envWithPath()), null, 'an empty PATH finds nothing');
    assert.equal(platform.resolveExe(path.join(cwdDir, exeName('obplant')), envWithPath()), path.join(cwdDir, exeName('obplant')), 'explicit paths work');
  } finally { process.chdir(startCwd); }
  assert.equal(platform.resolveExe(path.join(emptyDir, exeName('obplant')), envWithPath(binDir)), null, 'an explicit path that does not exist resolves to nothing');
  assert.equal(platform.resolveExe('no-such-program-xyz', process.env), null);
});

test('spawnResolved: a name that exists only in the child cwd is ENOENT and the planted file never runs (with and without NoDefaultCurrentDirectoryInExePath)', { timeout: 20000 }, async (t) => {
  plant(cwdDir);
  try {
    // A normal terminal does not set the variable: remove it from this process so libuv's cwd lookup is live.
    delete process.env[NO_CWD_VAR];
    if (WIN) {
      // Control (diagnostic only, never asserted: a future libuv may change the rule): what a raw spawn does here.
      const raw = await run(child_process.spawn, 'obplant', PLANT_ARGS, { cwd: cwdDir, env: envWithPath(emptyDir), windowsHide: true });
      t.diagnostic(`raw spawn of a bare name with the planted exe in the child cwd: ${raw.error ? raw.error.code : `ran, printed ${JSON.stringify(raw.out.trim())}`}`);
    }
    for (const env of [envWithPath(emptyDir), { ...envWithPath(emptyDir), [NO_CWD_VAR]: '1' }]) {
      const r = await run(platform.spawnResolved, 'obplant', PLANT_ARGS, { cwd: cwdDir, env, windowsHide: true });
      assert.equal(r.error?.code, 'ENOENT', 'the planted file is not found');
      assert.equal(r.error.syscall, 'spawn obplant'); assert.equal(r.error.path, 'obplant');
      assert.equal(r.out, '', 'nothing ran');
      assert.equal(r.closedAfterError, true, "'close' follows 'error' like a Node ENOENT");
    }
    // No env option: the board's own environment is used, PATH included.
    process.env.PATH = emptyDir;
    const r = await run(platform.spawnResolved, 'obplant', PLANT_ARGS, { cwd: cwdDir, windowsHide: true });
    assert.equal(r.error?.code, 'ENOENT');
  } finally { restoreEnv(); }
});

test('spawnResolved: the PATH copy runs by absolute path even when the child cwd holds a file of the same name', { timeout: 20000 }, async () => {
  const onPath = plant(binDir);
  garbage(cwdDir, 'obplant'); // would fail or print nothing if it were started
  try {
    delete process.env[NO_CWD_VAR];
    const r = await run(platform.spawnResolved, 'obplant', PLANT_ARGS, { cwd: cwdDir, env: envWithPath(binDir), windowsHide: true });
    assert.equal(r.error, null); assert.equal(r.code, 0);
    assert.equal(r.out.trim(), 'ran');
    assert.ok(samePath(r.spawnfile, onPath), `spawned ${r.spawnfile}, expected ${onPath}`);
    // An explicit path is spawned as given.
    const e = await run(platform.spawnResolved, onPath, PLANT_ARGS, { cwd: cwdDir, env: envWithPath(), windowsHide: true });
    assert.equal(e.code, 0); assert.equal(e.out.trim(), 'ran');
  } finally { restoreEnv(); }
});

test('spawnResolved: refuses shell spawns; children never inherit a NoDefaultCurrentDirectoryInExePath the user did not set', async () => {
  assert.throws(() => platform.spawnResolved('obplant', [], { shell: true }), /shell spawns are not allowed/);
  assert.throws(() => platform.execFileResolved('obplant', [], { shell: true }), /shell spawns are not allowed/);
  // The board sets the variable for itself on Windows (defence in depth); a child's env must not carry it unless
  // the user's own environment did. Observe the env Node hands to spawn via a stub that records it.
  const node = process.execPath;
  const r = await new Promise((resolve) => {
    const c = platform.spawnResolved(node, ['-e', `process.stdout.write(JSON.stringify(process.env[${JSON.stringify(NO_CWD_VAR)}] ?? null))`], { windowsHide: true });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => resolve(out));
  });
  const userHad = saved[NO_CWD_VAR] !== undefined;
  assert.equal(JSON.parse(r), userHad ? saved[NO_CWD_VAR] : null);
  // killTree on a child that never started is a no-op.
  assert.doesNotThrow(() => platform.killTree({ pid: undefined }));
  assert.doesNotThrow(() => platform.killTree(null));
});

test('execFileResolved: a bare name is resolved on PATH; nothing on PATH is ENOENT, never the cwd copy', () => {
  plant(cwdDir);
  const onPath = plant(binDir);
  const out = platform.execFileResolved('obplant', PLANT_ARGS, { cwd: cwdDir, env: envWithPath(binDir), encoding: 'utf8', windowsHide: true });
  assert.equal(out.trim(), 'ran');
  assert.throws(() => platform.execFileResolved('obplant', PLANT_ARGS, { cwd: cwdDir, env: envWithPath(emptyDir), encoding: 'utf8', windowsHide: true }), (e) => e.code === 'ENOENT');
  assert.ok(fs.existsSync(onPath));
});

test('only src/platform.js may require child_process: every other module in src/ and bin/ spawns through it', () => {
  const ROOT = path.join(__dirname, '..');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) files.push(f);
    }
  })(path.join(ROOT, 'src'));
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.js')) files.push(path.join(d, e.name)); })(path.join(ROOT, 'bin'));
  files.push(path.join(ROOT, 'server.js'));
  const offenders = files.filter((f) => /require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(fs.readFileSync(f, 'utf8')) && path.basename(f) !== 'platform.js');
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
  assert.ok(files.some((f) => path.basename(f) === 'platform.js'), 'platform.js is part of the scan');
});

// ---------- the reported bug, end to end against the fake CLI: a planted claude.exe / codex.exe never runs ----------
let fakeDir, fake, project, fakeBin;
before(() => {
  fakeDir = tmpDir('ob-spawn-fake-');
  fake = setupFakeCli(fakeDir); // sets ORCHESTRA_*_BIN to the built fakes and isolates HOME
  project = path.join(fakeDir, 'project'); fs.mkdirSync(project);
  fakeBin = path.join(fakeDir, 'pathbin'); fs.mkdirSync(fakeBin);
  if (!fake.skipReason) {
    // The real CLI names, on a PATH directory of our own (never the user's PATH: it may hold the real, paid CLIs).
    fs.copyFileSync(fake.claudeBin, path.join(fakeBin, exeName('claude')));
    fs.copyFileSync(fake.codexBin, path.join(fakeBin, exeName('codex')));
  }
});
after(() => { restoreEnv(); rmrf(fakeDir); });

const SEATS = [
  { id: 'ada', name: 'Ada', role: 'Builder', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', perm: 'read', target: '', budget: 0, color: '#e07a52', thread: null, used: 0, cached: 0, cost: 0 },
  { id: 'bob', name: 'Bob', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'low', perm: 'read', target: '', budget: 0, color: '#7aa2ff', thread: null, used: 0, cached: 0, cost: 0 },
];
function board() {
  const { createStore } = require('../src/store');
  const { createSeats } = require('../src/seats');
  const { createLimits } = require('../src/limits');
  const { createRunner } = require('../src/runner');
  const store = createStore(project); store.ensure();
  store.writeJson('seats.json', SEATS);
  const events = [];
  const broadcast = (e) => events.push(e);
  const limits = createLimits({ store, broadcast });
  const seats = createSeats({ store, broadcast });
  const runner = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast, detectVersions: false });
  return { store, seats, limits, runner, events };
}

testWithFake(fake, 'runner: with claude.exe/codex.exe planted in the project and no CLI on PATH, a turn fails with "not found" and the planted files never run', async () => {
  // Working copies of the fake CLI as the planted files: had one run, it would have logged a call.
  fs.copyFileSync(fake.claudeBin, path.join(project, exeName('claude')));
  fs.copyFileSync(fake.codexBin, path.join(project, exeName('codex')));
  fake.scenario({ default: { reply: 'I ran from the project. This must never happen.' } });
  const b = board();
  try {
    delete process.env.ORCHESTRA_CLAUDE_BIN; delete process.env.ORCHESTRA_CODEX_BIN; // bare names, as in a normal install
    delete process.env[NO_CWD_VAR];
    process.env.PATH = emptyDir;
    const before = fake.calls().length;
    const a = await b.runner.runSeat('ada', 'Say hi');
    assert.equal(a.ok, false);
    assert.match(a.error, /^Claude CLI not found: "claude" is not on PATH/);
    const c = await b.runner.runSeat('bob', 'Review this');
    assert.equal(c.ok, false);
    assert.match(c.error, /^Codex CLI not found: "codex" is not on PATH/);
    assert.equal(fake.calls().length, before, 'the planted executables were never started');
    assert.equal(b.seats.publicSeat(b.seats.seatById('ada')).status, 'error');
    assert.equal(b.events.filter((e) => e.t === 'end').length, 2);
    assert.ok(b.events.filter((e) => e.t === 'end').every((e) => e.ok === false && /not found/.test(e.error)));
  } finally { restoreEnv(); }
});

testWithFake(fake, 'runner: the CLI found on PATH is what runs (cwd stays the project) even with garbage claude.exe/codex.exe planted there', async () => {
  garbage(project, 'claude'); garbage(project, 'codex');
  fake.scenario({ default: { reply: 'Hello from PATH.' } });
  const b = board();
  try {
    delete process.env.ORCHESTRA_CLAUDE_BIN; delete process.env.ORCHESTRA_CODEX_BIN;
    delete process.env[NO_CWD_VAR];
    process.env.PATH = fakeBin;
    const a = await b.runner.runSeat('ada', 'Say hi');
    assert.equal(a.ok, true, a.error); assert.equal(a.text, 'Hello from PATH.');
    let [call] = fake.calls().slice(-1);
    assert.equal(call.agent, 'claude'); assert.ok(samePath(call.cwd, project), `cwd ${call.cwd} is the project`);
    const c = await b.runner.runSeat('bob', 'Review this');
    assert.equal(c.ok, true, c.error);
    [call] = fake.calls().slice(-1);
    assert.equal(call.agent, 'codex'); assert.ok(samePath(call.cwd, project));
  } finally { restoreEnv(); }
});

testWithFake(fake, 'version detection and the Claude limits probe resolve the CLI on PATH too (board cwd / temp dir never searched)', { timeout: 30000 }, async () => {
  const versions = require('../src/adapters/versions');
  fs.copyFileSync(fake.claudeBin, path.join(project, exeName('claude'))); // a working fake: would log if it ran
  fake.scenario({ default: { reply: 'ok', rateLimit: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: 1760300000 } } } } });
  const b = board();
  try {
    delete process.env.ORCHESTRA_CLAUDE_BIN; delete process.env.ORCHESTRA_CODEX_BIN;
    delete process.env[NO_CWD_VAR];
    process.env.PATH = emptyDir;
    process.chdir(project); // the board's own cwd holds the planted claude.exe
    const before = fake.calls().length;
    const miss = await versions.detectVersion('claude', 'claude', { timeoutMs: 5000 });
    assert.equal(miss.ok, false); assert.match(miss.error, /Claude CLI not found: "claude" is not on PATH/);
    const probe = await b.limits.probeClaude();
    assert.equal(probe.ok, false); assert.match(probe.error, /Claude CLI not found/);
    assert.match(b.limits.get().claude.error, /Claude CLI not found/);
    assert.equal(fake.calls().length, before, 'nothing was started');
    // With the fake on PATH both work, by the PATH copy.
    process.env.PATH = fakeBin;
    const hit = await versions.detectVersion('claude', 'claude', { timeoutMs: 10000 });
    assert.equal(hit.ok, true, hit.error); assert.equal(hit.version, '0.0.0-test');
    const ok = await b.limits.probeClaude();
    assert.equal(ok.ok, true, ok.error);
    await waitFor(() => b.limits.get().claude?.windows?.seven_day, { what: 'probe rate limit' });
    assert.equal(b.limits.get().claude.windows.seven_day.pct, 20);
    const probeCall = fake.calls().slice(before).find((c) => c.args.includes('--no-session-persistence'));
    assert.ok(probeCall && samePath(probeCall.cwd, os.tmpdir()), 'the probe ran (in the temp dir)');
  } finally { process.chdir(startCwd); restoreEnv(); }
});
