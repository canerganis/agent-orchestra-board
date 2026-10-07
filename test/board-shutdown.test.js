// Board-level fixes without the real CLIs: shutdown spawns nothing new, a queued turn cancels at once, a corrupt
// seats.json is kept aside, and user-facing hints name the right package. Every child is an in-process fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tmpDir } = require('./helpers');
const { createStore } = require('../src/store');
const { createSeats } = require('../src/seats');
const { createRunner } = require('../src/runner');

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { on() {}, end() {} };
  c.kill = () => true;
  return c;
}
function setup(spawned) {
  const dir = tmpDir('ob-shutdown-');
  const store = createStore(path.join(dir, 'project'));
  store.ensure();
  const broadcast = () => {};
  const seats = createSeats({ store, broadcast });
  const limits = { refreshCodex() {}, claudeLimits() {} };
  const spawnFn = () => { const c = fakeChild(); spawned.push(c); return c; };
  const runner = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast, spawnFn, detectVersions: false, retryDelaysMs: [] });
  const seat = seats.all().find((s) => s.agent === 'claude') || seats.all()[0];
  return { store, seats, runner, seat };
}

test('shutdown: no CLI child starts after it, and a queued turn is not run', async () => {
  const spawned = [];
  const { runner, seat } = setup(spawned);
  runner.shutdown();
  const res = await runner.runSeat(seat.id, 'hello', {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'stopped');
  assert.equal(spawned.length, 0, 'no spawn after shutdown');
});

test('a turn queued behind a running turn resolves as stopped when its signal aborts, and never spawns', async () => {
  const spawned = [];
  const { runner, seat } = setup(spawned);
  const first = runner.runSeat(seat.id, 'long turn', {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 1, 'the first turn is running');
  const ac = new AbortController();
  const second = runner.runSeat(seat.id, 'queued turn', { signal: ac.signal });
  ac.abort();
  const cut = await second;
  assert.equal(cut.ok, false);
  assert.equal(cut.error, 'stopped');
  spawned[0].emit('close', 1, null); // let the running turn end
  await first;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 1, 'the cancelled turn never spawned a CLI');
});

test('a corrupt seats.json is copied aside instead of being replaced silently', () => {
  const dir = tmpDir('ob-corrupt-');
  const store = createStore(path.join(dir, 'project'));
  store.ensure();
  store.write('seats.json', '{"truncated": ');
  const seats = createSeats({ store, broadcast() {} });
  assert.ok(seats.all().length > 0, 'defaults are used for the running board');
  const kept = fs.readdirSync(store.orch).filter((f) => f.startsWith('seats.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(store.orch, kept[0]), 'utf8'), '{"truncated": ');
});

test('atomic store write: the target is replaced whole and no temp file is left behind', () => {
  const dir = tmpDir('ob-atomic-');
  const store = createStore(path.join(dir, 'project'));
  store.ensure();
  store.write('notes.txt', 'first');
  store.write('notes.txt', 'second');
  assert.equal(store.read('notes.txt'), 'second');
  assert.deepEqual(fs.readdirSync(store.orch).filter((f) => f.endsWith('.tmp')), []);
});

test('user-facing hints never tell users to run the unrelated `orchestra-board` package', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'doctor.js'), 'utf8');
  assert.ok(!/(^|[^-\w])orchestra-board\s+<projectDir>/.test(src), 'doctor hints use agent-orchestra-board');
});
