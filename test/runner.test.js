// Runner against the fake CLIs (no HTTP): accounting, thread bookkeeping, tool modes, exit/err semantics, stop.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir, rmrf, waitFor, testWithFake, treeDead, samePath, hasGit, initRepo } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { createStore } = require('../src/store');
const { createSeats } = require('../src/seats');
const { createLimits } = require('../src/limits');
const { createRunner } = require('../src/runner');
const worktree = require('../src/worktree');
const { CLAUDE_TOOLS } = require('../src/config');
const { CLAUDE_WRITE_TOOLS } = require('../src/capability');
const claudeAdapter = require('../src/adapters/claude');

// A throwaway repository with one registered board worktree (<repo>/.orchestra/worktrees/r1/<item>): the runner's
// pre-spawn assertion only lets a write turn run in a real board worktree.
function boardWorktree(root, item = 'i1') {
  const repo = path.join(root, 'repo');
  if (!fs.existsSync(repo)) initRepo(repo, { 'README.md': 'hello\n', '.orchestra/.gitignore': 'worktrees/\n' });
  const head = require('child_process').spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout.trim();
  return worktree.createWorktree(repo, 'r1', item, head).dir;
}

const SEATS = [
  { id: 'ada', name: 'Ada', role: 'Builder', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', perm: 'read', target: '', budget: 0, color: '#e07a52', thread: null, used: 0, cached: 0, cost: 0 },
  { id: 'bob', name: 'Bob', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'high', perm: 'read', target: '', budget: 0, color: '#7aa2ff', thread: null, used: 0, cached: 0, cost: 0 },
  { id: 'wri', name: 'Wri', role: 'Writer', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', perm: 'write', target: '', budget: 0, color: '#ffcc4d', thread: null, used: 0, cached: 0, cost: 0 },
  { id: 'cox', name: 'Cox', role: 'Writer', agent: 'codex', model: 'gpt-6.1-sol', effort: 'low', perm: 'write', target: '', budget: 0, color: '#b48cff', thread: null, used: 0, cached: 0, cost: 0 },
  { id: 'tiny', name: 'Tiny', role: 'Budgeted', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', perm: 'read', target: '', budget: 5, color: '#4fd1a5', thread: null, used: 10, cached: 0, cost: 0 },
];

let dir, fake, store, seats, limits, runner, events;
const since = (n, t, seatId) => events.slice(n).filter((e) => e.t === t && (!seatId || e.seatId === seatId));

before(() => {
  dir = tmpDir('ob-runner-');
  fake = setupFakeCli(dir);
  store = createStore(path.join(dir, 'project')); store.ensure();
  store.writeJson('seats.json', SEATS);
  events = [];
  const broadcast = (e) => events.push(e);
  limits = createLimits({ store, broadcast });
  seats = createSeats({ store, broadcast });
  runner = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast, retryDelaysMs: [20, 40] });
});
after(async () => {
  for (const s of seats.all()) if (seats.rtOf(s.id).child) runner.stopSeat(s.id);
  try { await waitFor(() => seats.all().every((s) => !seats.rtOf(s.id).child), { timeout: 5000 }); } catch {}
  rmrf(dir);
});

testWithFake(fake, 'claude turn: result text, net/cached/cost accounting, thread saved + persisted, run/delta/end events, role header and lean args', async () => {
  fake.scenario({ default: { reply: 'Hello from the fake.' } });
  const n = events.length;
  const res = await runner.runSeat('ada', 'Say hi');
  assert.deepEqual(res, { ok: true, text: 'Hello from the fake.', tokens: 15, cached: 5, cost: 0.01, error: null });
  const [call] = fake.calls().slice(-1);
  assert.equal(call.agent, 'claude'); assert.equal(call.seat, 'Ada'); assert.equal(call.resume, false);
  assert.ok(call.stdin.startsWith('[You are "Ada" (Builder) in a multi-agent orchestra'), 'role header on a new thread');
  assert.match(call.stdin, /Reply in English\./); assert.match(call.stdin, /Do not modify files\./);
  assert.ok(call.stdin.endsWith('Say hi'));
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(call.args[call.args.indexOf('--effort') + 1], 'medium');
  assert.deepEqual(call.tools, ['Read', 'Grep', 'Glob']);
  assert.equal(call.permissionMode, 'dontAsk', 'read turns never wait for a permission prompt');
  assert.ok(call.args.includes('--strict-mcp-config'), 'lean flags');
  assert.ok(samePath(call.cwd, store.project), `cwd ${call.cwd} is the project ${store.project}`); // realpath-based: macOS /var -> /private/var
  // Thread: the runner mints the session id, the CLI echoes it, the seat remembers it.
  const sid = call.args[call.args.indexOf('--session-id') + 1];
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.equal(seats.seatById('ada').thread, sid);
  const persisted = store.readJson('seats.json').find((s) => s.id === 'ada');
  assert.equal(persisted.thread, sid); assert.equal(persisted.used, 15); assert.equal(persisted.cached, 5); assert.equal(persisted.cost, 0.01);
  // SSE: run, streamed deltas that add up to the text, end with the accounting.
  const run = since(n, 'run', 'ada'); assert.equal(run.length, 1); assert.equal(run[0].roomId, null);
  assert.equal(since(n, 'delta', 'ada').map((e) => e.text).join(''), 'Hello from the fake.');
  const end = since(n, 'end', 'ada'); assert.equal(end.length, 1);
  assert.deepEqual({ ...end[0], runId: undefined }, { t: 'end', seatId: 'ada', runId: undefined, roomId: null, ok: true, tokens: 15, cached: 5, cost: 0.01, error: null });
  assert.equal(end[0].runId, run[0].runId);
  const st = seats.publicSeat(seats.seatById('ada'));
  assert.equal(st.status, 'idle'); assert.equal(st.activity, ''); assert.equal(st.roomId, null);
});

testWithFake(fake, 'second claude turn resumes the seat thread and sends the prompt without header or preface', async () => {
  const before = seats.seatById('ada').thread;
  const res = await runner.runSeat('ada', 'Again');
  assert.equal(res.ok, true);
  const [call] = fake.calls().slice(-1);
  assert.equal(call.resume, true);
  assert.deepEqual(call.args.slice(call.args.indexOf('--resume'), call.args.indexOf('--resume') + 2), ['--resume', before]);
  assert.ok(!call.args.includes('--session-id'));
  assert.equal(call.stdin, 'Again');
  assert.equal(seats.seatById('ada').thread, before);
  assert.equal(seats.seatById('ada').used, 30, 'usage accumulates');
});

testWithFake(fake, 'codex turn: thread from thread.started, exec resume on the next turn, net usage (input - cached + output), effort/model via -c', async () => {
  const res = await runner.runSeat('bob', 'Review this');
  assert.deepEqual(res, { ok: true, text: 'Hello from the fake.', tokens: 47, cached: 60, cost: 0, error: null });
  const [c1] = fake.calls().slice(-1);
  assert.equal(c1.agent, 'codex'); assert.equal(c1.seat, 'Bob');
  assert.deepEqual(c1.args.slice(0, 3), ['exec', '--skip-git-repo-check', '--json']);
  assert.equal(c1.model, 'gpt-6-luna'); assert.equal(c1.effort, 'high'); assert.equal(c1.sandbox, 'read-only');
  assert.match(seats.seatById('bob').thread, /^cx-/);
  const res2 = await runner.runSeat('bob', 'More');
  assert.equal(res2.ok, true);
  const [c2] = fake.calls().slice(-1);
  assert.deepEqual(c2.args.slice(0, 3), ['exec', 'resume', c1.thread]);
  assert.equal(c2.stdin, 'More');
  assert.equal(seats.seatById('bob').used, 94); assert.equal(seats.seatById('bob').cached, 120);
});

testWithFake(fake, 'a non-zero exit after a completed turn still counts as success (both CLIs)', async () => {
  fake.scenario([{ seat: 'Ada', exit: 1, reply: 'done anyway' }, { seat: 'Bob', exit: 1, reply: 'codex done' }]);
  const a = await runner.runSeat('ada', 'go'), b = await runner.runSeat('bob', 'go');
  assert.equal(a.ok, true); assert.equal(a.text, 'done anyway'); assert.equal(a.error, null);
  assert.equal(b.ok, true); assert.equal(b.text, 'codex done');
  assert.equal(seats.publicSeat(seats.seatById('ada')).status, 'idle');
  assert.equal(events.filter((e) => e.t === 'end').at(-1).ok, true);
});

testWithFake(fake, 'an exit without a completed turn fails with the stderr tail in the error; seat status error', async () => {
  fake.scenario([{ seat: 'Ada', crash: 'fatal: no network', exit: 2 }]);
  const n = events.length;
  const res = await runner.runSeat('ada', 'go');
  assert.equal(res.ok, false);
  assert.match(res.error, /no network/);
  const st = seats.publicSeat(seats.seatById('ada'));
  assert.equal(st.status, 'error'); assert.equal(st.activity, res.error);
  const end = since(n, 'end', 'ada')[0];
  assert.equal(end.ok, false); assert.equal(end.error, res.error);
});

testWithFake(fake, 'claude is_error result and codex turn.failed fail the turn with the CLI message (transient ones after 2 retries)', async () => {
  fake.scenario([{ seat: 'Ada', error: 'API Error: 529 overloaded' }, { seat: 'Bob', error: 'stream disconnected' }]);
  let before = fake.calls().length;
  const a = await runner.runSeat('ada', 'go');
  assert.equal(a.ok, false); assert.match(a.error, /529 overloaded/); assert.equal(a.failure, 'transient');
  assert.equal(fake.calls().length - before, 3, 'first try + 2 retries');
  before = fake.calls().length;
  const b = await runner.runSeat('bob', 'go');
  assert.equal(b.ok, false); assert.match(b.error, /stream disconnected/);
  assert.equal(fake.calls().length - before, 3);
  fake.scenario([{ seat: 'Ada', error: 'Something else broke' }]);
  before = fake.calls().length;
  const c = await runner.runSeat('ada', 'go');
  assert.equal(c.ok, false); assert.equal(c.failure, 'other'); assert.equal(fake.calls().length - before, 1, 'a non-transient error is not retried');
});

testWithFake(fake, 'token budget blocks the turn before any spawn', async () => {
  const before = fake.calls().length;
  const res = await runner.runSeat('tiny', 'go');
  assert.equal(res.ok, false); assert.match(res.error, /Tiny reached its token budget/);
  assert.equal(fake.calls().length, before);
});

testWithFake(fake, 'tools: write without a worktree runs as read for every seat (the write gate is closed by default)', async () => {
  fake.scenario({ default: { reply: 'ok' } });
  let res = await runner.runSeat('ada', 'edit please', { tools: 'write' });
  let [c] = fake.calls().slice(-1);
  assert.equal(c.permissionMode, 'dontAsk'); assert.deepEqual(c.tools, ['Read', 'Grep', 'Glob']); assert.equal(res.mode, 'read');
  res = await runner.runSeat('wri', 'edit please', { tools: 'write' });
  [c] = fake.calls().slice(-1);
  assert.equal(c.permissionMode, 'dontAsk'); assert.deepEqual(c.tools, ['Read', 'Grep', 'Glob']); assert.equal(res.mode, 'read');
  assert.match(c.stdin, /Do not modify files\./, 'a clamped write turn is told not to edit');
  assert.ok(samePath(c.cwd, store.project));
  res = await runner.runSeat('cox', 'edit please'); // write seat: the default request is write, clamped to read
  [c] = fake.calls().slice(-1);
  assert.equal(c.sandbox, 'read-only'); assert.equal(res.mode, 'read');
  assert.ok(!c.args.includes('sandbox_workspace_write.network_access=false'));
  await runner.runSeat('cox', 'look only', { tools: 'read' });
  [c] = fake.calls().slice(-1);
  assert.equal(c.sandbox, 'read-only');
  assert.equal(Object.keys(res).includes('mode'), false, 'mode is readable but not one of the enumerable result fields');
});

testWithFake(fake, 'writeGate: write mode only with a worktree the gate allows; the CLI then runs in that worktree without --add-dir', async (t) => {
  if (!hasGit) return t.skip('git not available');
  fake.scenario({ default: { reply: 'ok' } });
  const wtRoot = tmpDir('ob-runner-wt-'), otherDir = tmpDir('ob-runner-other-');
  const dirW = boardWorktree(wtRoot);
  const asked = [];
  const gated = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast: (e) => events.push(e), retryDelaysMs: [20, 40], writeGate: (seat, d) => { asked.push([seat.id, d]); return d === dirW; } });
  try {
    let res = await gated.runSeat('wri', 'edit please', { tools: 'write', worktree: dirW });
    let [c] = fake.calls().slice(-1);
    assert.equal(res.ok, true); assert.equal(res.mode, 'write');
    assert.equal(c.permissionMode, 'acceptEdits'); assert.deepEqual(c.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write']);
    assert.ok(samePath(c.cwd, dirW), `cwd ${c.cwd} is the worktree`); assert.equal(c.addDir, null);
    assert.deepEqual(asked.at(-1), ['wri', dirW]);
    // Codex file edits are off on every platform (plan 5.1): a Codex write request runs read even when the gate says yes.
    res = await gated.runSeat('cox', 'edit please', { worktree: dirW });
    [c] = fake.calls().slice(-1);
    assert.equal(res.ok, true); assert.equal(res.mode, 'read'); assert.equal(c.sandbox, 'read-only'); assert.ok(samePath(c.cwd, dirW));
    assert.ok(!c.args.includes('sandbox_workspace_write.network_access=false'));
    // A worktree the gate does not allow: read mode, still in that directory.
    res = await gated.runSeat('wri', 'edit please', { tools: 'write', worktree: otherDir });
    [c] = fake.calls().slice(-1);
    assert.equal(res.mode, 'read'); assert.equal(c.permissionMode, 'dontAsk'); assert.deepEqual(c.tools, ['Read', 'Grep', 'Glob']);
    res = await gated.runSeat('cox', 'edit please', { tools: 'write', worktree: otherDir });
    [c] = fake.calls().slice(-1);
    assert.equal(res.mode, 'read'); assert.equal(c.sandbox, 'read-only'); assert.ok(samePath(c.cwd, otherDir));
    // No worktree: the gate is not even asked.
    const n = asked.length;
    res = await gated.runSeat('wri', 'edit please', { tools: 'write' });
    assert.equal(res.mode, 'read'); assert.equal(asked.length, n);
    // A no-tools Codex turn keeps the empty cwd even with a worktree.
    res = await gated.runSeat('cox', 'discuss', { tools: 'none', worktree: dirW });
    [c] = fake.calls().slice(-1);
    assert.equal(res.mode, 'none'); assert.ok(samePath(c.cwd, path.join(store.orch, 'empty')));
    // A gate that throws means no.
    const throwing = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast: (e) => events.push(e), retryDelaysMs: [20, 40], writeGate: () => { throw new Error('boom'); } });
    res = await throwing.runSeat('wri', 'edit please', { tools: 'write', worktree: dirW });
    [c] = fake.calls().slice(-1);
    assert.equal(res.ok, true); assert.equal(res.mode, 'read'); assert.equal(c.permissionMode, 'dontAsk');
  } finally { rmrf(wtRoot); rmrf(otherDir); }
});

