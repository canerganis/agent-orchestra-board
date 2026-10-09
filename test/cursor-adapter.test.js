// Cursor adapter: buildArgs shape and parseLine against recorded-style fixtures (UNVERIFIED, no real CLI is run).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cursor = require('../src/adapters/cursor');

const load = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'cursor', name), 'utf8').split('\n').filter(Boolean).flatMap((l) => cursor.parseLine(l));

test('cursor buildArgs: read-only flags, model, prompt last after --', () => {
  const a = cursor.buildArgs({ model: 'gpt-5', effort: 'high', prompt: '-hello world', mode: 'read' });
  assert.deepEqual(a.slice(0, 3), ['-p', '--output-format', 'stream-json']);
  assert.equal(a[a.indexOf('--model') + 1], 'gpt-5');
  assert.equal(a[a.indexOf('--mode') + 1], 'ask');
  assert.equal(a[a.indexOf('--sandbox') + 1], 'enabled');
  assert.deepEqual(a.slice(-2), ['--', '-hello world']);
  assert.ok(!a.includes('--force') && !a.includes('--yolo') && !a.includes('-f'));
  assert.ok(cursor.CURSOR_MODELS.includes('auto'));
});

test('cursor buildArgs: write mode and missing prompt are refused', () => {
  assert.throws(() => cursor.buildArgs({ model: 'm', effort: 'low', prompt: 'x', mode: 'write' }), /read-only/);
  assert.throws(() => cursor.buildArgs({ model: 'm', effort: 'low', prompt: '' }), /prompt/);
});

test('cursor parseLine: normal turn', () => {
  const ev = load('normal.jsonl');
  assert.deepEqual(ev[0], { type: 'thread', id: 'c0ffee00-1111-4222-8333-444455556666', model: 'Claude 4 Sonnet' });
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'The file exports one function.');
  assert.deepEqual(ev.at(-1), { type: 'done', result: null });
  assert.ok(!ev.some((e) => e.type === 'error' || e.type === 'usage'));
});

test('cursor parseLine: tool calls, failed result, generic function form', () => {
  const ev = load('tool.jsonl').filter((e) => e.type === 'tool');
  assert.deepEqual(ev[0], { type: 'tool', id: 'call-1', name: 'read', input: { path: 'C:\\proj\\src\\a.js' } });
  assert.deepEqual(ev[1], { type: 'tool', id: 'call-2', name: 'read', input: { path: 'C:\\proj\\src\\missing.js' } });
  assert.deepEqual(ev[2], { type: 'tool', id: 'call-2', failed: true });
  assert.deepEqual(ev[3], { type: 'tool', id: 'call-3', name: 'custom_tool', input: { q: 1 } });
  assert.equal(ev.length, 4);
});

test('cursor parseLine: errored result is fatal and still done', () => {
  const ev = load('error.jsonl');
  assert.deepEqual(ev.slice(1), [{ type: 'error', message: 'Usage limit reached for this plan', fatal: true }, { type: 'done', result: null }]);
});

test('cursor parseLine: junk lines and unknown types yield nothing', () => {
  for (const l of ['', '   ', 'not json', '[1]', '{"type":"future_event"}', '{bad', '{"type":"system","subtype":"other"}', '{"type":"assistant","message":{"content":[]}}']) assert.deepEqual(cursor.parseLine(l), [], l);
  assert.deepEqual(cursor.parseLine('{"type":"result"}'), [{ type: 'done', result: null }]);
  assert.deepEqual(cursor.parseLine(null), []);
});
