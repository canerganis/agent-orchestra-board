// NOTE: fixtures/claude-stream.jsonl and fixtures/codex-stream.jsonl are SYNTHETIC edge cases (two messages, an ignorable
// error, a split UTF-8 dash) that exact assertions here depend on. Real output is covered by real-fixtures.test.js.
// Adapter parsers against recorded-style streams: whole feed vs. arbitrary chunking, noise lines,
// usage/cached math, rate-limit passthrough, error paths. No CLI is run.
//
// Assertions follow the published handler contract. Additive extras an implementation may emit are normalized
// away before comparing: stream-level usage marked {partial:true} (the final usage replaces it) and a repeated
// identical activity status (the runner dedupes those anyway).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const claude = require('../src/adapters/claude');
const codex = require('../src/adapters/codex');

const HANDLERS = ['thread', 'activity', 'delta', 'item', 'usage', 'rateLimit', 'completed', 'error'];
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function collect(adapter) {
  const events = [];
  const parser = adapter.createParser(Object.fromEntries(HANDLERS.map((k) => [k, (...a) => events.push([k, ...a])])));
  return { parser, events: events, norm: () => norm(events) };
}
function norm(events) {
  const out = [];
  for (const e of events) {
    if (e[0] === 'usage' && e[1] && e[1].partial === true) continue;
    if (e[0] === 'activity' && out.length && out[out.length - 1][0] === 'activity' && out[out.length - 1][1] === e[1]) continue;
    out.push(e);
  }
  return out;
}
function feedChunked(adapter, text, size, asBuffer = false) {
  const { parser, norm } = collect(adapter);
  const whole = asBuffer ? Buffer.from(text, 'utf8') : text;
  for (let i = 0; i < whole.length; i += size) parser.feed(whole.slice(i, i + size));
  return norm();
}
const only = (events, kind) => norm(events).filter((e) => e[0] === kind).map((e) => e.slice(1));

const CLAUDE_EXPECTED = [
  ['thread', '3f2b9c1e-6d2a-4f0b-9a7e-1c2d3e4f5a6b'],
  ['rateLimit', { status: 'allowed', resetsAt: 1759900000, rateLimitType: 'five_hour', utilization: 0.42, isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1759900000 }, seven_day: { utilization: 0.11, resetsAt: 1760300000 } } }],
  ['activity', 'thinking · ~120 tok'],
  ['activity', 'thinking'],
  ['activity', 'tool: Read'],
  ['item', 'tool', 'Read {"file_path":"src/a.js"}'],
  ['activity', 'writing'],
  ['delta', 'The file '],
  ['activity', 'writing'],
  ['delta', 'exports `a` — see src/a.js:1.'],
  ['usage', { tokens: 16 + 2460 + 45, cached: 38400, cost: 0.0123 }],
  ['completed', { result: 'The file exports `a` — see src/a.js:1.' }],
];

const CODEX_EXPECTED = [
  ['thread', '019a1b2c-3d4e-7f80-9abc-def012345678'],
  ['activity', 'thinking'],
  ['item', 'reasoning', '**Scanning the repo**\n\nI should list the source files first.'],
  ['activity', 'running a command'],
  ['item', 'tool', 'Get-ChildItem src'],
  ['activity', 'writing'],
  ['delta', 'Found two files — a.js and b.js.'],
  ['item', 'tool', 'file change'],
  ['activity', 'writing'],
  ['delta', '\n\nDone.'],
  ['usage', { tokens: 15234 - 12800 + 301, cached: 12800, cost: 0 }],
  ['completed', { result: null }],
];

test('claude: recorded stream yields the normalized event sequence (thread, rate limit, activities, tool item, deltas, usage, completed)', () => {
  const { parser, norm } = collect(claude);
  parser.feed(fixture('claude-stream.jsonl'));
  assert.deepEqual(norm(), CLAUDE_EXPECTED);
});

