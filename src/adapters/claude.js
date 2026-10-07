// Claude CLI adapter: `claude -p --output-format stream-json` arguments and stream parsing.
const { CLAUDE_LEAN, CLAUDE_TOOLS, CLAUDE_PROBE_MODEL } = require('../config');
const { clip, jsonlFeeder } = require('../util');

// Claude sessions are stored per project dir, so resume needs a stable cwd (the caller passes PROJECT).
function buildArgs({ model, effort, thread = null, sessionId = null, addDir = null, mode = 'read' }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model, '--effort', effort, ...CLAUDE_LEAN];
  if (thread) args.push('--resume', thread); else if (sessionId) args.push('--session-id', sessionId);
  if (addDir) args.push('--add-dir', addDir);
  if (mode === 'write') args.push('--permission-mode', 'acceptEdits');
  args.push('--tools', ...CLAUDE_TOOLS[mode]);
  return args;
}

// Minimal no-tools call whose only purpose is the rate_limit_event.
function buildProbeArgs() {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--model', CLAUDE_PROBE_MODEL, '--effort', 'low', '--no-session-persistence', ...CLAUDE_LEAN, '--tools', ''];
}

// handlers: thread(id), activity(text), delta(text), item(kind, text), usage({tokens,cached,cost}),
//           rateLimit(info), completed({result}), error(message). All optional.
function createParser(handlers = {}) {
  const on = (k, ...a) => { if (typeof handlers[k] === 'function') handlers[k](...a); };
  let emitted = false; // some text was streamed already (separates consecutive messages)
  const delta = (s) => { if (s) emitted = true; on('delta', s); };

  function event(ev) {
    if (ev.type === 'rate_limit_event' && ev.rate_limit_info) on('rateLimit', ev.rate_limit_info);
    else if (ev.type === 'system' && ev.subtype === 'init') on('thread', ev.session_id);
    else if (ev.type === 'system' && ev.subtype === 'thinking_tokens') on('activity', `thinking · ~${ev.estimated_tokens} tok`);
    else if (ev.type === 'stream_event') {
      const e = ev.event || {};
      if (e.type === 'message_start' && emitted) delta('\n\n');
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { on('activity', 'writing'); delta(e.delta.text); }
      if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') on('activity', 'thinking');
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) if (c.type === 'tool_use') { on('activity', `tool: ${c.name}`); on('item', 'tool', `${c.name} ${clip(c.input)}`); }
    } else if (ev.type === 'result' || 'total_cost_usd' in ev) {
      const final = typeof ev.result === 'string' ? ev.result : null;
      const u = ev.usage || {}; const cached = u.cache_read_input_tokens || 0;
      const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      on('usage', { tokens, cached, cost: ev.total_cost_usd || 0 });
      on('completed', { result: final });
      if (ev.is_error) on('error', final || 'claude error');
    }
  }

  return { feed: jsonlFeeder(event), event };
}

module.exports = { buildArgs, buildProbeArgs, createParser };
