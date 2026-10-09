// Antigravity CLI adapter (read-only seats only): `agy -p ... --output-format stream-json` arguments and parsing.
// Verified against one real turn of agy 1.2.17 on Windows on 2026-10-09 (test/fixtures/antigravity/real-turn.jsonl).
// agy serves Gemini models and also Claude models through Antigravity's own quota.
const fs = require('node:fs');
const path = require('node:path');

const AGY_MODELS = [
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
  'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
  'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
  'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
  'gpt-oss-120b-medium',
];

// Flags a read-only seat must never carry.
const AGY_DENY = ['--dangerously-skip-permissions', '--add-dir', 'accept-edits'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The prompt is the -p value (a very long prompt can hit the Windows command line limit).
function buildArgs({ model, effort, prompt, mode = 'read', resumeId } = {}) {
  if (mode === 'write') throw new Error('antigravity adapter is read-only: write seats are not supported');
  if (typeof prompt !== 'string' || !prompt) throw new Error('antigravity adapter: prompt is required');
  const args = ['-p', prompt, '--output-format', 'stream-json', '--mode', 'plan', '--sandbox', '--disable-slash-commands'];
  if (model) args.push('--model', model);
  if (effort && EFFORTS.includes(effort)) args.push('--effort', effort);
  if (resumeId) args.push('--conversation', String(resumeId));
  return args;
}

// Finds agy: ORCHESTRA_AGY_BIN, then PATH, then %LOCALAPPDATA%\Packages\OpenAI.Codex_*\LocalCache\Local\agy\bin\agy.exe.
// Returns a path or null. Options exist for tests: env, platform, localAppData.
function resolveBin({ env = process.env, platform = process.platform, localAppData } = {}) {
  if (env.ORCHESTRA_AGY_BIN) return env.ORCHESTRA_AGY_BIN;
  const names = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  const base = localAppData || env.LOCALAPPDATA;
  if (base) {
    const pkgs = path.join(base, 'Packages');
    let dirs = [];
    try { dirs = fs.readdirSync(pkgs).filter((d) => d.startsWith('OpenAI.Codex_')).sort(); } catch { /* no packages */ }
    for (const d of dirs) {
      const p = path.join(pkgs, d, 'LocalCache', 'Local', 'agy', 'bin', 'agy.exe');
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

function usageOf(u) {
  const x = isObj(u) ? u : {};
  const input = num(x.input_tokens), output = num(x.output_tokens), cacheRead = num(x.cache_read_tokens);
  return { input, output, thinking: num(x.thinking_tokens), cacheRead, net: Math.max(0, input - cacheRead), total: num(x.total_tokens) };
}

// Maps one stdout line to board events (empty for blank, non-JSON or unknown lines):
//   init                    -> { type: 'thread', id: conversation_id, model }
//   step_update text_delta  -> { type: 'text', text }
//   step_update tool ACTIVE -> { type: 'tool', id, name, input }
//   result                  -> { type: 'usage', tokens: net input + output, cached, cost: 0, ... }, then
//                              { type: 'done', result: { response, usage } }; a status other than SUCCESS adds a fatal error.
// Per-step usage is not reported: the result carries the turn total, and reporting both would count tokens twice.
function parseLine(line) {
  const s = typeof line === 'string' ? line.trim() : '';
  if (!s.startsWith('{')) return [];
  let ev;
  try { ev = JSON.parse(s); } catch { return []; }
  if (!isObj(ev)) return [];
  if (ev.event === 'init') {
    const i = isObj(ev.init) ? ev.init : {};
    return [{ type: 'thread', id: str(ev.conversation_id), model: str(i.model) }];
  }
  if (ev.event === 'step_update' && isObj(ev.step_update)) {
    const st = ev.step_update;
    if (st.step_type === 'tool' && st.state === 'ACTIVE') {
      const info = isObj(st.tool_info) ? st.tool_info : {};
      return [{ type: 'tool', id: `${str(st.conversation_id) || 'agy'}:${st.step_index}`, name: str(st.tool_name) || str(info.name), input: isObj(info.parameters) ? info.parameters : {} }];
    }
    if (st.step_type === 'agent_response' && typeof st.text_delta === 'string' && st.text_delta) return [{ type: 'text', text: st.text_delta }];
    return [];
  }
  if (ev.event === 'result' && isObj(ev.result)) {
    const r = ev.result;
    const u = usageOf(r.usage);
    const out = [{ type: 'usage', tokens: u.net + u.output, cached: u.cacheRead, cost: 0, input: u.input, output: u.output, thinking: u.thinking, net: u.net, total: u.total }];
    if (r.status !== 'SUCCESS') out.push({ type: 'error', message: `agy status ${str(r.status) || 'unknown'}${str(r.response) ? `: ${r.response}` : ''}`, fatal: true });
    out.push({ type: 'done', result: { response: str(r.response) || '', usage: u } });
    return out;
  }
  return [];
}

module.exports = { AGY_MODELS, AGY_DENY, buildArgs, parseLine, resolveBin };