test('claude: usage = input + cache_creation + output (net), cached = cache_read, cost = total_cost_usd; the final usage is authoritative', () => {
  const { parser, events } = collect(claude);
  parser.feed(fixture('claude-stream.jsonl'));
  const all = events.filter((e) => e[0] === 'usage').map((e) => e[1]);
  assert.deepEqual(all[all.length - 1], { tokens: 2521, cached: 38400, cost: 0.0123 });
  assert.deepEqual(only(events, 'usage'), [[{ tokens: 2521, cached: 38400, cost: 0.0123 }]]);
  // Only text deltas count as "emitted": the first message (thinking + tool_use) must not produce a '\n\n' separator.
  assert.deepEqual(only(events, 'delta').map((d) => d[0]), ['The file ', 'exports `a` — see src/a.js:1.']);
  // The result handler fires exactly once and after the usage.
  const idx = (k) => events.findIndex((e) => e[0] === k);
  assert.equal(events.filter((e) => e[0] === 'completed').length, 1);
  assert.ok(idx('completed') > events.map((e) => e[0]).lastIndexOf('usage'));
});

test('claude: string chunking at any size gives identical events (1, 3, 17, 64, 1000 chars)', () => {
  const text = fixture('claude-stream.jsonl');
  for (const size of [1, 3, 17, 64, 1000]) assert.deepEqual(feedChunked(claude, text, size), CLAUDE_EXPECTED, `chunk size ${size}`);
});

test('claude: Buffer chunks (as the runner passes them) give identical events, including a UTF-8 character split across chunks', () => {
  const text = fixture('claude-stream.jsonl');
  for (const size of [1, 7, 500]) assert.deepEqual(feedChunked(claude, text, size, true), CLAUDE_EXPECTED, `buffer chunk size ${size}`);
  const buf = Buffer.from(text, 'utf8');
  const dash = buf.indexOf(Buffer.from('—', 'utf8'));
  const { parser, events } = collect(claude);
  parser.feed(buf.subarray(0, dash + 1)); // first byte of the 3-byte em dash
  parser.feed(buf.subarray(dash + 1));
  assert.deepEqual(only(events, 'delta').map((d) => d[0]), ['The file ', 'exports `a` — see src/a.js:1.']);
});

test('claude: non-JSON noise, blank lines, CRLF, truncated/invalid JSON and unknown event types are ignored', () => {
  const lines = fixture('claude-stream.jsonl').split('\n').filter(Boolean);
  const noise = ['npm warn Unknown env config "foo"', '', '   ', '{not json at all', '} stray brace', '[1,2,3]', '{"type":"unknown_future_event","x":1}', '{"type":"stream_event"}', '{"type":"assistant"}', '{"type":"system","subtype":"hook_started"}', 'null', '42'];
  const mixed = lines.flatMap((l, i) => [noise[i % noise.length], '  ' + l]).join('\r\n') + '\r\n' + noise.join('\r\n') + '\r\n';
  const { parser, norm } = collect(claude);
  parser.feed(mixed);
  assert.deepEqual(norm(), CLAUDE_EXPECTED);
});

test('claude: a line without a trailing newline is held until the newline arrives', () => {
  const { parser, events } = collect(claude);
  parser.feed('{"type":"system","subtype":"init","session_id":"s9"}');
  assert.deepEqual(events, []);
  parser.feed('\n');
  assert.deepEqual(events, [['thread', 's9']]);
});

test('claude: is_error result reports completed (with the error text as result) and then an error carrying the CLI message', () => {
  const { parser, events } = collect(claude);
  parser.feed(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'e1' }) + '\n');
  parser.feed(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded', total_cost_usd: 0.002, usage: { input_tokens: 7, output_tokens: 0 } }) + '\n');
  const kinds = norm(events).map((e) => e[0]);
  assert.deepEqual(kinds, ['thread', 'usage', 'completed', 'error']);
  assert.deepEqual(events.find((e) => e[0] === 'usage')[1], { tokens: 7, cached: 0, cost: 0.002 });
  assert.deepEqual(events.find((e) => e[0] === 'completed')[1], { result: 'API Error: 529 overloaded' });
  assert.match(events.find((e) => e[0] === 'error')[1], /529 overloaded/);
});

test('claude: is_error without result text still reports a non-empty error; a result without usage reports no tokens', () => {
  const { parser, events } = collect(claude);
  parser.feed(JSON.stringify({ type: 'result', is_error: true }) + '\n');
  assert.deepEqual(only(events, 'completed'), [[{ result: null }]]);
  const err = events.find((e) => e[0] === 'error');
  assert.ok(err && typeof err[1] === 'string' && err[1].length > 0);
  for (const u of only(events, 'usage')) assert.deepEqual(u[0], { tokens: 0, cached: 0, cost: 0 });
});

