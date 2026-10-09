// runChecks: order, exit codes, timeout kill, output cap. Commands are plain node one-liners so they run under cmd.exe and sh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, rmrf } = require('./helpers');
const { runChecks, formatChecks } = require('../src/checks');

const node = (js) => `node -e "${js}"`;

test('runs checks in order and reports ok, code, ms and the output tail', async () => {
  const d = tmpDir('ob-checks-');
  try {
    const res = await runChecks(d, [
      { name: 'pass', cmd: node("console.log('fine')") },
      { name: 'fail', cmd: node("console.error('boom'); process.exit(3)") },
    ]);
    assert.deepEqual(res.map((r) => r.name), ['pass', 'fail']);
    assert.equal(res[0].ok, true); assert.equal(res[0].code, 0); assert.match(res[0].tail, /fine/);
    assert.equal(res[1].ok, false); assert.equal(res[1].code, 3); assert.match(res[1].tail, /boom/);
    assert.equal(typeof res[1].ms, 'number');
    assert.match(formatChecks(res), /- fail: FAIL \(exit 3,[^\n]*\n    boom/);
  } finally { rmrf(d); }
});

test('runs in the given cwd', async () => {
  const d = tmpDir('ob-checks-');
  try {
    const [r] = await runChecks(d, [{ name: 'cwd', cmd: node('console.log(process.cwd())') }]);
    assert.ok(r.ok);
    assert.equal(fs.realpathSync(r.tail.trim()), fs.realpathSync(d));
  } finally { rmrf(d); }
});

test('a check that exceeds the timeout is killed and reported as failed', async () => {
  const d = tmpDir('ob-checks-');
  try {
    const t0 = Date.now();
    const [r] = await runChecks(d, [{ name: 'hang', cmd: node('setInterval(()=>{},1000)') }], { timeoutMs: 600 });
    assert.equal(r.ok, false); assert.equal(r.code, null);
    assert.match(r.tail, /timed out after 600 ms/);
    assert.ok(Date.now() - t0 < 10000, 'returned promptly after the kill');
  } finally { rmrf(d); }
});

test('output is capped to the last maxOutput characters', async () => {
  const d = tmpDir('ob-checks-');
  try {
    const [r] = await runChecks(d, [{ name: 'noisy', cmd: node("console.log('x'.repeat(5000)+'END')") }], { maxOutput: 100 });
    assert.ok(r.ok);
    assert.ok(r.tail.length <= 101);
    assert.ok(r.tail.trimEnd().endsWith('END'));
  } finally { rmrf(d); }
});

test('no checks gives an empty result', async () => {
  assert.deepEqual(await runChecks(process.cwd(), []), []);
});

// ---- hardening: scrubbed environment, tree kill on exit, timeout and stop ----
const path = require('path');
const { checkEnv } = require('../src/checks');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A script that starts a grandchild which writes marker.txt after 1.2 s. Mode 'exit' leaves right after spawning, 'hang' waits forever.
const SPAWNER = `const { spawn } = require('child_process');
spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync('marker.txt', 'x'), 1200)"], { stdio: 'ignore' }).unref();
if (process.argv[2] === 'hang') setInterval(() => {}, 1000);`;

test('checkEnv keeps an allowlist and drops secrets, tokens and keys', () => {
  const env = checkEnv({
    PATH: '/bin', Path: 'C:Windows', HOME: '/h', GITHUB_TOKEN: 'a', NPM_TOKEN: 'b', AWS_SECRET_ACCESS_KEY: 'c', AWS_REGION: 'eu',
    OPENAI_API_KEY: 'd', ANTHROPIC_API_KEY: 'e', GH_TOKEN: 'f', MY_KEY: 'g', SSH_AUTH_SOCK: '/s', DATABASE_URL: 'postgres://u:p@h/db',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'HOME', 'PATH', 'Path'].sort());
  assert.equal(env.CI, '1');
});

test('a check runs with a minimal environment: no inherited secrets', async () => {
  const d = tmpDir('ob-checks-');
  const saved = { ...process.env };
  Object.assign(process.env, { FAKE_TOKEN: 't1', FAKE_API_KEY: 'k1', AWS_ACCESS_KEY_ID: 'a1', GITHUB_PAT: 'g1', ORCH_SECRET_THING: 's1' });
  try {
    fs.writeFileSync(path.join(d, 'env.js'), "console.log(JSON.stringify(Object.keys(process.env)))");
    const [r] = await runChecks(d, [{ name: 'env', cmd: 'node env.js' }]);
    assert.ok(r.ok, r.tail);
    const keys = JSON.parse(r.tail.trim().split(/\r?\n/).pop()).map((k) => k.toLowerCase());
    for (const bad of ['fake_token', 'fake_api_key', 'aws_access_key_id', 'github_pat', 'orch_secret_thing']) assert.ok(!keys.includes(bad), bad);
    assert.ok(keys.includes('path'), 'PATH is kept so tools resolve');
  } finally {
    for (const k of ['FAKE_TOKEN', 'FAKE_API_KEY', 'AWS_ACCESS_KEY_ID', 'GITHUB_PAT', 'ORCH_SECRET_THING']) delete process.env[k];
    Object.assign(process.env, saved); rmrf(d);
  }
});

test('a timeout kills the whole tree: a grandchild does not survive', async () => {
  const d = tmpDir('ob-checks-');
  try {
    fs.writeFileSync(path.join(d, 'spawner.js'), SPAWNER);
    const [r] = await runChecks(d, [{ name: 'hang', cmd: 'node spawner.js hang' }], { timeoutMs: 500 });
    assert.equal(r.ok, false); assert.equal(r.code, null);
    await sleep(1800);
    assert.equal(fs.existsSync(path.join(d, 'marker.txt')), false, 'the grandchild was killed with the check');
  } finally { rmrf(d); }
});

test('a backgrounded child does not outlive a check that exits normally (POSIX process group)', { skip: process.platform === 'win32' && 'a shell-orphaned child needs a job object on Windows' }, async () => {
  const d = tmpDir('ob-checks-');
  try {
    fs.writeFileSync(path.join(d, 'spawner.js'), SPAWNER);
    const [r] = await runChecks(d, [{ name: 'bg', cmd: 'node spawner.js exit' }]);
    assert.equal(r.ok, true, 'the check itself passes');
    await sleep(1800);
    assert.equal(fs.existsSync(path.join(d, 'marker.txt')), false, 'the leftover child was killed when the check exited');
  } finally { rmrf(d); }
});

test('stopped() kills the running check and skips the rest', async () => {
  const d = tmpDir('ob-checks-');
  try {
    fs.writeFileSync(path.join(d, 'spawner.js'), SPAWNER);
    let stop = false;
    setTimeout(() => { stop = true; }, 400);
    const t0 = Date.now();
    const res = await runChecks(d, [{ name: 'hang', cmd: 'node spawner.js hang' }, { name: 'later', cmd: node("console.log('no')") }], { stopped: () => stop });
    assert.equal(res.length, 1, 'the second check never started');
    assert.equal(res[0].ok, false); assert.equal(res[0].code, null); assert.match(res[0].tail, /stopped/);
    assert.ok(Date.now() - t0 < 10000);
    await sleep(1800);
    assert.equal(fs.existsSync(path.join(d, 'marker.txt')), false, 'the tree died on stop');
  } finally { rmrf(d); }
});

// A spy around the real tree-kill helper: records the pid and whether the shell was still alive at the call.
function killSpy() {
  const { killTree } = require('../src/platform');
  const calls = [];
  const kill = (child) => { calls.push({ pid: child.pid, alive: child.exitCode === null && child.signalCode === null }); return killTree(child); };
  return { kill, calls };
}

test('win32 reap: a normal exit never calls the kill helper (the pid may be reused)', async () => {
  const d = tmpDir('ob-checks-');
  try {
    const spy = killSpy();
    const [r] = await runChecks(d, [{ name: 'ok', cmd: node("console.log('hi')") }], { kill: spy.kill, win: true });
    assert.equal(r.ok, true, r.tail);
    assert.deepEqual(spy.calls, [], 'no taskkill after the shell exited');
  } finally { rmrf(d); }
});

test('win32 reap: timeout and stop call the kill helper with the live pid', async () => {
  const d = tmpDir('ob-checks-');
  try {
    fs.writeFileSync(path.join(d, 'spawner.js'), SPAWNER);
    const spy = killSpy();
    const [t] = await runChecks(d, [{ name: 'hang', cmd: 'node spawner.js hang' }], { timeoutMs: 500, kill: spy.kill, win: true });
    assert.equal(t.code, null);
    assert.ok(spy.calls.length >= 1 && spy.calls[0].alive && spy.calls[0].pid > 0, 'timeout killed a live shell');
    const spy2 = killSpy();
    let stop = false; setTimeout(() => { stop = true; }, 400);
    const [s] = await runChecks(d, [{ name: 'hang', cmd: 'node spawner.js hang' }], { stopped: () => stop, kill: spy2.kill, win: true });
    assert.match(s.tail, /stopped/);
    assert.ok(spy2.calls.length >= 1 && spy2.calls[0].alive && spy2.calls[0].pid > 0, 'stop killed a live shell');
  } finally { rmrf(d); }
});
