// Codex CLI adapter: `codex exec --json` / `codex exec resume <id>` arguments and stream parsing.
const { CODEX_LEAN } = require('../config');
const { shortCmd, clip } = require('../util');
const { createFeeder } = require('./jsonl');

function buildArgs({ model, effort, mode = 'read', thread = null }) {
  const cfg = [...CODEX_LEAN, '-c', `model="${model}"`, '-c', `model_reasoning_effort="${effort}"`, '-c', `sandbox_mode="${mode === 'write' ? 'workspace-write' : 'read-only'}"`];
  if (process.platform === 'win32') cfg.push('-c', 'windows.sandbox="unelevated"');
  return thread ? ['exec', 'resume', thread, '--skip-git-repo-check', '--json', ...cfg, '-'] : ['exec', '--skip-git-repo-check', '--json', ...cfg, '-'];
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (e, fallback) => (typeof e === 'string' && e) || (isObj(e) && typeof e.message === 'string' && e.message) || (isObj(e) ? clip(e, 300) : '') || fallback;

// handlers: thread(id), activity(text), delta(text), item(kind, text), usage({tokens,cached,cost}),
//           rateLimit(info), completed({result}), error(message). All optional.
// event(ev) returns false for an event type this adapter does not know (the feeder counts those).
// `usage` is sent exactly once per turn.completed (zeros when the event carries no usage object; cost is always 0).
function createParser(handlers = {}) {
  const on = (k, ...a) => { if (typeof handlers[k] === 'function') handlers[k](...a); };
  let emitted = false;
  const delta = (s) => { if (s) emitted = true; on('delta', s); };

  function itemCompleted(it) {
    switch (it.type) {
      case 'agent_message':
        on('activity', 'writing');
        if (typeof it.text === 'string' && it.text) delta((emitted ? '\n\n' : '') + it.text);
        return;
      case 'reasoning': on('activity', 'thinking'); on('item', 'reasoning', it.text || it.summary || 'reasoning'); return;
      case 'file_change': on('item', 'tool', 'file change'); return;
      case 'error': { const m = errText(it.message, 'codex error'); if (!/ignoring|Under-development|clamping/i.test(m)) on('item', 'error', m); return; }
      default: return; // command_execution (shown at start), mcp_tool_call, web_search, todo_list, ...
    }
  }

  function event(ev) {
    if (!isObj(ev)) return false;
    switch (ev.type) {
      case 'thread.started': if (typeof ev.thread_id === 'string' && ev.thread_id) on('thread', ev.thread_id); return true;
      case 'turn.started': on('activity', 'thinking'); return true;
      case 'item.started':
        if (ev.item?.type === 'command_execution') { on('activity', 'running a command'); on('item', 'tool', shortCmd(ev.item.command ?? '')); }
        return true;
      case 'item.updated': return true;
      case 'item.completed': itemCompleted(isObj(ev.item) ? ev.item : {}); return true;
      case 'turn.completed': {
        // Net = uncached input + output; cached input is reported separately (much cheaper).
        const u = isObj(ev.usage) ? ev.usage : {}, cached = num(u.cached_input_tokens);
        on('usage', { tokens: Math.max(0, num(u.input_tokens) - cached) + num(u.output_tokens), cached, cost: 0 });
        on('completed', { result: null });
        return true;
      }
      case 'turn.failed': on('error', errText(ev.error, '') || errText(ev.message, 'codex error')); return true;
      case 'error': on('error', errText(ev.error, '') || errText(ev.message, 'codex error')); return true;
      default: return false;
    }
  }

  const feeder = createFeeder(event);
  return { feed: feeder.feed, end: feeder.end, stats: feeder.stats, event };
}

module.exports = { buildArgs, createParser };
