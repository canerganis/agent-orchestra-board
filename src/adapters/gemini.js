// Gemini CLI adapter (read-only seats only): `gemini -p ... --output-format stream-json` arguments and line parsing.
// UNVERIFIED: the real CLI is not installed here. Flags and event shapes below come from the public docs and are
// built against fixtures (test/fixtures/gemini); recheck against `gemini --help` and a real run before wiring this in.
// Docs relied on:
//   headless mode and stream-json events: https://geminicli.com/docs/cli/headless/
//   CLI flags (-p, -m, --approval-mode, --exclude-tools): https://geminicli.com/docs/cli/cli-reference/
//   plan (read-only) approval mode: https://geminicli.com/docs/cli/plan-mode/
//   built-in tool names: https://geminicli.com/docs/tools/
// Not wired into seats or config yet.

// Model ids offered for a Gemini seat (UNVERIFIED: ids change often; any id the CLI accepts works through -m).
const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// Tools a read-only seat must not have: file edits, shell and network fetches.
const GEMINI_DENY_TOOLS = ['run_shell_command', 'write_file', 'replace', 'web_fetch', 'google_web_search'];

// There is no reasoning-effort flag in the Gemini CLI, so `effort` is accepted and ignored.
// The prompt is passed as the -p value (UNVERIFIED: a very long prompt can hit the Windows command line limit).
function buildArgs({ model, effort, prompt, mode = 'read' }) {
  void effort;
  if (mode === 'write') throw new Error('gemini adapter is read-only: write seats are not supported');
  if (typeof prompt !== 'string' || !prompt) throw new Error('gemini adapter: prompt is required');
  const args = ['--output-format', 'stream-json'];
  if (model) args.push('-m', model);
  // --approval-mode plan: read-only planning mode, no edits or shell. UNVERIFIED (newer, may be experimental).
  args.push('--approval-mode', 'plan');
  // --exclude-tools: removes a tool from the model's reach (belt and braces next to plan mode). UNVERIFIED: the
  // flag is documented as deprecated in favour of the policy engine, and its repeat syntax is unconfirmed.
  for (const t of GEMINI_DENY_TOOLS) args.push('--exclude-tools', t);
  // -p/--prompt: non-interactive run. Kept last so nothing can be read as part of the prompt.
  args.push('-p', prompt);
  return args;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

// Maps one stdout line to an array of board events (empty for blank, non-JSON or unknown lines):
//   { type: 'thread', id, model }            init
//   { type: 'text', text }                   assistant message (delta or whole)
//   { type: 'tool', id, name, input }        tool_use
//   { type: 'tool', id, failed: true }       tool_result with status error (a success result is not reported)
//   { type: 'usage', tokens, cached, cost }  result stats (cost is always 0: the CLI reports none)
//   { type: 'error', message, fatal }        error event, or a result with status error
//   { type: 'done', result: null }           result event
function parseLine(line) {
  const s = typeof line === 'string' ? line.trim() : '';
  if (!s.startsWith('{')) return [];
  let ev;
  try { ev = JSON.parse(s); } catch { return []; }
  if (!isObj(ev)) return [];
  switch (ev.type) {
    case 'init': return [{ type: 'thread', id: str(ev.session_id), model: str(ev.model) }];
    case 'message':
      if (ev.role !== 'assistant' || typeof ev.content !== 'string' || !ev.content) return [];
      return [{ type: 'text', text: ev.content }];
    case 'tool_use': return [{ type: 'tool', id: str(ev.tool_id), name: str(ev.tool_name), input: isObj(ev.parameters) ? ev.parameters : {} }];
    case 'tool_result': return ev.status === 'error' ? [{ type: 'tool', id: str(ev.tool_id), failed: true }] : [];
    case 'error': return [{ type: 'error', message: str(ev.message) || 'gemini error', fatal: ev.severity !== 'warning' }];
    case 'result': {
      const st = isObj(ev.stats) ? ev.stats : {};
      const out = [{ type: 'usage', tokens: num(st.total_tokens) || num(st.input_tokens) + num(st.output_tokens), cached: num(st.cached), cost: 0 }];
      if (ev.status === 'error') out.push({ type: 'error', message: str(isObj(ev.error) ? ev.error.message : ev.error) || 'gemini error', fatal: true });
      out.push({ type: 'done', result: null });
      return out;
    }
    default: return [];
  }
}

module.exports = { GEMINI_MODELS, GEMINI_DENY_TOOLS, buildArgs, parseLine };