testWithFake(fake, 'Codex write clamp: with platform win32 and a gate that always says yes, a Codex write request runs read-only and a Claude write seat still writes', async (t) => {
  if (!hasGit) return t.skip('git not available');
  fake.scenario({ default: { reply: 'ok' } });
  const wtRoot = tmpDir('ob-runner-clamp-');
  const dirW = boardWorktree(wtRoot);
  const win = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast: (e) => events.push(e), retryDelaysMs: [], platform: 'win32', writeGate: () => true });
  try {
    let res = await win.runSeat('cox', 'edit please', { tools: 'write', worktree: dirW });
    let [c] = fake.calls().slice(-1);
    assert.equal(res.ok, true); assert.equal(res.mode, 'read');
    assert.equal(c.agent, 'codex'); assert.equal(c.sandbox, 'read-only');
    assert.ok(!c.args.includes('sandbox_mode="workspace-write"'));
    res = await win.runSeat('wri', 'edit please', { tools: 'write', worktree: dirW });
    [c] = fake.calls().slice(-1);
    assert.equal(res.ok, true); assert.equal(res.mode, 'write');
    assert.equal(c.agent, 'claude'); assert.equal(c.permissionMode, 'acceptEdits');
  } finally { rmrf(wtRoot); }
});

test('CLAUDE_TOOLS.write is exactly CLAUDE_WRITE_TOOLS and the write argv ends with --tools and exactly those names', () => {
  assert.deepEqual(CLAUDE_TOOLS.write, [...CLAUDE_WRITE_TOOLS]);
  for (const thread of [null, 'abc']) {
    const args = claudeAdapter.buildArgs({ model: 'claude-sonnet-5-5', effort: 'low', thread, sessionId: thread ? null : 'sid', mode: 'write' });
    const i = args.indexOf('--tools');
    assert.equal(args.lastIndexOf('--tools'), i);
    assert.deepEqual(args.slice(i), ['--tools', ...CLAUDE_WRITE_TOOLS]);
  }
});

