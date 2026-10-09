#!/usr/bin/env node
// Fake `claude` / `codex` CLI for the test suite. Never talks to any model.
//
// It is launched through the wrappers that test/fake-cli/index.js builds (fake-claude / fake-codex) and
// decides which CLI it impersonates from argv: codex args start with `exec`, claude args with `-p`.
// It then emits the recorded-style event stream (claude stream-json or codex --json) for a reply chosen
// from <OB_FAKE_DIR>/scenario.json and logs every invocation to <OB_FAKE_DIR>/calls.jsonl.
//
// scenario.json: { rules: [rule, ...], default?: rule }  (first matching rule wins)
//   rule selectors: agent ('claude'|'codex'), seat (seat name from the role header), match (regex on the
//                   prompt, dotall), nth (1-based call number for that seat), resume (true: only resumed turns,
//                   false: only new threads)
//   rule actions:   replay (path relative to test/fixtures, e.g. "real/claude-tool.jsonl": prints that real recording
//                   instead of synthetic lines, with the recorded thread id swapped for this call's thread id; true
//                   picks the recording for the agent: claude/codex *-plain (new thread) or *-resume, agy *-tool or
//                   *-resume; ignored for cursor, which has no recording). The default rule replays, so the happy
//                   path of every test runs real output. Synthetic lines are kept for rules that need exact content:
//                   anything with reply, usage, tool, error, crash, init, toolUses, commands and the like, because the
//                   recordings cannot carry a chosen text, token count or edge case (errors, broken JSON, hangs).
//                   reply (text), usage ({input, cacheCreation, cacheRead, output, cost} | {input, cached, output}),
//                   rateLimit (claude rate_limit_info object), thinking (bool), tool (bool), reasoning (text),
//                   events (extra raw events emitted before the result), error (message -> failed turn),
//                   warn (stderr text) and noise (a non-JSON stdout line) before a successful turn,
//                   crash (stderr text; exits without a completed turn), exit (exit code), gate (name: wait for
//                   <OB_FAKE_DIR>/gates/<name> before answering), delayMs, hang (never finishes),
//                   spawnChild (true, with hang: long command inheriting stdout/stderr; logs childPid),
//                   spawnChild ({path?}, codex only: starts a pretend sub-agent. It writes a child rollout under
//                   $CODEX_HOME/sessions/<today> (default ~/.codex) whose session_meta names this call's thread id as
//                   source.subagent.thread_spawn.parent_thread_id, and writes path (relative to the cwd) when given),
//                   lostThread (the resumed thread is gone: prints the CLI's own not-found message on stderr, no
//                   stdout, exit 1, like claude --resume / codex exec resume with an unknown id),
//                   writeFiles ([{path, content?, append?}]: writes files as an agent tool would; a relative path resolves
//                   against the cwd, an absolute one is used as given; mkdir -p the parent; content defaults to 'ok\n';
//                   append: true appends instead, which also works on a hidden file such as a worktree .git on Windows)
//                   and deleteFiles ([path]: removes files, force: a missing file is not an error). The file
//                   operations run after gate/delayMs and before the body, and are skipped for hang and lostThread.
//                   Each operation is logged to <OB_FAKE_DIR>/writes.jsonl as {n, op, path, ok, error}, where n is
//                   the number of the call that performed it.
//   containment and tool log actions (plan 5.6.4 and 5.6.5):
//                   init ({tools?, cwd?, permissionMode?, mcp_servers?}: overrides fields of claude's system/init
//                   event; a null value removes the field. Defaults: tools from --tools, cwd = the process cwd,
//                   permissionMode from --permission-mode, mcp_servers = []),
//                   beforeInit (true: claude emits an assistant tool_use event before its init event),
//                   toolUses ([{name, file_path, error?}]: claude assistant tool_use blocks, each followed by its
//                   tool_result, is_error = !!error), denials ([...]: claude result.permission_denials as given),
//                   commands ([{command, exit_code}]: codex command_execution items, started and completed; status
//                   failed when exit_code is not 0) and fileChanges ([{path, status}]: codex completed file_change items,
//                   status defaults to completed). None of these touch the disk: writeFiles does that.
//
// Thread bookkeeping mirrors the real CLIs: claude `--session-id` / `--resume`, codex `exec resume <id>`.
// The seat name is taken from the runner's role header on the first turn of a thread and remembered under
// threads/<id>.json so resumed turns (which carry no header) can still be matched by seat.
const fs = require('fs');
const path = require('path');

