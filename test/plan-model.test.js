// Plan model: validation, hashing, owner areas, topological order, role fallback. No server, no CLI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pm = require('../src/workflows/plan-model');
const { httpError } = require('../src/util');

const item = (over = {}) => ({
  id: 'alpha', title: 'Alpha', spec: 'Do alpha.', owns: ['src/alpha.js'],
  dependsOn: [], difficulty: 'easy', seatId: null, ...over,
});
const plan = (items, goal = 'Build things') => ({ goal, items });
const throwsWith = (fn, message) => assert.throws(fn, (e) => e instanceof Error && e.message === message);
const seats = (...ids) => (id) => ids.includes(id);

test('a valid plan round-trips; planHash is stable across key order and changes with one field', () => {
  const raw = plan([item(), item({ id: 'beta', owns: ['src/beta'], dependsOn: ['alpha'], difficulty: 'hard' })]);
  const v = pm.validatePlan(raw);
  assert.deepEqual(pm.validatePlan(v), v, 'validated plan validates again unchanged');
  assert.equal(v.goal, 'Build things');
  assert.equal(v.items[1].difficulty, 'hard');

  const reordered = {
    items: [{ seatId: null, difficulty: 'easy', dependsOn: [], owns: ['src/alpha.js'], spec: 'Do alpha.', title: 'Alpha', id: 'alpha' }],
    goal: 'Build things',
  };
  assert.equal(pm.planHash(pm.validatePlan(reordered)), pm.planHash(pm.validatePlan(plan([item()]))));
  const changed = plan([item({ spec: 'Do alpha differently.' })]);
  assert.notEqual(pm.planHash(pm.validatePlan(changed)), pm.planHash(pm.validatePlan(plan([item()]))));
  assert.match(pm.planHash(v), /^[0-9a-f]{64}$/);
});

test('canonicalJson sorts keys recursively, keeps array order and drops undefined object values', () => {
  assert.equal(pm.canonicalJson({ b: [2, 1], a: { d: 1, c: undefined, b: null } }), '{"a":{"b":null,"d":1},"b":[2,1]}');
  assert.equal(pm.itemHash({ x: 1, y: 2 }), pm.itemHash({ y: 2, x: 1, z: undefined }));
});

test('validatePlan: every error message', () => {
  const v = (raw) => () => pm.validatePlan(raw);
  throwsWith(v(null), 'plan must be an object');
  throwsWith(v(plan([item()], '')), 'plan.goal is required (max 8000 characters)');
  throwsWith(v(plan([item()], 'x'.repeat(8001))), 'plan.goal is required (max 8000 characters)');
  throwsWith(v(plan([])), 'plan.items must be a list of 1-30 items');
  throwsWith(v(plan(Array.from({ length: 31 }, (_, i) => item({ id: 'i' + i })))), 'plan.items must be a list of 1-30 items');
  throwsWith(v(plan([item({ id: 'Bad_ID' })])), 'item 1: id must match ^[a-z0-9][a-z0-9-]{0,31}$');
  throwsWith(v(plan([item(), item()])), 'duplicate item id "alpha"');
  throwsWith(v(plan([item({ title: '' })])), 'item "alpha": title is required (max 120 characters)');
  throwsWith(v(plan([item({ title: 'x'.repeat(121) })])), 'item "alpha": title is required (max 120 characters)');
  throwsWith(v(plan([item({ spec: '   ' })])), 'item "alpha": spec is required (max 4000 characters)');
  throwsWith(v(plan([item({ owns: [] })])), 'item "alpha": owns must list 1-20 paths');
  throwsWith(v(plan([item({ owns: Array.from({ length: 21 }, (_, i) => 'd' + i) })])), 'item "alpha": owns must list 1-20 paths');
  throwsWith(v(plan([item({ dependsOn: 'beta' })])), 'item "alpha": dependsOn must be a list of item ids');
  throwsWith(v(plan([item({ dependsOn: [3] })])), 'item "alpha": dependsOn must be a list of item ids');
  throwsWith(v(plan([item({ dependsOn: ['ghost'] })])), 'item "alpha" depends on unknown item "ghost"');
  throwsWith(v(plan([item({ dependsOn: ['alpha'] })])), 'item "alpha" depends on itself');
  throwsWith(v(plan([item({ difficulty: 'expert' })])), 'item "alpha": difficulty must be easy, medium or hard');
  throwsWith(v(plan([item({ seatId: 'has space' })])), 'item "alpha": seatId is not a valid id');
  throwsWith(v(plan([item({ id: 'a', owns: ['src'] }), item({ id: 'b', owns: ['src/x.js'] })])), 'items "a" and "b" overlap on "src"');
  throwsWith(
    v(plan([item({ id: 'a', dependsOn: ['b'], owns: ['x'] }), item({ id: 'b', dependsOn: ['a'], owns: ['y'] })])),
    'dependency cycle: a -> b -> a',
  );
  throwsWith(
    v(plan([item({ id: 'a', dependsOn: ['c'], owns: ['x'] }), item({ id: 'b', dependsOn: ['a'], owns: ['y'] }), item({ id: 'c', dependsOn: ['b'], owns: ['z'] })])),
    'dependency cycle: a -> c -> b -> a',
  );
});

