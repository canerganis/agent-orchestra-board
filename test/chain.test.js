// Propose -> Review workflow end-to-end with fake CLIs: strict VERDICT parsing on the last line,
// effort escalation, user notes routed to the next speaker, round limit, builder failure, a write builder proposing.
// The end of this file covers runItemChain in write mode (real git worktrees and fake CLIs that write files).
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, rmrf, waitFor, testWithFake, teardown, startApp, hasGit, initRepo, samePath } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { createStore } = require('../src/store');
const { createSeats } = require('../src/seats');
const { createLimits } = require('../src/limits');
const { createRunner } = require('../src/runner');
const { createRooms } = require('../src/rooms');
const { createChain } = require('../src/workflows/chain');
const wt = require('../src/worktree');
const patch = require('../src/patch');

let dir, project, fake, ctx;

before(async () => {
  dir = tmpDir('ob-chain-'); project = path.join(dir, 'project'); fs.mkdirSync(project);
  fake = setupFakeCli(dir);
  ctx = await startApp({ projectDir: project });
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

testWithFake(fake, 'write builder proposes: read-only turn, the reviewer gets no diff, and a system note says edits happen only in Build sessions', async () => {
  fake.resetCalls();
  fake.scenario([{ seat: 'Wri', reply: 'Proposal: add a new-feature.js module.' }, { seat: 'Bob', reply: 'Fine.\nVERDICT: PASS' }]);
  const { json: { roomId } } = await ctx.post('/api/chain', { task: 'Fourth task', builderId: 'wri', reviewerId: 'bob', maxRounds: 1 });
  const room = await finished(roomId);
  assert.equal(room.status, 'passed');
  const [w, b] = fake.calls();
  // A room chain has no worktree, so the write seat is clamped to read and told to propose.
  assert.equal(w.seat, 'Wri'); assert.equal(w.permissionMode, 'dontAsk'); assert.deepEqual(w.tools, ['Read', 'Grep', 'Glob']);
  assert.ok(w.stdin.includes('You cannot modify files: propose the change concretely'));
  assert.ok(b.stdin.includes("Review Wri's latest proposal on this task:"));
  assert.ok(!b.stdin.includes('--- changes ---'), 'no diff is sent to the reviewer');
  const sys = room.messages.filter((m) => m.seatId === 'system').map((m) => m.text);
  assert.ok(sys.includes('File edits happen only in Build sessions (Plan → Approve → Build); this builder proposes.'));
  assert.equal(room.messages.find((m) => m.seatId === 'wri').label, 'proposal · low');
});

testWithFake(fake, 'propose mode: round 2 sends the reviewer only the changed lines and the unresolved findings, so the prompt shrinks', async () => {
  fake.resetCalls();
  const steps = Array.from({ length: 60 }, (_, i) => `Step ${i}: change the module number ${i} carefully`).join('\n');
  fake.scenario([
    { seat: 'Ada', nth: 1, reply: `Proposal v1\n${steps}` },
    { seat: 'Bob', nth: 1, reply: 'BLOCKER: add a rollback step.\nVERDICT: FAIL' },
    { seat: 'Ada', nth: 2, reply: `Proposal v1\n${steps}\nRollback: restore the old module` },
    { seat: 'Bob', nth: 2, reply: 'VERDICT: PASS' },
  ]);
  const { json: { roomId } } = await ctx.post('/api/chain', { task: 'Delta task', builderId: 'ada', reviewerId: 'bob', maxRounds: 2 });
  const room = await finished(roomId);
  assert.equal(room.status, 'passed');
  const bob = fake.calls().filter((c) => c.seat === 'Bob');
  assert.equal(bob.length, 2);
  assert.ok(bob[0].stdin.includes('Step 59: change the module'), 'round 1 carries the whole output');
  assert.ok(!bob[1].stdin.includes('Step 59: change the module'), 'round 2 does not resend it');
  assert.ok(bob[1].stdin.includes('Rollback: restore the old module') && bob[1].stdin.includes('BLOCKER: add a rollback step.'));
  assert.ok(bob[1].stdin.length < bob[0].stdin.length / 2, `round 2 prompt (${bob[1].stdin.length}) is far smaller than round 1 (${bob[0].stdin.length})`);
});

// runItemChain in write mode, no HTTP: real git repositories and worktrees, and fake CLIs that really write files.
// The capability is a stub whose finish() result each test sets. The runner's write gate is open, so worktree turns
// run in write mode. Skipped (with a reason) when git or the fake CLI is unavailable; the check runs per test because
// the fake CLI is only built in the root before() hook.
describe('runItemChain write mode', () => {
  const WSEATS = [
    { id: 'wri', name: 'Wri', role: 'Implementer', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', perm: 'write', target: '', budget: 0, color: '#ffcc4d', thread: null, used: 0, cached: 0, cost: 0 },
    { id: 'bob', name: 'Bob', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'medium', perm: 'read', target: '', budget: 0, color: '#7aa2ff', thread: null, used: 0, cached: 0, cost: 0 },
  ];
  const skipWhy = () => fake.skipReason || (!hasGit && 'git not available');
  const guard = (t) => { const why = skipWhy(); if (why) t.skip(why); return !!why; };
  let root, project, head, store, seats, rooms, runner, events, chain, stubResult;
  const stub = { guardTurn: async () => ({ finish: async () => stubResult }) };

  before(() => {
    if (skipWhy()) return;
    root = tmpDir('ob-chain-wr-'); project = path.join(root, 'project');
    head = initRepo(project, { 'README.md': 'hello\n', 'src/keep.js': 'module.exports = 0;\n' });
    store = createStore(project); store.ensure();
    store.writeJson('seats.json', WSEATS);
    events = [];
    const broadcast = (e) => events.push(e);
    const limits = createLimits({ store, broadcast });
    seats = createSeats({ store, broadcast });
    runner = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast, detectVersions: false, retryDelaysMs: [20, 40], writeGate: () => true });
    rooms = createRooms({ store, seats, runner, broadcast });
    chain = createChain({ store, seats, rooms, broadcast, capability: stub, patch });
  });
  after(async () => {
    if (!root) return;
    for (const s of seats.all()) if (seats.rtOf(s.id).child) runner.stopSeat(s.id);
    try { await waitFor(() => seats.all().every((s) => !seats.rtOf(s.id).child), { timeout: 5000 }); } catch {}
    rmrf(root);
  });
  beforeEach(() => { stubResult = { ok: true, changed: [] }; if (!skipWhy()) fake.resetCalls(); });

  // A fresh build room, one item worktree on HEAD (startTree from prepareWorktree, no dependency patches).
  function setup(itemId) {
    const room = rooms.newRoom('build', `Build ${itemId}`, {});
    const item = { id: itemId };
    const made = wt.createWorktree(project, room.id, itemId, head);
    const startTree = patch.prepareWorktree({ store, worktreeDir: made.dir });
    return { room, item, worktree: { dir: made.dir, startTree } };
  }
  const run = (room, item, worktree, extra = {}) => chain.runItemChain(room, item, { task: 'Build the item', builderId: 'wri', reviewerId: 'bob', maxRounds: 2, worktree, ...extra });
  const seatsOf = () => fake.calls().map((c) => c.seat);
  const sysTexts = (room) => room.messages.filter((m) => m.seatId === 'system').map((m) => m.text);

  testWithFake(fake, 'the builder writes inside its worktree, the reviewer sees the frozen patch, and the main checkout stays clean', async (t) => {
    if (guard(t)) return;
    fake.scenario([
      { seat: 'Wri', writeFiles: [{ path: 'src/a.js', content: 'module.exports = 42;\n' }], reply: 'Added src/a.js.' },
      { seat: 'Bob', reply: 'Looks right.\nVERDICT: PASS' },
    ]);
    const { room, item, worktree } = setup('a');
    const res = await run(room, item, worktree, { owns: null });
    assert.equal(res.status, 'passed'); assert.equal(res.rounds, 1);
    assert.equal(item.status, 'passed');
    assert.equal(item.review.hash, item.proposal.hash, 'the review is bound to the frozen hash');
    assert.equal(item.review.verdict, 'pass');
    assert.deepEqual(item.proposal.files, ['src/a.js']);
    const [w, b] = fake.calls();
    assert.equal(w.seat, 'Wri');
    assert.ok(samePath(w.cwd, worktree.dir), `builder cwd ${w.cwd} is the worktree`);
    assert.ok(w.tools.includes('Edit') && w.tools.includes('Write') && !w.tools.includes('Bash'), 'write turns get file tools and no shell');
    assert.equal(w.permissionMode, 'acceptEdits');
    assert.ok(b.stdin.includes(`--- patch ${item.proposal.hash.slice(0, 12)} (1 file(s)) ---`), 'the reviewer sees the patch hash');
    assert.ok(b.stdin.includes('module.exports = 42;'), 'the reviewer sees the file content');
    assert.ok(samePath(b.cwd, worktree.dir), 'the reviewer reads the same worktree');
    assert.equal(fs.existsSync(path.join(project, 'src', 'a.js')), false, 'the main checkout does not get the file');
    assert.equal(wt.mainState(project).clean, true);
    assert.equal(room.messages.find((m) => m.seatId === 'wri').label, 'implementation · low');
  });

  testWithFake(fake, 'owner areas: a change outside them is sent back without a review, and the next round can finish inside them', async (t) => {
    if (guard(t)) return;
    fake.scenario([
      { seat: 'Wri', nth: 1, writeFiles: [{ path: 'docs/x.md', content: 'notes\n' }], reply: 'Wrote notes.' },
      { seat: 'Wri', nth: 2, deleteFiles: ['docs/x.md'], writeFiles: [{ path: 'src/b.js', content: 'module.exports = 2;\n' }], reply: 'Moved the change into src.' },
      { seat: 'Bob', reply: 'VERDICT: PASS' },
    ]);
    const { room, item, worktree } = setup('b');
    const res = await run(room, item, worktree, { owns: ['src'] });
    assert.equal(res.status, 'passed'); assert.equal(res.rounds, 2);
    assert.deepEqual(seatsOf(), ['Wri', 'Wri', 'Bob'], 'no review turn in round 1');
    assert.ok(sysTexts(room).includes('Wri changed files outside its areas in round 1; sent back without a review.'));
    const w2 = fake.calls()[1];
    assert.ok(w2.stdin.includes('BLOCKER: these changes are outside your owner areas or not allowed (symlinks, submodules): docs/x.md'));
    assert.ok(w2.stdin.includes('change only files under: src'));
    assert.deepEqual(item.proposal.files, ['src/b.js']);
    assert.equal(item.proposal.round, 2);
  });

  testWithFake(fake, 'no changes: the builder is asked to change the files, no review runs, and the round limit ends the item as needs-you', async (t) => {
    if (guard(t)) return;
    fake.scenario([{ seat: 'Wri', reply: 'I believe it is finished.' }, { seat: 'Bob', reply: 'VERDICT: PASS' }]);
    const { room, item, worktree } = setup('c');
    const res = await run(room, item, worktree, { maxRounds: 2 });
    assert.equal(res.status, 'failed'); assert.equal(res.rounds, 2);
    assert.deepEqual(seatsOf(), ['Wri', 'Wri'], 'zero reviewer calls');
    assert.ok(fake.calls()[1].stdin.includes('No changes were found in your worktree.'));
    assert.ok(sysTexts(room).includes('Wri made no changes in round 1.'));
    assert.ok(sysTexts(room).includes('Wri made no changes in round 2.'));
    assert.equal(item.status, 'needs-you');
  });

  testWithFake(fake, 'a change outside the worktree quarantines the item after the builder turn, and no review runs', async (t) => {
    if (guard(t)) return;
    stubResult = { ok: false, changed: ['the main checkout'] };
    fake.scenario([{ seat: 'Wri', writeFiles: [{ path: 'src/c.js' }], reply: 'Done.' }, { seat: 'Bob', reply: 'VERDICT: PASS' }]);
    const { room, item, worktree } = setup('d');
    const res = await run(room, item, worktree, { maxRounds: 2 });
    assert.equal(res.status, 'quarantined');
    assert.equal(item.status, 'quarantined');
    assert.equal(item.error, 'changes outside the worktree: the main checkout');
    assert.deepEqual(seatsOf(), ['Wri']);
    assert.ok(sysTexts(room).includes('⛔ Wri changed files outside its worktree (the main checkout). The item is quarantined and file edits are disabled until the write check passes again.'));
  });

  testWithFake(fake, 'round 2 sends the reviewer only the delta and the unresolved findings, so it is smaller than round 1', async (t) => {
    if (guard(t)) return;
    const big = 'module.exports = "' + 'x'.repeat(3000) + '";\n';
    fake.scenario([
      { seat: 'Wri', nth: 1, writeFiles: [{ path: 'src/big.js', content: big }], reply: 'Added big.js.' },
      { seat: 'Bob', nth: 1, reply: 'BLOCKER: add a small helper.\nVERDICT: FAIL' },
      { seat: 'Wri', nth: 2, writeFiles: [{ path: 'src/small.js', content: 'module.exports = 1;\n' }], reply: 'Added small.js.' },
      { seat: 'Bob', nth: 2, reply: 'VERDICT: PASS' },
    ]);
    const { room, item, worktree } = setup('delta');
    const res = await run(room, item, worktree, { maxRounds: 2, stable: { rules: 'SHARED RULES', plan: 'Plan goal: g', brief: '' } });
    assert.equal(res.status, 'passed'); assert.equal(res.rounds, 2);
    const bob = fake.calls().filter((c) => c.seat === 'Bob');
    assert.equal(bob.length, 2);
    assert.ok(bob[0].stdin.includes('x'.repeat(3000)), 'round 1 carries the whole patch');
    assert.ok(!bob[1].stdin.includes('x'.repeat(3000)), 'round 2 does not resend the earlier patch');
    assert.ok(bob[1].stdin.includes('src/small.js'), 'round 2 carries the new change');
    assert.ok(bob[1].stdin.includes('unresolved findings from your round 1 review') && bob[1].stdin.includes('BLOCKER: add a small helper.'));
    assert.ok(bob[1].stdin.length < bob[0].stdin.length, 'round 2 prompt is smaller');
    const wri = fake.calls().filter((c) => c.seat === 'Wri');
    assert.ok(wri[0].stdin.includes('SHARED RULES') && wri[0].stdin.includes('Plan goal: g'), 'the stable part leads the builder prompt');
    assert.ok(wri[0].stdin.indexOf('SHARED RULES') < wri[0].stdin.indexOf('Plan goal: g') && wri[0].stdin.indexOf('Plan goal: g') < wri[0].stdin.indexOf('=== This item ==='));
  });

  testWithFake(fake, 'patch mode: the reviewer gets the diff once (as the patch), not again inside the builder summary', async (t) => {
    if (guard(t)) return;
    const diff = 'diff --git a/src/p.js b/src/p.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/p.js\n@@ -0,0 +1 @@\n+module.exports = "UNIQUE_PATCH_LINE";\n';
    fake.scenario([
      { seat: 'Wri', reply: 'Added p.js.\n\n```diff\n' + diff + '```' },
      { seat: 'Bob', reply: 'VERDICT: PASS' },
    ]);
    const { room, item, worktree } = setup('patchonce');
    const res = await run(room, item, worktree, { patchMode: true, stable: { rules: '', plan: 'Plan goal: g', brief: 'SCOUT BRIEF' } });
    assert.equal(res.status, 'passed');
    const [w, b] = fake.calls();
    assert.ok(w.stdin.includes('SCOUT BRIEF'), 'the scout brief reaches the builder');
    assert.ok(b.stdin.includes('SCOUT BRIEF'), 'and the reviewer');
    assert.equal(b.stdin.split('UNIQUE_PATCH_LINE').length - 1, 1, 'the diff appears exactly once in the review prompt');
    assert.ok(b.stdin.includes('Added p.js.'));
  });

  testWithFake(fake, 'a worktree that changes after the freeze voids that review; the next round is reviewed again on its own hash', async (t) => {
    if (guard(t)) return;
    fake.scenario([
      { seat: 'Wri', nth: 1, writeFiles: [{ path: 'src/d.js' }], reply: 'First try.' },
      { seat: 'Bob', nth: 1, writeFiles: [{ path: 'review-note.txt', content: 'stray\n' }], reply: 'VERDICT: PASS' },
      { seat: 'Wri', nth: 2, reply: 'Nothing else to change.' },
      { seat: 'Bob', nth: 2, reply: 'VERDICT: PASS' },
    ]);
    const { room, item, worktree } = setup('e');
    const res = await run(room, item, worktree, { maxRounds: 2 });
    assert.equal(res.status, 'passed'); assert.equal(res.rounds, 2);
    const reviews = room.messages.filter((m) => m.seatId === 'bob');
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0].verdict, undefined, 'the voided review carries no verdict');
    assert.equal(reviews[1].verdict, 'pass');
    assert.equal(item.review.msgId, reviews[1].id);
    assert.ok(sysTexts(room).includes('The worktree changed after the proposal was frozen, so this review does not count.'));
    const wri2 = fake.calls()[2];
    assert.ok(wri2.stdin.includes('Review feedback from Bob (round 1):\nYour files changed after your change was frozen for review.'));
  });

  test('write mode without capability and patch is refused before any turn runs', async (t) => {
    if (guard(t)) return;
    const bare = createChain({ store, seats, rooms, broadcast: () => {} });
    const { room, item, worktree } = setup('f');
    await assert.rejects(() => bare.runItemChain(room, item, { task: 'x', builderId: 'wri', reviewerId: 'bob', worktree }), /write mode needs capability and patch/);
    assert.deepEqual(fake.calls(), []);
  });
});

