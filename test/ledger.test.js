const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendRecord, readRecords, summarize } = require('../src/ledger');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('appendRecord creates the directory and reads records back', () => {
  withTempDir((root) => {
    const dir = path.join(root, 'nested');
    appendRecord(dir, { room: 'r1', item: 'i1', role: 'build', model: 'm1' });
    const records = readRecords(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].room, 'r1');
    assert.equal(records[0].ts, new Date(records[0].ts).toISOString());
  });
});

test('readRecords skips malformed lines', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'ledger.jsonl'), '{"item":"ok"}\nnot json\n{"item":"also ok"}\n');
    assert.deepEqual(readRecords(dir), [{ item: 'ok' }, { item: 'also ok' }]);
  });
});

test('appendRecord drops unknown fields', () => {
  withTempDir((dir) => {
    appendRecord(dir, { item: 'i1', prompt: 'private', response: 'private', extra: true });
    const record = readRecords(dir)[0];
    assert.equal(record.item, 'i1');
    assert.equal(Object.hasOwn(record, 'prompt'), false);
    assert.equal(Object.hasOwn(record, 'response'), false);
    assert.equal(Object.hasOwn(record, 'extra'), false);
  });
});

test('summarize aggregates model and task type metrics', () => {
  const stats = summarize([
    { room: 'r1', item: 'i1', attempt: 1, role: 'build', model: 'm1', taskType: 'feature', outcome: 'pass', tokens: 100, ms: 10 },
    { room: 'r1', item: 'i1', attempt: 1, role: 'review', model: 'm2', taskType: 'feature', outcome: 'pass', tokens: 20, ms: 5 },
    { room: 'r1', item: 'i1', attempt: 1, role: 'fix', model: 'm1', taskType: 'feature', outcome: 'applied', tokens: 30, ms: 6 },
    { room: 'r1', item: 'i2', attempt: 2, role: 'build', model: 'm1', taskType: 'bugfix', outcome: 'fail', tokens: 40, ms: 4 },
  ]);

  assert.deepEqual(stats.models.m1, {
    attempts: 2, passedFirstReview: 1, fixes: 1, tokens: 170, ms: 20, tokensPerAccepted: 170,
  });
  assert.deepEqual(stats.models.m2, {
    attempts: 0, passedFirstReview: 0, fixes: 0, tokens: 20, ms: 5, tokensPerAccepted: 0,
  });
  assert.deepEqual(stats.taskTypes.feature, {
    attempts: 1, passedFirstReview: 1, fixes: 1, tokens: 150, ms: 21, tokensPerAccepted: 150,
  });
  assert.deepEqual(stats.taskTypes.bugfix, {
    attempts: 1, passedFirstReview: 0, fixes: 0, tokens: 40, ms: 4, tokensPerAccepted: 0,
  });
});

test('summarize uses review outcome for first-review pass and acceptance', () => {
  const base = { room: 'r1', item: 'i1', model: 'm1', taskType: 'feature', tokens: 10, ms: 1 };
  const stats = summarize([
    { ...base, attempt: 1, role: 'build', outcome: 'pass' },
    { ...base, attempt: 1, role: 'review', outcome: 'fail', model: 'm2' },
    { ...base, attempt: 2, role: 'build', outcome: 'pass' },
    { ...base, attempt: 2, role: 'review', outcome: 'pass', model: 'm2' },
  ]);
  assert.equal(stats.models.m1.attempts, 2);
  assert.equal(stats.models.m1.passedFirstReview, 0);
  assert.equal(stats.models.m1.tokensPerAccepted, 20);

  const rejected = summarize([
    { ...base, attempt: 1, role: 'build', outcome: 'pass' },
    { ...base, attempt: 1, role: 'review', outcome: 'fail' },
  ]);
  assert.equal(rejected.models.m1.passedFirstReview, 0);
  assert.equal(rejected.models.m1.tokensPerAccepted, 0);
});

test('summarize is safe for prototype-like keys', () => {
  const stats = summarize([
    { room: 'r', item: 'i', attempt: 1, role: 'build', model: '__proto__', taskType: 'constructor', outcome: 'pass', tokens: 5 },
    { room: 'r', item: 'i', attempt: 1, role: 'build', model: 'constructor', taskType: '__proto__', outcome: 'pass', tokens: 7 },
  ]);
  assert.equal(stats.models['__proto__'].tokens, 5);
  assert.equal(stats.models.constructor.tokens, 7);
  assert.equal(stats.taskTypes.constructor.tokens, 5);
  assert.equal(stats.taskTypes['__proto__'].tokens, 7);
  assert.equal(Object.prototype.tokens, undefined);
  assert.equal(({}).attempts, undefined);
});