test('validatePlan drops unknown keys, trims strings, treats blank seatId as null and dedupes owns', () => {
  const v = pm.validatePlan({
    goal: '  g  ', extra: 1,
    items: [{ id: ' alpha ', title: ' T ', spec: ' S ', owns: ['src/a', './src/a/', 'src/a'], dependsOn: undefined, difficulty: 'medium', seatId: '  ', junk: true }],
  });
  assert.equal(v.goal, 'g');
  assert.equal(v.items[0].id, 'alpha');
  assert.deepEqual(v.items[0].owns, ['src/a']);
  assert.deepEqual(v.items[0].dependsOn, []);
  assert.equal(v.items[0].seatId, null);
  assert.equal('junk' in v.items[0], false);
});

test('normalizeArea normalizes and rejects bad paths', () => {
  assert.equal(pm.normalizeArea('src\\a\\'), 'src/a');
  assert.equal(pm.normalizeArea('./src//b'), 'src/b');
  for (const [input, why] of [
    ['/abs', 'absolute paths are not allowed'],
    ['C:/x', 'absolute paths are not allowed'],
    ['../x', '"." and ".." segments are not allowed'],
    ['a/*.js', 'wildcards are not allowed'],
    ['.git/x', '.git and .orchestra cannot be owned'],
    ['.ORCHESTRA', '.git and .orchestra cannot be owned'],
    ['.git./x', 'segments ending in a dot or space are not allowed (NTFS aliases)'],
    ['.git /x', 'segments ending in a dot or space are not allowed (NTFS aliases)'],
    ['.orchestra./x', 'segments ending in a dot or space are not allowed (NTFS aliases)'],
    ['.git::$INDEX_ALLOCATION', 'colons are not allowed (NTFS alternate data streams)'],
    ['src/a.js:evil', 'colons are not allowed (NTFS alternate data streams)'],
    ['src/a.js.', 'segments ending in a dot or space are not allowed (NTFS aliases)'],
    ['', 'empty'],
    ['a\0b', 'NUL byte or not a string'],
    [42, 'NUL byte or not a string'],
    ['x'.repeat(201), 'too long'],
  ]) {
    assert.throws(() => pm.normalizeArea(input), (e) => e.message === `invalid owner area "${input}": ${why}`, String(input));
  }
});

test('validatePlan rejects NTFS aliases so two items cannot own the same file', () => {
  assert.throws(
    () => pm.validatePlan(plan([item({ id: 'a', owns: ['src/a.js'] }), item({ id: 'b', owns: ['src/a.js.'] })])),
    (e) => e instanceof Error && e.message === 'invalid owner area "src/a.js.": segments ending in a dot or space are not allowed (NTFS aliases)',
  );
  assert.throws(
    () => pm.validatePlan(plan([item({ owns: ['.git./config'] })])),
    (e) => e instanceof Error && e.message.startsWith('invalid owner area ".git./config": '),
  );
});

test('areasOverlap and pathInAreas are case-sensitive and prefix-aware', () => {
  assert.equal(pm.areasOverlap('src', 'src/a'), true);
  assert.equal(pm.areasOverlap('src', 'srcx'), false);
  assert.equal(pm.areasOverlap('SRC/A', 'src/a', { platform: 'linux' }), false);
  assert.equal(pm.areasOverlap('src', 'SRC', { platform: 'linux' }), false);
  assert.equal(pm.pathInAreas('SRC/Lib/x.js', ['src/lib']), false);
  assert.equal(pm.pathInAreas('src/lib/x.js', ['src/lib']), true);
  assert.equal(pm.pathInAreas('src/libx.js', ['src/lib']), false);
  assert.equal(pm.pathInAreas('../escape', ['src']), false, 'invalid file is false, not a throw');
});

