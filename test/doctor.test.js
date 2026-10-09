// Doctor checks: binary resolution mirrors libuv (PATH only, .com/.exe; .cmd/.bat are shims), spawn failures
// never reject, the state-directory probe never creates directories, login state comes only from the CLI status commands.
// No real CLI is ever started: the only processes are fake .cmd files (through cmd.exe) and injected spawn stubs.
const { test, after } = require('node:test');
// Fake children own no OS handles and the CLI timers are unref()d, so on Node 20/22 the event loop can drain
// mid-test and the runner cancels the test ("Promise resolution is still pending"). Keep one ref()d handle alive.
const keepAlive = setInterval(() => {}, 1 << 30);
after(() => clearInterval(keepAlive));

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const doctor = require('../src/doctor');

const WIN = process.platform === 'win32';
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {} };
const envWithPath = (...dirs) => {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'path') e[k] = v;
  e.PATH = dirs.join(path.delimiter);
  return e;
};
const touch = (f, text = '') => { fs.writeFileSync(f, text, { mode: 0o755 }); return f; };

// A spawn() replacement that throws synchronously, like Node does for a .cmd without a shell (EINVAL).
const throwingSpawn = () => { throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }); };
// A spawn() replacement whose child emits 'error' asynchronously (ENOENT) and then 'close'.
function enoentSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 0;
  setImmediate(() => { child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })); child.emit('close', -2, null); });
  return child;
}

test('versionOf: a spawn() that throws synchronously resolves with the error instead of crashing', async () => {
  const r = await doctor.versionOf('whatever', process.env, 1000, { spawnFn: throwingSpawn });
  assert.equal(r.error.code, 'EINVAL');
  assert.equal(r.timeout, undefined);
});

test('versionOf: an asynchronous spawn error resolves once', async () => {
  const r = await doctor.versionOf('whatever', process.env, 1000, { spawnFn: enoentSpawn });
  assert.equal(r.error.code, 'ENOENT');
});

test('cliCheck: a thrown spawn error is reported, never rejected', async () => {
  const dir = tmp('ob-doc-');
  try {
    const exe = touch(path.join(dir, WIN ? 'obfake.exe' : 'obfake'));
    const c = await doctor.cliCheck('claude', 'obfake', envWithPath(dir), 1000, { spawnFn: throwingSpawn });
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /EINVAL/);
    assert.ok(c.detail.includes(exe));
  } finally { rm(dir); }
});

test('resolveBin: PATH order, never the process cwd; unknown names resolve to nothing', () => {
  const a = tmp('ob-doc-a-'), b = tmp('ob-doc-b-');
  try {
    const name = WIN ? 'obres.exe' : 'obres';
    const fa = touch(path.join(a, name)), fb = touch(path.join(b, name));
    assert.deepEqual(doctor.resolveBin('obres', envWithPath(a, b)), [fa, fb]);
    assert.deepEqual(doctor.resolveBin('obres', envWithPath(b, a)), [fb, fa]);
    assert.deepEqual(doctor.resolveBin('obres', envWithPath(b, a)).length, 2);
    assert.deepEqual(doctor.resolveBin('no-such-binary-xyz', envWithPath(a, b)), []);
    // A bare name is not looked up in the process cwd (libuv would, unless NoDefaultCurrentDirectoryInExePath is set).
    const cwd = process.cwd();
    process.chdir(a);
    try { assert.deepEqual(doctor.resolveBin('obres', envWithPath(b)), [fb]); } finally { process.chdir(cwd); }
    // An explicit path is taken as given.
    assert.deepEqual(doctor.resolveBin(fa, envWithPath()), [fa]);
  } finally { rm(a); rm(b); }
});

