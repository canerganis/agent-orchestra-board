// Turn robustness against the fake CLIs (in-process, no HTTP): transient retry with backoff, lost-thread recovery,
// idle watchdog, login errors, failed seats that never stall a debate or a chain, ORCHESTRA_NAIVE.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir, rmrf, waitFor, testWithFake, treeDead } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { createStore } = require('../src/store');
const { createSeats } = require('../src/seats');
const { createLimits } = require('../src/limits');
const { createRunner } = require('../src/runner');
const { createRooms } = require('../src/rooms');
const { createMeeting } = require('../src/workflows/meeting');
const { createChain } = require('../src/workflows/chain');
const config = require('../src/config');
const claudeAdapter = require('../src/adapters/claude');
const codexAdapter = require('../src/adapters/codex');
const { classifyFailure, authMessage } = require('../src/adapters/diagnose');

const seat = (id, name, agent, extra = {}) => ({ id, name, role: 'Tester', agent, model: agent === 'codex' ? 'gpt-6-luna' : 'claude-sonnet-5-5', effort: 'medium', perm: 'read', target: '', budget: 0, color: '#e07a52', thread: null, used: 0, cached: 0, cost: 0, ...extra });
const SEATS = [seat('ada', 'Ada', 'claude'), seat('bob', 'Bob', 'codex'), seat('cid', 'Cid', 'codex'), seat('dee', 'Dee', 'claude')];
const IDLE_MS = 1500;

let dir, fake, store, seats, limits, runner, rooms, meeting, chain, events;
before(() => {
  dir = tmpDir('ob-robust-');
  fake = setupFakeCli(dir);
  store = createStore(path.join(dir, 'project')); store.ensure();
  store.writeJson('seats.json', SEATS);
  events = [];
  const broadcast = (e) => events.push(e);
  limits = createLimits({ store, broadcast });
  seats = createSeats({ store, broadcast });
  runner = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast, retryDelaysMs: [20, 40], idleMs: IDLE_MS });
  rooms = createRooms({ store, seats, runner, broadcast });
  meeting = createMeeting({ store, seats, rooms });
  chain = createChain({ store, seats, rooms, broadcast });
});
after(async () => {
  for (const s of seats.all()) runner.stopSeat(s.id);
  try { await waitFor(() => seats.all().every((s) => !seats.rtOf(s.id).child), { timeout: 5000 }); } catch {}
  rmrf(dir);
});
// Token-trimming flags only: '-c' is shared with the isolation flags, so it is not a token marker.
const TOKEN_FLAGS = [...config.CLAUDE_TOKEN, ...config.CODEX_TOKEN.filter((t) => !config.CODEX_ISOLATION.includes(t))];
const callsOf = (name, from) => fake.calls().slice(from).filter((c) => c.seat === name);

// ---------- pure units ----------
test('classifyFailure: transient vs auth vs lost thread vs other; usage limits are not transient', () => {
  for (const t of ['API Error: 529 {"type":"overloaded_error"}', 'Error: 429 Too Many Requests', 'rate limit exceeded', 'read ECONNRESET', 'stream disconnected before completion', '503 Service Unavailable', 'socket hang up']) assert.equal(classifyFailure(t), 'transient', t);
  for (const t of ['Not logged in · Please run /login', 'Invalid API key · Please run /login', 'OAuth token has expired', 'Error: 401 Unauthorized', 'You are not logged in. Run codex login']) assert.equal(classifyFailure(t), 'auth', t);
  assert.equal(classifyFailure('No conversation found with session ID: abc', { resumed: true }), 'resume');
  assert.equal(classifyFailure('Error: thread/resume failed: no rollout found for thread id x', { resumed: true }), 'resume');
  assert.equal(classifyFailure('No conversation found with session ID: abc', { resumed: false }), 'other', 'only a resumed turn can lose its thread');
  assert.equal(classifyFailure('Claude AI usage limit reached, resets 5pm'), 'other');
  assert.equal(classifyFailure('claude: boom'), 'other');
  assert.match(authMessage('claude', 'Invalid API key'), /not logged in \(Invalid API key\)\. Run `claude` once to log in/);
  assert.match(authMessage('codex', 'Not logged in'), /Run `codex login` once/);
  assert.match(authMessage('claude', 'x', 'running in bare mode'), /bare mode/);
});