test('validatePlan accepts case-distinct areas on linux and refuses them on case-insensitive platforms', () => {
  assert.equal(pm.areasOverlap('SRC/A', 'src/a', { platform: 'win32' }), true);
  assert.equal(pm.areasOverlap('SRC', 'src/a', { platform: 'darwin' }), true);
  assert.equal(pm.areasOverlap('SRC', 'srcx', { platform: 'darwin' }), false);
});

test('pathCaseConflict refuses a path differing from an owned path only by case on win32 and darwin', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.equal(pm.pathCaseConflict('SRC/evil.js', ['src'], { platform }), true, platform);
    assert.equal(pm.pathCaseConflict('src/Lib/x.js', ['src/lib'], { platform }), true, platform);
    assert.equal(pm.pathCaseConflict('src/lib/x.js', ['src/lib'], { platform }), false, platform);
    assert.equal(pm.pathCaseConflict('other/x.js', ['src'], { platform }), false, platform);
  }
  assert.equal(pm.pathCaseConflict('SRC/evil.js', ['src'], { platform: 'linux' }), false);
  assert.equal(pm.pathCaseConflict('../x', ['src'], { platform: 'win32' }), false);
});

test('topoOrder respects dependsOn and is stable for ties', () => {
  const items = [
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['c'] },
    { id: 'c', dependsOn: [] },
    { id: 'd', dependsOn: [] },
  ];
  assert.deepEqual(pm.topoOrder(items), ['a', 'c', 'b', 'd']);
  assert.deepEqual(pm.topoOrder([{ id: 'x', dependsOn: [] }, { id: 'y', dependsOn: [] }]), ['x', 'y']);
});

test('resolveRoles: fallback, notes and the error cases', () => {
  const only = pm.resolveRoles({ easy: 'a' }, seats('a'));
  for (const r of pm.ROLES) assert.equal(only.resolved[r], 'a');
  assert.ok(only.notes.length > 0);
  assert.ok(only.notes.includes('hard uses the easy agent'));

  const two = pm.resolveRoles({ hard: 'h', easy: 'e' }, seats('h', 'e'));
  assert.equal(two.resolved.medium, 'h');
  assert.equal(two.resolved.manager, 'h');
  assert.equal(two.resolved.easy, 'e');

  const blank = pm.resolveRoles({ hard: 'h', easy: '' }, seats('h'));
  assert.equal(blank.resolved.easy, 'h');

  throwsWith(() => pm.resolveRoles({ hard: 'ghost' }, seats('h')), 'role "hard": no such agent');
  throwsWith(() => pm.resolveRoles({ wizard: 'h' }, seats('h')), 'unknown role "wizard"');
  throwsWith(() => pm.resolveRoles({}, seats('h')), 'assign an agent to at least one role');
  throwsWith(() => pm.resolveRoles({ hard: null }, seats('h')), 'assign an agent to at least one role');
  throwsWith(() => pm.resolveRoles('hard', seats('h')), 'roles must be an object');
});

test('seatForItem prefers an existing item seat, else the difficulty role', () => {
  const resolved = { manager: 'm', hard: 'h', medium: 'm', easy: 'e', reviewer: 'r' };
  assert.equal(pm.seatForItem({ seatId: 'x', difficulty: 'hard' }, resolved, seats('x')), 'x');
  assert.equal(pm.seatForItem({ seatId: 'gone', difficulty: 'hard' }, resolved, seats('h')), 'h');
  assert.equal(pm.seatForItem({ seatId: null, difficulty: 'easy' }, resolved, seats()), 'e');
});

test('reviewerFor: self with one seat, a different reviewer with two', () => {
  assert.deepEqual(pm.reviewerFor('a', { manager: 'a', hard: 'a', medium: 'a', easy: 'a', reviewer: 'a' }), { reviewerId: 'a', self: true });
  assert.deepEqual(pm.reviewerFor('a', { manager: 'a', hard: 'a', medium: 'a', easy: 'a', reviewer: 'b' }), { reviewerId: 'b', self: false });
  assert.deepEqual(pm.reviewerFor('e', { manager: 'm', hard: 'h', medium: 'e', easy: 'e', reviewer: 'e' }), { reviewerId: 'm', self: false });
});