testWithFake(fake, 'tools none: claude gets --tools "", codex runs inside .orchestra/empty; the prompt carries the no-tools note', async () => {
  await runner.runSeat('ada', 'discuss', { tools: 'none' });
  let [c] = fake.calls().slice(-1);
  assert.deepEqual(c.args.slice(-2), ['--tools', '']);
  assert.match(c.stdin, /\(No tools or commands this turn: answer from the conversation\.\)/);
  await runner.runSeat('bob', 'discuss', { tools: 'none' });
  [c] = fake.calls().slice(-1);
  assert.ok(samePath(c.cwd, path.join(store.orch, 'empty')), `cwd ${c.cwd} is .orchestra/empty`);
  assert.equal(c.sandbox, 'read-only');
  assert.ok(fs.existsSync(path.join(store.orch, 'empty')));
});

testWithFake(fake, 'rate_limit_event in a turn updates limits (pct, resetsAt ms), persists limits.json and broadcasts', async () => {
  fake.scenario([{ seat: 'Ada', reply: 'ok', rateLimit: { status: 'allowed', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1759900000 } } } }]);
  const n = events.length;
  await runner.runSeat('ada', 'go');
  assert.deepEqual(limits.get().claude.windows, { five_hour: { pct: 42, resetsAt: 1759900000000 } });
  assert.equal(limits.get().claude.status, 'allowed');
  assert.deepEqual(store.readJson('limits.json').claude.windows, limits.get().claude.windows);
  assert.ok(since(n, 'limits').length >= 1);
});