test('claude: an event carrying total_cost_usd counts as the result even without type "result"', () => {
  const { parser, norm } = collect(claude);
  parser.feed(JSON.stringify({ total_cost_usd: 0.5, result: 'done', usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 9, output_tokens: 1 } }) + '\n');
  assert.deepEqual(norm(), [['usage', { tokens: 3, cached: 9, cost: 0.5 }], ['completed', { result: 'done' }]]);
});

test('claude: rate_limit_event passes the raw rate_limit_info object through; one without info is ignored', () => {
  const { parser, events } = collect(claude);
  const info = { status: 'rejected', rateLimitType: 'seven_day', utilization: 1, resetsAt: 1 };
  parser.feed(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }) + '\n' + JSON.stringify({ type: 'rate_limit_event' }) + '\n');
  assert.deepEqual(events, [['rateLimit', info]]);
});

test('claude: consecutive text messages are separated by a blank line; the separator appears only after text was emitted', () => {
  const { parser, events } = collect(claude);
  const se = (event) => JSON.stringify({ type: 'stream_event', event }) + '\n';
  parser.feed(se({ type: 'message_start' }) + se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'one' } }) + se({ type: 'message_start' }) + se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'two' } }));
  assert.deepEqual(only(events, 'delta').map((d) => d[0]), ['one', '\n\n', 'two']);
});

test('codex: recorded stream yields the normalized event sequence (ignorable errors filtered, net usage, blank line between messages)', () => {
  const { parser, norm } = collect(codex);
  parser.feed(fixture('codex-stream.jsonl'));
  assert.deepEqual(norm(), CODEX_EXPECTED);
});

test('codex: chunking at any size gives identical events; Buffer chunks (also splitting the em dash) too', () => {
  const text = fixture('codex-stream.jsonl');
  for (const size of [1, 5, 33, 256, 4096]) assert.deepEqual(feedChunked(codex, text, size), CODEX_EXPECTED, `chunk size ${size}`);
  for (const size of [1, 11]) assert.deepEqual(feedChunked(codex, text, size, true), CODEX_EXPECTED, `buffer chunk size ${size}`);
});

test('codex: usage math = input - cached + output, cost always 0; a turn without usage still completes', () => {
  const { parser, events } = collect(codex);
  parser.feed(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 999, output_tokens: 1 } }) + '\n');
  assert.deepEqual(only(events, 'usage'), [[{ tokens: 2, cached: 999, cost: 0 }]]);
  assert.deepEqual(only(events, 'completed'), [[{ result: null }]]);
  const second = collect(codex);
  second.parser.feed(JSON.stringify({ type: 'turn.completed' }) + '\n');
  assert.deepEqual(only(second.events, 'completed'), [[{ result: null }]]);
  for (const u of only(second.events, 'usage')) assert.deepEqual(u[0], { tokens: 0, cached: 0, cost: 0 });
});

test('codex: turn.failed reports its message; real item errors become error items; filtered ones vanish', () => {
  const { parser, events } = collect(codex);
  parser.feed(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Rate limit reached for gpt-6-luna' } }) + '\n');
  parser.feed(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'ignoring unknown config key x' } }) + '\n');
  parser.feed(JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }) + '\n');
  parser.feed(JSON.stringify({ type: 'error', message: 'unexpected status 500' }) + '\n');
  parser.feed(JSON.stringify({ type: 'turn.failed' }) + '\n');
  // The top-level error after turn.failed is an item only; the bare turn.failed still yields a non-empty error.
  assert.deepEqual(events, [
    ['item', 'error', 'Rate limit reached for gpt-6-luna'],
    ['error', 'stream disconnected'],
    ['item', 'error', 'unexpected status 500'],
    ['error', 'codex error'],
  ]);
});

