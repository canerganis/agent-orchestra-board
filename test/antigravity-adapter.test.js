// Antigravity adapter: buildArgs, parseLine against a real agy 1.2.17 turn, and resolveBin. No real CLI is run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agy = require('../src/adapters/antigravity');

const events = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'antigravity', 'real-turn.jsonl'), 'utf8')
  .split('\n').filter(Boolean).flatMap((l) => agy.parseLine(l));

test('antigravity buildArgs: read-only flags and the deny list', () => {
  const a = agy.buildArgs({ model: 'gemini-3.8-flash-low', effort: 'low', prompt: 'hello', mode: 'read' });
  assert.deepEqual(a.slice(0, 2), ['-p', 'hello']);
  assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(a[a.indexOf('--mode') + 1], 'plan');
  assert.equal(a[a.indexOf('--model') + 1], 'gemini-3.8-flash-low');
  assert.equal(a[a.indexOf('--effort') + 1], 'low');
  for (const f of ['--sandbox', '--disable-slash-commands']) assert.ok(a.includes(f), f);
  for (const d of agy.AGY_DENY) assert.ok(!a.includes(d), d);
  assert.ok(!a.includes('--conversation'));
});

test('antigravity buildArgs: resume adds --conversation, write mode and empty prompt are refused', () => {
  const a = agy.buildArgs({ model: 'claude-sonnet-5-5-high', prompt: 'x', resumeId: 'abc' });
  assert.equal(a[a.indexOf('--conversation') + 1], 'abc');
  assert.ok(!a.includes('--effort'));
  assert.throws(() => agy.buildArgs({ prompt: 'x', mode: 'write' }), /read-only/);
  assert.throws(() => agy.buildArgs({ prompt: '' }), /prompt/);
  assert.ok(agy.AGY_MODELS.includes('gemini-3.1-pro-high') && agy.AGY_MODELS.includes('claude-opus-5-5-high'));
});

test('antigravity parseLine: the real turn', () => {
  const ev = events();
  assert.deepEqual(ev[0], { type: 'thread', id: '3c8effb9-a0c6-41c2-b801-591a886ce9f0', model: 'gemini-3.8-flash-low' });
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'hello\n');
  const tool = ev.filter((e) => e.type === 'tool');
  assert.equal(tool.length, 1);
  assert.equal(tool[0].name, 'view_file');
  assert.match(tool[0].input.AbsolutePath, /note\.txt$/);
  const u = ev.filter((e) => e.type === 'usage');
  assert.equal(u.length, 1);
  assert.equal(u[0].input, 26989);
  assert.equal(u[0].output, 57);
  assert.equal(u[0].cached, 20382);
  assert.equal(u[0].net, 26989 - 20382);
  assert.equal(u[0].tokens, 26989 - 20382 + 57);
  const done = ev[ev.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(done.result.response, 'hello\n');
  assert.equal(done.result.usage.total, 27046);
  assert.ok(!ev.some((e) => e.type === 'error'));
});

test('antigravity parseLine: a non-SUCCESS result is a fatal error; noise is ignored', () => {
  const ev = agy.parseLine(JSON.stringify({ event: 'result', result: { status: 'ERROR', response: 'boom', usage: {} } }));
  assert.ok(ev.some((e) => e.type === 'error' && e.fatal && /boom/.test(e.message)));
  assert.equal(ev[ev.length - 1].type, 'done');
  for (const l of ['', 'warn', '{bad', '[]', '{"event":"other"}']) assert.deepEqual(agy.parseLine(l), [], l);
});

test('antigravity resolveBin: override, PATH and the Packages folder', () => {
  assert.equal(agy.resolveBin({ env: { ORCHESTRA_AGY_BIN: 'X:\\agy.exe', PATH: '' } }), 'X:\\agy.exe');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bin-'));
  try {
    assert.equal(agy.resolveBin({ env: { PATH: '' }, localAppData: root }), null);
    const dir = path.join(root, 'Packages', 'OpenAI.Codex_abc123', 'LocalCache', 'Local', 'agy', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agy.exe'), '');
    assert.equal(agy.resolveBin({ env: { PATH: '' }, localAppData: root }), path.join(dir, 'agy.exe'));
    const onPath = path.join(root, 'bin');
    fs.mkdirSync(onPath);
    fs.writeFileSync(path.join(onPath, 'agy.exe'), '');
    assert.equal(agy.resolveBin({ env: { PATH: onPath }, platform: 'win32', localAppData: root }), path.join(onPath, 'agy.exe'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