const DIR = process.env.OB_FAKE_DIR;

function parseArgs(args) {
  const a = { agent: args[0] === 'exec' ? 'codex' : process.env.OB_FAKE_AGENT === 'cursor' ? 'cursor' : (process.env.OB_FAKE_AGENT === 'agy' || args.includes('--mode')) ? 'agy' : 'claude', prompt: null, resume: null, sessionId: null, model: null, effort: null, tools: null, permissionMode: null, addDir: null, sandbox: null, config: {} };
  if (a.agent === 'codex') {
    if (args[1] === 'resume') a.resume = args[2];
    for (let i = 0; i < args.length; i++) if (args[i] === '-c') { const [k, v] = String(args[++i]).split(/=(.*)/s); a.config[k] = v; }
    a.model = (a.config.model || '').replace(/^"|"$/g, '');
    a.effort = (a.config.model_reasoning_effort || '').replace(/^"|"$/g, '');
    a.sandbox = (a.config.sandbox_mode || '').replace(/^"|"$/g, '');
  } else if (a.agent === 'cursor') {
    // agent -p --output-format stream-json --mode ask [--model m] [--sandbox s] [--trust] [--resume id] <prompt> (prompt last)
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--model') a.model = args[++i];
      else if (args[i] === '--mode') a.permissionMode = args[++i];
      else if (args[i] === '--sandbox') a.sandbox = args[++i];
      else if (args[i] === '--resume') a.resume = args[++i];
      else if (args[i] === '--output-format') i++;
      else if (!args[i].startsWith('-')) a.prompt = args[i];
    }
  } else if (a.agent === 'agy') {
    // agy -p <prompt> --output-format stream-json --mode plan --sandbox ... [--model m] [--effort e] [--conversation id]
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--model') a.model = args[++i];
      else if (args[i] === '--effort') a.effort = args[++i];
      else if (args[i] === '--mode') a.permissionMode = args[++i];
      else if (args[i] === '--conversation') a.resume = args[++i];
      else if (args[i] === '--sandbox') a.sandbox = 'on';
      else if (args[i] === '-p') a.prompt = args[++i];
    }
  } else {
    for (let i = 0; i < args.length; i++) {
      const x = args[i];
      if (x === '--resume') a.resume = args[++i];
      else if (x === '--session-id') a.sessionId = args[++i];
      else if (x === '--model') a.model = args[++i];
      else if (x === '--effort') a.effort = args[++i];
      else if (x === '--permission-mode') a.permissionMode = args[++i];
      else if (x === '--add-dir') a.addDir = args[++i];
      else if (x === '--tools') { a.tools = args.slice(i + 1); break; }
    }
  }
  return a;
}

const readStdin = () => new Promise((resolve) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s)); process.stdin.on('error', () => resolve(s)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (stream, s) => new Promise((r) => stream.write(s, () => r()));
const jsonl = (events) => events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)) + '\n').join('');
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

function readCalls() {
  let s; try { s = fs.readFileSync(path.join(DIR, 'calls.jsonl'), 'utf8'); } catch { return []; }
  return s.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function pickRule(scenario, ctx) {
  const rules = Array.isArray(scenario.rules) ? scenario.rules : [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.agent && r.agent !== ctx.agent) continue;
    if (r.seat && r.seat !== ctx.seat) continue;
    if (r.nth && r.nth !== ctx.nth) continue;
    if (typeof r.resume === 'boolean' && r.resume !== ctx.resume) continue;
    if (r.match && !new RegExp(r.match, 's').test(ctx.prompt)) continue;
    return { rule: r, index: i };
  }
  return { rule: scenario.default || { replay: true }, index: 'default' };
}

