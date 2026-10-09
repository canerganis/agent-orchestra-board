// Router classifier: type, group, difficulty and reasons from plan item signals.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, GROUPS, TYPES } = require('../src/router/classify');

test('every type is reachable and maps to its group', () => {
  const cases = {
    plan: { id: 'a', title: 'Split the goal', spec: '', owns: [], type: 'plan' },
    arch: { id: 'b', title: 'Define the worker protocol', spec: '', owns: [] },
    research: { id: 'c', title: 'Measure cold start', spec: '', owns: [] },
    backend: { id: 'd', title: 'Add scoring helper', spec: '', owns: ['src/router/score.js'] },
    refactor: { id: 'e', title: 'Rename the runner helper', spec: '', owns: ['src/runner.js'] },
    security: { id: 'f', title: 'Guard the sandbox', spec: '', owns: ['src/sandbox.js'] },
    ui: { id: 'g', title: 'Restyle the board', spec: '', owns: ['public/app.css'] },
    tests: { id: 'h', title: 'Cover the router', spec: '', owns: ['test/router-classify.test.js'] },
    docs: { id: 'i', title: 'Document routing', spec: '', owns: ['docs/router.md'] },
  };
  const seen = new Set();
  for (const [want, item] of Object.entries(cases)) {
    const got = classify(item);
    assert.equal(got.type, want, `item ${item.id} should be ${want}`);
    assert.equal(got.group, GROUPS[want]);
    seen.add(got.type);
  }
  assert.deepEqual([...seen].sort(), [...TYPES].sort(), 'all 9 types covered');
  assert.equal(TYPES.length, 9);
});

test('a security path forces hard difficulty', () => {
  const got = classify({ id: 's1', title: 'Tidy session code', spec: '', owns: ['src/auth/session.js'] });
  assert.equal(got.type, 'security');
  assert.equal(got.group, 'security');
  assert.equal(got.difficulty, 'hard');
});

test('a security path wins over a planner hint of another type', () => {
  const got = classify({ id: 's2', title: 'Tidy', spec: '', owns: ['src/security/guard.js'], type: 'docs' });
  assert.equal(got.type, 'security', 'security is sticky at 3 or more points');
});

test('backslash paths are normalized', () => {
  const got = classify({ id: 's3', title: 'Tidy', spec: '', owns: ['src\\auth\\x.js'] });
  assert.equal(got.type, 'security');
});

test('a security keyword makes a security item (hard when it owns paths), and race or lock words force hard on any type', () => {
  const soft = classify({ id: 'h1', title: 'Escape handling', spec: '', owns: ['src/x.js'] });
  assert.equal(soft.type, 'security');
  assert.equal(soft.difficulty, 'hard', 'security type itself is hard');

  const race = classify({ id: 'h2', title: 'Fix the queue', spec: 'a race between two writers', owns: ['src/queue.js'] });
  assert.equal(race.difficulty, 'hard');
  const lock = classify({ id: 'h3', title: 'Fix the queue', spec: 'take the lock first', owns: ['src/queue.js'] });
  assert.equal(lock.difficulty, 'hard');
});

test('many owned paths raise difficulty to hard, and a few paths stay easy', () => {
  const many = Array.from({ length: 9 }, (_, i) => `src/part${i}.js`);
  assert.equal(classify({ id: 'm1', title: 'Big change', spec: '', owns: many }).difficulty, 'hard');

  const few = ['src/a.js', 'src/b.js', 'src/c.js'];
  assert.equal(classify({ id: 'm2', title: 'Small change', spec: '', owns: few }).difficulty, 'easy');
});

test('arch and plan items are not upgraded without a spec rule', () => {
  const got = classify({ id: 'n1', title: 'Migrate the store', spec: '', owns: ['src/store.js'], type: 'plan' });
  assert.equal(got.type, 'plan');
  assert.equal(got.difficulty, 'easy');
});

test('difficulty is never lowered by a rule', () => {
  const got = classify({ id: 'n2', title: 'Fix the queue', spec: 'a race between writers', owns: ['src/queue.js'], type: 'plan' });
  assert.equal(got.difficulty, 'hard');
});

test('a security item with no owned paths is not forced to hard', () => {
  const got = classify({ id: 'n3', title: 'Investigate injection', spec: '', owns: [] });
  assert.equal(got.type, 'security');
  assert.equal(got.difficulty, 'easy');
});

test('an item with no signals defaults to backend and still explains itself', () => {
  const got = classify({ id: 'z1', title: 'Misc', spec: '', owns: [] });
  assert.equal(got.type, 'backend');
  assert.equal(got.difficulty, 'easy');
  assert.ok(got.reasons.some((r) => /defaulted to backend/.test(r)));
});

test('reasons are always a non-empty array of strings', () => {
  const items = [
    { id: 'r1', title: 'Split the goal', spec: '', owns: [], type: 'plan' },
    { id: 'r2', title: 'Guard the sandbox', spec: '', owns: ['src/sandbox.js'] },
    { id: 'r3', title: 'Cover', spec: '', owns: ['test/x.test.js'] },
    { id: 'r4', title: 'Tiny', spec: '', owns: ['src/x.js'] },
    {},
    undefined,
  ];
  for (const item of items) {
    const got = classify(item);
    assert.ok(Array.isArray(got.reasons));
    assert.ok(got.reasons.length > 0);
    for (const r of got.reasons) assert.equal(typeof r, 'string');
    assert.ok(TYPES.includes(got.type));
    assert.ok(['easy', 'medium', 'hard'].includes(got.difficulty));
  }
});

test('planner hint with an unknown type is ignored', () => {
  const got = classify({ id: 'p1', title: 'Misc', spec: '', owns: [], type: 'feature' });
  assert.equal(got.type, 'backend');
});
