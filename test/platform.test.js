// Exercise POSIX signal semantics even when the suite runs on Windows. Real process-tree coverage lives in stop.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function posixPlatform(platform, kill) {
  const spawns = [];
  const module = { exports: {} };
  const mocks = {
    fs: { statSync: () => ({ isFile: () => true }), accessSync: () => {}, constants: { X_OK: 1 } },
    path: path.posix,
    child_process: { spawn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { pid: 12345 }; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/platform.js'), 'utf8'), {
    module, require: (name) => mocks[name] || require(name), process: { platform, env: {}, kill },
  });
  return { ...module.exports, spawns };
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: Stop signals the isolated group, including commands inheriting CLI pipes`, () => {
    const signals = [];
    const api = posixPlatform(platform, (...args) => signals.push(args));
    const child = api.spawnResolved('/usr/bin/fake-cli', ['exec'], { cwd: '/project', detached: false });
    assert.equal(api.spawns[0].opts.detached, true, 'the CLI must lead its own group');
    assert.equal(api.spawns[0].opts.cwd, '/project');
    api.killTree(child);
    assert.deepEqual(signals, [[-child.pid, 'SIGTERM']], 'negative PID addresses the entire group');
    api.killTree(null);
    api.killTree({ pid: undefined });
    assert.equal(signals.length, 1, 'failed spawns must not signal any group');
  });

  test(`${platform}: an already exited group is harmless; other signal errors remain visible`, () => {
    const gone = posixPlatform(platform, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    assert.doesNotThrow(() => gone.killTree({ pid: 12345 }));
    const denied = posixPlatform(platform, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    assert.throws(() => denied.killTree({ pid: 12345 }), { code: 'EPERM' });
  });
}

// Codex file edits are off on every platform in v0.2; the reasons and codes are part of the gate's contract.
test('codexWriteSupport: off on win32 (unelevated sandbox), darwin and linux (writes off), unsupported elsewhere', () => {
  const p = require('../src/platform');
  assert.equal(p.CODEX_UNIX_WRITES, false);
  const win = p.codexWriteSupport('win32');
  assert.deepEqual(win, { ok: false, code: 'codex-windows-unelevated', reason: p.CODEX_WINDOWS_WRITE_REASON });
  assert.match(p.CODEX_WINDOWS_WRITE_REASON, /^off: Codex file edits are off in v0.2 on every platform. Codex seats read, review and propose patches that the board applies.$/);
  for (const plat of ['darwin', 'linux']) {
    const r = p.codexWriteSupport(plat);
    assert.equal(r.ok, false, plat);
    assert.equal(r.code, 'codex-writes-off', plat);
    assert.equal(r.reason, p.CODEX_WINDOWS_WRITE_REASON);
  }
  for (const other of ['freebsd', 'aix', 'sunos', '', null]) {
    const r = p.codexWriteSupport(other);
    assert.equal(r.ok, false); assert.equal(r.code, 'codex-platform-unsupported');
  }
  // The exported flag is a copy: changing it does not turn Codex writes on.
  const saved = p.CODEX_UNIX_WRITES;
  try { p.CODEX_UNIX_WRITES = true; assert.equal(p.codexWriteSupport('linux').ok, false); } finally { p.CODEX_UNIX_WRITES = saved; }
  const dashes = new RegExp('[\u2013\u2014]');
  for (const plat of ['win32', 'darwin', 'linux', 'freebsd']) assert.doesNotMatch(p.codexWriteSupport(plat).reason, dashes);
});

test('codexEnv(base) reads base: on Windows it drops WindowsApps from PATH without touching base; elsewhere it returns base', () => {
  const base = { Path: 'C:\\a;C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps;C:\\b;C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\', FOO: '1' };
  const win = posixPlatform('win32', () => {});
  const env = win.codexEnv(base);
  assert.equal(env.Path, 'C:\\a;C:\\b');
  assert.equal(env.FOO, '1');
  assert.notEqual(env, base);
  assert.match(base.Path, /WindowsApps/, 'base is not modified');
  assert.equal(JSON.stringify(win.codexEnv({ FOO: '2' })), '{"FOO":"2"}', 'no PATH at all'); // a vm-realm object: compared as JSON
  for (const plat of ['linux', 'darwin']) {
    const api = posixPlatform(plat, () => {});
    assert.equal(api.codexEnv(base), base);
    assert.equal(api.codexWriteSupport(plat).code, 'codex-writes-off');
  }
  // The real module on this machine reads the given base too.
  const real = require('../src/platform').codexEnv({ PATH: 'x', BAR: 'y' });
  assert.equal(real.BAR, 'y');
});