testWithFake(fake, 'probeClaude: Haiku no-tools probe runs the configured claude binary in the temp dir and feeds its rate limit', async () => {
  fake.scenario({ default: { reply: 'ok', rateLimit: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.115, resetsAt: 1760300000 } } } } });
  const before = fake.calls().length;
  limits.probeClaude();
  await waitFor(() => limits.get().claude?.windows?.seven_day, { what: 'probe rate limit' });
  assert.deepEqual(limits.get().claude.windows.seven_day, { pct: 11.5, resetsAt: 1760300000000 });
  const probe = await waitFor(() => fake.calls().slice(before).find((c) => c.args.includes('--no-session-persistence')), { what: 'probe call' });
  assert.equal(probe.agent, 'claude'); assert.equal(probe.seat, null);
  assert.equal(probe.args[probe.args.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.deepEqual(probe.args.slice(-2), ['--tools', '']);
  assert.equal(probe.stdin, 'Reply with: ok');
  assert.ok(samePath(probe.cwd, os.tmpdir()), `probe cwd ${probe.cwd} is the temp dir`);
});

testWithFake(fake, 'room turns keep one thread per seat per room under room.threads[threadKey || seatId], never on the seat', async () => {
  fake.scenario({ default: { reply: 'ok' } });
  const room = { id: 'room1', kind: 'meeting', messages: [] };
  const seatThread = seats.seatById('ada').thread;
  const o = { room, roomId: room.id };
  await runner.runSeat('ada', 'scout', { ...o, threadKey: 'ada:scout', tools: 'read' });
  let [c] = fake.calls().slice(-1);
  assert.equal(c.resume, false); assert.match(room.threads['ada:scout'], /^[0-9a-f-]{36}$/);
  assert.equal(seats.seatById('ada').thread, seatThread, 'seat thread untouched');
  await runner.runSeat('ada', 'round 1', { ...o, tools: 'none', withTarget: false });
  [c] = fake.calls().slice(-1);
  assert.equal(c.resume, false); assert.ok(room.threads.ada && room.threads.ada !== room.threads['ada:scout']);
  await runner.runSeat('ada', 'round 2', { ...o, tools: 'none', withTarget: false });
  [c] = fake.calls().slice(-1);
  assert.equal(c.resume, true); assert.equal(c.args[c.args.indexOf('--resume') + 1], room.threads.ada);
  await runner.runSeat('bob', 'round 1', { ...o, tools: 'none', withTarget: false });
  assert.match(room.threads.bob, /^cx-/);
  assert.equal(seats.seatById('bob').thread !== room.threads.bob, true, 'codex seat thread untouched too');
  const runs = events.filter((e) => e.t === 'run' && e.roomId === 'room1'), ends = events.filter((e) => e.t === 'end' && e.roomId === 'room1');
  assert.equal(runs.length, 4); assert.equal(ends.length, 4);
  assert.deepEqual(ends.map((e) => e.runId), runs.map((e) => e.runId));
});

