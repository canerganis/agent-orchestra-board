// Zero token demo: starts on a temporary sample project, serves the prerecorded rooms, refuses everything that could
// start work, and never spawns a child process (child_process.spawn is counted; spawnResolved goes through it).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { tmpDir, rmrf, request, exitGuard } = require('./helpers');
const { parseArgs } = require('../bin/agent-orchestra-board');

exitGuard();
const calls = [];
const realSpawn = cp.spawn;
cp.spawn = (...a) => { calls.push(a[0]); throw new Error('spawn must not be called in the demo'); };
const home = tmpDir('ob-demo-home-');
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home; process.env.USERPROFILE = home;
const { startDemo, MESSAGE } = require('../src/demo');

let demo, cookie;
after(async () => {
  cp.spawn = realSpawn;
  if (demo) await demo.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmrf(home);
});

test('demo starts on a temporary copy of the sample project and loads the recorded rooms', async () => {
  demo = await startDemo();
  assert.notEqual(demo.port, 4317);
  assert.equal(demo.rooms, 3);
  assert.ok(fs.existsSync(path.join(demo.projectDir, 'src', 'format.js')));
  assert.ok(fs.existsSync(path.join(demo.projectDir, '.orchestra', 'rooms', 'build.json')));
  cookie = `ob_session_${demo.port}=${demo.app.token}`;
  assert.match(demo.url, new RegExp(`^http://localhost:${demo.port}/\\?t=`));
});

test('serves the recorded real run: a finished Council with synthesis, an approved plan and a build waiting for you', async () => {
  const st = await request(demo.port, 'GET', '/api/state', { cookie });
  assert.equal(st.status, 200);
  const byId = Object.fromEntries(st.json.rooms.map((r) => [r.id, r]));
  const council = byId['demo-council'];
  assert.equal(council.status, 'done');
  assert.ok(council.messages.some((m) => /synthesis/i.test(m.label || '') && m.id === council.resultId));
  const build = byId['demo-build'];
  assert.equal(build.status, 'needs-you');
  assert.ok(Object.values(build.items).some((i) => i.status === 'passed'), 'at least one item passed its review');
  assert.equal(byId['demo-plan'].status, 'approved');
  const one = await request(demo.port, 'GET', '/api/rooms/demo-build', { cookie });
  assert.equal(one.json.kind, 'build');
});

test('the page carries the recorded run banner with its date', async () => {
  const r = await request(demo.port, 'GET', '/', { cookie });
  assert.equal(r.status, 200);
  assert.match(r.text, /Recorded from a real run on \d{4}-\d{2}-\d{2}\. No agents run now\./);
});

test('everything that could start work is refused, and spawn is never called', async () => {
  for (const [p, body] of [['/api/seats/claude/send', { text: 'hi' }], ['/api/meeting', { topic: 'x', seatIds: ['claude'] }], ['/api/run', { engine: 'board' }], ['/api/limits/refresh', {}]]) {
    const r = await request(demo.port, 'POST', p, { cookie, body });
    assert.equal(r.status, 403, p);
    assert.equal(r.json.error, MESSAGE);
  }
  assert.equal((await request(demo.port, 'GET', '/api/doctor', { cookie })).status, 200);
  assert.equal((await request(demo.port, 'GET', '/api/capability', { cookie })).status, 200);
  // The runner itself refuses a turn too (shutdown), without reaching spawn.
  await demo.app.runner.runSeat("claude", "x", {}).catch(() => {});
  assert.deepEqual(calls, []);
});

test('the CLI parses the demo command', () => {
  assert.equal(parseArgs(['demo']).cmd, 'demo');
  assert.equal(parseArgs(['demo', '--port', '4390']).port, 4390);
});

test('closing the demo removes the temporary project', async () => {
  const dir = demo.projectDir;
  await demo.close();
  demo = null;
  assert.equal(fs.existsSync(dir), false);
});

test('the published package includes the recorded demo rooms', () => {
  const out = cp.execSync('npm pack --dry-run --json', { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const files = JSON.parse(out)[0].files.map((f) => f.path.split(path.sep).join('/'));
  for (const n of fs.readdirSync(path.join(__dirname, '..', 'bench', 'demo-rooms')).filter((f) => f.endsWith('.json'))) {
    assert.ok(files.includes(`bench/demo-rooms/${n}`), `missing ${n} in package`);
  }
});
