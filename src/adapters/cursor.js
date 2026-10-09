// Cursor CLI adapter (read-only seats only): `agent -p --output-format stream-json ...` arguments, binary lookup and parsing.
// Verified against one real turn and one resume of Cursor CLI 2026.10.01-e373342 on Windows (test/fixtures/real/cursor-*.jsonl).
// The CLI is installed as `agent` (`cursor-agent` is a legacy alias).
const fs = require('node:fs');
const path = require('node:path');

// `agent --list-models` (live set; any id the CLI accepts works through --model). The cheapest default is auto.
const CURSOR_MODELS = [
  'auto', 'composer-2.5', 'gpt-5.3-codex-low', 'gpt-5.3-codex', 'gpt-5.2', 'gemini-3.7-flash-high',
  'cursor-grok-4.5-high', 'claude-sonnet-5-thinking-high', 'claude-opus-5-thinking-high', 'gpt-5.6-sol-high',
];

// Flags a read-only seat must never carry: they allow edits, commands or MCP servers without asking.
const CURSOR_DENY = ['-f', '--force', '--yolo', '--approve-mcps', '--auto-review'];

// Read-only headless turn. --mode ask is read-only Q&A. --trust only skips the workspace trust prompt (it allows no commands).
// --sandbox enabled is required on macOS and Linux; Windows has no sandbox ("Sandbox requires macOS or Linux"), so it
// gets --sandbox disabled, which is allowlist mode (unapproved commands do not run). The prompt is the last positional argument.
function buildArgs({ model, prompt, resumeId, platform = process.platform, mode = 'read' } = {}) {
  if (mode === 'write') throw new Error('cursor adapter is read-only: write seats are not supported');
  if (typeof prompt !== 'string' || !prompt) throw new Error('cursor adapter: prompt is required');
  const args = ['-p', '--output-format', 'stream-json', '--mode', 'ask', '--sandbox', platform === 'win32' ? 'disabled' : 'enabled', '--trust'];
  if (model) args.push('--model', model);
  if (resumeId) args.push('--resume', String(resumeId));
  args.push(prompt);
  return args;
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Finds the CLI. Returns { cmd, prefixArgs } or null; spawn cmd with [...prefixArgs, ...buildArgs()].
// ORCHESTRA_CURSOR_BIN overrides. On Windows the installer's agent.cmd/agent.ps1 shims are refused by spawnResolved, so the
// newest %LOCALAPPDATA%\cursor-agent\versions\<YYYY.MM.DD-commit>\ is run directly as node.exe + index.js. Elsewhere `agent`
// (or `cursor-agent`) on PATH, usually ~/.local/bin. Options exist for tests: env, platform, localAppData.
function resolveBin({ env = process.env, platform = process.platform, localAppData } = {}) {
  if (env.ORCHESTRA_CURSOR_BIN) return { cmd: env.ORCHESTRA_CURSOR_BIN, prefixArgs: [] };
  const win = platform === 'win32';
  if (win) {
    const base = localAppData || env.LOCALAPPDATA;
    if (base) {
      const versions = path.join(base, 'cursor-agent', 'versions');
      let dirs = [];
      try { dirs = fs.readdirSync(versions).filter((d) => /^\d{4}\.\d{2}\.\d{2}/.test(d)).sort().reverse(); } catch { /* not installed */ }
      for (const d of dirs) {
        const node = path.join(versions, d, 'node.exe'), index = path.join(versions, d, 'index.js');
        if (isFile(node) && isFile(index)) return { cmd: node, prefixArgs: [index] };
      }
    }
  }
  const names = win ? ['agent.exe', 'cursor-agent.exe'] : ['agent', 'cursor-agent'];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter);
  if (!win && env.HOME) dirs.push(path.join(env.HOME, '.local', 'bin'));
  for (const dir of dirs) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      if (isFile(p)) return { cmd: p, prefixArgs: [] };
    }
  }
  return null;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

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
    if (!k.endsWith('ToolCall')) continue;
    return { name: k.replace(/ToolCall$/, '') || k, input: isObj(v.args) ? v.args : {}, result: isObj(v.result) ? v.result : null };
  }
  return { name: null, input: {}, result: null };
}

// Maps one stdout line to an array of board events (empty for blank, non-JSON or unknown lines; thinking and user events are ignored):
//   { type: 'thread', id, model }            system init (id = session_id)
//   { type: 'text', text }                   assistant message (text parts joined)
//   { type: 'tool', id, name, input }        tool_call started
//   { type: 'tool', id, failed: true }       tool_call completed with an error result (a success is not reported)
//   { type: 'usage', tokens, cached, ... }   result only: net = inputTokens, cached = cacheReadTokens, tokens = net + output
//   { type: 'error', message, fatal }        result with is_error true or a subtype other than success
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
      if (isObj(ev.usage)) {
        const net = num(ev.usage.inputTokens), output = num(ev.usage.outputTokens), cached = num(ev.usage.cacheReadTokens);
        out.push({ type: 'usage', tokens: net + output, cached, cost: 0, input: net, output, net, cacheWrite: num(ev.usage.cacheWriteTokens) });
      }
      if (ev.is_error === true || (ev.subtype !== undefined && ev.subtype !== 'success')) out.push({ type: 'error', message: str(ev.result) || 'cursor error', fatal: true });
      out.push({ type: 'done', result: null });
      return out;
    }
    default: return [];
  }
}

module.exports = { CURSOR_MODELS, CURSOR_DENY, buildArgs, parseLine, resolveBin };
