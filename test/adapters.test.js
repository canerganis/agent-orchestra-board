// Adapter contracts: buildArgs shape and the normalized parser events (no real CLI is run).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const claude = require('../src/adapters/claude');
const codex = require('../src/adapters/codex');

function collect(adapter) {
  const events = [];
  const rec = (k) => (...a) => events.push([k, ...a]);
  const parser = adapter.createParser(Object.fromEntries(['thread', 'activity', 'delta', 'item', 'usage', 'rateLimit', 'completed', 'error'].map((k) => [k, rec(k)])));
  return { parser, events };
}

test('claude buildArgs: new thread gets --session-id, resume gets --resume, tools follow mode', () => {
  const a = claude.buildArgs({ model: 'm', effort: 'low', sessionId: 'sid', mode: 'read' });
  assert.ok(a.includes('--session-id') && a.includes('sid') && !a.includes('--resume'));
  assert.deepEqual(a.slice(a.indexOf('--tools') + 1), ['Read', 'Grep', 'Glob']);
  const b = claude.buildArgs({ model: 'm', effort: 'low', thread: 'tid', mode: 'write' });
  assert.ok(b.includes('--resume') && b.includes('tid') && b.includes('acceptEdits'));
  assert.deepEqual(claude.buildArgs({ model: 'm', effort: 'low', mode: 'none' }).slice(-2), ['--tools', '']);
});

test('claude parser: thread, deltas, rate limit, usage and completion', () => {
  const { parser, events } = collect(claude);
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'result', result: 'hi', total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 3 } },
  ];
  parser.feed(lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  assert.deepEqual(events[0], ['thread', 's1']);
  assert.deepEqual(events[1], ['rateLimit', { status: 'allowed' }]);
  assert.deepEqual(events.filter((e) => e[0] === 'delta').map((e) => e[1]), ['hi', '\n\n']);
  assert.deepEqual(events.find((e) => e[0] === 'usage')[1], { tokens: 15, cached: 5, cost: 0.01 });
  assert.deepEqual(events.at(-1), ['completed', { result: 'hi' }]);
});

test('codex buildArgs: resume form and sandbox mode', () => {
  const a = codex.buildArgs({ model: 'm', effort: 'high', mode: 'write', thread: 't1' });
  assert.deepEqual(a.slice(0, 3), ['exec', 'resume', 't1']);
  assert.ok(a.includes('sandbox_mode="workspace-write"') && a.at(-1) === '-');
  assert.deepEqual(codex.buildArgs({ model: 'm', effort: 'low' }).slice(0, 2), ['exec', '--skip-git-repo-check']);
});

test('codex parser: thread, message deltas, net usage, failure', () => {
  const { parser, events } = collect(codex);
  const lines = [
    { type: 'thread.started', thread_id: 'c1' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'a' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'b' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 } },
    { type: 'turn.failed', error: { message: 'boom' } },
  ];
  for (const l of lines) parser.feed(JSON.stringify(l) + '\n');
  assert.deepEqual(events[0], ['thread', 'c1']);
  assert.deepEqual(events.filter((e) => e[0] === 'delta').map((e) => e[1]), ['a', '\n\nb']);
  assert.deepEqual(events.find((e) => e[0] === 'usage')[1], { tokens: 47, cached: 60, cost: 0 });
  assert.deepEqual(events.at(-1), ['error', 'boom']);
});
