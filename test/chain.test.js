// Propose -> Review workflow end-to-end with fake CLIs (port 4393): strict VERDICT parsing on the last line,
// effort escalation, user notes routed to the next speaker, round limit, builder failure, write-seat diff.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, waitFor, startApp, testWithFake, teardown } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');

const PORT = 4393;
let dir, project, fake, ctx;

before(async () => {
  dir = tmpDir('ob-chain-'); project = path.join(dir, 'project'); fs.mkdirSync(project);
  fake = setupFakeCli(dir);
  ctx = await startApp({ port: PORT, projectDir: project });
  for (const s of [
    { name: 'Ada', role: 'Builder', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', perm: 'read' },
    { name: 'Bob', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'medium', perm: 'read' },
    { name: 'Wri', role: 'Implementer', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', perm: 'write' },
  ]) assert.equal((await ctx.post('/api/seats', s)).status, 200);
});
after(() => teardown(ctx, dir));

const TASK ='Add a per-launch session token to the API';
const NOTE = 'Please keep the token out of the logs.';
const finished = (roomId) => waitFor(async () => { const r = await ctx.room(roomId); return r && r.status !== 'running' && r; }, { timeout: 25000, what: 'chain to finish' });
const logOf = () => fs.readFileSync(path.join(project, '.orchestra', 'LOG.md'), 'utf8');

testWithFake(fake, 'FAIL -> escalate -> sloppy verdict counts as FAIL -> PASS: strict last-line verdict, labels, resultId, notes go to the reviewer', async () => {
  fake.scenario([
    { seat: 'Ada', nth: 1, reply: 'Proposal v1: add a token check in handle().', gate: 'b1' },
    { seat: 'Bob', nth: 1, reply: 'BLOCKER: token never rotated.\nSHOULD-FIX: add tests.\nVERDICT: FAIL' },
    { seat: 'Ada', nth: 2, reply: 'Proposal v2: rotate the token on start.' },
    { seat: 'Bob', nth: 2, reply: 'VERDICT: PASS\nWell, almost: one NIT remains.' }, // verdict not on the last line -> not a PASS
    { seat: 'Ada', nth: 3, reply: 'Proposal v3: NIT addressed.' },
    { seat: 'Bob', nth: 3, reply: 'No blockers left.\n**VERDICT: PASS**' },
  ]);
  const sse = await ctx.sse();
  const start = await ctx.post('/api/chain', { task: TASK, builderId: 'ada', reviewerId: 'bob', maxRounds: 3, escalate: true });
  assert.equal(start.status, 200);
  const roomId = start.json.roomId;
  await fake.waitCalls((c) => c.seat === 'Ada', 1);
  assert.equal((await ctx.room(roomId)).round, 1);
  assert.deepEqual((await ctx.post(`/api/rooms/${roomId}/say`, { text: NOTE })).json, { ok: true });
  fake.openGate('b1');
  const room = await finished(roomId);
  sse.close();
  assert.equal(room.status, 'passed'); assert.equal(room.round, 3);

  const calls = fake.calls();
  assert.deepEqual(calls.map((c) => c.seat), ['Ada', 'Bob', 'Ada', 'Bob', 'Ada', 'Bob']);
  const [a1, b1, a2, b2, a3, b3] = calls;
  assert.ok(a1.stdin.includes(`Task:\n${TASK}`) && a1.stdin.includes('You cannot modify files: propose the change concretely'), 'read-only builder proposes');
  assert.equal(a1.effort, 'medium'); assert.equal(a1.resume, false); assert.deepEqual(a1.tools, ['Read', 'Grep', 'Glob']);
  assert.ok(!a1.stdin.includes(NOTE));
  assert.ok(b1.stdin.includes("Review Ada's latest proposal on this task:") && b1.stdin.includes('--- Ada output ---\nProposal v1: add a token check in handle().\n---'));
  assert.ok(b1.stdin.includes(`Notes from the user:\n- ${NOTE}`), 'a note posted while the builder worked goes to the reviewer');
  assert.ok(b1.stdin.includes('The last line must be exactly "VERDICT: PASS" or "VERDICT: FAIL"'));
  assert.ok(!b1.stdin.includes('--- changes ---'), 'no diff for a proposal');
  assert.equal(b1.sandbox, 'read-only');
  assert.equal(a2.resume, true);
  assert.ok(a2.stdin.includes('Review feedback from Bob (round 1):\nBLOCKER: token never rotated.') && a2.stdin.includes('Address the BLOCKER and SHOULD-FIX items only'));
  assert.ok(!a2.stdin.includes(NOTE), 'the note was consumed by the reviewer');
  assert.equal(a2.effort, 'high', 'escalated after the first FAIL');
  assert.deepEqual(b2.args.slice(0, 2), ['exec', 'resume']); assert.ok(b2.stdin.includes('Proposal v2'));
  assert.equal(a3.effort, 'xhigh', 'escalated again after the sloppy verdict');
  assert.ok(a3.stdin.includes('Review feedback from Bob (round 2):\nVERDICT: PASS\nWell, almost'));
  assert.ok(b3.stdin.includes('Proposal v3'));

  const msgs = room.messages;
  const reviews = msgs.filter((m) => m.seatId === 'bob');
  assert.deepEqual(reviews.map((m) => m.verdict), ['fail', 'fail', 'pass']);
  assert.deepEqual(reviews.map((m) => m.label), ['review', 'review', 'review']);
  assert.equal(room.resultId, reviews[2].id, 'the latest review is the result');
  const builds = msgs.filter((m) => m.seatId === 'ada');
  assert.deepEqual(builds.map((m) => m.label), ['proposal · medium', 'proposal · high', 'proposal · xhigh']);
  assert.deepEqual(builds.map((m) => m.effort), ['medium', 'high', 'xhigh']);
  const sys = msgs.filter((m) => m.seatId === 'system').map((m) => m.text);
  assert.deepEqual(sys, ['⚡ Ada effort raised → high', '⚡ Ada effort raised → xhigh']);
  const note = msgs.find((m) => m.seatId === 'user' && m.text === NOTE);
  assert.equal(note.consumed, true);
  assert.deepEqual(room.usage.perSeat, { ada: 45, bob: 141 });
  assert.ok(logOf().includes(`Propose→Review Ada→Bob "${TASK}": passed after 3 round(s).`));
  assert.deepEqual(sse.of('msg').filter((e) => e.msg.verdict).map((e) => e.msg.verdict), ['fail', 'fail', 'pass'], 'verdicts are broadcast once set');
  assert.equal(sse.of('end').length, 6);
  assert.deepEqual((await ctx.seat('ada')).status, 'idle');
});

testWithFake(fake, 'round limit without a PASS -> needs-you with a hint; no escalation on the last round; a note posted after the last turn is not delivered', async () => {
  fake.resetCalls();
  fake.scenario([{ seat: 'Ada', reply: 'Proposal only' }, { seat: 'Bob', reply: 'BLOCKER: nope\nVERDICT: FAIL', gate: 'rv' }]);
  const { json: { roomId } } = await ctx.post('/api/chain', { task: 'Second task', builderId: 'ada', reviewerId: 'bob', maxRounds: 1, escalate: true });
  await fake.waitCalls((c) => c.seat === 'Bob', 1);
  assert.deepEqual((await ctx.post(`/api/rooms/${roomId}/say`, { text: 'Too late note' })).json, { ok: true });
  fake.openGate('rv');
  const room = await finished(roomId);
  assert.equal(room.status, 'needs-you'); assert.equal(room.round, 1);
  const sys = room.messages.filter((m) => m.seatId === 'system').map((m) => m.text);
  assert.ok(sys.some((t) => /Round limit reached without a PASS/.test(t)));
  assert.ok(sys.some((t) => /^Not delivered .*"Too late note"/.test(t)));
  assert.ok(!sys.some((t) => /effort raised/.test(t)), 'no escalation when no round follows');
  assert.equal(room.messages.find((m) => m.seatId === 'bob').verdict, 'fail');
  assert.equal(fake.calls().length, 2);
  assert.ok(logOf().includes('Propose→Review Ada→Bob "Second task": needs-you after 1 round(s).'));
  assert.equal((await ctx.post(`/api/rooms/${roomId}/say`, { text: 'x' })).status, 400);
});

testWithFake(fake, 'builder failure ends the chain as an error with a system note, no review turn and no misleading round-limit note', async () => {
  fake.resetCalls();
  fake.scenario([{ seat: 'Ada', crash: 'claude exploded', exit: 1 }]);
  const { json: { roomId } } = await ctx.post('/api/chain', { task: 'Third task', builderId: 'ada', reviewerId: 'bob', maxRounds: 2 });
  const room = await finished(roomId);
  assert.equal(room.status, 'error');
  const sys = room.messages.filter((m) => m.seatId === 'system').map((m) => m.text);
  assert.ok(sys.some((t) => /^Ada failed: .*exploded/.test(t)));
  assert.ok(sys.some((t) => /could not complete a turn/.test(t)));
  assert.ok(!sys.some((t) => /Round limit reached/.test(t)), 'a builder that never ran is not a round limit');
  assert.ok(logOf().includes('"Third task": error after 1 round(s).'));
  assert.deepEqual(fake.calls().map((c) => c.seat), ['Ada']);
  assert.match(room.messages.find((m) => m.seatId === 'ada').error, /exploded/);
});

const hasGit = (() => { try { return spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0; } catch { return false; } })();

test('write builder: implements instead of proposing, the reviewer gets the git diff (incl. untracked files) and skips the target preface', { timeout: 30000, skip: fake.skipReason || (!hasGit && 'git not available') }, async () => {
  fake.resetCalls();
  const r = spawnSync('git', ['init', '-q'], { cwd: project, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  fs.writeFileSync(path.join(project, 'new-feature.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.orchestra/\n');
  fake.scenario([{ seat: 'Wri', reply: 'Implemented: added new-feature.js.' }, { seat: 'Bob', reply: 'Fine.\nVERDICT: PASS' }]);
  const { json: { roomId } } = await ctx.post('/api/chain', { task: 'Fourth task', builderId: 'wri', reviewerId: 'bob', maxRounds: 1 });
  const room = await finished(roomId);
  assert.equal(room.status, 'passed');
  const [w, b] = fake.calls();
  assert.equal(w.seat, 'Wri'); assert.equal(w.permissionMode, 'acceptEdits'); assert.deepEqual(w.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write']);
  assert.ok(w.stdin.includes('Do the task. End with a short summary of what you changed.') && !w.stdin.includes('Do not modify files'));
  assert.ok(b.stdin.includes("Review Wri's latest work on this task:"));
  assert.ok(b.stdin.includes('--- changes ---') && b.stdin.includes('New files:') && b.stdin.includes('new-feature.js'), 'untracked files appear in the diff');
  assert.equal(room.messages.find((m) => m.seatId === 'wri').label, 'implementation · low');
});