test('resolveBin/resolveShims (Windows): only .com/.exe count as spawnable, .cmd/.bat are shims', { skip: !WIN }, () => {
  const a = tmp('ob-doc-a-'), b = tmp('ob-doc-b-');
  try {
    const cmd = touch(path.join(a, 'obfake.cmd'), '@echo 1.2.3\r\n');
    const bat = touch(path.join(a, 'obfake.bat'), '@echo 1.2.3\r\n');
    const exe = touch(path.join(b, 'obfake.exe'));
    // (a) npm-style install: only the shim exists -> nothing spawnable, shim reported.
    assert.deepEqual(doctor.resolveBin('obfake', envWithPath(a)), []);
    assert.deepEqual(doctor.resolveShims('obfake', envWithPath(a)), [cmd, bat]);
    // (b) shim earlier on PATH than a working exe -> spawn runs the exe; it must be found first.
    assert.deepEqual(doctor.resolveBin('obfake', envWithPath(a, b)), [exe]);
    // PATHEXT is irrelevant to spawn(): even with .CMD first, only the exe is spawnable.
    assert.deepEqual(doctor.resolveBin('obfake', { ...envWithPath(a, b), PATHEXT: '.CMD;.BAT;.EXE' }), [exe]);
    // An explicit .cmd path is a shim, not a spawnable binary.
    assert.deepEqual(doctor.resolveBin(cmd, envWithPath()), []);
    assert.deepEqual(doctor.resolveShims(cmd, envWithPath()), [cmd]);
    // A name with an extension is tried as given, then with .com/.exe appended.
    assert.deepEqual(doctor.resolveBin('obfake.exe', envWithPath(a, b)), [exe]);
  } finally { rm(a); rm(b); }
});

test('cliCheck (Windows): a .cmd-only install is a shim warning with the ORCHESTRA_*_BIN hint, version read via cmd.exe', { skip: !WIN, timeout: 20000 }, async () => {
  const dir = tmp('ob doc space '); // a path with spaces must survive the cmd.exe quoting
  try {
    const cmd = touch(path.join(dir, 'obfake.cmd'), '@echo off\r\necho 9.9.9-fake (Claude Code)\r\n');
    const c = await doctor.cliCheck('claude', 'obfake', envWithPath(dir), 10000);
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /^9\.9\.9-fake/);
    assert.match(c.detail, /\.cmd shim/);
    assert.match(c.detail, /ENOENT/);
    assert.ok(c.detail.includes(cmd));
    assert.match(c.hint, /ORCHESTRA_CLAUDE_BIN/);
    // Explicit .cmd via the env override: same warning, spawn would give EINVAL.
    const d = await doctor.cliCheck('codex', cmd, envWithPath(), 10000);
    assert.equal(d.status, 'warn');
    assert.match(d.detail, /EINVAL/);
    assert.match(d.hint, /ORCHESTRA_CODEX_BIN/);
  } finally { rm(dir); }
});

test('cliCheck (Windows): a shim earlier on PATH than the exe is not reported as a shim', { skip: !WIN }, async () => {
  const a = tmp('ob-doc-a-'), b = tmp('ob-doc-b-');
  try {
    touch(path.join(a, 'obfake.cmd'), '@echo 1.2.3\r\n');
    const exe = touch(path.join(b, 'obfake.exe'));
    const okSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 0;
      setImmediate(() => { child.stdout.emit('data', '2.0.1 (exe)\n'); child.emit('close', 0, null); });
      return child;
    };
    const c = await doctor.cliCheck('claude', 'obfake', envWithPath(a, b), 1000, { spawnFn: okSpawn });
    assert.equal(c.status, 'ok');
    assert.equal(c.detail, `2.0.1 (exe) — ${exe}`);
  } finally { rm(a); rm(b); }
});

