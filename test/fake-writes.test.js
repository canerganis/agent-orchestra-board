// The fake CLI's writeFiles / deleteFiles actions: they really change files in the cwd (or at an absolute path,
// which simulates a misbehaving agent), and every operation is logged to writes.jsonl. Runs fake-cli.js directly
// with node; no model and no real CLI is involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPT } = require('./fake-cli');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {} };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// One claude-style turn for seat W, the way the runner sends it (role header, then the message).
function runTurn(fakeDir, cwd) {
  return spawnSync(process.execPath, [SCRIPT, '-p', '--output-format', 'stream-json', '--model', 'm', '--session-id', 's1', '--tools', ''], {
    cwd,
    input: '[You are "W" (role) ...]\n\nhello',
    env: { ...process.env, OB_FAKE_DIR: fakeDir },
    encoding: 'utf8',
  });
}

test('writeFiles and deleteFiles change files and log every operation', () => {
  const root = tmp('ob-fw-');
  const fakeDir = path.join(root, 'fake');
  const cwd = path.join(root, 'cwd');
  const outside = tmp('ob-fw-out-');
  const abs = path.join(outside, 'nested', 'abs.txt');
  try {
    for (const d of ['gates', 'threads']) fs.mkdirSync(path.join(fakeDir, d), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'gone.txt'), 'bye');
    fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify({
      rules: [{ seat: 'W', writeFiles: [{ path: 'a/b.txt', content: 'x' }, { path: abs, content: 'y' }], deleteFiles: ['gone.txt'], reply: 'done' }],
    }));

    const r = runTurn(fakeDir, cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(cwd, 'a', 'b.txt'), 'utf8'), 'x');
    assert.equal(fs.readFileSync(abs, 'utf8'), 'y');
    assert.equal(fs.existsSync(path.join(cwd, 'gone.txt')), false);
    assert.match(r.stdout, /"type":"result"/);

    const writes = readLines(path.join(fakeDir, 'writes.jsonl'));
    assert.equal(writes.length, 3);
    assert.ok(writes.every((w) => w.ok === true && w.error === null && w.n === 1));
    assert.deepEqual(writes.map((w) => w.op), ['write', 'write', 'delete']);
    // Compare through the real parent folder: on macOS the temp dir /var/... is a link to /private/var/...
    const real = (p) => path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
    assert.equal(real(writes[0].path), real(path.resolve(cwd, 'a', 'b.txt')));
    assert.equal(real(writes[1].path), real(abs));
    assert.equal(real(writes[2].path), real(path.resolve(cwd, 'gone.txt')));
  } finally {
    rm(root);
    rm(outside);
  }
});

test('a rule without file actions logs no file operations', () => {
  const root = tmp('ob-fw-none-');
  const fakeDir = path.join(root, 'fake');
  const cwd = path.join(root, 'cwd');
  try {
    for (const d of ['gates', 'threads']) fs.mkdirSync(path.join(fakeDir, d), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify({ rules: [{ seat: 'W', reply: 'plain' }] }));

    const r = runTurn(fakeDir, cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"type":"result"/);
    assert.deepEqual(readLines(path.join(fakeDir, 'writes.jsonl')), []);
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    rm(root);
  }
});
