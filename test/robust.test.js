// CLI robustness: JSONL splitting, unknown schemas, usage fallback, spawn errors, version detection (no real CLI).
const { test, after } = require('node:test');
// Fake children own no OS handles and the CLI timers are unref()d, so on Node 20/22 the event loop can drain
// mid-test and the runner cancels the test ("Promise resolution is still pending"). Keep one ref()d handle alive.
const keepAlive = setInterval(() => {}, 1 << 30);
after(() => clearInterval(keepAlive));

const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createFeeder } = require('../src/adapters/jsonl');
const claude = require('../src/adapters/claude');
const codex = require('../src/adapters/codex');
const { detectVersion } = require('../src/adapters/versions');
const { spawnErrorMessage, explainExit, findShim } = require('../src/adapters/diagnose');
const { createRunner } = require('../src/runner');
const { createLimits } = require('../src/limits');

function collect(adapter) {
  const events = [];
  const rec = (k) => (...a) => events.push([k, ...a]);
  const parser = adapter.createParser(Object.fromEntries(['thread', 'activity', 'delta', 'item', 'usage', 'partialUsage', 'rateLimit', 'completed', 'error'].map((k) => [k, rec(k)])));
  return { parser, events };
}
const J = (o) => JSON.stringify(o);

// ---------- jsonl feeder ----------
test('feeder: partial lines, CRLF, split multi-byte char, noise, bad JSON, flush on end, stats', () => {
  const seen = [];
  const f = createFeeder((o) => { seen.push(o); return o.type !== 'mystery'; });
  const line = J({ type: 'a', text: 'héllo €' });
  const buf = Buffer.from(line + '\r\n');
  const cut = buf.indexOf(Buffer.from('€')) + 1; // split inside the 3-byte euro sign
  f.feed(buf.subarray(0, cut)); f.feed(buf.subarray(cut));
  f.feed('warning: something on stderr-ish\n\x1b[32m{"type":"b"}\x1b[0m\n{not json\n[1,2]\n');
  f.feed('{"type":"mystery"}'); // no trailing newline
  assert.equal(seen.length, 2);
  f.end();
  assert.deepEqual(seen.map((o) => o.type), ['a', 'b', 'mystery']);
  assert.equal(seen[0].text, 'héllo €');
  assert.equal(f.stats.lines, 6);
  assert.equal(f.stats.json, 3); assert.equal(f.stats.events, 2); assert.equal(f.stats.unknown, 1);
  assert.deepEqual(f.stats.unknownTypes, ['mystery']);
  assert.equal(f.stats.noise, 2, 'non-object lines ([1,2]) are noise'); assert.equal(f.stats.bad, 1);
  assert.equal(f.stats.lastNoise, '[1,2]'); assert.match(f.stats.lastBad, /^\{not json/);
});

test('feeder: a throwing handler is counted, not propagated', () => {
  const f = createFeeder(() => { throw new Error('kaboom'); });
  f.feed('{"type":"x"}\n');
  assert.equal(f.stats.handlerErrors, 1); assert.equal(f.stats.lastHandlerError, 'kaboom');
});

// ---------- claude ----------
test('claude: stream totals go to partialUsage; usage is sent exactly once, from the result; parser exposes end/stats', () => {
  const { parser, events } = collect(claude);
  parser.feed([
    J({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 500, output_tokens: 1 } } } }),
    J({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } }),
    J({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 600, output_tokens: 0 } } } }),
    J({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 7 } } }),
  ].join('\n') + '\n');
  assert.equal(events.filter((e) => e[0] === 'usage').length, 0, 'no usage before the result');
  const partials = events.filter((e) => e[0] === 'partialUsage').map((e) => e[1]);
  assert.equal(partials.length, 4);
  assert.deepEqual(partials.at(-1), { tokens: 100 + 20 + 40 + 10 + 7, cached: 1100 });
  parser.feed(J({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.5, usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } }));
  parser.end();
  assert.deepEqual(events.filter((e) => e[0] === 'usage'), [['usage', { tokens: 8, cached: 2, cost: 0.5 }]]);
  assert.deepEqual(events.at(-1), ['completed', { result: 'done' }]);
  assert.equal(parser.stats.events, 5); assert.equal(parser.stats.unknown, 0);
});

test('claude: a result without usage still sends one usage of zeros', () => {
  const { parser, events } = collect(claude);
  parser.feed(J({ type: 'result', subtype: 'success', result: 'ok' }) + '\n');
  assert.deepEqual(events, [['usage', { tokens: 0, cached: 0, cost: 0 }], ['completed', { result: 'ok' }]]);
});

