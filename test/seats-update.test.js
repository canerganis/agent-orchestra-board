// Seat updates through the API keep the fields the request leaves out. Found by the real CLI demo recorder: an update
// with only a model and effort turned a Claude seat into a Codex seat, which then sent a Claude model to Codex.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, rmrf } = require('./helpers');
const { createStore } = require('../src/store');
const { createSeats } = require('../src/seats');

function seatsIn(dir) {
  const store = createStore(dir); store.ensure();
  store.writeJson('seats.json', [
    { id: 'claude', name: 'Claude', role: 'Builder', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', perm: 'write', target: '', budget: 0, color: '#7aa2ff', thread: null, used: 0, cost: 0 },
  ]);
  return createSeats({ store, broadcast: () => {} });
}

test('an update without agent, effort or perm keeps the seat agent, effort and permission', () => {
  const dir = tmpDir('ob-seat-upd-');
  try {
    const seats = seatsIn(dir);
    const s = seats.upsertSeat({ id: 'claude', model: 'claude-haiku-5-5' });
    assert.equal(s.agent, 'claude');
    assert.equal(s.model, 'claude-haiku-5-5');
    assert.equal(s.effort, 'high');
    assert.equal(s.perm, 'write');
  } finally { rmrf(dir); }
});

test('explicit fields still change the seat, and a new seat without agent defaults to Codex as before', () => {
  const dir = tmpDir('ob-seat-upd-');
  try {
    const seats = seatsIn(dir);
    const s = seats.upsertSeat({ id: 'claude', agent: 'codex', model: 'gpt-6-luna', effort: 'low', perm: 'read' });
    assert.equal(s.agent, 'codex'); assert.equal(s.effort, 'low'); assert.equal(s.perm, 'read');
    const n = seats.upsertSeat({ name: 'New' });
    assert.equal(n.agent, 'codex'); assert.equal(n.perm, 'read');
  } finally { rmrf(dir); }
});
