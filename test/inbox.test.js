const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cardsFor, PRIORITY } = require('../src/inbox');

const build = (items, extra = {}) => ({ id: 'b1', kind: 'build', mode: 'write', status: 'stopped', title: 'Build', order: items.map((i) => i.id), items: Object.fromEntries(items.map((i) => [i.id, i])), ...extra });
const one = (state) => { const c = cardsFor(state); assert.equal(c.length, 1); return c[0]; };

test('empty and malformed state give no cards', () => {
  assert.deepEqual(cardsFor(), []);
  assert.deepEqual(cardsFor({}), []);
  assert.deepEqual(cardsFor({ rooms: [null, { kind: 'build' }] }), []);
});

test('plan awaiting approval', () => {
  const c = one({ rooms: [{ id: 'p1', kind: 'plan', status: 'awaiting-approval', planRevision: 2, plan: { goal: 'G', items: [{}, {}] } }] });
  assert.equal(c.kind, 'plan-approval');
  assert.equal(c.roomId, 'p1');
  assert.deepEqual(c.actions.map((a) => a.id), ['approve', 'edit', 'reject']);
  assert.ok(c.evidence.includes('2 item(s)'));
  assert.equal(cardsFor({ rooms: [{ id: 'p2', kind: 'plan', status: 'approved' }] }).length, 0);
});

test('item needing apply', () => {
  const it = { id: 'a', status: 'passed', proposal: { file: 'x.diff', hash: 'h', files: ['f.js'] }, review: { verdict: 'pass', hash: 'h' } };
  const c = one({ rooms: [build([it])] });
  assert.equal(c.kind, 'apply'); assert.equal(c.itemId, 'a'); assert.equal(c.id, 'apply:b1:a');
  const stale = { ...it, review: { verdict: 'pass', hash: 'other' } };
  assert.equal(cardsFor({ rooms: [build([stale])] }).length, 0);
  assert.equal(cardsFor({ rooms: [build([{ ...it, status: 'applied' }])] }).length, 0);
});

test('no apply card while the build is running or a dependency is unapplied', () => {
  const it = { id: 'a', status: 'passed', proposal: { file: 'x.diff', hash: 'h', files: [] }, review: { verdict: 'pass', hash: 'h' } };
  assert.equal(cardsFor({ rooms: [build([it], { status: 'running' })] }).length, 0);
  const dep = { id: 'd', status: 'passed' };
  const b = build([dep, { ...it, id: 'a', dependsOn: ['d'] }]);
  assert.equal(cardsFor({ rooms: [b] }).filter((c) => c.itemId === 'a').length, 0);
  b.items.d.status = 'applied';
  assert.equal(cardsFor({ rooms: [b] }).filter((c) => c.itemId === 'a').length, 1);
});

test('no failed-check card while the agent is auto-fixing', () => {
  const results = { results: [{ name: 'unit', ok: false, code: 1 }] };
  for (const status of ['pending', 'building', 'checking', 'reviewing']) {
    assert.equal(cardsFor({ rooms: [build([{ id: 'a', status, checkResults: results }], { status: 'running' })] }).length, 0, status);
  }
});

test('quarantined card offers no retry', () => {
  const c = one({ rooms: [build([{ id: 'a', status: 'quarantined' }], { status: 'error' })] });
  assert.deepEqual(c.actions.map((a) => a.id), ['inspect', 'discard']);
});

test('failed checks list each failing check', () => {
  const it = { id: 'a', status: 'passed', checkResults: { results: [{ name: 'lint', ok: true }, { name: 'unit', ok: false, code: 1, output: 'boom' }] } };
  const c = one({ rooms: [build([it])] });
  assert.equal(c.kind, 'failed-check');
  assert.equal(c.evidence.length, 1);
  assert.match(c.evidence[0], /unit.*exit 1.*boom/);
});

test('quarantined, needs-artifact, needs-you and failed items', () => {
  const kinds = (status) => one({ rooms: [build([{ id: 'a', status, error: 'why' }])] }).kind;
  assert.equal(kinds('quarantined'), 'quarantined');
  assert.equal(kinds('needs-artifact'), 'needs-artifact');
  assert.equal(kinds('needs-you'), 'item-failed');
  assert.equal(kinds('failed'), 'item-failed');
  assert.deepEqual(one({ rooms: [build([{ id: 'a', status: 'quarantined', error: 'why' }])] }).evidence, ['why']);
});

test('paused build and quota stop', () => {
  assert.equal(one({ rooms: [build([], { status: 'paused' })] }).kind, 'paused');
  const q = one({ rooms: [build([], { status: 'stopped', stopReason: 'quota', quotaStop: { seat: 'codex', resetsAt: '14:00' } })] });
  assert.equal(q.kind, 'quota-stop');
  assert.deepEqual(q.evidence, ['codex', 'resets at 14:00']);
});

test('ordering by priority, then stable by room and item; rooms may be an object', () => {
  const rooms = {
    z: { id: 'z', kind: 'plan', status: 'awaiting-approval', plan: { items: [] } },
    b2: build([{ id: 'n', status: 'needs-artifact' }, { id: 'm', status: 'needs-artifact' }], { id: 'b2' }),
    b1: build([{ id: 'q', status: 'quarantined' }], { id: 'b1', status: 'paused' }),
  };
  const got = cardsFor({ rooms }).map((c) => c.id);
  assert.deepEqual(got, ['quarantined:b1:q', 'needs-artifact:b2:m', 'needs-artifact:b2:n', 'plan-approval:z', 'paused:b1']);
  const pr = cardsFor({ rooms }).map((c) => c.priority);
  assert.deepEqual(pr, [...pr].sort((a, b) => a - b));
  assert.deepEqual(cardsFor({ rooms: Object.values(rooms).reverse() }).map((c) => c.id), got);
  assert.ok(PRIORITY.quarantined < PRIORITY.paused);
});

test('pure: does not mutate state', () => {
  const state = { rooms: [build([{ id: 'a', status: 'needs-you' }], { status: 'paused' })] };
  const before = JSON.stringify(state);
  cardsFor(state);
  assert.equal(JSON.stringify(state), before);
});
