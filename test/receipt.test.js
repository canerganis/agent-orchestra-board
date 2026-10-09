// Change receipts: hashes, tampering and canonical key order.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeReceipt, verifyReceipt } = require('../src/receipt');

const patch = Buffer.from('diff --git a/x b/x\n+hello\n');
const patchHash = crypto.createHash('sha256').update(patch).digest('hex');
const input = (over = {}) => ({
  planHash: 'p'.repeat(64), itemId: 'it-1', itemHash: 'i'.repeat(64), baseCommit: 'abc123', patchBytes: patch,
  reviews: [{ reviewer: 'codex', verdict: 'PASS', hash: patchHash }],
  checks: [{ name: 'test', ok: true, code: 0 }],
  containment: { result: 'contained', cliVersion: '1.2.3' },
  ...over,
});

test('receipt: hashes the patch, lists facts and verifies', () => {
  const r = makeReceipt(input());
  assert.equal(r.patchHash, patchHash);
  assert.match(r.receiptHash, /^[0-9a-f]{64}$/);
  assert.ok(r.facts.length >= 3);
  assert.deepEqual(verifyReceipt(r, patch), { ok: true, problems: [] });
  assert.deepEqual(verifyReceipt(JSON.parse(JSON.stringify(r)), patch), { ok: true, problems: [] });
});

test('receipt: a tampered patch is detected', () => {
  const r = makeReceipt(input());
  const v = verifyReceipt(r, Buffer.concat([patch, Buffer.from('+evil\n')]));
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /patchHash/.test(p)));
});

test('receipt: a tampered field breaks receiptHash', () => {
  const r = makeReceipt(input());
  r.baseCommit = 'other';
  const v = verifyReceipt(r, patch);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /receiptHash/.test(p)));
});

test('receipt: a PASS review bound to another hash is a problem, a FAIL one is not', () => {
  const bad = makeReceipt(input({ reviews: [{ reviewer: 'claude', verdict: 'PASS', hash: 'f'.repeat(64) }] }));
  const v = verifyReceipt(bad, patch);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /another patch hash/.test(p)));
  const fail = makeReceipt(input({ reviews: [{ reviewer: 'claude', verdict: 'FAIL', hash: 'f'.repeat(64) }] }));
  assert.equal(verifyReceipt(fail, patch).ok, true);
});

test('receipt: key order does not change receiptHash, and no extra fields leak in', () => {
  const a = makeReceipt(input());
  const b = makeReceipt({
    containment: { cliVersion: '1.2.3', result: 'contained' },
    checks: [{ code: 0, ok: true, name: 'test' }],
    reviews: [{ hash: patchHash, verdict: 'PASS', reviewer: 'codex', prompt: 'secret prompt' }],
    patchBytes: patch, baseCommit: 'abc123', itemHash: 'i'.repeat(64), itemId: 'it-1', planHash: 'p'.repeat(64),
  });
  assert.equal(a.receiptHash, b.receiptHash);
  assert.ok(!JSON.stringify(b).includes('secret prompt'));
  const shuffled = Object.fromEntries(Object.entries(a).reverse());
  assert.deepEqual(verifyReceipt(shuffled, patch), { ok: true, problems: [] });
});

test('receipt: bad input is reported, not thrown', () => {
  assert.equal(verifyReceipt(null, patch).ok, false);
  assert.equal(makeReceipt(input({ containment: undefined })).containment, null);
});