test('cliCheck: the ORCHESTRA_*_BIN note appears only when the checked bin is that override (CI sets both variables)', async () => {
  const dir = tmp('ob-doc-');
  const saved = process.env.ORCHESTRA_CLAUDE_BIN;
  try {
    const exe = touch(path.join(dir, WIN ? 'obfake.exe' : 'obfake'));
    const okSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 0;
      setImmediate(() => { child.stdout.emit('data', '2.0.1\n'); child.emit('close', 0, null); });
      return child;
    };
    process.env.ORCHESTRA_CLAUDE_BIN = 'fake-claude'; // set for another bin: must not be mentioned
    const c = await doctor.cliCheck('claude', 'obfake', envWithPath(dir), 1000, { spawnFn: okSpawn });
    assert.equal(c.status, 'ok');
    assert.equal(c.detail, `2.0.1 — ${exe}`);
    process.env.ORCHESTRA_CLAUDE_BIN = exe; // the override is what is being checked: say so
    const d = await doctor.cliCheck('claude', exe, envWithPath(), 1000, { spawnFn: okSpawn });
    assert.equal(d.status, 'ok');
    assert.equal(d.detail, `2.0.1 — ${exe} (ORCHESTRA_CLAUDE_BIN=${exe})`);
  } finally {
    if (saved === undefined) delete process.env.ORCHESTRA_CLAUDE_BIN; else process.env.ORCHESTRA_CLAUDE_BIN = saved;
    rm(dir);
  }
});

test('cliCheck (Windows): a file named like the CLI in the project is pointed out (the board itself never runs it)', { skip: !WIN }, async () => {
  const bin = tmp('ob-doc-bin-'), project = tmp('ob-doc-proj-');
  try {
    const exe = touch(path.join(bin, 'obfake.exe'));
    const planted = touch(path.join(project, 'obfake.exe'));
    const spawned = [];
    const okSpawn = (cmd) => {
      spawned.push(cmd);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 0;
      setImmediate(() => { child.stdout.emit('data', '2.0.1\n'); child.emit('close', 0, null); });
      return child;
    };
    const c = await doctor.cliCheck('claude', 'obfake', envWithPath(bin), 1000, { spawnFn: okSpawn, projectDir: project });
    assert.equal(c.status, 'warn');
    assert.ok(c.detail.includes(exe) && c.detail.includes(planted));
    assert.match(c.detail, /The board ignores it/);
    assert.match(c.hint, /executable named like the CLI/);
    assert.deepEqual(spawned, [exe], '--version ran the PATH copy, not the planted file');
    // Without the planted file the same environment is plain ok.
    fs.unlinkSync(planted);
    const d = await doctor.cliCheck('claude', 'obfake', envWithPath(bin), 1000, { spawnFn: okSpawn, projectDir: project });
    assert.equal(d.status, 'ok');
  } finally { rm(bin); rm(project); }
});

test('orchestraWriteCheck: skipped for a missing project and never creates directories', () => {
  const base = tmp('ob-doc-');
  try {
    const missing = path.join(base, 'typo');
    const c = doctor.orchestraWriteCheck(missing, false);
    assert.equal(c.status, 'skip');
    assert.equal(fs.existsSync(missing), false);
    assert.equal(fs.existsSync(path.join(missing, '.orchestra')), false);
    // Existing project without .orchestra: write access is tested in place, .orchestra is not created.
    const ok = doctor.orchestraWriteCheck(base, true);
    assert.equal(ok.status, 'ok');
    assert.match(ok.detail, /will be created on first start/);
    assert.deepEqual(fs.readdirSync(base), []);
    // Existing .orchestra: probed inside and left clean.
    fs.mkdirSync(path.join(base, '.orchestra'));
    const ok2 = doctor.orchestraWriteCheck(base, true);
    assert.equal(ok2.status, 'ok');
    assert.deepEqual(fs.readdirSync(path.join(base, '.orchestra')), []);
  } finally { rm(base); }
});

test('run: a missing project directory fails the project check, skips the state check and leaves no trace', async () => {
  const base = tmp('ob-doc-');
  const saved = { ORCHESTRA_CLAUDE_BIN: process.env.ORCHESTRA_CLAUDE_BIN, ORCHESTRA_CODEX_BIN: process.env.ORCHESTRA_CODEX_BIN };
  process.env.ORCHESTRA_CLAUDE_BIN = 'ob-no-such-claude-xyz'; // never the real CLIs
  process.env.ORCHESTRA_CODEX_BIN = 'ob-no-such-codex-xyz';
  try {
    const missing = path.join(base, 'typo');
    const r = await doctor.run({ projectDir: missing, timeoutMs: 2000 });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.equal(r.ok, false);
    assert.equal(by.project.status, 'fail');
    assert.equal(by.orchestra.status, 'skip');
    assert.equal(by.claude.status, 'fail');
    assert.match(by.claude.detail, /not found on PATH/);
    assert.equal(fs.existsSync(missing), false);
    assert.deepEqual(fs.readdirSync(base), []);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rm(base);
  }
});

