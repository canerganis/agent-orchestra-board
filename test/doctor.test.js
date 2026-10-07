// Doctor checks: binary resolution mirrors libuv (PATH only, .com/.exe; .cmd/.bat are shims), spawn failures
// never reject, the state-directory probe never creates directories, token logins are recognised.
// No real CLI is ever started: the only processes are fake .cmd files (through cmd.exe) and injected spawn stubs.
const { test } = require('node:test');
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

test('claudeLoginCheck: token logins count, values are never shown', () => {
  const base = { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'ob-doc-no-such-config-dir') };
  for (const v of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) {
    const c = doctor.claudeLoginCheck({ ...base, [v]: 'sk-secret-value-123' });
    assert.equal(c.status, 'ok', v);
    assert.ok(c.detail.includes(v));
    assert.ok(!c.detail.includes('secret'));
  }
  const none = doctor.claudeLoginCheck(base);
  assert.notEqual(none.status, 'ok');
  if (none.status === 'warn') assert.match(none.hint, /CLAUDE_CODE_OAUTH_TOKEN/);
});
