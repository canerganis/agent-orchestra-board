// Cursor CLI adapter (read-only seats only): `cursor-agent -p --output-format stream-json ...` arguments and line parsing.
// UNVERIFIED: the real CLI is not installed here. Flags and event shapes below come from the public docs and are
// built against fixtures (test/fixtures/cursor); recheck against `cursor-agent --help` and a real run before wiring this in.
// Docs relied on:
//   headless / print mode (-p): https://cursor.com/docs/cli/headless
//   flags (--output-format, --model, --mode, --sandbox, --force): https://cursor.com/docs/cli/reference/parameters
//   stream-json event shapes (system init, assistant, tool_call, result): https://cursor.com/docs/cli/reference/output-format
//   modes (agent / plan / ask, the last two read-only): https://cursor.com/docs/cli/overview
// Not wired into seats or config yet.

// Model ids offered for a Cursor seat (UNVERIFIED: ids change often; `cursor-agent --list-models` shows the live set,
// and any id the CLI accepts works through --model).
const CURSOR_MODELS = ['auto', 'sonnet-4', 'gpt-5', 'grok'];

// There is no reasoning-effort flag in the Cursor CLI, so `effort` is accepted and ignored.
// The prompt is the final positional argument after `--` (UNVERIFIED that `--` is honoured; a very long prompt can
// also hit the Windows command line limit).
function buildArgs({ model, effort, prompt, mode = 'read' }) {
  void effort;
  if (mode === 'write') throw new Error('cursor adapter is read-only: write seats are not supported');
  if (typeof prompt !== 'string' || !prompt) throw new Error('cursor adapter: prompt is required');
  // -p/--print: non-interactive run, output to stdout. Without --stream-partial-output each assistant event is a whole message.
  const args = ['-p', '--output-format', 'stream-json'];
  if (model) args.push('--model', model);
  // --mode ask: read-only Q&A, no edits (plan is the other read-only mode). UNVERIFIED that it is enforced in print mode.
  args.push('--mode', 'ask');
  // --sandbox enabled: sandboxes command execution (belt and braces). UNVERIFIED flag value syntax.
  // Never --force/--yolo: those allow file writes and commands without approval.
  args.push('--sandbox', 'enabled');
  // `--` ends flag parsing so a prompt starting with "-" is not read as a flag. Kept last.
  args.push('--', prompt);
  return args;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

// First `<name>ToolCall` entry of a tool_call payload, or the generic `function` form.
function toolInfo(tc) {
  if (!isObj(tc)) return { name: null, input: {}, result: null };
  for (const k of Object.keys(tc)) {
    const v = tc[k];
    if (!isObj(v)) continue;
    if (k === 'function') {
      let input = {};
      try { const p = JSON.parse(v.arguments); if (isObj(p)) input = p; } catch { /* keep {} */ }
      return { name: str(v.name), input, result: null };
    }
    return { name: k.replace(/ToolCall$/, '') || k, input: isObj(v.args) ? v.args : {}, result: isObj(v.result) ? v.result : null };
  }
  return { name: null, input: {}, result: null };
}

// Maps one stdout line to an array of board events (empty for blank, non-JSON or unknown lines):
//   { type: 'thread', id, model }            system init
//   { type: 'text', text }                   assistant message (text parts joined)
//   { type: 'tool', id, name, input }        tool_call started
//   { type: 'tool', id, failed: true }       tool_call completed with an error result (a success is not reported)
//   { type: 'usage', ... }                   never emitted: the CLI reports no usage
//   { type: 'error', message, fatal }        result with is_error or an error subtype
//   { type: 'done', result: null }           result event
function parseLine(line) {
  const s = typeof line === 'string' ? line.trim() : '';
  if (!s.startsWith('{')) return [];
  let ev;
  try { ev = JSON.parse(s); } catch { return []; }
  if (!isObj(ev)) return [];
  switch (ev.type) {
    case 'system':
      return ev.subtype === 'init' ? [{ type: 'thread', id: str(ev.session_id), model: str(ev.model) }] : [];
    case 'assistant': {
      const c = isObj(ev.message) ? ev.message.content : null;
      const text = Array.isArray(c) ? c.map((p) => (isObj(p) && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('') : '';
      return text ? [{ type: 'text', text }] : [];
    }
    case 'tool_call': {
      const t = toolInfo(ev.tool_call);
      if (ev.subtype === 'started') return [{ type: 'tool', id: str(ev.call_id), name: t.name, input: t.input }];
      if (ev.subtype === 'completed') return t.result && t.result.error !== undefined ? [{ type: 'tool', id: str(ev.call_id), failed: true }] : [];
      return [];
    }
    case 'result': {
      const out = [];
      if (ev.is_error === true || ev.subtype === 'error') out.push({ type: 'error', message: str(ev.result) || 'cursor error', fatal: true });
      out.push({ type: 'done', result: null });
      return out;
    }
    default: return [];
  }
}

module.exports = { CURSOR_MODELS, buildArgs, parseLine };