// Real recording to print for a rule, or null for synthetic lines. A rule that asks for exact content (reply, usage,
// tool, ...) or an edge case stays synthetic unless it names a replay file itself.
const SYNTHETIC_KEYS = ['reply', 'usage', 'rateLimit', 'thinking', 'tool', 'reasoning', 'events', 'error', 'crash', 'init', 'beforeInit', 'toolUses', 'denials', 'commands', 'fileChanges'];
function replayFile(rule, agent, resumed) {
  if (!rule.replay) return null;
  if (typeof rule.replay === 'string') return rule.replay;
  if (SYNTHETIC_KEYS.some((k) => rule[k] !== undefined)) return null;
  if (agent === 'cursor') return null;
  if (agent === 'agy') return resumed ? 'real/agy-resume.jsonl' : 'real/agy-tool.jsonl';
  return `real/${agent}-${resumed ? 'resume' : 'plain'}.jsonl`;
}

// Splits a real recording into head (the first line: init / thread.started), body, and tail (from the result /
// turn.completed line on), so gate, delayMs, hang, warn and noise keep working. The recorded id becomes `thread`.
function replayEvents(file, agent, thread) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'fixtures', file), 'utf8');
  const lines = text.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const first = parsed[0] || {};
  const recorded = first.session_id || first.thread_id || first.conversation_id;
  let tailAt = -1;
  parsed.forEach((e, i) => { if (e && (e.type === 'result' || e.type === 'turn.completed' || e.event === 'result' || (e.total_cost_usd !== undefined && e.usage))) tailAt = i; });
  if (tailAt < 0) tailAt = lines.length;
  const fix = (l) => (recorded && thread ? l.split(recorded).join(thread) : l);
  const out = lines.map(fix);
  return { head: out.slice(0, 1), body: out.slice(1, tailAt), tail: out.slice(tailAt) };
}

const chunks = (text) => { const out = []; for (let i = 0; i < text.length; i += 9) out.push(text.slice(i, i + 9)); return out.length ? out : ['']; };

function claudeEvents(rule, a, sid, reply) {
  const u = { input: 10, cacheCreation: 2, cacheRead: 5, output: 3, cost: 0.01, ...(rule.usage || {}) };
  const init = { type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, tools: (a.tools || []).filter(Boolean), mcp_servers: [], model: a.model, permissionMode: a.permissionMode || 'default' };
  for (const [k, v] of Object.entries(rule.init && typeof rule.init === 'object' ? rule.init : {})) { if (v === null) delete init[k]; else init[k] = v; }
  const head = [];
  if (rule.beforeInit) head.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_early', name: 'Write', input: { file_path: 'early.txt', content: 'x' } }], stop_reason: 'tool_use' }, session_id: sid });
  head.push(init);
  if (rule.rateLimit) head.push({ type: 'rate_limit_event', rate_limit_info: rule.rateLimit, session_id: sid });
  const body = [];
  if (rule.thinking) body.push({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 42, session_id: sid });
  if (rule.tool) {
    body.push({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } }, session_id: sid });
    body.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.js' } }], stop_reason: 'tool_use' }, session_id: sid });
    body.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\tconst a = 1;' }] }, session_id: sid });
  }
  (Array.isArray(rule.toolUses) ? rule.toolUses : []).forEach((u, i) => {
    const id = `toolu_u${i + 1}`;
    body.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: u.name, input: { file_path: u.file_path, content: 'ok' } }], stop_reason: 'tool_use' }, session_id: sid });
    body.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!u.error, content: u.error ? String(u.error) : 'done' }] }, session_id: sid });
  });
  body.push({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } }, session_id: sid });
  body.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sid });
  for (const c of chunks(reply)) body.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } }, session_id: sid });
  body.push({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sid });
  body.push({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: u.output } }, session_id: sid });
  body.push({ type: 'stream_event', event: { type: 'message_stop' }, session_id: sid });
  body.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }, session_id: sid });
  for (const e of rule.events || []) body.push(e);
  const tail = rule.crash ? [] : [{
    type: 'result', subtype: rule.error ? 'error_during_execution' : 'success', is_error: !!rule.error, duration_ms: 12, duration_api_ms: 10, num_turns: 1,
    result: rule.error ? rule.error : reply, session_id: sid, total_cost_usd: u.cost,
    usage: { input_tokens: u.input, cache_creation_input_tokens: u.cacheCreation, cache_read_input_tokens: u.cacheRead, output_tokens: u.output, server_tool_use: { web_search_requests: 0 } },
    ...(Array.isArray(rule.denials) ? { permission_denials: rule.denials } : {}),
  }];
  return { head, body, tail };
}

