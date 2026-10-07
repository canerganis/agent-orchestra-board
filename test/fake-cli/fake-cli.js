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
//   rule actions:   reply (text), usage ({input, cacheCreation, cacheRead, output, cost} | {input, cached, output}),
//                   rateLimit (claude rate_limit_info object), thinking (bool), tool (bool), reasoning (text),
//                   events (extra raw events emitted before the result), error (message -> failed turn),
//                   crash (stderr text; exits without a completed turn), exit (exit code), gate (name: wait for
//                   <OB_FAKE_DIR>/gates/<name> before answering), delayMs, hang (never finishes),
//                   lostThread (the resumed thread is gone: prints the CLI's own not-found message on stderr, no
//                   stdout, exit 1, like claude --resume / codex exec resume with an unknown id)
//
// Thread bookkeeping mirrors the real CLIs: claude `--session-id` / `--resume`, codex `exec resume <id>`.
// The seat name is taken from the runner's role header on the first turn of a thread and remembered under
// threads/<id>.json so resumed turns (which carry no header) can still be matched by seat.
const fs = require('fs');
const path = require('path');

const DIR = process.env.OB_FAKE_DIR;

function parseArgs(args) {
  const a = { agent: args[0] === 'exec' ? 'codex' : 'claude', resume: null, sessionId: null, model: null, effort: null, tools: null, permissionMode: null, addDir: null, sandbox: null, config: {} };
  if (a.agent === 'codex') {
    if (args[1] === 'resume') a.resume = args[2];
    for (let i = 0; i < args.length; i++) if (args[i] === '-c') { const [k, v] = String(args[++i]).split(/=(.*)/s); a.config[k] = v; }
    a.model = (a.config.model || '').replace(/^"|"$/g, '');
    a.effort = (a.config.model_reasoning_effort || '').replace(/^"|"$/g, '');
    a.sandbox = (a.config.sandbox_mode || '').replace(/^"|"$/g, '');
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
const jsonl = (events) => events.map((e) => JSON.stringify(e) + '\n').join('');
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
  return { rule: scenario.default || { reply: 'ok' }, index: 'default' };
}

const chunks = (text) => { const out = []; for (let i = 0; i < text.length; i += 9) out.push(text.slice(i, i + 9)); return out.length ? out : ['']; };

function claudeEvents(rule, a, sid, reply) {
  const u = { input: 10, cacheCreation: 2, cacheRead: 5, output: 3, cost: 0.01, ...(rule.usage || {}) };
  const head = [{ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, tools: (a.tools || []).filter(Boolean), model: a.model, permissionMode: a.permissionMode || 'default' }];
  if (rule.rateLimit) head.push({ type: 'rate_limit_event', rate_limit_info: rule.rateLimit, session_id: sid });
  const body = [];
  if (rule.thinking) body.push({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 42, session_id: sid });
  if (rule.tool) {
    body.push({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } }, session_id: sid });
    body.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.js' } }], stop_reason: 'tool_use' }, session_id: sid });
    body.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\tconst a = 1;' }] }, session_id: sid });
  }
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
  body.push({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: reply } });
  for (const e of rule.events || []) body.push(e);
  const tail = rule.crash ? [] : rule.error
    ? [{ type: 'turn.failed', error: { message: rule.error } }]
    : [{ type: 'turn.completed', usage: { input_tokens: u.input, cached_input_tokens: u.cached, output_tokens: u.output } }];
  return { head, body, tail };
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
  const a = parseArgs(args);
  const prompt = await readStdin();
  const threadsDir = path.join(DIR, 'threads');
  fs.mkdirSync(threadsDir, { recursive: true });

  // Thread id: claude gets it from argv (or none for the probe); codex mints one on a new thread.
  let thread = a.resume, seat = null;
  if (a.resume) seat = readJson(path.join(threadsDir, a.resume + '.json'), {}).seat || null;
  else {
    seat = (prompt.match(/^\[You are "([^"]+)"/) || [])[1] || null;
    thread = a.agent === 'codex' ? 'cx-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) : a.sessionId;
    if (thread) fs.writeFileSync(path.join(threadsDir, thread + '.json'), JSON.stringify({ seat, agent: a.agent }));
  }

  const scenario = readJson(path.join(DIR, 'scenario.json'), {});
  const prev = readCalls();
  const nth = prev.filter((c) => c.seat === seat).length + 1;
  const { rule, index } = pickRule(scenario, { agent: a.agent, seat, nth, prompt, resume: !!a.resume });
  const reply = rule.reply ?? 'ok';

  fs.appendFileSync(path.join(DIR, 'calls.jsonl'), JSON.stringify({
    n: prev.length + 1, nth, agent: a.agent, seat, thread, resume: !!a.resume, args, cwd: process.cwd(), stdin: prompt,
    model: a.model, effort: a.effort, tools: a.tools, permissionMode: a.permissionMode, sandbox: a.sandbox, addDir: a.addDir,
    rule: index, pid: process.pid, ppid: process.ppid, ts: new Date().toISOString(),
  }) + '\n');

  if (rule.lostThread) {
    await write(process.stderr, a.agent === 'codex' ? `Error: thread/resume failed: no rollout found for thread id ${a.resume}\n` : `No conversation found with session ID: ${a.resume}\n`);
    process.exitCode = 1;
    return;
  }
  const ev = a.agent === 'codex' ? codexEvents(rule, a, thread, reply) : claudeEvents(rule, a, thread || 'probe-' + process.pid, reply);
  await write(process.stdout, jsonl(ev.head));
  if (rule.hang) {
    // Looks busy forever (so the board shows "thinking") until the runner kills the process tree.
    await write(process.stdout, jsonl(a.agent === 'codex' ? [{ type: 'turn.started' }] : [{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 7 }]));
    setInterval(() => {}, 1000);
    return;
  }
  if (rule.gate) await waitGate(rule.gate);
  if (rule.delayMs) await sleep(rule.delayMs);
  await write(process.stdout, jsonl(ev.body));
  await write(process.stdout, jsonl(ev.tail));
  if (rule.crash) await write(process.stderr, String(rule.crash) + '\n');
  process.exitCode = rule.exit ?? (rule.crash ? 2 : 0);
}

// `node --test` also executes this file (everything under test/ matches its default globs): stay inert then.
if (require.main === module && DIR) main().catch((e) => { process.stderr.write('fake-cli: ' + (e.stack || e) + '\n'); process.exitCode = 70; });

module.exports = { parseArgs, pickRule };
