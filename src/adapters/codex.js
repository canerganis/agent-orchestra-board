// Codex CLI adapter: `codex exec --json` / `codex exec resume <id>` arguments and stream parsing.
const { codexLean } = require('../config');
const { shortCmd, clip } = require('../util');
const { createFeeder } = require('./jsonl');

// Codex's workspace-write sandbox also allows /tmp and $TMPDIR by default; a write turn excludes both.
const WRITE_EXCLUDES = ['sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true'];

function buildArgs({ model, effort, mode = 'read', thread = null }) {
  const cfg = [...codexLean(), '-c', `model="${model}"`, '-c', `model_reasoning_effort="${effort}"`, '-c', `sandbox_mode="${mode === 'write' ? 'workspace-write' : 'read-only'}"`];
  // Write turns: the sandbox's writable root is the cwd (the item worktree); no network access from inside it, and
  // /tmp and $TMPDIR are not writable roots either (Codex adds both by default unless they are excluded).
  if (mode === 'write') cfg.push('-c', 'sandbox_workspace_write.network_access=false', ...WRITE_EXCLUDES.flatMap((x) => ['-c', x]));
  if (process.platform === 'win32') cfg.push('-c', 'windows.sandbox="unelevated"');
  return thread ? ['exec', 'resume', thread, '--skip-git-repo-check', '--json', ...cfg, '-'] : ['exec', '--skip-git-repo-check', '--json', ...cfg, '-'];
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (e, fallback) => (typeof e === 'string' && e) || (isObj(e) && typeof e.message === 'string' && e.message) || (isObj(e) ? clip(e, 300) : '') || fallback;

// A command as text: a string as it is, an argv array joined with spaces, anything else ''.
const cmdText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(String).join(' ') : '');
// The paths of a file_change item, read tolerantly: changes[].path, else paths[], else path.
function changePaths(it) {
  const out = [];
  const add = (p) => { if (typeof p === 'string' && p) out.push(p); };
  if (Array.isArray(it.changes)) for (const c of it.changes) add(isObj(c) ? c.path : c);
  else if (Array.isArray(it.paths)) it.paths.forEach(add);
  else add(it.path);
  return out;
}

// handlers: thread(id), activity(text), delta(text), item(kind, text), usage({tokens,cached,cost}),
//           rateLimit(info), completed({result}), error(message). All optional.
// Tool log: toolUse({name: 'command_execution', command, exitCode, status, failed}) for a completed command
// (failed when exit_code !== 0 or the status is failed) and toolUse({name: 'file_change', paths, status, failed})
// for a completed file change (failed when the status is failed).
// event(ev) returns false for an event type this adapter does not know (the feeder counts those).
// `usage` is sent exactly once per turn.completed (zeros when the event carries no usage object; cost is always 0).
function createParser(handlers = {}) {
  const on = (k, ...a) => { if (typeof handlers[k] === 'function') handlers[k](...a); };
  let emitted = false, completed = false, failed = false, pendingError = null;
  const delta = (s) => { if (s) emitted = true; on('delta', s); };

  function itemCompleted(it) {
    switch (it.type) {
      case 'agent_message':
        on('activity', 'writing');
        if (typeof it.text === 'string' && it.text) delta((emitted ? '\n\n' : '') + it.text);
        return;
      case 'reasoning': on('activity', 'thinking'); on('item', 'reasoning', it.text || it.summary || 'reasoning'); return;
      case 'command_execution': {
        const exitCode = typeof it.exit_code === 'number' ? it.exit_code : null;
        const status = typeof it.status === 'string' ? it.status : null;
        on('toolUse', { name: 'command_execution', command: cmdText(it.command), exitCode, status, failed: exitCode !== 0 || status === 'failed' });
        return;
      }
      case 'file_change': {
        on('item', 'tool', 'file change');
        const status = typeof it.status === 'string' ? it.status : null;
        on('toolUse', { name: 'file_change', paths: changePaths(it), status, failed: status === 'failed' });
        return;
      }
      case 'error': { const m = errText(it.message, 'codex error'); if (!/ignoring|Under-development|clamping/i.test(m)) on('item', 'error', m); return; }
      default: return; // mcp_tool_call, web_search, todo_list, ...
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
        completed = true; pendingError = null;
        on('completed', { result: null });
        return true;
      }
      case 'turn.failed': failed = true; on('error', errText(ev.error, '') || errText(ev.message, 'codex error')); return true;
      case 'error': {
        // Codex also reports its own recoverable stream retries this way ("stream disconnected - retrying sampling
        // request (1/5 …)", "Reconnecting…") and the turn usually completes afterwards. turn.completed / turn.failed
        // decide the outcome: an error only fails the turn when the stream ends with neither (see end()).
        const m = errText(ev.error, '') || errText(ev.message, 'codex error');
        on('item', 'error', m);
        if (!completed && !failed) pendingError = m;
        return true;
      }
      default: return false;
    }
  }

  const feeder = createFeeder(event);
  // end(): flush the last line, then report a top-level error that no turn.completed / turn.failed followed.
  const end = () => { feeder.end(); if (pendingError && !completed && !failed) { failed = true; on('error', pendingError); } };
  return { feed: feeder.feed, end, stats: feeder.stats, event };
}

module.exports = { buildArgs, createParser, WRITE_EXCLUDES };