test('claude: error results carry the CLI text unprefixed; unknown types; tolerant of malformed fields', () => {
  const { parser, events } = collect(claude);
  assert.equal(parser.event({ type: 'brand_new_event' }), false);
  assert.equal(parser.event({ type: 'user', message: {} }), true);
  assert.equal(parser.event({ type: 'stream_event', event: null }), true);
  assert.equal(parser.event({ type: 'assistant', message: { content: 'not an array' } }), true);
  parser.event({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', total_cost_usd: 0.1 });
  assert.deepEqual(events.filter((e) => e[0] === 'error'), [['error', 'boom']]);
  assert.ok(events.some((e) => e[0] === 'completed'));
  parser.feed('{"type":"result","is_error":true,"errors":["bad model"]}\n');
  assert.equal(events.at(-1)[1], 'bad model');
  parser.feed('{"type":"result","is_error":true}\n');
  assert.equal(events.at(-1)[1], 'claude error');
});

// ---------- codex ----------
test('codex: unknown types, undefined text never becomes "undefined", error shapes, negative-safe net tokens', () => {
  const { parser, events } = collect(codex);
  assert.equal(parser.event({ type: 'something.else' }), false);
  assert.equal(parser.event({ type: 'item.updated', item: { type: 'agent_message', text: 'x' } }), true);
  parser.event({ type: 'item.completed', item: { type: 'agent_message' } });
  assert.equal(events.filter((e) => e[0] === 'delta').length, 0);
  parser.event({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 10, output_tokens: 2 } });
  assert.deepEqual(events.find((e) => e[0] === 'usage')[1], { tokens: 2, cached: 10, cost: 0 });
  parser.event({ type: 'turn.failed', error: 'plain string' });
  parser.event({ type: 'error', message: 'top-level message' });
  parser.event({ type: 'turn.failed' });
  // A top-level error after turn.failed is an item only; the next turn.failed reports its own message.
  assert.deepEqual(events.filter((e) => e[0] === 'error').map((e) => e[1]), ['plain string', 'codex error']);
  parser.event({ type: 'turn.completed' });
  assert.deepEqual(events.filter((e) => e[0] === 'usage').map((e) => e[1]), [{ tokens: 2, cached: 10, cost: 0 }, { tokens: 0, cached: 0, cost: 0 }], 'one usage per turn.completed, zeros when missing');
});

// ---------- fake child process ----------
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
  // pid 0 is falsy: killTree() returns at once, so a fake child can never signal a real process (or a real tree).
  c.pid = 0; c.input = '';
  c.stdin.on('data', (d) => { c.input += d; });
  c.out = (s) => c.stdout.write(s);
  c.close = (code = 0, signal = null) => setImmediate(() => c.emit('close', code, signal));
  c.fail = (code) => setImmediate(() => { const e = new Error(`spawn x ${code}`); e.code = code; c.emit('error', e); c.emit('close', -4058, null); });
  return c;
}
const fakeSpawn = (script) => { const calls = []; const fn = (cmd, args, opts) => { const c = fakeChild(); calls.push({ cmd, args, opts, child: c }); setImmediate(() => script(c, cmd, args)); return c; }; fn.calls = calls; return fn; };

// ---------- versions ----------
test('detectVersion: parses a version, reports a missing binary, times out', async () => {
  const ok = await detectVersion('claude', 'claude', { spawnFn: fakeSpawn((c) => { c.out('2.1.47 (Claude Code)\n'); c.close(0); }) });
  assert.deepEqual([ok.ok, ok.version, ok.error], [true, '2.1.47', null]);
  const miss = await detectVersion('codex', 'fake-codex', { spawnFn: fakeSpawn((c) => c.fail('ENOENT')) });
  assert.equal(miss.ok, false); assert.match(miss.error, /Codex CLI not found: "fake-codex".*ORCHESTRA_CODEX_BIN/);
  const slow = await detectVersion('claude', 'claude', { timeoutMs: 30, spawnFn: fakeSpawn(() => {}) });
  assert.match(slow.error, /did not answer --version/);
  const bad = await detectVersion('claude', 'claude', { spawnFn: fakeSpawn((c) => { c.stderr.write('error: not logged in\n'); c.close(1); }) });
  assert.match(bad.error, /exit code 1.*not logged in/);
});