const topLevel = (...lines) => { const { parser, events } = collect(codex); for (const l of lines) parser.feed(JSON.stringify(l) + '\n'); parser.end(); return events; };
test('codex: a top-level error is an item at once and an error only when no turn.completed/turn.failed follows', () => {
  // Alone: shown at once, reported as the turn error by end().
  assert.deepEqual(topLevel({ type: 'error', message: 'unexpected status 500' }), [['item', 'error', 'unexpected status 500'], ['error', 'unexpected status 500']]);
  // Followed by turn.completed: the stream recovered, not a failure.
  assert.deepEqual(topLevel({ type: 'error', message: 'Reconnecting' }, { type: 'turn.completed', usage: {} }).filter((e) => e[0] === 'error'), []);
  // After turn.failed: an item only.
  assert.deepEqual(topLevel({ type: 'turn.failed', error: { message: 'x' } }, { type: 'error', message: 'late' }).filter((e) => e[0] === 'error'), [['error', 'x']]);
});

test('codex: noise lines between events are ignored', () => {
  const lines = fixture('codex-stream.jsonl').split('\n').filter(Boolean);
  const mixed = lines.flatMap((l) => ['WARNING: sandbox fallback', l, '']).join('\n') + '\n{"type":"item.completed"}\n{"type":"item.started","item":{"type":"reasoning"}}\n';
  const { parser, norm } = collect(codex);
  parser.feed(mixed);
  assert.deepEqual(norm(), CODEX_EXPECTED);
});

test('both parsers: handlers are optional (no throw when none is given) and event() accepts objects directly', () => {
  for (const adapter of [claude, codex]) {
    const p = adapter.createParser();
    assert.doesNotThrow(() => p.feed(fixture(adapter === claude ? 'claude-stream.jsonl' : 'codex-stream.jsonl')));
    assert.doesNotThrow(() => p.event({ type: 'turn.completed' }));
  }
  const { parser, events } = collect(codex);
  parser.event({ type: 'thread.started', thread_id: 'direct' });
  assert.deepEqual(events, [['thread', 'direct']]);
});

test('buildProbeArgs: Haiku, no --effort, no session persistence, no tools, lean flags', () => {
  const a = claude.buildProbeArgs();
  assert.ok(!a.includes('--effort'), 'Haiku takes no effort flag');
  assert.ok(a.includes('claude-haiku-5-5') && a.includes('--no-session-persistence') && a.includes('--strict-mcp-config'));
  assert.deepEqual(a.slice(-2), ['--tools', '']);
  assert.ok(!a.includes('--resume') && !a.includes('--session-id'));
});

test('claude buildArgs: lean flags, model/effort, add-dir, and the --tools list per mode', () => {
  const a = claude.buildArgs({ model: 'claude-sonnet-5-5', effort: 'high', addDir: 'D:\\elsewhere', mode: 'read' });
  assert.deepEqual(a.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  assert.ok(a.includes('--model') && a[a.indexOf('--model') + 1] === 'claude-sonnet-5-5' && a[a.indexOf('--effort') + 1] === 'high');
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--disable-slash-commands') && a.includes('--exclude-dynamic-system-prompt-sections'));
  assert.deepEqual(a.slice(a.indexOf('--add-dir'), a.indexOf('--add-dir') + 2), ['--add-dir', 'D:\\elsewhere']);
  assert.ok(!a.includes('--resume') && !a.includes('--session-id'));
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk'], 'read turns: dontAsk');
  assert.equal(a.indexOf('--tools'), a.length - 4, '--tools stays last (variadic)');
  assert.deepEqual(claude.buildArgs({ model: 'm', effort: 'low', mode: 'write' }).slice(-5), ['Read', 'Grep', 'Glob', 'Edit', 'Write']);
});

test('codex buildArgs: Windows gets windows.sandbox="unelevated"; lean flags and effort/model config are present', () => {
  const a = codex.buildArgs({ model: 'gpt-6-luna', effort: 'xhigh', mode: 'none' });
  assert.equal(a.includes('windows.sandbox="unelevated"'), process.platform === 'win32');
  assert.ok(a.includes('--ignore-user-config') && a.includes('model="gpt-6-luna"') && a.includes('model_reasoning_effort="xhigh"') && a.includes('sandbox_mode="read-only"'));
  assert.ok(a.includes('web_search="disabled"') && a.includes('features.plugins=false'));
  assert.equal(a[a.length - 1], '-'); // prompt comes on stdin
});