test('config: retry delays default 3s/10s (env override), idle watchdog 5 min (10 for Codex) scaled by effort (settings/env override)', () => {
  const env = { r: process.env.ORCHESTRA_RETRY_DELAYS_MS, i: process.env.ORCHESTRA_IDLE_MINUTES };
  try {
    delete process.env.ORCHESTRA_RETRY_DELAYS_MS; delete process.env.ORCHESTRA_IDLE_MINUTES;
    assert.deepEqual(config.retryDelays(), [3000, 10000]);
    process.env.ORCHESTRA_RETRY_DELAYS_MS = '5, 7'; assert.deepEqual(config.retryDelays(), [5, 7]);
    process.env.ORCHESTRA_RETRY_DELAYS_MS = ''; assert.deepEqual(config.retryDelays(), []);
    assert.equal(config.idleTimeoutMs('medium'), 5 * 60000);
    assert.equal(config.idleTimeoutMs('high'), 10 * 60000);
    assert.equal(config.idleTimeoutMs('xhigh'), 15 * 60000);
    assert.equal(config.idleTimeoutMs('medium', null, 'codex'), 10 * 60000, 'Codex default is 10 min');
    assert.equal(config.idleTimeoutMs('high', null, 'codex'), 20 * 60000, 'Codex keeps the effort factor');
    assert.equal(config.idleTimeoutMs('medium', null, 'claude'), 5 * 60000);
    assert.equal(config.idleTimeoutMs('medium', { idleMinutes: 3 }, 'codex'), 3 * 60000, 'settings win over the Codex default');
    assert.equal(config.idleTimeoutMs('medium', { idleMinutes: 0 }, 'codex'), 0, 'settings 0 = watchdog off');
    assert.equal(config.idleTimeoutMs('medium', { idleMinutes: 'off' }, 'codex'), 0, 'settings off = watchdog off');
    assert.equal(config.idleTimeoutMs('low', { idleMinutes: 2 }), 2 * 60000);
    process.env.ORCHESTRA_IDLE_MINUTES = '1'; assert.equal(config.idleTimeoutMs('low'), 60000);
  } finally {
    if (env.r === undefined) delete process.env.ORCHESTRA_RETRY_DELAYS_MS; else process.env.ORCHESTRA_RETRY_DELAYS_MS = env.r;
    if (env.i === undefined) delete process.env.ORCHESTRA_IDLE_MINUTES; else process.env.ORCHESTRA_IDLE_MINUTES = env.i;
  }
});

test('claude args: read/none turns pass --permission-mode dontAsk, write acceptEdits, --tools always last; probe has no --effort', () => {
  for (const [mode, perm] of [['read', 'dontAsk'], ['none', 'dontAsk'], ['write', 'acceptEdits']]) {
    const a = claudeAdapter.buildArgs({ model: 'm', effort: 'low', mode, thread: 't' });
    assert.equal(a[a.indexOf('--permission-mode') + 1], perm, mode);
    assert.equal(a.indexOf('--tools'), a.length - config.CLAUDE_TOOLS[mode].length - 1, `${mode}: --tools last`);
  }
  const p = claudeAdapter.buildProbeArgs();
  assert.ok(!p.includes('--effort')); assert.deepEqual(p.slice(-2), ['--tools', '']);
});

