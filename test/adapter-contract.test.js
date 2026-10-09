// Adapter contract: every registry entry validates, and a read-only turn never carries a write or shell permission.
// No real CLI is run; only argv arrays are built and fixture lines are parsed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registry, validateAdapter } = require('../src/adapters');

const NAMES = ['claude', 'codex', 'gemini', 'cursor'];

// Deny list per adapter. `tokens` must not equal any argv entry. `fragments` must not appear inside any argv entry
// (codex passes its sandbox as a -c value such as sandbox_mode="workspace-write").
const DENY = {
  claude: { tokens: ['acceptEdits', 'bypassPermissions', '--dangerously-skip-permissions', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'], fragments: [] },
  codex: { tokens: ['--full-auto', '--yolo', '--dangerously-bypass-approvals-and-sandbox'], fragments: ['workspace-write', 'danger-full-access'] },
  gemini: { tokens: ['--yolo', '-y', 'auto_edit', 'yolo'], fragments: [] },
  cursor: { tokens: ['--force', '-f', '--yolo', 'agent'], fragments: [] },
};

// Positive checks: the read-only mode is the one the CLI is asked for, not just the absence of write flags.
const POSITIVE = {
  claude: (a) => a[a.indexOf('--permission-mode') + 1] === 'dontAsk',
  codex: (a) => a.includes('sandbox_mode="read-only"'),
  gemini: (a) => a[a.indexOf('--approval-mode') + 1] === 'plan',
  cursor: (a) => a[a.indexOf('--mode') + 1] === 'ask',
};

const PROMPT = 'List the files in this project.';

// Option sets a read-only turn is built with: a fresh turn, and a resumed turn where the CLI supports one.
function readOnlyOptions(name) {
  const base = { model: registry[name].MODELS[0], effort: 'low', prompt: PROMPT, mode: 'read' };
  return [base, { ...base, thread: 'thread-123' }];
}

function violations(name, argv) {
  const d = DENY[name];
  const bad = [];
  for (const a of argv) {
    if (d.tokens.includes(a)) bad.push(a);
    for (const f of d.fragments) if (a.includes(f)) bad.push(a);
  }
  return bad;
}

test('registry has exactly the four CLI adapters, keyed by their own name', () => {
  assert.deepEqual(Object.keys(registry).sort(), [...NAMES].sort());
  for (const n of NAMES) assert.equal(registry[n].name, n);
});

test('every registry entry passes validateAdapter', () => {
  for (const n of NAMES) assert.deepEqual(validateAdapter(registry[n]), [], n);
});

test('validateAdapter reports each missing or malformed export', () => {
  assert.ok(validateAdapter(null).length > 0);
  assert.ok(validateAdapter({}).length >= 4);
  const ok = registry.codex;
  assert.match(validateAdapter({ ...ok, buildArgs: 'nope' }).join('\n'), /buildArgs/);
  assert.match(validateAdapter({ ...ok, parseLine: undefined }).join('\n'), /parseLine/);
  assert.match(validateAdapter({ ...ok, MODELS: [] }).join('\n'), /MODELS/);
  assert.match(validateAdapter({ ...ok, readOnly: '  ' }).join('\n'), /readOnly/);
});

for (const n of NAMES) {
  test(`${n}: read-only buildArgs carry no write or shell permission flags`, () => {
    for (const opts of readOnlyOptions(n)) {
      const argv = registry[n].buildArgs(opts);
      assert.ok(Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string'), `${n} returns a string argv`);
      assert.deepEqual(violations(n, argv), [], `${n} argv ${JSON.stringify(argv)}`);
      assert.ok(POSITIVE[n](argv), `${n} asks for its read-only mode: ${JSON.stringify(argv)}`);
    }
  });
}

test('gemini and cursor refuse write mode outright', () => {
  for (const n of ['gemini', 'cursor']) {
    const { MODELS } = registry[n];
    assert.throws(() => registry[n].buildArgs({ model: MODELS[0], effort: 'low', prompt: PROMPT, mode: 'write' }), /read-only/, n);
  }
});

test('parseLine returns an array for noise and blank lines', () => {
  for (const n of NAMES) {
    assert.deepEqual(registry[n].parseLine(''), [], n);
    assert.deepEqual(registry[n].parseLine('warning: something on stderr'), [], n);
    assert.deepEqual(registry[n].parseLine('{not json'), [], n);
  }
});

function fixtureLines(rel) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf8').split(/\r?\n/).filter(Boolean);
}

for (const n of ['gemini', 'cursor']) {
  test(`${n}: parseLine turns a recorded fixture into text and done events`, () => {
    const events = fixtureLines(path.join(n, 'normal.jsonl')).flatMap((l) => registry[n].parseLine(l));
    assert.ok(events.some((e) => e.type === 'text'), `${n} has a text event`);
    assert.ok(events.some((e) => e.type === 'done'), `${n} has a done event`);
  });
}

test('claude and codex parseLine reads a single streamed line through the shared parser', () => {
  const claudeLines = fixtureLines('claude-stream.jsonl').flatMap((l) => registry.claude.parseLine(l));
  assert.ok(claudeLines.some((e) => e.type === 'done'), 'claude has a done event');
  const codexLines = fixtureLines('codex-stream.jsonl').flatMap((l) => registry.codex.parseLine(l));
  assert.ok(codexLines.some((e) => e.type === 'done'), 'codex has a done event');
});