test('extractJson: fenced block, bare JSON with prose, and garbage', () => {
  assert.deepEqual(pm.extractJson('Here:\n```json\n{"a": 1}\n```\nThanks'), { a: 1 });
  assert.deepEqual(pm.extractJson('Sure. {"goal": "g", "items": []} Hope it helps.'), { goal: 'g', items: [] });
  assert.throws(() => pm.extractJson('no braces here'), (e) => e.message === 'no JSON object found in the reply');
  assert.throws(() => pm.extractJson('{"a": }'), (e) => e.message.startsWith('the reply is not valid JSON: '));
  assert.throws(() => pm.extractJson('```json\n{oops}\n```'), (e) => e.message.startsWith('the reply is not valid JSON: '));
});

test('httpError sets message, status, code and expose', () => {
  const e = httpError(409, 'plan-stale', 'approval-stale');
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'plan-stale');
  assert.equal(e.status, 409);
  assert.equal(e.code, 'approval-stale');
  assert.equal(e.expose, true);
  assert.equal(httpError(404, 'gone').code, null);
});

test('plan-model.js names no agent or model', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workflows', 'plan-model.js'), 'utf8');
  assert.doesNotMatch(src, /\b(astra|sol|fable|luna|opus|sonnet|haiku|gpt-|claude-)\b/i);
});

// ---- acceptance checks are off unless the owner turns them on ----
const CK = [{ name: 'unit', cmd: 'node --test test/a.test.js' }];

test('a manager plan never carries live checks: they become proposedChecks and checksEnabled stays unset', () => {
  const v = pm.validatePlan({ ...plan([item({ checks: CK })]), checksEnabled: true }, { source: 'manager' });
  assert.equal(v.items[0].checks, undefined);
  assert.deepEqual(v.items[0].proposedChecks, CK);
  assert.equal(v.checksEnabled, undefined, 'a manager cannot switch checks on');
  const again = pm.validatePlan(v, { source: 'manager' });
  assert.deepEqual(again, v, 'stable when validated again');
  assert.deepEqual(pm.validatePlan(v), v, 'an owner revalidating an untouched manager plan does not enable anything');
});

test('the owner path keeps checks live, sets checksEnabled, and checksEnabled:false turns them back into proposals', () => {
  const on = pm.validatePlan(plan([item({ checks: CK })]));
  assert.deepEqual(on.items[0].checks, CK); assert.equal(on.checksEnabled, true);
  assert.deepEqual(pm.validatePlan(on), on);
  const off = pm.validatePlan({ ...on, checksEnabled: false });
  assert.equal(off.items[0].checks, undefined); assert.deepEqual(off.items[0].proposedChecks, CK); assert.equal(off.checksEnabled, undefined);
});

test('turning checks on changes the plan hash, and so does editing one command', () => {
  const man = pm.validatePlan(plan([item({ checks: CK })]), { source: 'manager' });
  const turnedOn = pm.validatePlan({ ...man, items: [{ ...man.items[0], checks: man.items[0].proposedChecks, proposedChecks: undefined }] });
  assert.notEqual(pm.planHash(turnedOn), pm.planHash(man));
  const edited = pm.validatePlan({ ...turnedOn, items: [{ ...turnedOn.items[0], checks: [{ name: 'unit', cmd: 'node evil.js' }] }] });
  assert.notEqual(pm.planHash(edited), pm.planHash(turnedOn));
  assert.notEqual(pm.itemHash(turnedOn.items[0]), pm.itemHash(man.items[0]));
});

test('a plan without checks is unchanged by the checks rules; bad checks are still rejected', () => {
  const v = pm.validatePlan(plan([item()]), { source: 'manager' });
  assert.deepEqual(Object.keys(v), ['goal', 'items']);
  assert.deepEqual(Object.keys(v.items[0]).sort(), ['dependsOn', 'difficulty', 'id', 'owns', 'seatId', 'spec', 'title']);
  assert.throws(() => pm.validatePlan(plan([item({ checks: [{ name: 'x', cmd: '' }] })]), { source: 'manager' }), /needs a cmd string/);
  assert.throws(() => pm.validatePlan(plan([item({ proposedChecks: new Array(6).fill(CK[0]) })])), /at most 5/);
});