test('ORCHESTRA_NAIVE=1 drops only the token flags; the isolation flags stay for both CLIs', () => {
  const prev = process.env.ORCHESTRA_NAIVE;
  try {
    delete process.env.ORCHESTRA_NAIVE;
    assert.ok(claudeAdapter.buildArgs({ model: 'm', effort: 'low' }).includes('--strict-mcp-config'));
    assert.ok(codexAdapter.buildArgs({ model: 'm', effort: 'low' }).includes('--ignore-user-config'));
    process.env.ORCHESTRA_NAIVE = '1';
    assert.equal(config.naive(), true);
    const c = claudeAdapter.buildArgs({ model: 'm', effort: 'low' }), x = codexAdapter.buildArgs({ model: 'm', effort: 'low' });
    assert.ok(c.includes('--strict-mcp-config') && c.includes('--setting-sources'), 'Claude isolation stays');
    assert.ok(!c.some((s) => TOKEN_FLAGS.includes(s)), 'Claude token flags dropped');
    assert.ok(x.includes('--ignore-user-config') && x.includes('features.hooks=false'), 'Codex isolation stays');
    assert.ok(!x.some((s) => TOKEN_FLAGS.includes(s)), 'Codex token flags dropped');
    assert.equal(x.includes('windows.sandbox="unelevated"'), process.platform === 'win32', 'the Windows sandbox fix stays');
    assert.ok(c.includes('dontAsk') && x.includes('sandbox_mode="read-only"'), 'permissions are identical');
  } finally { if (prev === undefined) delete process.env.ORCHESTRA_NAIVE; else process.env.ORCHESTRA_NAIVE = prev; }
});

test('limits: rate_limit_event with missing fields keeps known windows; codex rollout with null secondary and limit_id', () => {
  limits.claudeLimits({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1759900000 } } });
  limits.claudeLimits({}); // nothing usable: ignored
  limits.claudeLimits({ status: 'allowed_warning' }); // status only: windows kept
  assert.deepEqual(limits.get().claude.windows, { five_hour: { pct: 50, resetsAt: 1759900000000 } });
  assert.equal(limits.get().claude.status, 'allowed_warning');
  limits.claudeLimits({ unifiedWindows: { seven_day: { utilization: 0.25 } } }); // no resetsAt
  assert.deepEqual(limits.get().claude.windows, { seven_day: { pct: 25, resetsAt: null } });
  const fs = require('fs');
  const f = path.join(process.env.OB_TEST_HOME, '.codex', 'sessions', '2026', '10', '08', 'rollout-x.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ payload: { rate_limits: { limit_id: 'codex', primary: { used_percent: 9, window_minutes: 300, resets_at: 2 }, secondary: null, plan_type: 'pro' } } }) + '\n');
  limits.refreshCodex();
  assert.deepEqual(limits.get().codex.windows, { five_hour: { pct: 9, minutes: 300, resetsAt: 2000 } });
  assert.equal(limits.get().codex.limitId, 'codex');
});

// ---------- runner against the fake CLIs ----------
testWithFake(fake, 'transient failure: retried on the same thread with backoff, "retrying (n/2)" shown, then succeeds', async () => {
  fake.resetCalls();
  fake.scenario({ default: { reply: 'first' } });
  assert.equal((await runner.runSeat('ada', 'warm up')).ok, true);
  const thread = seats.seatById('ada').thread;
  fake.scenario([{ seat: 'Ada', nth: 2, error: 'API Error: 529 overloaded' }, { seat: 'Ada', nth: 3, crash: 'Error: read ECONNRESET', exit: 1 }, { seat: 'Ada', reply: 'third time lucky' }]);
  const n = events.length;
  const res = await runner.runSeat('ada', 'try hard');
  assert.equal(res.ok, true); assert.equal(res.text, 'third time lucky');
  const calls = callsOf('Ada', 1);
  assert.equal(calls.length, 3);
  // The first attempt sends the prompt; retries on the same resumed thread ask again without re-sending it (the CLI
  // already stored it once the thread was reported).
  assert.equal(calls[0].stdin, 'try hard');
  for (const c of calls) { assert.equal(c.resume, true); assert.equal(c.args[c.args.indexOf('--resume') + 1], thread, 'same thread'); }
  for (const c of calls.slice(1)) assert.match(c.stdin, /previous reply was interrupted/);
  assert.equal(seats.seatById('ada').thread, thread);
  const acts = events.slice(n).filter((e) => e.t === 'seat' && e.seat.id === 'ada').map((e) => e.seat.activity);
  assert.ok(acts.includes('retrying (1/2)') && acts.includes('retrying (2/2)'), acts.join(' | '));
  assert.equal(events.slice(n).filter((e) => e.t === 'run' && e.seatId === 'ada').length, 1, 'one run per turn');
  assert.equal(events.slice(n).filter((e) => e.t === 'end' && e.seatId === 'ada').length, 1, 'one end per turn');
  assert.equal(events.slice(n).filter((e) => e.t === 'item' && e.kind === 'retry').length, 2);
});

