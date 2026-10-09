// The adapter parsers against REAL recordings (test/fixtures/real, see its README). Nothing here runs a CLI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const claude = require('../src/adapters/claude');
const codex = require('../src/adapters/codex');
const agy = require('../src/adapters/antigravity');
const cursor = require('../src/adapters/cursor');

const DIR = path.join(__dirname, 'fixtures', 'real');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

function runStateful(mod, file) {
  const r = { threads: [], text: '', tools: [], usage: [], errors: [], completed: [] };
  const p = mod.createParser({
    thread: (id) => r.threads.push(id),
    delta: (t) => { r.text += t; },
    toolUse: (t) => r.tools.push(t),
    usage: (u) => r.usage.push(u),
    error: (m) => r.errors.push(m),
    completed: (c) => r.completed.push(c),
  });
  p.feed(read(file));
  p.end();
  return r;
}

function runAgy(file) {
  const evs = read(file).split('\n').filter(Boolean).flatMap((l) => agy.parseLine(l));
  const of = (t) => evs.filter((e) => e.type === t);
  return { threads: of('thread').map((e) => e.id), text: of('text').map((e) => e.text).join(''), tools: of('tool'), usage: of('usage'), errors: of('error'), completed: of('done') };
}

const runCursor = (file) => {
  const evs = read(file).split('\n').filter(Boolean).flatMap((l) => cursor.parseLine(l));
  const of = (t) => evs.filter((e) => e.type === t);
  return { threads: of('thread').map((e) => e.id), text: of('text').map((e) => e.text).join(''), tools: of('tool'), usage: of('usage'), errors: of('error'), completed: of('done') };
};

function common(r) {
  assert.equal(r.threads.length, 1, 'exactly one thread id');
  assert.ok(r.threads[0] && r.threads[0].length > 8);
  assert.deepEqual(r.errors, [], 'no parser errors');
  assert.equal(r.completed.length, 1, 'one completed turn');
  assert.ok(r.text.trim().length > 0, 'final text present');
  const total = r.usage.reduce((n, u) => n + (u.tokens || 0), 0);
  assert.ok(total > 0, 'usage tokens > 0');
}

const CASES = [
  ['claude', runStateful.bind(null, claude), 'claude-plain.jsonl', { text: /ready/ }],
  ['claude', runStateful.bind(null, claude), 'claude-tool.jsonl', { text: /list\(/, tool: true }],
  ['claude', runStateful.bind(null, claude), 'claude-resume.jsonl', { text: /src[\/]list\.js/ }],
  ['codex', runStateful.bind(null, codex), 'codex-plain.jsonl', { text: /ready/ }],
  ['codex', runStateful.bind(null, codex), 'codex-tool.jsonl', { text: /list\(\)/, tool: true }],
  ['codex', runStateful.bind(null, codex), 'codex-resume.jsonl', { text: /src[\/]list\.js/ }],
  ['agy', runAgy, 'agy-tool.jsonl', { tool: true }],
  ['agy', runAgy, 'agy-resume.jsonl', { text: /src[\/]list\.js/ }],
  ['cursor', runCursor, 'cursor-tool.jsonl', { text: /list\(/, tool: true }],
  ['cursor', runCursor, 'cursor-resume.jsonl', { text: /src[\/]list\.js/ }],
];

for (const [name, run, file, want] of CASES) {
  test(`real ${file}: ${name} parser yields thread id, final text, usage and no errors`, () => {
    const r = run(file);
    common(r);
    if (want.text) assert.match(r.text, want.text);
    if (want.tool) assert.ok(r.tools.length >= 1, 'at least one tool event');
  });
}

test('real recordings: resume files keep the thread id of the matching tool recording', () => {
  assert.equal(runStateful(claude, 'claude-resume.jsonl').threads[0], runStateful(claude, 'claude-tool.jsonl').threads[0]);
  assert.equal(runStateful(codex, 'codex-resume.jsonl').threads[0], runStateful(codex, 'codex-tool.jsonl').threads[0]);
  assert.equal(runAgy('agy-resume.jsonl').threads[0], runAgy('agy-tool.jsonl').threads[0]);
  assert.equal(runCursor('cursor-resume.jsonl').threads[0], runCursor('cursor-tool.jsonl').threads[0]);
});

test('fake CLI: a scenario rule with replay prints the real recording, with the thread id swapped', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-replay-'));
  try {
    fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ rules: [{ replay: 'real/claude-tool.jsonl' }] }));
    const out = spawnSync(process.execPath, [path.join(__dirname, 'fake-cli', 'fake-cli.js'), '-p', '--session-id', 'sid-1', '--tools', 'Read'], { input: 'hi', env: { ...process.env, OB_FAKE_DIR: dir }, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim().split('\n').length, read('claude-tool.jsonl').trim().split('\n').length);
    assert.ok(!out.stdout.includes('5cdd978b-6142-4a44-b168-5af1c640dfff'));
    const r = { text: '', tools: [], threads: [] };
    const p = claude.createParser({ thread: (id) => r.threads.push(id), delta: (t) => { r.text += t; }, toolUse: (t) => r.tools.push(t) });
    p.feed(out.stdout); p.end();
    assert.deepEqual(r.threads, ['sid-1']);
    assert.match(r.text, /list\(/);
    assert.equal(r.tools.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
