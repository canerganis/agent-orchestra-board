// Claude CLI adapter: `claude -p --output-format stream-json` arguments and stream parsing.
const { CLAUDE_LEAN, CLAUDE_TOOLS, CLAUDE_PROBE_MODEL } = require('../config');
const { clip } = require('../util');
const { createFeeder } = require('./jsonl');

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

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// handlers: thread(id), activity(text), delta(text), item(kind, text), usage({tokens,cached,cost}),
//           partialUsage({tokens,cached}), rateLimit(info), completed({result}), error(message). All optional.
// event(ev) returns false for an event type this adapter does not know (the feeder counts those).
// `usage` is the one authoritative per-turn report (from `result`; zeros when the result carries no usage).
// `partialUsage` carries the running totals from message_start/message_delta (no cost) so a consumer can still
// account a run that was killed before its result; it is never a substitute for a `usage` that did arrive.
function createParser(handlers = {}) {
  const on = (k, ...a) => { if (typeof handlers[k] === 'function') handlers[k](...a); };
  let emitted = false; // some text was streamed already (separates consecutive messages)
  const delta = (s) => { if (s) emitted = true; on('delta', s); };
  // Per-turn token accounting from the stream: `done` = finished messages, `cur` = the message in flight.
  const done = { inp: 0, cached: 0, out: 0 };
  let cur = null;
  const usageOf = (u) => ({ inp: num(u.input_tokens) + num(u.cache_creation_input_tokens), cached: num(u.cache_read_input_tokens), out: num(u.output_tokens) });
  const partial = () => on('partialUsage', { tokens: done.inp + done.out + (cur ? cur.inp + cur.out : 0), cached: done.cached + (cur ? cur.cached : 0) });

  function streamEvent(e) {
    switch (e.type) {
      case 'message_start': {
        if (emitted) delta('\n\n');
        if (cur) { done.inp += cur.inp; done.cached += cur.cached; done.out += cur.out; }
        cur = null;
        const u = e.message && e.message.usage;
        if (isObj(u)) { cur = usageOf(u); partial(); }
        return;
      }
      case 'message_delta': {
        const u = e.usage;
        if (!isObj(u)) return;
        cur ||= { inp: 0, cached: 0, out: 0 };
        if (typeof u.output_tokens === 'number') cur.out = num(u.output_tokens);
        if (typeof u.input_tokens === 'number') { cur.inp = num(u.input_tokens) + num(u.cache_creation_input_tokens); cur.cached = num(u.cache_read_input_tokens); }
        partial();
        return;
      }
      case 'content_block_start':
        if (e.content_block?.type === 'tool_use' && e.content_block.name) on('activity', `tool: ${e.content_block.name}`);
        return;
      case 'content_block_delta': {
        const d = e.delta || {};
        if (d.type === 'text_delta') { on('activity', 'writing'); if (typeof d.text === 'string') delta(d.text); }
        else if (d.type === 'thinking_delta') on('activity', 'thinking');
        return;
      }
      default: return; // message_stop, content_block_stop, ping, ...
    }
  }

  function result(ev) {
    const final = typeof ev.result === 'string' ? ev.result : null;
    const u = isObj(ev.usage) ? ev.usage : {};
    const cached = num(u.cache_read_input_tokens);
    const tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens);
    on('usage', { tokens, cached, cost: num(ev.total_cost_usd) }); // zeros when the result carries no usage
    on('completed', { result: final });
    const sub = typeof ev.subtype === 'string' ? ev.subtype : '';
    if (ev.is_error === true || sub.startsWith('error')) {
      const errs = Array.isArray(ev.errors) ? ev.errors.map((x) => (typeof x === 'string' ? x : clip(x, 200))).filter(Boolean).join('; ') : '';
      on('error', final || errs || 'claude error'); // the CLI's own text, unprefixed (the subtype stays in the raw event)
    }
  }

  function event(ev) {
    if (!isObj(ev)) return false;
    switch (ev.type) {
      case 'rate_limit_event': if (isObj(ev.rate_limit_info)) on('rateLimit', ev.rate_limit_info); return true;
      case 'system':
        if (ev.subtype === 'init') { if (typeof ev.session_id === 'string' && ev.session_id) on('thread', ev.session_id); }
        else if (ev.subtype === 'thinking_tokens') on('activity', `thinking · ~${num(ev.estimated_tokens)} tok`);
        return true; // other system subtypes (compact_boundary, hooks, ...) carry nothing we show
      case 'stream_event': streamEvent(isObj(ev.event) ? ev.event : {}); return true;
      case 'assistant':
        for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
          if (c?.type === 'tool_use') { on('activity', `tool: ${c.name}`); on('item', 'tool', `${c.name} ${clip(c.input)}`); }
        }
        return true;
      case 'user': return true; // tool results echoed back
      case 'result': result(ev); return true;
      default:
        if ('total_cost_usd' in ev) { result(ev); return true; } // older CLIs: result object without type
        return false;
    }
  }

  const feeder = createFeeder(event);
  return { feed: feeder.feed, end: feeder.end, stats: feeder.stats, event };
}

module.exports = { buildArgs, buildProbeArgs, createParser };