testWithFake(fake, 'login problems are reported with an actionable message and never retried (claude and codex)', async () => {
  fake.resetCalls();
  fake.scenario([{ seat: 'Dee', error: 'Not logged in · Please run /login' }, { seat: 'Cid', crash: 'Error: Not logged in. Please run codex login', exit: 1 }]);
  const d = await runner.runSeat('dee', 'hi');
  assert.equal(d.ok, false); assert.equal(d.failure, 'auth');
  assert.match(d.error, /^Claude CLI is not logged in \(Not logged in · Please run \/login\)\. Run `claude` once to log in/);
  const c = await runner.runSeat('cid', 'hi');
  assert.equal(c.ok, false); assert.match(c.error, /^Codex CLI is not logged in .*Run `codex login` once/);
  assert.equal(fake.calls().length, 2, 'no retries');
  assert.match(seats.publicSeat(seats.seatById('dee')).activity, /Run `claude` once/);
});

testWithFake(fake, 'idle watchdog: a silent turn is killed (process tree dies) and retried as a transient failure', async () => {
  fake.resetCalls();
  fake.scenario([{ seat: 'Bob', nth: 1, hang: true }, { seat: 'Bob', reply: 'awake now' }]);
  const t0 = Date.now();
  const res = await runner.runSeat('bob', 'think quietly');
  assert.equal(res.ok, true); assert.equal(res.text, 'awake now');
  assert.ok(Date.now() - t0 >= IDLE_MS, 'waited for the watchdog');
  const [hung, retry] = callsOf('Bob', 0);
  assert.ok(hung && retry);
  await waitFor(() => treeDead(hung), { what: 'hung fake CLI to die', timeout: 8000 });
  // Out of retries: the watchdog error is the result (a runner without retries keeps this test short).
  fake.resetCalls();
  fake.scenario({ default: { hang: true } });
  const once = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast: () => {}, retryDelaysMs: [], idleMs: IDLE_MS });
  const r2 = await once.runSeat('bob', 'never answers');
  assert.equal(r2.ok, false); assert.equal(r2.failure, 'transient'); assert.match(r2.error, /no output for .* min \(idle watchdog\); the process was killed/);
  assert.equal(callsOf('Bob', 0).length, 1);
});

testWithFake(fake, 'idle watchdog disabled (idleMs 0): a normal turn completes without any watchdog kill', async () => {
  fake.resetCalls();
  const noDog = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast: () => {}, retryDelaysMs: [], idleMs: 0 });
  fake.scenario({ default: { reply: 'no watchdog needed' } });
  const res = await noDog.runSeat('bob', 'take your time');
  assert.equal(res.ok, true); assert.equal(res.text, 'no watchdog needed');
  assert.equal(callsOf('Bob', 0).length, 1, 'one spawn, not killed and retried');
});

