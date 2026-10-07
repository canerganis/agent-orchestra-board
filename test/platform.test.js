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