testWithFake(fake, 'a stopped room or a cancelled() turn resolves {ok:false, error:"stopped"} without spawning', async () => {
  const before = fake.calls().length;
  assert.deepEqual(await runner.runSeat('ada', 'x', { room: { id: 'r2', kind: 'meeting', messages: [], stopped: true } }), { ok: false, error: 'stopped', text: '' });
  assert.deepEqual(await runner.runSeat('ada', 'x', { cancelled: () => true }), { ok: false, error: 'stopped', text: '' });
  assert.equal(fake.calls().length, before);
});

test('unknown seat resolves with "no such agent"', async () => {
  assert.deepEqual(await runner.runSeat('nobody', 'x'), { ok: false, error: 'no such agent', text: '' });
});

testWithFake(fake, 'stopSeat: false when idle; a running turn ends with error "stopped" and its process tree is dead', async () => {
  assert.equal(runner.stopSeat('ada'), false);
  fake.scenario([{ seat: 'Ada', hang: true }]);
  const n = events.length;
  const p = runner.runSeat('ada', 'hang forever');
  const call = await waitFor(() => fake.calls().find((c) => c.stdin.endsWith('hang forever')), { what: 'hanging call' });
  await waitFor(() => seats.rtOf('ada').child, { what: 'child handle' });
  assert.equal(seats.publicSeat(seats.seatById('ada')).status, 'working');
  assert.equal(runner.stopSeat('ada'), true);
  const res = await p;
  assert.equal(res.ok, false); assert.equal(res.error, 'stopped');
  const st = seats.publicSeat(seats.seatById('ada'));
  assert.equal(st.status, 'error'); assert.equal(st.activity, 'stopped'); assert.equal(st.startedAt, null);
  assert.equal(since(n, 'end', 'ada')[0].error, 'stopped');
  await waitFor(() => treeDead(call), { what: 'fake CLI process tree to die', timeout: 8000 });
  assert.equal(runner.stopSeat('ada'), false);
});

testWithFake(fake, 'runSeat queues turns per seat: run/end pairs never interleave for one seat; different seats run in parallel', async () => {
  fake.scenario({ default: { reply: 'ok', delayMs: 120 } });
  const n = events.length;
  await Promise.all([runner.runSeat('ada', 'q1'), runner.runSeat('ada', 'q2'), runner.runSeat('bob', 'p1')]);
  const ada = events.slice(n).filter((e) => e.seatId === 'ada' && (e.t === 'run' || e.t === 'end')).map((e) => e.t);
  assert.deepEqual(ada, ['run', 'end', 'run', 'end']);
  const order = events.slice(n).filter((e) => e.t === 'run' || e.t === 'end').map((e) => `${e.t}:${e.seatId}`);
  assert.ok(order.indexOf('run:bob') < order.indexOf('end:ada'), 'bob started while ada was still running');
});
