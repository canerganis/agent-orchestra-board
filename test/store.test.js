// Persistence: store.ensure() writes .orchestra/.gitignore once (session token never committed); rooms.load()
// skips a truncated or malformed room file and still loads the rooms after it. No CLI, no HTTP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/store');
const { createRooms } = require('../src/rooms');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ob-store-'));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {} };

test('ensure: creates .orchestra/ with a .gitignore that lists `session`; an existing .gitignore is never overwritten', () => {
  const dir = tmp();
  try {
    const store = createStore(dir);
    store.ensure();
    const gi = path.join(dir, '.orchestra', '.gitignore');
    assert.match(fs.readFileSync(gi, 'utf8'), /^session$/m);
    assert.match(fs.readFileSync(gi, 'utf8'), /^worktrees\/$/m);
    fs.writeFileSync(gi, '# mine\nsession\nrooms/\n');
    store.ensure();
    assert.equal(fs.readFileSync(gi, 'utf8'), '# mine\nsession\nrooms/\nworktrees/\ncapability.json\n');
  } finally { rm(dir); }
});

test('load: a truncated or malformed room file is skipped and logged; the rooms after it still load', () => {
  const dir = tmp();
  const errors = [];
  const origErr = console.error; console.error = (m) => errors.push(String(m));
  try {
    const store = createStore(dir); store.ensure();
    fs.mkdirSync(store.roomDir, { recursive: true });
    const room = (id, extra = {}) => ({ id, kind: 'meeting', title: id, status: 'running', created: new Date().toISOString(), round: 1, messages: [{ id: 'm1', seatId: 'ada', text: 'hi', streaming: true }], ...extra });
    fs.writeFileSync(path.join(store.roomDir, 'a-first.json'), JSON.stringify(room('a-first')));
    fs.writeFileSync(path.join(store.roomDir, 'b-truncated.json'), JSON.stringify(room('b-truncated')).slice(0, 40));
    fs.writeFileSync(path.join(store.roomDir, 'c-no-messages.json'), JSON.stringify({ id: 'c-no-messages', kind: 'dm', title: 'x' }));
    fs.writeFileSync(path.join(store.roomDir, 'd-last.json'), JSON.stringify(room('d-last', { kind: 'dm', seatId: 'ada' })));
    const seats = { seatById: (id) => (id === 'ada' ? { id, name: 'Ada' } : undefined), all: () => [], rtOf: () => ({}) };
    const rooms = createRooms({ store, seats, runner: {}, broadcast: () => {} });
    assert.deepEqual([...rooms.rooms.keys()].sort(), ['a-first', 'd-last']);
    assert.equal(rooms.rooms.get('a-first').status, 'stopped', 'a room that was running when the board died is marked stopped');
    assert.equal(rooms.rooms.get('a-first').messages[0].streaming, false);
    assert.equal(rooms.rooms.get('d-last').title, 'Chat with Ada');
    assert.equal(errors.filter((e) => /skipping unreadable room file/.test(e)).length, 2, errors.join('\n'));
    assert.ok(errors.some((e) => e.includes('b-truncated.json')) && errors.some((e) => e.includes('c-no-messages.json')));
  } finally { console.error = origErr; rm(dir); }
});
