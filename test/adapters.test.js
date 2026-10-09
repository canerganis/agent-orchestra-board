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

test('codex buildArgs: network access is turned off for write turns only', () => {
  const w = codex.buildArgs({ model: 'm', effort: 'low', mode: 'write' });
  assert.equal(w[w.indexOf('sandbox_workspace_write.network_access=false') - 1], '-c');
  for (const mode of ['read', 'none']) {
    assert.ok(!codex.buildArgs({ model: 'm', effort: 'low', mode }).includes('sandbox_workspace_write.network_access=false'), mode);
  }
});

test('codex buildArgs: write turns exclude /tmp and $TMPDIR from the writable roots; other modes leave them alone', () => {
  const flags = ['sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true'];
  for (const thread of [null, 't1']) {
    const w = codex.buildArgs({ model: 'm', effort: 'low', mode: 'write', thread });
    for (const f of flags) {
      assert.ok(w.includes(f), `${f} (thread ${thread})`);
      assert.equal(w[w.indexOf(f) - 1], '-c', f);
    }
    assert.equal(w.at(-1), '-', 'the prompt still comes from stdin');
  }
  for (const mode of ['read', 'none']) {
    const a = codex.buildArgs({ model: 'm', effort: 'low', mode });
    for (const f of flags) assert.ok(!a.includes(f), `${mode}: ${f}`);
  }
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

// Containment and tool log events (plan 5.6.4, 5.6.5).
function collectAll(adapter) {
  const events = [];
  const keys = ['thread', 'activity', 'delta', 'item', 'usage', 'rateLimit', 'completed', 'error', 'init', 'preInit', 'toolUse', 'toolResult', 'denials'];
  const parser = adapter.createParser(Object.fromEntries(keys.map((k) => [k, (...a) => events.push([k, ...a])])));
  const feed = (evs) => { for (const e of evs) parser.feed(JSON.stringify(e) + '\n'); parser.end(); };
  return { feed, events, of: (k) => events.filter((e) => e[0] === k).map((e) => e[1]) };
}

test('claude parser: init carries tools, cwd, permissionMode and the mcp_servers names, before the thread', () => {
  const { feed, events, of } = collectAll(claude);
  feed([{ type: 'system', subtype: 'init', session_id: 's1', cwd: '/w', tools: ['Read', 'Write'], permissionMode: 'acceptEdits', mcp_servers: [{ name: 'gh', status: 'connected' }, 'plain'] }]);
  assert.deepEqual(of('init'), [{ tools: ['Read', 'Write'], cwd: '/w', permissionMode: 'acceptEdits', mcpServers: ['gh', 'plain'] }]);
  assert.deepEqual(events.map((e) => e[0]), ['init', 'thread']);
});

test('claude parser: init fields that are missing or of the wrong type are null', () => {
  const { feed, of } = collectAll(claude);
  feed([{ type: 'system', subtype: 'init', session_id: 's1', tools: 'Read', cwd: '', permissionMode: 7 }]);
  assert.deepEqual(of('init'), [{ tools: null, cwd: null, permissionMode: null, mcpServers: null }]);
});

test('claude parser: preInit for assistant, stream, user and result events before init; none after it', () => {
  const early = collectAll(claude);
  early.feed([
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'assistant', message: { content: [] } },
    { type: 'user', message: { content: [] } },
    { type: 'result', result: 'x' },
    { total_cost_usd: 0 },
  ]);
  assert.deepEqual(early.of('preInit'), ['stream_event', 'assistant', 'user', 'result', 'result']);
  const late = collectAll(claude);
  late.feed([{ type: 'system', subtype: 'init', session_id: 's1' }, { type: 'assistant', message: { content: [] } }, { type: 'result', result: 'x' }]);
  assert.deepEqual(late.of('preInit'), []);
});

test('claude parser: toolUse with the path (file_path, path, notebook_path) once per id, toolResult with is_error, denials', () => {
  const { feed, of } = collectAll(claude);
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  feed([
    { type: 'system', subtype: 'init', session_id: 's1' },
    use('t1', 'Write', { file_path: 'a.txt', content: 'x' }),
    use('t1', 'Write', { file_path: 'a.txt', content: 'x' }), // the same block again (partial messages)
    use('t2', 'Glob', { pattern: '*', path: 'src' }),
    use('t3', 'NotebookEdit', { notebook_path: 'n.ipynb' }),
    use('t4', 'Read', {}),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'denied' }, { type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } },
    { type: 'result', result: 'done', permission_denials: [{ tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: '/out/b.txt' } }, 'Bash', 42] },
  ]);
  assert.deepEqual(of('toolUse'), [
    { id: 't1', name: 'Write', path: 'a.txt' },
    { id: 't2', name: 'Glob', path: 'src' },
    { id: 't3', name: 'NotebookEdit', path: 'n.ipynb' },
    { id: 't4', name: 'Read', path: null },
  ]);
  assert.deepEqual(of('toolResult'), [{ id: 't1', error: true }, { id: 't2', error: false }]);
  assert.deepEqual(of('denials'), [[{ name: 'Write', id: 't1', path: '/out/b.txt' }, { name: 'Bash', id: null, path: null }, { name: null, id: null, path: null }]]);
});

test('claude parser: no denials event for an empty or missing permission_denials', () => {
  const { feed, of } = collectAll(claude);
  feed([{ type: 'system', subtype: 'init', session_id: 's1' }, { type: 'result', result: 'x', permission_denials: [] }]);
  assert.deepEqual(of('denials'), []);
});

test('codex parser: toolUse for completed command_execution (failed on a non-zero exit or status failed) and file_change items', () => {
  const { feed, of } = collectAll(codex);
  feed([
    { type: 'thread.started', thread_id: 'c1' },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'echo ok > a.txt', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'echo ok > a.txt', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: ['bash', '-lc', 'touch ../b'], exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: 'x', exit_code: 0, status: 'failed' } },
    { type: 'item.completed', item: { id: 'i4', type: 'command_execution' } },
    { type: 'item.completed', item: { id: 'i5', type: 'file_change', changes: [{ path: 'a.txt', kind: 'add' }, { path: '/out/c.txt', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'i6', type: 'file_change', changes: [{ path: 'd.txt', kind: 'add' }], status: 'failed' } },
    { type: 'item.completed', item: { id: 'i7', type: 'file_change', path: 'e.txt' } },
    { type: 'turn.completed', usage: {} },
  ]);
  assert.deepEqual(of('toolUse'), [
    { name: 'command_execution', command: 'echo ok > a.txt', exitCode: 0, status: 'completed', failed: false },
    { name: 'command_execution', command: 'bash -lc touch ../b', exitCode: 1, status: 'failed', failed: true },
    { name: 'command_execution', command: 'x', exitCode: 0, status: 'failed', failed: true },
    { name: 'command_execution', command: '', exitCode: null, status: null, failed: true },
    { name: 'file_change', paths: ['a.txt', '/out/c.txt'], status: 'completed', failed: false },
    { name: 'file_change', paths: ['d.txt'], status: 'failed', failed: true },
    { name: 'file_change', paths: ['e.txt'], status: null, failed: false },
  ]);
});
