// Codex CLI adapter: `codex exec --json` / `codex exec resume <id>` arguments and stream parsing.
const { CODEX_LEAN } = require('../config');
const { shortCmd, jsonlFeeder } = require('../util');

function buildArgs({ model, effort, mode = 'read', thread = null }) {
  const cfg = [...CODEX_LEAN, '-c', `model="${model}"`, '-c', `model_reasoning_effort="${effort}"`, '-c', `sandbox_mode="${mode === 'write' ? 'workspace-write' : 'read-only'}"`];
  if (process.platform === 'win32') cfg.push('-c', 'windows.sandbox="unelevated"');
  return thread ? ['exec', 'resume', thread, '--skip-git-repo-check', '--json', ...cfg, '-'] : ['exec', '--skip-git-repo-check', '--json', ...cfg, '-'];
}

// handlers: thread(id), activity(text), delta(text), item(kind, text), usage({tokens,cached,cost}),
//           rateLimit(info), completed({result}), error(message). All optional.
function createParser(handlers = {}) {
  const on = (k, ...a) => { if (typeof handlers[k] === 'function') handlers[k](...a); };
  let emitted = false;
  const delta = (s) => { if (s) emitted = true; on('delta', s); };

  function event(ev) {
    if (ev.type === 'thread.started') on('thread', ev.thread_id);
    else if (ev.type === 'turn.started') on('activity', 'thinking');
    else if (ev.type === 'item.started' && ev.item?.type === 'command_execution') { on('activity', 'running a command'); on('item', 'tool', shortCmd(ev.item.command)); }
    else if (ev.type === 'item.completed') {
      const it = ev.item || {};
      if (it.type === 'agent_message') { on('activity', 'writing'); delta((emitted ? '\n\n' : '') + it.text); }
      else if (it.type === 'reasoning') { on('activity', 'thinking'); on('item', 'reasoning', it.text || it.summary || 'reasoning'); }
      else if (it.type === 'file_change') on('item', 'tool', 'file change');
      else if (it.type === 'error' && !/ignoring|Under-development|clamping/i.test(it.message || '')) on('item', 'error', it.message);
    } else if (ev.type === 'turn.completed') {
      // Net = uncached input + output; cached input is reported separately (much cheaper).
      const u = ev.usage || {}; const cached = u.cached_input_tokens || 0;
      on('usage', { tokens: (u.input_tokens || 0) - cached + (u.output_tokens || 0), cached, cost: 0 });
      on('completed', { result: null });
    }
    else if (ev.type === 'turn.failed' || ev.type === 'error') on('error', ev.error?.message || ev.message || 'codex error');
  }

  return { feed: jsonlFeeder(event), event };
}

module.exports = { buildArgs, createParser };