test('diagnose: spawn error codes and exit explanations', () => {
  const e = (code) => Object.assign(new Error('x'), { code });
  const noPath = { PATH: '' };
  assert.match(spawnErrorMessage('claude', 'claude', e('ENOENT'), noPath), /^Claude CLI not found: "claude" is not on PATH/);
  assert.match(spawnErrorMessage('codex', 'c', e('EACCES')), /not executable \(EACCES\)/);
  assert.match(explainExit({ agent: 'claude', bin: 'claude', code: 1, stats: { lines: 0 }, stderr: 'Invalid API key\n' }), /without any output: Invalid API key/);
  assert.match(explainExit({ agent: 'codex', bin: 'codex', code: 0, stats: { lines: 2, json: 0, lastNoise: 'Hello world' } }), /printed no JSON.*Hello world/);
  assert.match(explainExit({ agent: 'claude', bin: 'claude', code: 0, version: '9.9.9', stats: { lines: 2, json: 2, events: 0, unknownTypes: ['v2.result'] } }), /Unrecognised Claude CLI output \(claude 9.9.9\).*\[v2.result\].*schema may have changed/);
  assert.match(explainExit({ agent: 'claude', bin: 'claude', code: 0, stats: { lines: 3, json: 3, events: 3 } }), /ended \(exit code 0\) before reporting a result/);
  // A handler that threw is reported as our bug, not as a CLI schema change (the feeder leaves events at 0 for such lines).
  assert.match(explainExit({ agent: 'claude', bin: 'claude', code: 0, stats: { lines: 2, json: 2, events: 0, handlerErrors: 2, lastHandlerError: 'kaboom' } }), /could not be processed.*kaboom/);
});

