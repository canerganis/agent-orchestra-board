// Cursor adapter: buildArgs shape, resolveBin layouts and parseLine, against the real recordings (test/fixtures/real). No CLI is run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cursor = require('../src/adapters/cursor');

const load = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'real', name), 'utf8').split('\n').filter(Boolean).flatMap((l) => cursor.parseLine(l));

test('cursor buildArgs: read-only flags, model, prompt is the last positional argument', () => {
  const a = cursor.buildArgs({ model: 'auto', prompt: '-hello world', platform: 'linux' });
  assert.deepEqual(a.slice(0, 3), ['-p', '--output-format', 'stream-json']);
  assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(a[a.indexOf('--mode') + 1], 'ask');
  assert.equal(a[a.indexOf('--model') + 1], 'auto');
  assert.ok(a.includes('--trust'));
  assert.ok(!a.includes('--resume'));
  assert.equal(a.at(-1), '-hello world');
  for (const bad of cursor.CURSOR_DENY) assert.ok(!a.includes(bad), bad);
  assert.ok(cursor.CURSOR_MODELS.includes('auto'));
});

test('cursor buildArgs: sandbox enabled on macOS and Linux, disabled on Windows', () => {
  for (const p of ['linux', 'darwin']) assert.equal(cursor.buildArgs({ prompt: 'x', platform: p }).at(cursor.buildArgs({ prompt: 'x', platform: p }).indexOf('--sandbox') + 1), 'enabled');
  const w = cursor.buildArgs({ prompt: 'x', platform: 'win32' });
  assert.equal(w[w.indexOf('--sandbox') + 1], 'disabled');
});

test('cursor buildArgs: resume adds --resume with the session id, prompt still last', () => {
  const a = cursor.buildArgs({ model: 'auto', prompt: 'again', resumeId: 'sess-1', platform: 'win32' });
  assert.equal(a[a.indexOf('--resume') + 1], 'sess-1');
  assert.equal(a.at(-1), 'again');
  for (const bad of cursor.CURSOR_DENY) assert.ok(!a.includes(bad), bad);
});

test('cursor buildArgs: write mode and missing prompt are refused', () => {
  assert.throws(() => cursor.buildArgs({ model: 'm', prompt: 'x', mode: 'write' }), /read-only/);
  assert.throws(() => cursor.buildArgs({ model: 'm', prompt: '' }), /prompt/);
});

test('cursor resolveBin: override, Windows version layout (newest wins), PATH on other systems', () => {
  assert.deepEqual(cursor.resolveBin({ env: { ORCHESTRA_CURSOR_BIN: '/x/agent' }, platform: 'linux' }), { cmd: '/x/agent', prefixArgs: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cursor-'));
  try {
    const mk = (v, files) => { const d = path.join(dir, 'cursor-agent', 'versions', v); fs.mkdirSync(d, { recursive: true }); for (const f of files) fs.writeFileSync(path.join(d, f), ''); return d; };
    mk('2026.09.01-aaaaaaa', ['node.exe', 'index.js']);
    const newest = mk('2026.10.01-e373342', ['node.exe', 'index.js']);
    mk('2026.10.05-incomplete', ['node.exe']);
    assert.deepEqual(cursor.resolveBin({ env: { PATH: '' }, platform: 'win32', localAppData: dir }), { cmd: path.join(newest, 'node.exe'), prefixArgs: [path.join(newest, 'index.js')] });
    assert.equal(cursor.resolveBin({ env: { PATH: '' }, platform: 'win32', localAppData: path.join(dir, 'none') }), null);
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'agent'), '');
    assert.deepEqual(cursor.resolveBin({ env: { PATH: bin }, platform: 'linux' }), { cmd: path.join(bin, 'agent'), prefixArgs: [] });
    assert.equal(cursor.resolveBin({ env: { PATH: '' }, platform: 'linux' }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cursor parseLine: real tool turn (thread, text, tool, usage, done; thinking ignored)', () => {
  const ev = load('cursor-tool.jsonl');
  assert.deepEqual(ev[0], { type: 'thread', id: '711bf2a9-bc70-4358-a426-745620da545a', model: 'Auto' });
  assert.match(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), /list\(\)/);
  const tools = ev.filter((e) => e.type === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'read');
  assert.deepEqual(tools[0].input, { path: 'C:\\work\\demo\\src\\list.js' });
  const usage = ev.filter((e) => e.type === 'usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].net, 9686);
  assert.equal(usage[0].cached, 17152);
  assert.equal(usage[0].tokens, 9686 + 132);
  assert.deepEqual(ev.at(-1), { type: 'done', result: null });
  assert.ok(!ev.some((e) => e.type === 'error'));
});

test('cursor parseLine: real resume keeps the session id and names src/list.js', () => {
  const ev = load('cursor-resume.jsonl');
  assert.equal(ev[0].id, load('cursor-tool.jsonl')[0].id);
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'src/list.js');
});

test('cursor parseLine: failed tool, generic function form, error results', () => {
  const p = (o) => cursor.parseLine(JSON.stringify(o));
  assert.deepEqual(p({ type: 'tool_call', subtype: 'completed', call_id: 'c', tool_call: { readToolCall: { args: {}, result: { error: { message: 'nope' } } } } }), [{ type: 'tool', id: 'c', failed: true }]);
  assert.deepEqual(p({ type: 'tool_call', subtype: 'started', call_id: 'd', tool_call: { function: { name: 'custom_tool', arguments: '{"q":1}' } } }), [{ type: 'tool', id: 'd', name: 'custom_tool', input: { q: 1 } }]);
  assert.deepEqual(p({ type: 'result', subtype: 'success', is_error: true, result: 'Usage limit reached' }), [{ type: 'error', message: 'Usage limit reached', fatal: true }, { type: 'done', result: null }]);
  assert.deepEqual(p({ type: 'result', subtype: 'error', is_error: false, result: 'boom' }), [{ type: 'error', message: 'boom', fatal: true }, { type: 'done', result: null }]);
  assert.deepEqual(p({ type: 'result', subtype: 'success', is_error: false }), [{ type: 'done', result: null }]);
});

test('cursor parseLine: junk lines and unknown types yield nothing', () => {
  for (const l of ['', '   ', 'not json', '[1]', '{"type":"future_event"}', '{bad', '{"type":"system","subtype":"other"}', '{"type":"assistant","message":{"content":[]}}', '{"type":"thinking","subtype":"delta","text":"hm"}']) assert.deepEqual(cursor.parseLine(l), [], l);
  assert.deepEqual(cursor.parseLine(null), []);
});
