// Regression tests for persisted state: an interrupted turn on load, the session ignore rule, and seat thread generations.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/store');
const { createRooms } = require('../src/rooms');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ob-hard-'));

test('a turn still streaming when the board stopped loads as a failed turn, not an empty success', () => {
  const dir = tmp();
  try {
    const store = createStore(dir);
    fs.mkdirSync(store.roomDir, { recursive: true });
    fs.writeFileSync(path.join(store.roomDir, 'r1.json'), JSON.stringify({
      id: 'r1', kind: 'meeting', title: 'T', status: 'running', messages: [
        { id: 'm1', seatId: 'ada', name: 'Ada', text: '', streaming: true },
        { id: 'm2', seatId: 'bob', name: 'Bob', text: 'done', streaming: false, error: null },
      ],
    }));
    const rooms = createRooms({ store, seats: { seatById: () => null }, runner: {}, broadcast: () => {} });
    const [m1, m2] = rooms.rooms.get('r1').messages;
    assert.equal(m1.streaming, false);
    assert.equal(m1.failed, true);
    assert.match(m1.error, /interrupted/);
    assert.equal(m2.failed, undefined, 'finished turns are left alone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an existing .orchestra/.gitignore keeps its lines and still ignores the session token', () => {
  const dir = tmp();
  try {
    const store = createStore(dir);
    fs.mkdirSync(store.orch, { recursive: true });
    fs.writeFileSync(path.join(store.orch, '.gitignore'), 'rooms/');
    store.ensure();
    const lines = fs.readFileSync(path.join(store.orch, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(lines.includes('rooms/'), 'own line kept');
    assert.ok(lines.includes('session'), 'session token ignored');
    store.ensure(); // idempotent
    assert.equal(fs.readFileSync(path.join(store.orch, '.gitignore'), 'utf8').split(/\r?\n/).filter((l) => l === 'session').length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a write whose directory resolves outside the project is refused', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const dir = tmp(), outside = tmp();
  try {
    const store = createStore(dir);
    fs.mkdirSync(store.orch, { recursive: true });
    fs.symlinkSync(outside, store.roomDir, 'dir');
    assert.throws(() => store.write(path.join('rooms', 'x.json'), '{}'), /outside the project/);
    assert.equal(fs.existsSync(path.join(outside, 'x.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});
