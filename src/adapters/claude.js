// Claude CLI adapter: `claude -p --output-format stream-json` arguments and stream parsing.
const { CLAUDE_LEAN, CLAUDE_TOOLS, CLAUDE_PROBE_MODEL, claudeLean } = require('../config');
const { clip } = require('../util');
const { createFeeder } = require('./jsonl');

// Claude sessions are stored per project dir, so resume needs a stable cwd (the caller passes PROJECT).
// Permission mode: a write seat auto-approves edits (acceptEdits); read and none turns run with dontAsk, so a tool
// outside the allowed list is denied instead of waiting for a prompt nobody can answer in -p mode.
// --tools takes a variable number of values, so it must stay the last flag (the prompt goes on stdin).
// Haiku models take no --effort (the probe below omits it too), so it is left out for them.
const takesEffort = (model) => !/haiku/i.test(String(model || ''));
function buildArgs({ model, effort, thread = null, sessionId = null, addDir = null, mode = 'read' }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model, ...(takesEffort(model) ? ['--effort', effort] : []), ...claudeLean()];
  if (thread) args.push('--resume', thread); else if (sessionId) args.push('--session-id', sessionId);
  if (addDir) args.push('--add-dir', addDir);
  args.push('--permission-mode', mode === 'write' ? 'acceptEdits' : 'dontAsk');
  args.push('--tools', ...(CLAUDE_TOOLS[mode] || CLAUDE_TOOLS.read));
  return args;
}

// Minimal no-tools call whose only purpose is the rate_limit_event. No --effort: Haiku does not take one.
function buildProbeArgs(model = CLAUDE_PROBE_MODEL) {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--no-session-persistence', ...CLAUDE_LEAN, '--tools', ''];
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The path a tool call names: file_path, else path, else notebook_path (null when none is a non-empty string).
const pathOfInput = (input) => {
  if (!isObj(input)) return null;
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof input[k] === 'string' && input[k]) return input[k];
  return null;
};
// A name list from the init event: strings as they are, objects by their name; anything else is kept as its string
// form so a check against an allow list rejects it. null when the field is missing or not an array.
const namesOf = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : isObj(x) && typeof x.name === 'string' ? x.name : String(x))) : null);
// One entry of the result's permission_denials, parsed tolerantly: {name, id, path} (null for what is missing).
const denialOf = (d) => {
  if (typeof d === 'string') return { name: d, id: null, path: null };
  if (!isObj(d)) return { name: null, id: null, path: null };
  const name = typeof d.tool_name === 'string' ? d.tool_name : typeof d.name === 'string' ? d.name : null;
  const id = typeof d.tool_use_id === 'string' ? d.tool_use_id : typeof d.id === 'string' ? d.id : null;
  return { name, id, path: pathOfInput(d.tool_input) ?? pathOfInput(d.input) ?? pathOfInput(d) };
};

// handlers: thread(id), activity(text), delta(text), item(kind, text), usage({tokens,cached,cost}),
//           partialUsage({tokens,cached}), rateLimit(info), completed({result}), error(message). All optional.
// Containment and tool log (the runner checks write turns with these):
//   init({tools, cwd, permissionMode, mcpServers}): the system/init event, sent before thread(); a field the event
//     lacks (or has with the wrong type) is null. mcpServers are the names in mcp_servers.
//   preInit(type): an assistant, stream, user (tool result) or result event arrived before any init event.
//   toolUse({id, name, path}): a tool_use block (path = input.file_path ?? input.path ?? input.notebook_path), once
//     per id. toolResult({id, error}): a tool_result block (error = is_error === true), once per id.
//   denials([{name, id, path}]): the result's permission_denials (sent only when there are some).
// event(ev) returns false for an event type this adapter does not know (the feeder counts those).
// `usage` is the one authoritative per-turn report (from `result`; zeros when the result carries no usage).
// `partialUsage` carries the running totals from message_start/message_delta (no cost) so a consumer can still
// account a run that was killed before its result; it is never a substitute for a `usage` that did arrive.
function createParser(handlers = {}) {
  const on = (k, ...a) => { if (typeof handlers[k] === 'function') handlers[k](...a); };
  let emitted = false; // some text was streamed already (separates consecutive messages)
  let sawInit = false;
  const seenUse = new Set(), seenResult = new Set();
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
    if (Array.isArray(ev.permission_denials) && ev.permission_denials.length) on('denials', ev.permission_denials.map(denialOf));
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
    const resultLike = ev.type === 'result' || (ev.type === undefined && 'total_cost_usd' in ev);
    if (!sawInit && (resultLike || ev.type === 'assistant' || ev.type === 'stream_event' || ev.type === 'user')) on('preInit', resultLike ? 'result' : ev.type);
    switch (ev.type) {
      case 'rate_limit_event': if (isObj(ev.rate_limit_info)) on('rateLimit', ev.rate_limit_info); return true;
      case 'system':
        if (ev.subtype === 'init') {
          sawInit = true;
          on('init', {
            tools: namesOf(ev.tools),
            cwd: typeof ev.cwd === 'string' && ev.cwd ? ev.cwd : null,
            permissionMode: typeof ev.permissionMode === 'string' && ev.permissionMode ? ev.permissionMode : null,
            mcpServers: namesOf(ev.mcp_servers),
          });
          if (typeof ev.session_id === 'string' && ev.session_id) on('thread', ev.session_id);
        }
        else if (ev.subtype === 'thinking_tokens') on('activity', `thinking · ~${num(ev.estimated_tokens)} tok`);
        return true; // other system subtypes (compact_boundary, hooks, ...) carry nothing we show
      case 'stream_event': streamEvent(isObj(ev.event) ? ev.event : {}); return true;
      case 'assistant':
        for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
          if (c?.type !== 'tool_use') continue;
          on('activity', `tool: ${c.name}`); on('item', 'tool', `${c.name} ${clip(c.input)}`);
          const id = typeof c.id === 'string' && c.id ? c.id : null;
          if (id && seenUse.has(id)) continue; // with partial messages a block can arrive more than once
          if (id) seenUse.add(id);
          on('toolUse', { id, name: typeof c.name === 'string' ? c.name : null, path: pathOfInput(c.input) });
        }
        return true;
      case 'user': // tool results echoed back
        for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
          if (c?.type !== 'tool_result') continue;
          const id = typeof c.tool_use_id === 'string' && c.tool_use_id ? c.tool_use_id : null;
          if (id && seenResult.has(id)) continue;
          if (id) seenResult.add(id);
          on('toolResult', { id, error: c.is_error === true });
        }
        return true;
      case 'result': result(ev); return true;
      default:
        if ('total_cost_usd' in ev) { result(ev); return true; } // older CLIs: result object without type
        return false;
    }
  }

  const feeder = createFeeder(event);
  return { feed: feeder.feed, end: feeder.end, stats: feeder.stats, event };
}

module.exports = { buildArgs, buildProbeArgs, createParser, takesEffort };
