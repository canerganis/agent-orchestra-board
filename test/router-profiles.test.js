const test = require('node:test');
const assert = require('node:assert/strict');
const { updateProfile, shadowScore } = require('../src/router/profiles');

const M = 'claude-sonnet-5-5';
const pass = (extra) => ({ model: M, taskType: 'backend', outcome: 'pass', tokens: 10, ms: 5, attempt: 1, ...extra });

function many(k, extra) {
  let p = {};
  for (let i = 0; i < k; i++) p = updateProfile(p, pass(extra));
  return p;
}

test('board failure is ignored, other errors count', () => {
  const p = many(1);
  assert.deepEqual(updateProfile(p, { model: M, taskType: 'backend', outcome: 'error', reason: 'board' }), p);
  const q = updateProfile(p, { model: M, taskType: 'backend', outcome: 'error', reason: 'model', attempt: 1 });
  assert.equal(q[M].code.n, 2);
  assert.equal(q[M].code.firstPass, 1);
});

test('first pass and fixes are counted', () => {
  assert.equal(many(1)[M].code.firstPass, 1);
  const p = updateProfile({}, pass({ attempt: 3 }));
  assert.equal(p[M].code.fixes, 2);
  assert.equal(p[M].code.firstPass, 0);
  assert.equal(p[M].code.tokens, 10);
});

test('small samples are not confident', () => {
  const r2 = shadowScore(many(2), M, 'code', 0.5);
  assert.equal(r2.score, 0.5);
  assert.equal(r2.confident, false);
  assert.equal(shadowScore(many(7), M, 'code', 0.5).confident, false);
  assert.equal(shadowScore(many(8), M, 'code', 0.5).confident, true);
});

test('blend moves toward observations as n grows', () => {
  const s8 = shadowScore(many(8), M, 'code', 0.5).score;
  const s20 = shadowScore(many(20), M, 'code', 0.5).score;
  assert.ok(s20 > s8);
  assert.ok(s8 > 0.5);
  assert.ok(Math.abs(1 - s20) <= 0.15);
});

test('input profile is not mutated', () => {
  const p = many(2);
  const snap = JSON.stringify(p);
  updateProfile(p, pass());
  assert.equal(JSON.stringify(p), snap);
});