function codexEvents(rule, a, tid, reply) {
  const u = { input: 100, cached: 60, output: 7, ...(rule.usage || {}) };
  const head = [{ type: 'thread.started', thread_id: tid }];
  const body = [{ type: 'turn.started' }];
  if (rule.reasoning) body.push({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: rule.reasoning } });
  if (rule.tool) {
    body.push({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "powershell -Command 'Get-ChildItem src'", aggregated_output: '', status: 'in_progress' } });
    body.push({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "powershell -Command 'Get-ChildItem src'", aggregated_output: 'a.js\n', exit_code: 0, status: 'completed' } });
  }
  (Array.isArray(rule.commands) ? rule.commands : []).forEach((c, i) => {
    const id = `item_c${i + 1}`, code = c.exit_code ?? 0;
    body.push({ type: 'item.started', item: { id, type: 'command_execution', command: c.command, aggregated_output: '', status: 'in_progress' } });
    body.push({ type: 'item.completed', item: { id, type: 'command_execution', command: c.command, aggregated_output: '', exit_code: code, status: code === 0 ? 'completed' : 'failed' } });
  });
  (Array.isArray(rule.fileChanges) ? rule.fileChanges : []).forEach((c, i) => {
    body.push({ type: 'item.completed', item: { id: `item_f${i + 1}`, type: 'file_change', changes: [{ path: c.path, kind: 'add' }], status: c.status || 'completed' } });
  });
  body.push({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: reply } });
  for (const e of rule.events || []) body.push(e);
  const tail = rule.crash ? [] : rule.error
    ? [{ type: 'turn.failed', error: { message: rule.error } }]
    : [{ type: 'turn.completed', usage: { input_tokens: u.input, cached_input_tokens: u.cached, output_tokens: u.output } }];
  return { head, body, tail };
}

// Agy mode (see src/adapters/antigravity.js): replays test/fixtures/antigravity/real-turn.jsonl with the conversation id
// and the reply swapped in; selected by OB_FAKE_AGENT=agy or a --mode flag. Honours reply, error and crash.
function agyEvents(rule, a, tid, reply) {
  const file = path.join(__dirname, '..', 'fixtures', 'antigravity', 'real-turn.jsonl');
  const evs = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  for (const ev of evs) {
    const o = ev.event === 'init' ? ev : ev.step_update || ev.result;
    o.conversation_id = tid;
    if (typeof o.text_delta === 'string') o.text_delta = String(reply);
    if (ev.event === 'result') o.response = String(reply);
  }
  const head = evs.filter((e) => e.event === 'init');
  if (a.model) head[0].init.model = a.model;
  const body = evs.filter((e) => e.event === 'step_update');
  let tail = evs.filter((e) => e.event === 'result');
  if (rule.error) tail = [{ event: 'result', result: { conversation_id: tid, status: 'ERROR', response: String(rule.error), duration_seconds: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } }];
  if (rule.crash) tail = [];
  return { head, body, tail };
}

// Cursor mode (shape from the real recordings, see src/adapters/cursor.js): selected by OB_FAKE_AGENT=cursor. Honours reply, tool, error.
function cursorEvents(rule, a, tid, reply) {
  const head = [{ type: 'system', subtype: 'init', session_id: tid, model: a.model || 'auto', permissionMode: a.permissionMode || 'default', cwd: process.cwd() }];
  const body = [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: a.prompt || '' }] }, session_id: tid }];
  if (rule.tool) body.push({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'a.js' } } }, session_id: tid }, { type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'a.js' }, result: { success: { content: 'a' } } } }, session_id: tid });
  body.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] }, session_id: tid });
  for (const e of rule.events || []) body.push(e);
  const tail = rule.crash ? [] : [{ type: 'result', subtype: rule.error ? 'error' : 'success', is_error: !!rule.error, result: rule.error || reply, duration_ms: 10, session_id: tid }];
  return { head, body, tail };
}