test('diagnose (Windows): ENOENT with only a .cmd shim on PATH points at the shim, not at a reinstall', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-shim-'));
  try {
    const shim = path.join(dir, 'obfakecodex.cmd');
    fs.writeFileSync(shim, '@echo 1.2.3\r\n');
    const e = Object.assign(new Error('spawn obfakecodex ENOENT'), { code: 'ENOENT' });
    const m = spawnErrorMessage('codex', 'obfakecodex', e, { PATH: dir });
    assert.match(m, /\.cmd shim .*obfakecodex\.cmd.*cannot spawn without a shell.*ORCHESTRA_CODEX_BIN/);
    assert.ok(!/not on PATH/.test(m));
    assert.equal(findShim('obfakecodex', { PATH: dir }), shim);
    assert.equal(findShim('obfakecodex', { PATH: '' }), null);
    assert.equal(findShim(shim, { PATH: dir }), null, 'explicit paths are not searched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- runner ----------
function harness(seatPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-runner-'));
  fs.mkdirSync(path.join(dir, '.orchestra'), { recursive: true });
  const seat = { id: 's1', name: 'S1', role: 'tester', agent: 'claude', model: 'm', effort: 'low', perm: 'read', target: '', budget: 0, thread: null, used: 0, cached: 0, cost: 0, ...seatPatch };
  const rt = new Map();
  const rtOf = (id) => { if (!rt.has(id)) rt.set(id, { status: 'idle', activity: '', startedAt: null, child: null, queue: Promise.resolve() }); return rt.get(id); };
  const events = [];
  const seats = { rtOf, seatById: (id) => (id === seat.id ? seat : null), setRt: (id, p) => Object.assign(rtOf(id), p), saveSeats: () => {} };
  const limits = { claudeLimits: () => {}, refreshCodex: () => {} };
  const make = (spawnFn, opts = {}) => createRunner({ store: { project: dir, orch: path.join(dir, '.orchestra') }, seats, limits, settings: { lang: 'English' }, broadcast: (e) => events.push(e), spawnFn, detectVersions: false, ...opts });
  return { seat, rtOf, events, make, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('runner: nothing is spawned at construction; version detection runs lazily and only for an unexplained exit', async () => {
  const h = harness();
  try {
    const sp = fakeSpawn((c, cmd, args) => {
      if (args[0] === '--version') { c.out(`${cmd} 7.7.7\n`); c.close(0); return; }
      c.out(J({ type: 'system', subtype: 'init', session_id: 'sid' }) + '\n'); c.close(1);
    });
    const runner = h.make(sp, { detectVersions: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sp.calls.length, 0, 'createRunner must not spawn');
    const res = await runner.runSeat('s1', 'hi');
    assert.equal(res.ok, false);
    assert.equal(sp.calls[0].args[0], '-p', 'the seat turn is the first spawn');
    const versionCalls = sp.calls.filter((c) => c.args[0] === '--version');
    assert.ok(versionCalls.length >= 1, 'version detected after the unexplained exit');
    assert.match(res.error, /before reporting a result/);
    // Other failure kinds (CLI-reported error) do not touch version detection.
    const sp2 = fakeSpawn((c) => { c.out(J({ type: 'result', is_error: true, result: 'nope' }) + '\n'); c.close(1); });
    const r2 = await h.make(sp2, { detectVersions: true }).runSeat('s1', 'hi');
    assert.equal(r2.error, 'nope'); assert.equal(sp2.calls.length, 1);
  } finally { h.cleanup(); }
});

test('runner: missing CLI is an explicit, user-visible error (seat status, SSE end event, result)', async () => {
  const h = harness();
  try {
    const sp = fakeSpawn((c) => c.fail('ENOENT'));
    const res = await h.make(sp).runSeat('s1', 'hi');
    assert.equal(res.ok, false);
    assert.match(res.error, /^Claude CLI not found: ".*" is not on PATH\. Install it or set ORCHESTRA_CLAUDE_BIN/);
    assert.equal(h.rtOf('s1').status, 'error'); assert.equal(h.rtOf('s1').activity, res.error);
    const end = h.events.find((e) => e.t === 'end'); assert.equal(end.ok, false); assert.equal(end.error, res.error);
    assert.ok(sp.calls[0].args.includes('--strict-mcp-config'), 'lean flags intact');
  } finally { h.cleanup(); }
});

test('runner: a clean exit with no parsable JSON is a failure, never a success', async () => {
  const h = harness();
  try {
    const r1 = await h.make(fakeSpawn((c) => { c.out('Welcome to Claude!\nSome plain text answer\n'); c.close(0); })).runSeat('s1', 'hi');
    assert.equal(r1.ok, false); assert.match(r1.error, /printed no JSON/);
    const r2 = await h.make(fakeSpawn((c) => { c.out('{"kind":"v3.turn","text":"x"}\n{"kind":"v3.done"}'); c.close(0); })).runSeat('s1', 'hi');
    assert.equal(r2.ok, false); assert.match(r2.error, /Unrecognised Claude CLI output.*2 JSON line\(s\).*\(no type\)/);
    const r3 = await h.make(fakeSpawn((c) => { c.out(J({ type: 'system', subtype: 'init', session_id: 'sid' }) + '\n'); c.stderr.write('API Error: 401 unauthorized\n'); c.close(1); })).runSeat('s1', 'hi');
    assert.equal(r3.ok, false); assert.match(r3.error, /before reporting a result: API Error: 401 unauthorized/);
    assert.equal(h.seat.thread, 'sid', 'thread id from init is still kept');
  } finally { h.cleanup(); }
});

test('runner: completed turn succeeds even on non-zero exit; final usage wins; split lines reassembled', async () => {
  const h = harness();
  try {
    const sp = fakeSpawn((c) => {
      const lines = [J({ type: 'system', subtype: 'init', session_id: 'sid' }), J({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } } }), J({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }), J({ type: 'result', result: 'hello', total_cost_usd: 0.02, usage: { input_tokens: 3, cache_read_input_tokens: 9, output_tokens: 4 } })].join('\n');
      for (let i = 0; i < lines.length; i += 17) c.out(lines.slice(i, i + 17)); // no trailing newline on the last line
      c.stderr.write('notify hook failed\n'); c.close(1);
    });
    const res = await h.make(sp).runSeat('s1', 'hi');
    assert.deepEqual(res, { ok: true, text: 'hello', tokens: 7, cached: 9, cost: 0.02, error: null });
    assert.equal(h.seat.used, 7); assert.equal(h.seat.thread, 'sid');
    assert.match(sp.calls[0].child.input, /^\[You are "S1"/);
  } finally { h.cleanup(); }
});

test('runner: a killed run keeps the partial token accounting from message_start/message_delta', async () => {
  const h = harness();
  try {
    let child;
    const runner = h.make(fakeSpawn((c) => {
      child = c;
      c.out(J({ type: 'system', subtype: 'init', session_id: 'sid' }) + '\n');
      c.out(J({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 1 } } } }) + '\n');
      c.out(J({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 250 } } }) + '\n');
    }));
    const p = runner.runSeat('s1', 'hi');
    await new Promise((r) => setTimeout(r, 20));
    h.rtOf('s1').stopRequested = true; child.close(null, 'SIGTERM'); // what killTree + the OS do
    const res = await p;
    assert.equal(res.ok, false); assert.equal(res.error, 'stopped');
    assert.equal(res.tokens, 1250); assert.equal(res.cached, 4000); assert.equal(h.seat.used, 1250);
  } finally { h.cleanup(); }
});

