// Gemini adapter: buildArgs shape and parseLine against recorded-style fixtures (UNVERIFIED, no real CLI is run).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gemini = require('../src/adapters/gemini');

const load = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'gemini', name), 'utf8').split('\n').filter(Boolean).flatMap((l) => gemini.parseLine(l));

test('gemini buildArgs: read-only flags, model, prompt last', () => {
  const a = gemini.buildArgs({ model: 'gemini-2.5-pro', effort: 'high', prompt: 'hello world', mode: 'read' });
  assert.deepEqual(a.slice(0, 2), ['--output-format', 'stream-json']);
  assert.equal(a[a.indexOf('-m') + 1], 'gemini-2.5-pro');
  assert.equal(a[a.indexOf('--approval-mode') + 1], 'plan');
  assert.deepEqual(a.slice(-2), ['-p', 'hello world']);
  const denied = a.flatMap((x, i) => (x === '--exclude-tools' ? [a[i + 1]] : []));
  for (const t of ['run_shell_command', 'write_file', 'replace']) assert.ok(denied.includes(t), t);
  assert.ok(!a.includes('--yolo') && !a.includes('auto_edit') && !a.includes('yolo'));
  assert.ok(gemini.GEMINI_MODELS.includes('gemini-2.5-pro'));
});

test('gemini buildArgs: write mode and missing prompt are refused', () => {
  assert.throws(() => gemini.buildArgs({ model: 'm', effort: 'low', prompt: 'x', mode: 'write' }), /read-only/);
  assert.throws(() => gemini.buildArgs({ model: 'm', effort: 'low', prompt: '' }), /prompt/);
});

test('gemini parseLine: normal turn', () => {
  const ev = load('normal.jsonl');
  assert.deepEqual(ev[0], { type: 'thread', id: '6f1c2d3e-aaaa-4bbb-8ccc-0123456789ab', model: 'gemini-2.5-pro' });
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'The file exports one function.');
  assert.deepEqual(ev.find((e) => e.type === 'usage'), { type: 'usage', tokens: 1200, cached: 800, cost: 0 });
  assert.deepEqual(ev.at(-1), { type: 'done', result: null });
  assert.ok(!ev.some((e) => e.type === 'error'));
});

test('gemini parseLine: tool call and failed tool result', () => {
  const all = load('tool.jsonl');
  const ev = all.filter((e) => e.type === 'tool');
  assert.deepEqual(ev[0], { type: 'tool', id: 'read_file-1', name: 'read_file', input: { absolute_path: 'C:\\proj\\src\\a.js' } });
  assert.equal(ev.length, 3);
  assert.deepEqual(ev[2], { type: 'tool', id: 'read_file-2', failed: true });
  assert.equal(all.find((e) => e.type === 'usage').tokens, 2500);
});

test('gemini parseLine: warning is non-fatal, errored result is fatal and still done', () => {
  const ev = load('error.jsonl');
  const errs = ev.filter((e) => e.type === 'error');
  assert.equal(errs[0].fatal, false);
  assert.match(errs[0].message, /Loop detected/);
  assert.ok(errs.slice(1).every((e) => e.fatal === true && /quota/.test(e.message)));
  assert.equal(ev.at(-1).type, 'done');
});

test('gemini parseLine: junk lines and unknown types yield nothing', () => {
  for (const l of ['', '   ', 'not json', '[1]', '{"type":"future_event"}', '{bad', '{"type":"message","role":"user","content":"x"}']) assert.deepEqual(gemini.parseLine(l), [], l);
  assert.deepEqual(gemini.parseLine('{"type":"result"}').map((e) => e.type), ['usage', 'done']);
  assert.deepEqual(gemini.parseLine(null), []);
});