testWithFake(fake, 'stopping a seat while it waits to retry ends the turn as stopped without another spawn', async () => {
  fake.resetCalls();
  const slow = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast: () => {}, retryDelaysMs: [10000], idleMs: IDLE_MS });
  fake.scenario({ default: { error: 'Error: 503 Service Unavailable' } });
  const p = slow.runSeat('dee', 'go');
  await waitFor(() => seats.rtOf('dee').retryWait, { what: 'retry wait' });
  assert.equal(seats.rtOf('dee').activity, 'retrying (1/1)');
  assert.equal(slow.stopSeat('dee'), true);
  const res = await p;
  assert.equal(res.ok, false); assert.equal(res.error, 'stopped');
  assert.equal(fake.calls().length, 1);
  assert.equal(seats.rtOf('dee').status, 'error'); assert.equal(seats.rtOf('dee').retryWait, null);
});

testWithFake(fake, 'lost thread: a fresh thread gets the role header, topic, scout brief and a recap, then the prompt; a system line records it (claude and codex)', async () => {
  fake.resetCalls();
  fake.scenario({ default: { reply: 'ok' } });
  const room = rooms.newRoom('meeting', 'Recovery', { topic: 'Robust recovery topic', seatIds: ['ada', 'bob'], rounds: 2 });
  rooms.userMsg(room, 'Robust recovery topic');
  rooms.post(room, { seatId: 'dee', name: 'Dee', round: 'scout', label: 'scout brief', text: 'BRIEF: src/a.js:1 holds the config.' });
  await rooms.say(room, 'ada', 'Round 1 prompt', { round: 1, tools: 'none', withTarget: false });
  await rooms.say(room, 'bob', 'Round 1 prompt', { round: 1, tools: 'none', withTarget: false });
  const oldAda = room.threads.ada, oldBob = room.threads.bob;
  assert.ok(oldAda && oldBob);
  fake.scenario([{ resume: true, lostThread: true }, { seat: 'Ada', reply: 'Ada is back' }, { seat: 'Bob', reply: 'Bob is back' }]);
  const from = fake.calls().length;
  const a = await rooms.say(room, 'ada', 'Round 2: new messages since your last turn: Bob said ok', { round: 2, tools: 'none', withTarget: false });
  const b = await rooms.say(room, 'bob', 'Round 2: Ada said Ada is back', { round: 2, tools: 'none', withTarget: false });
  assert.equal(a.ok, true); assert.equal(a.text, 'Ada is back'); assert.equal(a.recovered, true);
  assert.equal(b.ok, true); assert.equal(b.text, 'Bob is back');
  for (const [name, old] of [['Ada', oldAda], ['Bob', oldBob]]) {
    const [lost, fresh] = callsOf(name, from);
    assert.equal(lost.resume, true); assert.equal(lost.thread, old);
    assert.equal(fresh.resume, false, `${name}: fresh thread`);
    assert.ok(fresh.stdin.startsWith(`[You are "${name}" (Tester)`), 'role header first');
    assert.match(fresh.stdin, /Context recovery/);
    assert.match(fresh.stdin, /Meeting topic:\nRobust recovery topic/);
    assert.match(fresh.stdin, /Shared brief \(by Dee\):\nBRIEF: src\/a\.js:1/);
    assert.match(fresh.stdin, /Recap of the latest messages/);
    assert.ok(/Round 2/.test(fresh.stdin.slice(fresh.stdin.indexOf('Recap'))), 'the turn prompt comes after the recap');
    assert.ok(fresh.stdin.trimEnd().endsWith(name === 'Ada' ? 'Bob said ok' : 'Ada said Ada is back'), 'prompt last');
  }
  assert.ok(callsOf('Bob', from)[1].stdin.includes('Ada (round 2): Ada is back'), 'recap carries the latest messages');
  assert.notEqual(room.threads.ada, oldAda); assert.notEqual(room.threads.bob, oldBob);
  const notes = room.messages.filter((m) => m.seatId === 'system' && /could not be resumed/.test(m.text));
  assert.equal(notes.length, 2);
  assert.match(notes[0].text, /^Ada's thread .* could not be resumed \(.*No conversation found.*\); started a fresh thread with a recap/);
  // Next turn resumes the new thread normally.
  fake.scenario({ default: { reply: 'steady' } });
  const c = await rooms.say(room, 'ada', 'Round 3', { round: 3, tools: 'none', withTarget: false });
  assert.equal(c.ok, true); const [last] = fake.calls().slice(-1);
  assert.equal(last.resume, true); assert.equal(last.thread, room.threads.ada); assert.equal(last.stdin, '(No tools or commands this turn: answer from the conversation.)\n\nRound 3');
});

testWithFake(fake, 'Direct chat: a lost seat thread is recovered with a recap of the chat', async () => {
  fake.resetCalls();
  fake.scenario({ default: { reply: 'Noted: blue.' } });
  const room = rooms.sendDm(seats.seatById('dee'), 'My favourite colour is blue.');
  await waitFor(() => room.status === 'idle', { what: 'dm reply' });
  fake.scenario([{ resume: true, lostThread: true }, { reply: 'Blue, as you said.' }]);
  rooms.sendDm(seats.seatById('dee'), 'What colour did I say?');
  await waitFor(() => room.status === 'idle' && room.messages.some((m) => m.text === 'Blue, as you said.'), { what: 'recovered dm reply' });
  const [fresh] = fake.calls().slice(-1);
  assert.equal(fresh.resume, false);
  assert.match(fresh.stdin, /You: My favourite colour is blue\.|User: My favourite colour is blue\./);
  assert.ok(fresh.stdin.trimEnd().endsWith('What colour did I say?'));
  assert.equal((fresh.stdin.match(/What colour did I say\?/g) || []).length, 1, 'the prompt is not duplicated in the recap');
  assert.ok(room.messages.some((m) => m.seatId === 'system' && /could not be resumed/.test(m.text)));
});

// ---------- workflows: a failed seat never stalls ----------
testWithFake(fake, 'debate: a seat that cannot log in sits out, a flaky seat fails after retries, the others continue and the synthesis is told', async () => {
  fake.resetCalls();
  fake.scenario([
    { seat: 'Ada', error: 'Invalid API key · Please run /login' },
    { seat: 'Cid', crash: 'Error: stream disconnected before completion', exit: 1 },
    { match: 'You are the facilitator', reply: 'Synthesis done.' },
    { seat: 'Bob', reply: 'Bob idea\nSTANCE: OPEN' },
  ]);
  const room = rooms.newRoom('meeting', 'Failing seats', { topic: 'Failing seats topic', seatIds: ['ada', 'bob', 'cid'], rounds: 2, synthId: 'bob', scoutId: null });
  rooms.userMsg(room, 'Failing seats topic');
  await meeting.runMeeting(room);
  assert.equal(room.status, 'done');
  const ada = room.messages.filter((m) => m.seatId === 'ada');
  assert.equal(ada.length, 1, 'Ada only got round 1'); assert.equal(ada[0].failed, true); assert.equal(ada[0].failure, 'auth');
  assert.ok(room.messages.some((m) => m.seatId === 'system' && /^Ada cannot run .* sits out the rest of this debate/.test(m.text)));
  const cid = room.messages.filter((m) => m.seatId === 'cid');
  assert.equal(cid.length, 2, 'Cid keeps its turns'); assert.ok(cid.every((m) => m.failed && m.failure === 'transient'));
  assert.equal(callsOf('Cid', 0).length, 6, '2 turns x (1 + 2 retries)');
  assert.equal(callsOf('Ada', 0).length, 1);
  const synth = fake.calls().find((c) => /You are the facilitator/.test(c.stdin));
  assert.match(synth.stdin, /Some turns failed and are missing from the transcript: Ada \(round 1: Claude CLI is not logged in/);
  assert.match(synth.stdin, /Cid \(round 1: .*stream disconnected.*Cid \(round 2:/);
  assert.equal(room.messages.find((m) => m.id === room.resultId).text, 'Synthesis done.');
});

testWithFake(fake, 'propose -> review: a reviewer that cannot run ends the chain as an error with a note, not a FAIL loop', async () => {
  fake.resetCalls();
  fake.scenario([{ seat: 'Ada', reply: 'Proposal: change x.' }, { seat: 'Bob', crash: 'Error: 401 Unauthorized', exit: 1 }]);
  const room = rooms.newRoom('chain', 'Reviewer down', { task: 'Reviewer down task', builderId: 'ada', reviewerId: 'bob', maxRounds: 3, escalate: false });
  rooms.userMsg(room, 'Reviewer down task');
  await chain.runChain(room);
  assert.equal(room.status, 'error');
  const sys = room.messages.filter((m) => m.seatId === 'system').map((m) => m.text);
  assert.ok(sys.some((t) => /^Bob failed: Codex CLI is not logged in/.test(t)), sys.join(' | '));
  assert.ok(sys.some((t) => /could not complete the review, so the latest proposal above is unreviewed/.test(t)));
  assert.deepEqual(fake.calls().map((c) => c.seat), ['Ada', 'Bob'], 'one round, no retries on auth');
  const review = room.messages.find((m) => m.seatId === 'bob');
  assert.equal(review.failed, true); assert.equal(review.verdict, undefined);
});

testWithFake(fake, 'ORCHESTRA_NAIVE=1 debate: no scout, full transcript on a fresh thread with read tools every round, no early stop', async () => {
  const prev = process.env.ORCHESTRA_NAIVE;
  process.env.ORCHESTRA_NAIVE = '1';
  try {
    fake.resetCalls();
    fake.scenario({ default: { reply: 'Agreed.\nSTANCE: CONVERGED' } });
    const room = rooms.newRoom('meeting', 'Naive', { topic: 'Naive topic', seatIds: ['ada', 'bob'], rounds: 3, synthId: 'dee', scoutId: 'dee' });
    rooms.userMsg(room, 'Naive topic');
    await meeting.runMeeting(room);
    assert.equal(room.status, 'done'); assert.equal(room.round, 'synthesis');
    const calls = fake.calls();
    assert.ok(!calls.some((c) => /Scout task/.test(c.stdin)), 'scout ignored');
    assert.equal(calls.filter((c) => /Round \d of 3/.test(c.stdin)).length, 6, 'every planned round ran');
    assert.ok(!room.messages.some((m) => /Everyone converged|agreed silently/.test(m.text)));
    const r3 = calls.filter((c) => /Round 3 of 3/.test(c.stdin));
    r3.forEach((c, i) => {
      assert.equal(c.resume, false, 'fresh thread');
      assert.match(c.stdin, /Full meeting transcript so far/);
      // Ada sees rounds 1-2 (4 messages, her own included); Bob, speaking after her, also her round-3 reply.
      assert.equal((c.stdin.match(/Agreed\./g) || []).length, 4 + i, 'every earlier message, own ones included');
      if (c.agent === 'claude') assert.deepEqual(c.tools, ['Read', 'Grep', 'Glob']);
      assert.ok(!c.args.some((a) => TOKEN_FLAGS.includes(a)), 'no token flags');
      assert.ok(c.args.includes(c.agent === 'claude' ? '--strict-mcp-config' : '--ignore-user-config'), 'isolation flags stay');
    });
    const synth = calls.find((c) => /You are the facilitator/.test(c.stdin));
    assert.equal((synth.stdin.match(/Agreed\./g) || []).length, 6);
  } finally { if (prev === undefined) delete process.env.ORCHESTRA_NAIVE; else process.env.ORCHESTRA_NAIVE = prev; }
});