// A fake CLI: answer(args) -> { out, code } for a child that prints and exits, or null for one that never exits.
function fakeCli(answer, spawned = []) {
  return (cmd, args) => {
    spawned.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 0;
    const a = answer(args);
    if (a) setImmediate(() => { if (a.out) child.stdout.emit('data', a.out); child.emit('close', a.code, null); });
    return child;
  };
}

// Every read of a file under ~/.claude, ~/.codex or ~/.claude.json throws and is recorded, so a read that the code
// swallows still fails the test through the recorded list.
function guardCredentialReads() {
  const home = os.homedir();
  const guarded = [path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.claude.json')].map((p) => p.toLowerCase());
  const hit = (f) => { const p = path.resolve(String(f)).toLowerCase(); return guarded.some((g) => p === g || p.startsWith(g + path.sep)); };
  const reads = [];
  const orig = { readFileSync: fs.readFileSync, readFile: fs.readFile, promisesReadFile: fs.promises.readFile, openSync: fs.openSync };
  const deny = (f) => { reads.push(String(f)); throw Object.assign(new Error(`test: credential read of ${f}`), { code: 'EACCES' }); };
  fs.readFileSync = function (f, ...rest) { if (typeof f !== 'number' && hit(f)) deny(f); return orig.readFileSync.call(fs, f, ...rest); };
  fs.openSync = function (f, ...rest) { if (typeof f !== 'number' && hit(f)) deny(f); return orig.openSync.call(fs, f, ...rest); };
  fs.readFile = function (f, ...rest) { if (typeof f !== 'number' && hit(f)) deny(f); return orig.readFile.call(fs, f, ...rest); };
  fs.promises.readFile = function (f, ...rest) { if (typeof f !== 'number' && hit(f)) deny(f); return orig.promisesReadFile.call(fs.promises, f, ...rest); };
  const restore = () => { fs.readFileSync = orig.readFileSync; fs.readFile = orig.readFile; fs.promises.readFile = orig.promisesReadFile; fs.openSync = orig.openSync; };
  return { reads, restore };
}

test('loginChecks: the CLI status command decides; missing subcommand or timeout is unknown; no credential file is read', async () => {
  const dir = tmp('ob-doc-');
  const guard = guardCredentialReads();
  try {
    const exe = touch(path.join(dir, WIN ? 'obfake.exe' : 'obfake'));
    const env = envWithPath(dir);
    const cases = [
      ['claude', doctor.claudeLoginCheck, ['auth', 'status']],
      ['codex', doctor.codexLoginCheck, ['login', 'status']],
    ];
    for (const [agent, fn, args] of cases) {
      // Logged in: exit 0. The output (which may name the account) is never shown.
      let spawned = [];
      const ok = await fn('obfake', env, 2000, { spawnFn: fakeCli(() => ({ out: 'Logged in as someone@example.com\n', code: 0 }), spawned) });
      assert.equal(ok.status, 'ok', agent);
      assert.deepEqual(spawned, [{ cmd: exe, args }]);
      assert.ok(!ok.detail.includes('example.com'));
      // Not logged in: non-zero exit with no unknown-command text.
      const no = await fn('obfake', env, 2000, { spawnFn: fakeCli(() => ({ out: 'Not logged in\n', code: 1 })) });
      assert.equal(no.status, 'warn');
      assert.match(no.detail, /^not logged in/);
      assert.match(no.hint, agent === 'claude' ? /claude login/ : /codex login/);
      // An older CLI without the subcommand: unknown, never a guess.
      for (const out of ["error: unknown command 'auth'\n", "error: unrecognized subcommand 'login'\n"]) {
        const u = await fn('obfake', env, 2000, { spawnFn: fakeCli(() => ({ out, code: 2 })) });
        assert.equal(u.status, 'warn');
        assert.match(u.detail, /^login state unknown: this CLI has no/);
      }
      // A status command that never answers: unknown after the short timeout.
      const t = await fn('obfake', env, 150, { spawnFn: fakeCli(() => null) });
      assert.equal(t.status, 'warn');
      assert.match(t.detail, /^login state unknown: .* timed out after 0\.15s/);
      // A spawn failure: unknown.
      const e = await fn('obfake', env, 2000, { spawnFn: throwingSpawn });
      assert.match(e.detail, /^login state unknown: .*EINVAL/);
      // Not on PATH: nothing spawned, skipped.
      spawned = [];
      const m = await fn('ob-no-such-cli-xyz', env, 2000, { spawnFn: fakeCli(() => ({ code: 0 }), spawned) });
      assert.equal(m.status, 'skip');
      assert.deepEqual(spawned, []);
    }
    assert.deepEqual(guard.reads, [], 'no file under ~/.claude or ~/.codex was read');
  } finally { guard.restore(); rm(dir); }
});

test('run: plain doctor spawns only `--version` and login status calls, reads no credential file, and warns about an ORCHESTRA_*_BIN override', async () => {
  const dir = tmp('ob-doc-');
  const keys = ['ORCHESTRA_CLAUDE_BIN', 'ORCHESTRA_CODEX_BIN', 'CODEX_HOME'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  // The Windows sandbox check reads config.toml from CODEX_HOME (a setting, not a credential): point it away from ~/.codex.
  process.env.CODEX_HOME = path.join(dir, 'codex-home');
  const guard = guardCredentialReads();
  try {
    process.env.ORCHESTRA_CLAUDE_BIN = touch(path.join(dir, WIN ? 'obclaude.exe' : 'obclaude'));
    process.env.ORCHESTRA_CODEX_BIN = touch(path.join(dir, WIN ? 'obcodex.exe' : 'obcodex'));
    const spawned = [];
    const spawnFn = fakeCli((args) => ({ out: args[0] === '--version' ? '1.0.0\n' : 'ok\n', code: 0 }), spawned);
    const r = await doctor.run({ projectDir: dir, timeoutMs: 2000, spawnFn });
    const calls = spawned.map((s) => `${path.basename(s.cmd)} ${s.args.join(' ')}`).sort();
    const ext = WIN ? '.exe' : '';
    assert.deepEqual(calls, [`obclaude${ext} --version`, `obclaude${ext} auth status`, `obcodex${ext} --version`, `obcodex${ext} login status`].sort());
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.equal(by.claudeLogin.status, 'ok');
    assert.equal(by.codexLogin.status, 'ok');
    assert.deepEqual(guard.reads, [], 'no file under ~/.claude or ~/.codex was read');
    const o = by.binOverride;
    assert.equal(o.status, 'warn');
    assert.ok(o.detail.includes(`ORCHESTRA_CLAUDE_BIN=${process.env.ORCHESTRA_CLAUDE_BIN}`) && o.detail.includes('ORCHESTRA_CODEX_BIN='));
    assert.match(o.detail, /instead of the CLI found on PATH/);
  } finally {
    guard.restore();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rm(dir);
  }
});

test('binOverrideCheck: nothing when no override is set, one variable named when one is', () => {
  assert.equal(doctor.binOverrideCheck({}), null);
  assert.equal(doctor.binOverrideCheck({ ORCHESTRA_CLAUDE_BIN: '' }), null);
  const c = doctor.binOverrideCheck({ ORCHESTRA_CODEX_BIN: '/opt/codex' });
  assert.equal(c.status, 'warn'); assert.match(c.detail, /^ORCHESTRA_CODEX_BIN=\/opt\/codex: the board runs this file/);
});

test('codexSandboxCheck (Windows): every result says Codex file edits are off on Windows', { skip: !WIN }, () => {
  const c = doctor.codexSandboxCheck();
  assert.match(c.detail, /; Codex file edits are off on Windows \(the unelevated sandbox does not confine writes\)$/);
});