// Acceptance checks: they run on the frozen change, before any reviewer call.
describe('runItemChain acceptance checks', { concurrency: false }, () => {
  const skipWhy = () => fake.skipReason || (!hasGit && 'git not available');
  const WSEATS = [
    { id: 'wri', name: 'Wri', role: 'Implementer', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', perm: 'write', target: '', budget: 0, color: '#ffcc4d', thread: null, used: 0, cached: 0, cost: 0 },
    { id: 'bob', name: 'Bob', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'medium', perm: 'read', target: '', budget: 0, color: '#7aa2ff', thread: null, used: 0, cached: 0, cost: 0 },
  ];
  let root, project, head, store, seats, rooms, runner, chain;
  const stub = { guardTurn: async () => ({ finish: async () => ({ ok: true, changed: [] }) }) };
  const node = (js) => `node -e "${js}"`;
  const NEED_OK = node("process.exit(require('fs').existsSync('src/ok.js')?0:1)");

  before(() => {
    if (skipWhy()) return;
    root = tmpDir('ob-chain-ck-'); project = path.join(root, 'project');
    head = initRepo(project, { 'README.md': 'hello\n' });
    store = createStore(project); store.ensure();
    store.writeJson('seats.json', WSEATS);
    const broadcast = () => {};
    const limits = createLimits({ store, broadcast });
    seats = createSeats({ store, broadcast });
    runner = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast, detectVersions: false, retryDelaysMs: [20, 40], writeGate: () => true });
    rooms = createRooms({ store, seats, runner, broadcast });
    chain = createChain({ store, seats, rooms, broadcast, capability: stub, patch });
  });
  after(async () => {
    if (!root) return;
    for (const s of seats.all()) if (seats.rtOf(s.id).child) runner.stopSeat(s.id);
    try { await waitFor(() => seats.all().every((s) => !seats.rtOf(s.id).child), { timeout: 5000 }); } catch {}
    rmrf(root);
  });
  beforeEach(() => { if (!skipWhy()) fake.resetCalls(); });

  function setup(itemId, checks) {
    const room = rooms.newRoom('build', `Build ${itemId}`, {});
    const item = { id: itemId, checks };
    const made = wt.createWorktree(project, room.id, itemId, head);
    const startTree = patch.prepareWorktree({ store, worktreeDir: made.dir });
    return { room, item, worktree: { dir: made.dir, startTree } };
  }
  const run = (room, item, worktree, extra = {}) => chain.runItemChain(room, item, { task: 'Build the item', builderId: 'wri', reviewerId: 'bob', maxRounds: 2, worktree, ...extra });
  const seatsOf = () => fake.calls().map((c) => c.seat);

  testWithFake(fake, 'a failing check sends its output back to the builder with zero reviewer calls; the fixed round is reviewed with the results', async (t) => {
    if (skipWhy()) return t.skip(skipWhy());
    fake.scenario([
      { seat: 'Wri', nth: 1, writeFiles: [{ path: 'src/a.js', content: '1\n' }], reply: 'First try.' },
      { seat: 'Wri', nth: 2, writeFiles: [{ path: 'src/ok.js', content: '2\n' }], reply: 'Fixed.' },
      { seat: 'Bob', reply: 'VERDICT: PASS' },
    ]);
    const { room, item, worktree } = setup('c1', [{ name: 'needs ok.js', cmd: NEED_OK }, { name: 'lint', cmd: node("console.log('lint clean')") }]);
    const res = await run(room, item, worktree);
    assert.equal(res.status, 'passed'); assert.equal(res.rounds, 2);
    assert.deepEqual(seatsOf(), ['Wri', 'Wri', 'Bob'], 'no reviewer call in the failing round');
    const w2 = fake.calls()[1];
    assert.ok(w2.stdin.includes('Acceptance checks failed (round 1)') && w2.stdin.includes('- needs ok.js: FAIL (exit 1'));
    assert.ok(w2.stdin.includes('Fix the failing checks'));
    const b = fake.calls()[2];
    assert.ok(b.stdin.includes('--- acceptance checks (patch ') && b.stdin.includes('- needs ok.js: PASS') && b.stdin.includes('- lint: PASS'));
    assert.equal(item.checkResults.hash, item.proposal.hash, 'results are bound to the patch hash');
    assert.equal(item.review.hash, item.proposal.hash);
    assert.ok(item.checkResults.results.every((r) => r.ok));
  });

  testWithFake(fake, 'a check that times out fails the round without a review', async (t) => {
    if (skipWhy()) return t.skip(skipWhy());
    fake.scenario([{ seat: 'Wri', writeFiles: [{ path: 'src/a.js' }], reply: 'Done.' }, { seat: 'Bob', reply: 'VERDICT: PASS' }]);
    const { room, item, worktree } = setup('c2', [{ name: 'hang', cmd: node('setInterval(()=>{},1000)') }]);
    const res = await run(room, item, worktree, { maxRounds: 1, checkTimeoutMs: 500 });
    assert.equal(res.status, 'failed');
    assert.deepEqual(seatsOf(), ['Wri']);
    assert.equal(item.checkResults.results[0].code, null);
    assert.match(item.checkResults.results[0].tail, /timed out/);
  });

  testWithFake(fake, 'a check that changes the tree invalidates its results and nothing is reviewed', async (t) => {
    if (skipWhy()) return t.skip(skipWhy());
    fake.scenario([{ seat: 'Wri', writeFiles: [{ path: 'src/a.js' }], reply: 'Done.' }, { seat: 'Bob', reply: 'VERDICT: PASS' }]);
    const { room, item, worktree } = setup('c3', [{ name: 'dirty', cmd: node("require('fs').writeFileSync('stray.txt','x')") }]);
    const res = await run(room, item, worktree, { maxRounds: 1 });
    assert.equal(res.status, 'failed');
    assert.deepEqual(seatsOf(), ['Wri']);
    assert.equal(item.checkResults, null, 'results from a changed tree are discarded');
    assert.ok(room.messages.some((m) => m.seatId === 'system' && /checks changed the worktree/.test(m.text)));
  });
  testWithFake(fake, 'a check that writes outside the worktree quarantines the item and nothing is reviewed', async (t) => {
    if (skipWhy()) return t.skip(skipWhy());
    fake.scenario([{ seat: 'Wri', writeFiles: [{ path: 'src/a.js' }], reply: 'Done.' }, { seat: 'Bob', reply: 'VERDICT: PASS' }]);
    const { room, item, worktree } = setup('c4', [{ name: 'escape', cmd: NEED_OK }]);
    let n = 0;
    const guarded = createChain({ store, seats, rooms, broadcast: () => {}, patch,
      capability: { guardTurn: async () => ({ finish: async () => (++n >= 2 ? { ok: false, changed: ['the main checkout'] } : { ok: true, changed: [] }) }) } });
    const res = await guarded.runItemChain(room, item, { task: 'Build the item', builderId: 'wri', reviewerId: 'bob', maxRounds: 2, worktree });
    assert.equal(res.status, 'quarantined'); assert.equal(item.status, 'quarantined');
    assert.match(item.error, /acceptance checks/);
    assert.deepEqual(seatsOf(), ['Wri']);
    assert.equal(item.checkResults, null);
  });

  testWithFake(fake, 'a stale checks header is not reused after a later round with other feedback', async (t) => {
    if (skipWhy()) return t.skip(skipWhy());
    fake.scenario([
      { seat: 'Wri', nth: 1, writeFiles: [{ path: 'src/b/x.js', content: '1\n' }], reply: 'First.' },
      { seat: 'Wri', nth: 2, writeFiles: [{ path: 'docs/stray.md', content: '2\n' }], reply: 'Out of area.' },
      { seat: 'Wri', nth: 3, writeFiles: [{ path: 'src/b/y.js', content: '3\n' }], reply: 'Again.' },
      { seat: 'Bob', reply: 'VERDICT: PASS' },
    ]);
    const { room, item, worktree } = setup('c5', [{ name: 'needs ok.js', cmd: NEED_OK }]);
    const res = await run(room, item, worktree, { maxRounds: 3, owns: ['src/b'] });
    assert.equal(res.status, 'failed'); assert.deepEqual(seatsOf(), ['Wri', 'Wri', 'Wri'], 'the reviewer is never called');
    const w2 = fake.calls()[1].stdin, w3 = fake.calls()[2].stdin;
    assert.ok(w2.includes('Acceptance checks failed (round 1)'));
    assert.ok(!w3.includes('Acceptance checks failed'), w3);
    assert.ok(w3.includes('outside your owner areas'), w3);
    assert.ok(!w3.includes('Fix the failing checks'));
  });
  testWithFake(fake, 'a passing run records that the checks ran: commands, minimal env, not sandboxed', async (t) => {
    if (skipWhy()) return t.skip(skipWhy());
    fake.scenario([{ seat: 'Wri', writeFiles: [{ path: 'src/a.js' }], reply: 'Done.' }, { seat: 'Bob', reply: 'VERDICT: PASS' }]);
    const cmd = node("console.log('fine')");
    const { room, item, worktree } = setup('c6', [{ name: 'lint', cmd }]);
    const res = await run(room, item, worktree, { maxRounds: 1 });
    assert.equal(res.status, 'passed');
    assert.deepEqual(item.checkResults.ran.commands, [cmd]);
    assert.equal(item.checkResults.ran.count, 1);
    assert.equal(item.checkResults.ran.env, 'minimal');
    assert.equal(item.checkResults.ran.sandboxed, false);
    assert.equal(typeof item.checkResults.ran.startedAt, 'string');
  });

  testWithFake(fake, 'checks do not run on a worktree that no longer equals the frozen patch', async (t) => {
    if (skipWhy()) return t.skip(skipWhy());
    fake.scenario([{ seat: 'Wri', writeFiles: [{ path: 'src/a.js' }], reply: 'Done.' }, { seat: 'Bob', reply: 'VERDICT: PASS' }]);
    const { room, item, worktree } = setup('c7', [{ name: 'marker', cmd: node("require('fs').writeFileSync('ran.txt','x')") }]);
    let calls = 0;
    // The first hash after the freeze (taken just before the checks) differs: the tree moved after the freeze.
    const moved = { ...patch, hashWorktree: (a) => (++calls === 1 ? 'f'.repeat(64) : patch.hashWorktree(a)) };
    const c2 = createChain({ store, seats, rooms, broadcast: () => {}, patch: moved, capability: stub });
    const res = await c2.runItemChain(room, item, { task: 'Build the item', builderId: 'wri', reviewerId: 'bob', maxRounds: 1, worktree });
    assert.equal(res.status, 'failed');
    assert.deepEqual(seatsOf(), ['Wri'], 'no review');
    assert.equal(fs.existsSync(path.join(worktree.dir, 'ran.txt')), false, 'the check command never ran');
    assert.equal(item.checkResults, null);
    assert.ok(room.messages.some((m) => m.seatId === 'system' && /acceptance checks were not run/.test(m.text)));
  });

  testWithFake(fake, 'stopping the room kills a running check and the item stops', async (t) => {
    if (skipWhy()) return t.skip(skipWhy());
    fake.scenario([{ seat: 'Wri', writeFiles: [{ path: 'src/a.js' }], reply: 'Done.' }, { seat: 'Bob', reply: 'VERDICT: PASS' }]);
    const { room, item, worktree } = setup('c8', [{ name: 'hang', cmd: node('setInterval(()=>{},1000)') }]);
    const t0 = Date.now();
    const timer = setInterval(() => { if (item.status === 'checking') { room.stopped = true; clearInterval(timer); } }, 50);
    let res;
    try { res = await run(room, item, worktree, { maxRounds: 1, checkTimeoutMs: 60000 }); } finally { clearInterval(timer); }
    assert.equal(res.status, 'stopped');
    assert.deepEqual(seatsOf(), ['Wri']);
    assert.ok(Date.now() - t0 < 20000, 'did not wait for the check timeout');
  });

});