test('runner: codex error event and CLI-reported error both fail the turn with the CLI message', async () => {
  const h = harness({ agent: 'codex' });
  try {
    const sp = fakeSpawn((c) => { c.out(J({ type: 'thread.started', thread_id: 't1' }) + '\n' + J({ type: 'turn.failed', error: { message: 'model not available' } }) + '\n'); c.close(0); });
    const res = await h.make(sp).runSeat('s1', 'hi');
    assert.equal(res.ok, false); assert.equal(res.error, 'model not available'); assert.equal(h.seat.thread, 't1');
    assert.ok(sp.calls[0].args.includes('--ignore-user-config'), 'codex lean flags intact');
    if (process.platform === 'win32') assert.ok(sp.calls[0].args.includes('windows.sandbox="unelevated"'));
  } finally { h.cleanup(); }
});

// ---------- limits probe ----------
test('limits.probeClaude: missing CLI and a stream without rate_limit_event become limits.claude.error', async () => {
  const written = [], events = [];
  const store = { readJson: () => ({ claude: { windows: { five_hour: { pct: 10 } } }, codex: null }), writeJson: (f, o) => written.push(o) };
  const lim = createLimits({ store, broadcast: (e) => events.push(e), spawnFn: fakeSpawn((c) => c.fail('ENOENT')) });
  const r = await lim.probeClaude();
  assert.equal(r.ok, false); assert.match(r.error, /Claude CLI not found/);
  assert.match(lim.get().claude.error, /Claude CLI not found/); assert.equal(lim.get().claude.windows.five_hour.pct, 10, 'old windows kept');
  const lim2 = createLimits({ store, broadcast: () => {}, spawnFn: fakeSpawn((c) => { c.out(J({ type: 'result', result: 'ok' }) + '\n'); c.close(0); }) });
  assert.match((await lim2.probeClaude()).error, /completed but got no rate_limit_event.*claude\.ai login/);
  const lim3 = createLimits({ store, broadcast: () => {}, spawnFn: fakeSpawn((c) => { c.out(J({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.42 } } } }) + '\n'); c.close(0); }) });
  assert.deepEqual(await lim3.probeClaude(), { ok: true, error: null });
  assert.equal(lim3.get().claude.windows.five_hour.pct, 42); assert.equal(lim3.get().claude.error, undefined);
});

test('limits.probeClaude: the CLI\'s own error result is the reported cause; an exit without result is explained from the stream', async () => {
  const store = { readJson: () => ({ claude: null, codex: null }), writeJson: () => {} };
  const notLoggedIn = fakeSpawn((c) => {
    c.out(J({ type: 'system', subtype: 'init', session_id: 'p1' }) + '\n' + J({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }) + '\n');
    c.close(1);
  });
  const r = await createLimits({ store, broadcast: () => {}, spawnFn: notLoggedIn }).probeClaude();
  assert.equal(r.ok, false);
  // A login problem keeps the CLI's own text and says what to do.
  assert.match(r.error, /^Claude limits probe failed: Claude CLI is not logged in \(Invalid API key · Please run \/login\)\. Run `claude` once to log in/);
  const noResult = fakeSpawn((c) => { c.out(J({ type: 'system', subtype: 'init', session_id: 'p2' }) + '\n'); c.stderr.write('API Error: 401 unauthorized\n'); c.close(1); });
  const r2 = await createLimits({ store, broadcast: () => {}, spawnFn: noResult }).probeClaude();
  assert.match(r2.error, /got no rate_limit_event: Claude CLI ended \(exit code 1\) before reporting a result: API Error: 401 unauthorized/);
});

test('limits: a failed probe keeps the old windows and their `updated` stamp, dating the failure in errorAt', async () => {
  const old = '2026-01-01T00:00:00.000Z';
  const written = [], events = [];
  const store = { readJson: () => ({ claude: { windows: { seven_day: { pct: 85 } }, updated: old }, codex: null }), writeJson: (f, o) => written.push(JSON.parse(JSON.stringify(o))) };
  const lim = createLimits({ store, broadcast: (e) => events.push(e), spawnFn: fakeSpawn((c) => c.fail('ENOENT')) });
  await lim.probeClaude();
  const c = lim.get().claude;
  assert.equal(c.updated, old, 'updated is the age of the windows, not of the failure');
  assert.equal(c.windows.seven_day.pct, 85);
  assert.match(c.error, /Claude CLI not found/);
  assert.ok(c.errorAt && Date.now() - new Date(c.errorAt) < 60000);
  assert.equal(written.at(-1).claude.updated, old); assert.equal(events.at(-1).t, 'limits');
  // A later successful report replaces the whole record: no stale error survives.
  lim.claudeLimits({ unifiedWindows: { seven_day: { utilization: 0.5 } } });
  assert.equal(lim.get().claude.error, undefined); assert.equal(lim.get().claude.errorAt, undefined); assert.notEqual(lim.get().claude.updated, old);
});