// Performs the rule's file writes and deletes in the working directory, one log line per operation. Never throws:
// a failing operation is logged with ok: false and the turn goes on.
function runFileOps(rule, n) {
  if (rule.hang || rule.lostThread) return;
  const log = (op, target, ok, error) => {
    try { fs.appendFileSync(path.join(DIR, 'writes.jsonl'), JSON.stringify({ n, op, path: target, ok, error }) + '\n'); } catch {}
  };
  const resolveTarget = (p) => { if (typeof p !== 'string' || !p) throw new Error('path must be a non-empty string'); return path.resolve(process.cwd(), p); };
  for (const w of Array.isArray(rule.writeFiles) ? rule.writeFiles : []) {
    let target = null;
    try {
      target = resolveTarget(w && w.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      (w.append ? fs.appendFileSync : fs.writeFileSync)(target, w.content === undefined ? 'ok\n' : String(w.content));
      log('write', target, true, null);
    } catch (e) { log('write', target, false, String((e && e.message) || e)); }
  }
  for (const p of Array.isArray(rule.deleteFiles) ? rule.deleteFiles : []) {
    let target = null;
    try {
      target = resolveTarget(p);
      fs.rmSync(target, { force: true });
      log('delete', target, true, null);
    } catch (e) { log('delete', target, false, String((e && e.message) || e)); }
  }
}

// A pretend Codex sub-agent: the child rollout a real sub-agent would leave, plus its file write. Never throws.
function spawnSubagent(spec, parentId) {
  try {
    const home = process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const dir = path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    fs.mkdirSync(dir, { recursive: true });
    const id = 'cx-child-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const meta = { timestamp: d.toISOString(), type: 'session_meta', payload: { id, timestamp: d.toISOString(), cwd: process.cwd(), cli_version: '0.0.0-test',
      source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_nickname: 'fake child', agent_role: 'worker' } } } } };
    fs.writeFileSync(path.join(dir, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`), JSON.stringify(meta) + '\n');
    if (typeof spec.path === 'string' && spec.path) {
      const target = path.resolve(process.cwd(), spec.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'ok\n');
    }
  } catch (e) { try { process.stderr.write('fake-cli: spawnChild failed: ' + ((e && e.message) || e) + '\n'); } catch {} }
}

async function waitGate(name) {
  const f = path.join(DIR, 'gates', name);
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(f)) { if (Date.now() > deadline) break; await sleep(20); }
}

async function main() {
  const args = process.argv.slice(2);
  // `<bin> --version` (runner version detection, doctor): answer like a CLI would; not a turn, so not logged.
  if (args.length === 1 && args[0] === '--version') { await write(process.stdout, `${process.env.OB_FAKE_NAME || 'fake-cli'} 0.0.0-test (orchestra-board test double)\n`); return; }
  // `claude auth status` / `codex login status` (doctor's login checks): logged in; not a turn, so not logged.
  if (args.length === 2 && args[1] === 'status' && (args[0] === 'auth' || args[0] === 'login')) { await write(process.stdout, 'Logged in (orchestra-board test double)\n'); return; }
  const a = parseArgs(args);
  const prompt = a.agent === 'agy' || a.agent === 'cursor' ? (a.prompt || '') : await readStdin();
  const threadsDir = path.join(DIR, 'threads');
  fs.mkdirSync(threadsDir, { recursive: true });

  // Thread id: claude gets it from argv (or none for the probe); codex mints one on a new thread.
  let thread = a.resume, seat = null;
  if (a.resume) seat = readJson(path.join(threadsDir, a.resume + '.json'), {}).seat || null;
  else {
    seat = (prompt.match(/^\[You are "([^"]+)"/) || [])[1] || null;
    thread = a.agent === 'codex' || a.agent === 'agy' || a.agent === 'cursor' ? (a.agent === 'agy' ? 'ag-' : a.agent === 'cursor' ? 'cu-' : 'cx-') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) : a.sessionId;
    if (thread) fs.writeFileSync(path.join(threadsDir, thread + '.json'), JSON.stringify({ seat, agent: a.agent }));
  }

  const scenario = readJson(path.join(DIR, 'scenario.json'), {});
  const prev = readCalls();
  const nth = prev.filter((c) => c.seat === seat).length + 1;
  const { rule, index } = pickRule(scenario, { agent: a.agent, seat, nth, prompt, resume: !!a.resume });
  const reply = rule.reply ?? 'ok';

  let childPid = null;
  if (rule.hang && rule.spawnChild === true) {
    const child = require('child_process').spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000); process.send("ready");'],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    // Publish the call only after the child is running, so a Stop cannot race fixture startup.
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    childPid = child.pid;
    if (process.platform !== 'win32') {
      // Reap the child before exiting, avoiding zombies on hosts whose PID 1 does not reap orphans.
      // This handler does not forward signals: a main-PID-only kill leaves the command alive and hangs.
      process.on('SIGTERM', () => {
        if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
        else child.once('exit', () => process.exit(0));
      });
    }
  }

  const n = prev.length + 1;
  fs.appendFileSync(path.join(DIR, 'calls.jsonl'), JSON.stringify({
    n, nth, agent: a.agent, seat, thread, resume: !!a.resume, args, cwd: process.cwd(), stdin: prompt,
    model: a.model, effort: a.effort, tools: a.tools, permissionMode: a.permissionMode, sandbox: a.sandbox, addDir: a.addDir,
    rule: index, pid: process.pid, ppid: process.ppid, childPid, ts: new Date().toISOString(),
  }) + '\n');

  if (rule.lostThread) {
    await write(process.stderr, a.agent === 'codex' ? `Error: thread/resume failed: no rollout found for thread id ${a.resume}\n` : `No conversation found with session ID: ${a.resume}\n`);
    process.exitCode = 1;
    return;
  }
  const replay = replayFile(rule, a.agent, !!a.resume);
  const ev = replay ? replayEvents(replay, a.agent, a.agent === 'claude' ? thread || 'probe-' + process.pid : thread) : a.agent === 'cursor' ? cursorEvents(rule, a, thread, reply) : a.agent === 'agy' ? agyEvents(rule, a, thread, reply) : a.agent === 'codex' ? codexEvents(rule, a, thread, reply) : claudeEvents(rule, a, thread || 'probe-' + process.pid, reply);
  // A replayed claude init line describes the recording's cwd, permission mode and tools: rewrite them from this call.
  if (replay && a.agent === 'claude' && ev.head.length) {
    try {
      const init = JSON.parse(ev.head[0]);
      if (init.type === 'system' && init.subtype === 'init') {
        init.cwd = process.cwd();
        init.permissionMode = a.permissionMode || 'default';
        init.tools = (a.tools || []).filter(Boolean);
        if (a.model) init.model = a.model;
        ev.head[0] = JSON.stringify(init);
      }
    } catch {}
  }
  await write(process.stdout, jsonl(ev.head));
  if (rule.hang) {
    // Looks busy forever (so the board shows "thinking") until the runner kills the process tree.
    await write(process.stdout, jsonl(a.agent === 'codex' ? [{ type: 'turn.started' }] : [{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 7 }]));
    setInterval(() => {}, 1000);
    return;
  }
  if (rule.gate) await waitGate(rule.gate);
  if (rule.delayMs) await sleep(rule.delayMs);
  runFileOps(rule, n);
  if (a.agent === 'codex' && rule.spawnChild && typeof rule.spawnChild === 'object') spawnSubagent(rule.spawnChild, thread);
  // warn: a warning on stderr and noise (a non-JSON line on stdout) before a successful turn, as the CLI prints for
  // unknown model ids; the turn must still succeed.
  if (rule.warn) await write(process.stderr, String(rule.warn) + '\n');
  if (rule.noise) await write(process.stdout, String(rule.noise) + '\n');
  await write(process.stdout, jsonl(ev.body));
  await write(process.stdout, jsonl(ev.tail));
  if (rule.crash) await write(process.stderr, String(rule.crash) + '\n');
  process.exitCode = rule.exit ?? (rule.crash ? 2 : 0);
}

// `node --test` also executes this file (everything under test/ matches its default globs): stay inert then.
if (require.main === module && DIR) main().catch((e) => { process.stderr.write('fake-cli: ' + (e.stack || e) + '\n'); process.exitCode = 70; });

module.exports = { parseArgs, pickRule };
