// Build workflow end to end on a temp git project with fake CLIs that really write files (in-process app):
// difficulty tiers and role fallback, dependency patches in item worktrees, write vs propose mode, the approval and
// checkout guards, pause / stop / restart / resume, plan re-approval, apply and discard, and the runtime guard's
// quarantine. No real CLI is started; the write check runs against the fake.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, waitFor, startApp, teardown, hasGit, initRepo, gitIn, samePath, exitGuard } = require('./helpers');
exitGuard();
const { setupFakeCli } = require('./fake-cli');
const { createBuild } = require('../src/workflows/build');
const { validatePlan } = require('../src/workflows/plan-model');
const worktree = require('../src/worktree');
const patch = require('../src/patch');

const GOAL = 'Build the a and b modules';
let dir, project, fake, ctx, B;

// Writes inside its worktree and reports both outside attempts of the write check as refused (plan 5.8: a pass needs
// proof of an attempt). The paths are relative to the check worktree <scratch>/repo/.orchestra/worktrees/check/item.
const WELL_BEHAVED = {
  match: 'Board write check', writeFiles: [{ path: 'WRITE_CHECK_INSIDE.txt' }], reply: 'STEP 1: done\nSTEP 2: refused\nSTEP 3: refused',
  toolUses: [{ name: 'Write', file_path: '../../../../WRITE_CHECK_OUTSIDE.txt', error: 'refused' }, { name: 'Write', file_path: '../../../../../outside/WRITE_CHECK_SIBLING.txt', error: 'refused' }],
};
const REVIEW_PASS = { seat: 'Rev', match: 'VERDICT: PASS', reply: 'Looks right.\nVERDICT: PASS' };
const REV_PROPOSES = { seat: 'Rev', reply: 'Proposal: create the module with one export.' };
const writeA = (extra = {}) => ({ seat: 'Eva', match: 'Build item "a"', writeFiles: [{ path: 'src/a/index.js', content: 'module.exports = "a";\n' }], reply: 'Added src/a/index.js.', ...extra });
const writeB = (extra = {}) => ({ seat: 'Mgr', match: 'Build item "b"', writeFiles: [{ path: 'src/b/index.js', content: 'module.exports = require("../a") + "b";\n' }], reply: 'Added src/b/index.js.', ...extra });
const writeC = { seat: 'Eva', match: 'Build item "c"', writeFiles: [{ path: 'docs/c.md', content: '# c\n' }], reply: 'Added docs/c.md.' };
const scenario = (...rules) => fake.scenario([WELL_BEHAVED, REVIEW_PASS, REV_PROPOSES, ...rules]);

const ITEM_A = { id: 'a', title: 'Module a', spec: 'Create src/a/index.js exporting "a".', owns: ['src/a'], dependsOn: [], difficulty: 'easy', seatId: null };
const ITEM_B = { id: 'b', title: 'Module b', spec: 'Create src/b/index.js using module a.', owns: ['src/b'], dependsOn: ['a'], difficulty: 'hard', seatId: null };
const ITEM_C = { id: 'c', title: 'Docs c', spec: 'Write docs/c.md.', owns: ['docs'], dependsOn: [], difficulty: 'easy', seatId: null };
const ROLES = { manager: 'mgr', easy: 'eva', reviewer: 'rev' };

const skipWhy = () => (!hasGit && 'git not available') || fake.skipReason || false;
// Every test needs git and the fake CLI; the fake is only known after before() ran, so it is checked inside.
const t = (name, fn) => test(name, { timeout: 90000, skip: !hasGit && 'git not available' }, async (tc) => {
  const why = skipWhy();
  if (why) { if (process.env.GITHUB_ACTIONS && fake.skipReason) throw new Error(`fake CLI unavailable on CI: ${why}`); tc.skip(why); return; }
  fake.resetCalls();
  await fn(tc);
});

function makeBuild(app) {
  return createBuild({ store: app.store, seats: app.seats, rooms: app.rooms, chain: app.chain, capability: app.capability, patch, worktree, plan: app.planApi, broadcast: app.broadcast });
}

// A plan room with the server's shape, its plan set as revision 1 and approved.
function approvedPlan(items = [ITEM_A, ITEM_B], { approve = true, by = 'manager' } = {}) {
  const pr = ctx.app.rooms.newRoom('plan', 'Plan', {
    goal: GOAL, topic: GOAL, seatIds: [], rounds: 1, scoutId: null, synthId: null, managerId: 'mgr', withContext: false, overrides: {},
    phase: 'plan', plan: null, planRevision: 0, planHash: null, revisions: [], approval: null, buildIds: [],
  });
  ctx.app.planApi.setRevision(pr, validatePlan({ goal: GOAL, items }), by);
  pr.status = 'awaiting-approval';
  if (approve) ctx.app.planApi.approvePlan(pr, { revision: pr.planRevision, hash: pr.planHash });
  return pr;
}
const start = (pr, opts = {}) => B.startBuild(pr, { revision: pr.planRevision, hash: pr.planHash, roles: ROLES, maxRounds: 2, ...opts });
const idle = async (room) => { assert.equal(await B.whenIdle(room, 60000), true, 'the build loop ended'); return room; };
const rejects409 = async (fn, code) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected an error');
  assert.equal(err.status, 409, err.message);
  assert.equal(err.code, code);
  return err;
};
const wtAbs = (item) => path.join(project, item.worktree.rel);
const callsFor = (seat, id) => fake.calls().filter((c) => c.seat === seat && c.stdin.includes(`Build item "${id}"`));
const sysTexts = (room) => room.messages.filter((m) => m.seatId === 'system').map((m) => m.text);
async function ensureWrites() {
  const st = await ctx.app.capability.status({ detect: true });
  if (st.agents.claude.available) return;
  scenario();
  const out = await ctx.app.capability.verify('eva');
  assert.equal(out.result, 'pass', out.detail);
  assert.equal((await ctx.app.capability.status()).agents.claude.available, true);
}
const resetCheckout = () => gitIn(project, ['reset', '-q', '--hard']);

before(async () => {
  dir = tmpDir('ob-build-');
  fake = setupFakeCli(dir);
  if (skipWhy()) return;
  project = path.join(dir, 'project');
  initRepo(project, { 'README.md': 'hello\n', 'src/keep.js': 'module.exports = 0;\n', 'docs/readme.md': '# docs\n' });
  ctx = await startApp({ projectDir: project });
  for (const s of [
    { name: 'Mgr', role: 'Manager', agent: 'claude', effort: 'low', perm: 'write' },
    { name: 'Eva', role: 'Builder', agent: 'claude', effort: 'low', perm: 'write' },
    { name: 'Rev', role: 'Reviewer', agent: 'codex', effort: 'low', perm: 'read' },
  ]) {
    const res = await ctx.post('/api/seats', s);
    assert.equal(res.status, 200);
  }
  B = makeBuild(ctx.app);
  await ensureWrites();
}, { timeout: 180000 });
after(() => teardown(ctx, dir), { timeout: 90000 });

let roomA = null; // the write-mode build of test (a), applied in test (f)

t('(a) write mode: tiers with fallback, worktrees per item, dependency patches, both pass, checkout untouched', async () => {
  const events = await ctx.sse();
  scenario(writeA(), writeB({ gate: 'a-b' }));
  const pr = approvedPlan();
  const room = await start(pr);
  roomA = room;
  assert.equal(room.kind, 'build');
  assert.equal(room.mode, 'write'); assert.equal(room.modeReason, null);
  assert.equal(room.items.a.builderId, 'eva');
  assert.equal(room.items.b.builderId, 'mgr', 'hard falls back through medium to the manager');
  assert.equal(room.items.a.reviewerId, 'rev'); assert.equal(room.items.b.reviewerId, 'rev');
  assert.deepEqual(room.order, ['a', 'b']);
  assert.equal(room.baseCommit, gitIn(project, ['rev-parse', 'HEAD']));
  assert.deepEqual(pr.buildIds, [room.id]);
  assert.ok(sysTexts(room).some((s) => s.startsWith('Roles: manager → Mgr, hard → Mgr, medium → Eva, easy → Eva, reviewer → Rev.')));

  // b's turn waits on its gate: its worktree already holds a's file (a's frozen patch was applied to it).
  const [mgrCall] = await fake.waitCalls((c) => c.seat === 'Mgr', 1, 30000);
  assert.ok(fs.existsSync(path.join(mgrCall.cwd, 'src', 'a', 'index.js')), "b's worktree contains a's file before b's turn");
  assert.ok(samePath(mgrCall.cwd, wtAbs(room.items.b)));
  fake.openGate('a-b');
  await idle(room);

  assert.equal(room.status, 'done');
  for (const id of ['a', 'b']) {
    const it = room.items[id];
    assert.equal(it.status, 'passed');
    assert.equal(it.review.hash, it.proposal.hash);
    assert.ok(it.worktree.rel.startsWith(`.orchestra/worktrees/${room.id}/`), it.worktree.rel);
    assert.ok(worktree.isBoardWorktree(project, wtAbs(it)));
  }
  assert.deepEqual(room.items.a.proposal.files, ['src/a/index.js']);
  assert.deepEqual(room.items.b.proposal.files, ['src/b/index.js'], "b's proposal does not repeat a's change");
  const [evaCall] = callsFor('Eva', 'a');
  assert.ok(samePath(evaCall.cwd, wtAbs(room.items.a)));
  assert.equal(evaCall.permissionMode, 'acceptEdits');
  assert.ok(mgrCall.stdin.includes('Already done and present in your files: a'));
  assert.ok(mgrCall.stdin.includes('Owner areas (the only paths you may change): src/b'));
  assert.equal(worktree.mainState(project).clean, true, 'the main checkout is still clean');
  assert.equal(fs.existsSync(path.join(project, 'src', 'a')), false);
  assert.ok(sysTexts(room).includes('All items passed review. Apply them one at a time from the build view.'));
  await events.waitFor((e) => e.t === 'build' && e.roomId === room.id && e.itemId === 'b' && e.item.status === 'passed');
  events.close();
  assert.match(ctx.app.store.read('LOG.md'), /Build "Build the a and b modules" done: 2\/2 passed, 0 applied\./);
});

t('(f) apply: dependency order, stale hash, staged in the main checkout, worktree removed', async () => {
  assert.ok(roomA && roomA.status === 'done', 'needs the build of test (a)');
  const room = roomA;
  const { a, b } = room.items;
  await rejects409(() => B.applyItem(room, 'b', b.proposal.hash), 'dependency-not-applied');
  await rejects409(() => B.applyItem(room, 'a', 'f'.repeat(64)), 'stale-proposal');
  const view = B.proposalOf(room, 'a');
  assert.equal(view.applicable.ok, true, JSON.stringify(view.applicable));
  assert.ok(view.patch.includes('module.exports = "a";'));
  assert.equal(view.truncated, false);

  const aDir = wtAbs(a);
  const res = await B.applyItem(room, 'a', a.proposal.hash);
  assert.equal(res.ok, true); assert.match(res.tree, /^[0-9a-f]{40,64}$/);
  assert.equal(a.status, 'applied');
  assert.equal(a.worktree, null);
  assert.equal(fs.existsSync(aDir), false, "a's worktree is removed after apply");
  assert.deepEqual(room.applied, ['a']);
  assert.equal(gitIn(project, ['diff', '--cached', '--name-only']), 'src/a/index.js');

  const res2 = await B.applyItem(room, 'b', b.proposal.hash);
  assert.equal(res2.ok, true);
  assert.deepEqual(room.applied, ['a', 'b']);
  assert.deepEqual(gitIn(project, ['diff', '--cached', '--name-only']).split('\n').sort(), ['src/a/index.js', 'src/b/index.js']);
  assert.equal(gitIn(project, ['rev-parse', 'HEAD']), room.baseCommit, 'nothing was committed');
  assert.ok(sysTexts(room).includes('Applied b to the main checkout (staged, not committed).'));
  await rejects409(() => B.discardItem(room, 'a'), 'applied');
  resetCheckout();
  assert.equal(worktree.mainState(project).clean, true);
});

t('(f2) the ledger holds build, review and apply records for the build, and no prompt text', async () => {
  assert.ok(roomA && roomA.status === 'done', 'needs the build of test (a)');
  const file = path.join(project, '.orchestra', 'records', 'ledger.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  const recs = raw.split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.room === roomA.id);
  for (const item of ['a', 'b']) {
    const roles = recs.filter((r) => r.item === item).map((r) => r.role);
    for (const role of ['build', 'review', 'apply']) assert.ok(roles.includes(role), `${item} has a ${role} record`);
  }
  const build = recs.find((r) => r.item === 'a' && r.role === 'build');
  assert.equal(build.outcome, 'pass'); assert.equal(build.taskType, 'easy'); assert.ok(Number.isFinite(build.ms));
  assert.equal(recs.find((r) => r.item === 'a' && r.role === 'apply').outcome, 'applied');
  const allowed = new Set(['room', 'item', 'attempt', 'role', 'model', 'effort', 'cli', 'taskType', 'outcome', 'tokens', 'cachedTokens', 'ms', 'ts']);
  for (const r of recs) for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unexpected ledger field ${k}`);
  assert.ok(!raw.includes('Create src/a/index.js') && !raw.includes('VERDICT') && !raw.includes('Looks right'), 'no prompt or reply text');
});

t('(b) startBuild refuses an unapproved plan, a stale hash and a dirty checkout', async () => {
  scenario(writeA(), writeB());
  const draft = approvedPlan([ITEM_A, ITEM_B], { approve: false });
  await rejects409(() => start(draft), 'not-approved');
  const pr = approvedPlan();
  await rejects409(() => start(pr, { hash: 'f'.repeat(64) }), 'not-approved');
  await rejects409(() => start(pr, { revision: pr.planRevision + 1 }), 'not-approved');
  fs.writeFileSync(path.join(project, 'src', 'dirty.txt'), 'local edit\n');
  try {
    await rejects409(() => start(pr), 'checkout-dirty');
    await rejects409(() => start(pr, { mode: 'write' }), 'checkout-dirty');
  } finally {
    fs.rmSync(path.join(project, 'src', 'dirty.txt'), { force: true });
  }
  assert.deepEqual(pr.buildIds, [], 'no build room was created');
  assert.deepEqual(fake.calls(), [], 'no agent turn ran');
});

t('(c) editing the plan mid-build: needs-approval after the current item, then resume adopts the new revision', async () => {
  scenario(writeA({ gate: 'c1' }), writeB());
  const pr = approvedPlan();
  const room = await start(pr);
  await fake.waitCalls((c) => c.seat === 'Eva', 1, 30000);
  const edited = { goal: GOAL, items: [ITEM_A, { ...ITEM_B, spec: 'Create src/b/index.js using module a, with a comment.' }] };
  ctx.app.planApi.editPlan(pr, { revision: pr.planRevision, hash: pr.planHash, plan: edited });
  fake.openGate('c1');
  await idle(room);
  assert.equal(room.status, 'needs-approval');
  assert.equal(room.items.a.status, 'passed');
  assert.equal(room.items.b.status, 'pending');
  assert.ok(sysTexts(room).includes('The plan changed or lost its approval. Approve the current revision, then resume.'));
  assert.equal(callsFor('Mgr', 'b').length, 0, 'b did not start');

  await rejects409(() => B.resumeBuild(room), 'not-approved');
  await rejects409(() => B.resumeBuild(room, { revision: pr.planRevision, hash: pr.planHash }), 'not-approved');
  ctx.app.planApi.approvePlan(pr, { revision: pr.planRevision, hash: pr.planHash });
  const aHash = room.items.a.proposal.hash;
  await B.resumeBuild(room, { revision: pr.planRevision, hash: pr.planHash });
  await idle(room);
  assert.equal(room.status, 'done');
  assert.equal(room.planRevision, 2); assert.equal(room.planHash, pr.planHash);
  assert.equal(room.items.a.status, 'passed');
  assert.equal(room.items.a.proposal.hash, aHash, 'the unchanged item kept its reviewed proposal');
  assert.equal(callsFor('Eva', 'a').length, 1, 'a was not built again');
  assert.equal(room.items.b.status, 'passed');
  assert.ok(callsFor('Mgr', 'b')[0].stdin.includes('with a comment'), 'b was built from the new spec');
  assert.ok(sysTexts(room).includes('Adopted plan revision 2.'));
});

t('acceptance checks from the plan run in the item worktree: a failing check means zero reviewer calls, and a stale "checking" item resets on resume', async () => {
  scenario(writeA());
  const item = { ...ITEM_A, checks: [{ name: 'always red', cmd: 'node -e "process.exit(1)"' }] };
  const pr = approvedPlan([item], { by: 'user' });
  const room = await start(pr, { maxRounds: 1 });
  await idle(room);
  assert.deepEqual(room.items.a.checks, [{ name: 'always red', cmd: 'node -e "process.exit(1)"' }], 'newItem copies the plan checks');
  assert.equal(room.items.a.status, 'needs-you');
  assert.equal(room.items.a.checkResults.results[0].ok, false);
  assert.equal(fake.calls().filter((c) => c.seat === 'Rev' && c.stdin.includes('VERDICT')).length, 0, 'the reviewer was never called');
  room.items.a.status = 'checking'; room.status = 'stopped';
  scenario(writeA());
  await B.resumeBuild(room);
  assert.notEqual(room.items.a.status, 'checking', 'a persisted checking item is reset on resume');
  await idle(room);
});

t('checks stored on a manager revision are not run: only an owner-written revision with checks on runs them', async () => {
  scenario(writeA(), REVIEW_PASS);
  const item = { ...ITEM_A, checks: [{ name: 'always red', cmd: 'node -e "process.exit(1)"' }] };
  const pr = approvedPlan([item], { by: 'manager' });
  // Simulate a plan stored before the rule: live checks on a manager revision.
  pr.plan.items[0].checks = item.checks; pr.plan.checksEnabled = true;
  pr.revisions[pr.revisions.length - 1].plan = pr.plan;
  const room = await start(pr, { maxRounds: 1 });
  await idle(room);
  assert.equal(room.items.a.checkResults?.results?.length || 0, 0, 'no check ran');
  assert.notEqual(room.items.a.status, 'needs-you');
});

t('(d) pause during a builder turn: paused after that item, resume finishes the build', async () => {
  scenario(writeA({ gate: 'd1' }), writeB());
  const room = await start(approvedPlan());
  await fake.waitCalls((c) => c.seat === 'Eva', 1, 30000);
  assert.equal(B.isActive(room.id), true);
  assert.deepEqual(B.pauseBuild(room), { ok: true });
  fake.openGate('d1');
  await idle(room);
  assert.equal(room.status, 'paused');
  assert.equal(room.items.a.status, 'passed');
  assert.equal(room.items.b.status, 'pending');
  assert.equal(B.isActive(room.id), false);
  assert.throws(() => B.pauseBuild(room), (e) => e.status === 409 && e.code === 'not-running');
  await B.resumeBuild(room);
  await idle(room);
  assert.equal(room.status, 'done');
  assert.equal(callsFor('Eva', 'a').length, 1);
});

t('(h) discard removes only that item\'s worktree, and its dependent is blocked on resume', async () => {
  scenario(writeC, writeA({ gate: 'h1' }), writeB());
  const room = await start(approvedPlan([ITEM_C, ITEM_A, ITEM_B]));
  assert.deepEqual(room.order, ['c', 'a', 'b']);
  await fake.waitCalls((c) => c.seat === 'Eva' && c.stdin.includes('Build item "a"'), 1, 30000);
  B.pauseBuild(room);
  fake.openGate('h1');
  await idle(room);
  assert.equal(room.status, 'paused');
  const aDir = wtAbs(room.items.a), cDir = wtAbs(room.items.c);
  assert.deepEqual(B.discardItem(room, 'a'), { ok: true });
  assert.equal(room.items.a.status, 'discarded');
  assert.equal(fs.existsSync(aDir), false, "a's worktree is gone");
  assert.equal(fs.existsSync(cDir), true, "c's worktree is untouched");
  assert.ok(worktree.isBoardWorktree(project, cDir));
  assert.ok(fs.existsSync(path.join(ctx.app.store.orch, room.items.a.proposal.file)), 'the patch file is kept');
  await B.resumeBuild(room);
  await idle(room);
  assert.equal(room.items.b.status, 'blocked');
  assert.equal(room.items.c.status, 'passed');
  assert.equal(room.status, 'needs-you');
  assert.equal(callsFor('Mgr', 'b').length, 0);
});

const newFileDiff = (p, body) => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+${body}\n`;
const fenced = (d) => '```diff\n' + d + '```\n';

t('(i0) propose mode: a passed review without an exported diff is needs-artifact and blocks the dependent and the build', async () => {
  scenario();
  const room = await start(approvedPlan(), { roles: { manager: 'rev' } });
  await idle(room);
  assert.equal(room.items.a.status, 'needs-artifact');
  assert.ok(room.items.a.error);
  assert.equal(room.items.b.status, 'blocked');
  assert.equal(room.status, 'needs-you');
});

t('(i) propose mode when no builder may write: no worktrees, items pass, apply is refused', async () => {
  fake.scenario([WELL_BEHAVED, REVIEW_PASS,
    { seat: 'Rev', match: 'Build item "a"', reply: fenced(newFileDiff('src/a/index.js', 'module.exports = "a";')) },
    { seat: 'Rev', match: 'Build item "b"', reply: fenced(newFileDiff('src/b/index.js', 'module.exports = "b";')) },
    REV_PROPOSES]);
  const room = await start(approvedPlan(), { roles: { manager: 'rev' } });
  assert.equal(room.mode, 'propose');
  assert.equal(room.modeReason, 'Rev is read-only');
  assert.equal(room.baseCommit, null);
  assert.equal(room.items.a.builderId, 'rev'); assert.equal(room.items.a.selfReview, true);
  await idle(room);
  assert.equal(room.status, 'done');
  for (const id of ['a', 'b']) {
    assert.equal(room.items[id].status, 'passed');
    assert.equal(room.items[id].worktree, null);
  }
  assert.ok(sysTexts(room).includes('a: Rev reviews its own work (only one agent available).'));
  assert.equal(fs.existsSync(path.join(project, '.orchestra', 'worktrees', room.id)), false);
  await assert.rejects(() => B.applyItem(room, 'a', room.items.a.proposal.hash), (e) => e.status === 400);
  assert.equal(B.proposalOf(room, 'a').patch, null);
  await rejects409(() => start(approvedPlan(), { roles: { manager: 'rev' }, mode: 'write' }), 'writes-unavailable');
});

t('(e) restart mid-build: the room is stopped, recover marks it, resume rebuilds the in-flight item in a fresh worktree', async () => {
  scenario(writeA({ gate: 'e1' }), writeB());
  const pr = approvedPlan();
  const room = await start(pr);
  await fake.waitCalls((c) => c.seat === 'Eva', 1, 30000);
  ctx.app.stopWork(); // what the server's close() does first: no new turn, every room stops, children are killed
  await idle(room);
  assert.equal(room.status, 'stopped');
  assert.equal(room.items.a.status, 'pending');
  const oldDir = wtAbs(room.items.a);
  fs.writeFileSync(path.join(oldDir, 'src', 'stale.txt'), 'left behind\n');
  await ctx.stop();
  ctx = null;

  ctx = await startApp({ projectDir: project });
  B = makeBuild(ctx.app);
  const r2 = ctx.app.rooms.rooms.get(room.id);
  assert.equal(r2.status, 'stopped');
  assert.equal(r2.resumeNeeded, true, 'the server runs recover() on startup');
  B.recover(); // idempotent
  assert.equal(r2.resumeNeeded, true);
  assert.equal(B.isActive(r2.id), false, 'nothing runs before an explicit resume');
  scenario(writeA(), writeB());
  await B.resumeBuild(r2);
  assert.equal(r2.resumeNeeded, false);
  await idle(r2);
  assert.equal(r2.status, 'done');
  assert.equal(r2.items.a.status, 'passed');
  assert.deepEqual(r2.items.a.proposal.files, ['src/a/index.js'], 'the stale file of the interrupted run is gone');
  assert.ok(samePath(wtAbs(r2.items.a), oldDir), 'the worktree was recreated at the same place');
  assert.equal(fs.existsSync(path.join(oldDir, 'src', 'stale.txt')), false);
  assert.ok(worktree.isBoardWorktree(project, oldDir));
});

t('(k) apply is refused while another write build runs: no quarantine, no blamed CLI', async () => {
  await ensureWrites();
  scenario(writeA(), writeB());
  const first = await start(approvedPlan());
  await idle(first);
  assert.equal(first.status, 'done');
  assert.equal(worktree.mainState(project).clean, true, 'nothing applied yet');

  scenario(writeA({ gate: 'k2' }), writeB());
  const second = await start(approvedPlan());
  assert.equal(second.mode, 'write');
  await fake.waitCalls((c) => c.seat === 'Eva' && c.stdin.includes('Build item "a"'), 2, 30000);
  const err = await rejects409(() => B.applyItem(first, 'a', first.items.a.proposal.hash), 'busy');
  assert.match(err.message, /another build that edits files is running/);
  assert.equal(first.items.a.status, 'passed', 'the refused item keeps its state');
  assert.equal(worktree.mainState(project).clean, true, 'the main checkout was not touched');
  fake.openGate('k2');
  await idle(second);
  assert.equal(second.status, 'done');
  for (const id of ['a', 'b']) assert.equal(second.items[id].status, 'passed');
  assert.equal((await ctx.app.capability.status()).agents.claude.available, true, 'the CLI was not blamed');

  // Once no write build runs, the same apply goes through.
  const res = await B.applyItem(first, 'a', first.items.a.proposal.hash);
  assert.equal(res.ok, true);
  assert.equal(gitIn(project, ['diff', '--cached', '--name-only']), 'src/a/index.js');
  resetCheckout();
  assert.equal(worktree.mainState(project).clean, true);
});

t('(l) an item rebuilt after a re-approved spec change starts fresh agent threads that get the new spec', async () => {
  await ensureWrites();
  scenario(writeA(), writeB({ gate: 'l1' }));
  const pr = approvedPlan();
  const room = await start(pr);
  await fake.waitCalls((c) => c.seat === 'Mgr' && c.stdin.includes('Build item "b"'), 1, 30000);
  B.pauseBuild(room);
  fake.openGate('l1');
  await idle(room);
  assert.equal(room.status, 'paused');
  assert.equal(room.items.b.status, 'passed', 'b was built and reviewed under the old spec');
  assert.ok(room.threads['mgr:b'] && room.threads['rev:b:review'], 'b has builder and reviewer threads');
  const revBefore = fake.calls().filter((c) => c.seat === 'Rev').length;

  const newSpec = 'Create src/b/index.js using module a, and document its export.';
  const edited = { goal: GOAL, items: [ITEM_A, { ...ITEM_B, spec: newSpec }] };
  ctx.app.planApi.editPlan(pr, { revision: pr.planRevision, hash: pr.planHash, plan: edited });
  ctx.app.planApi.approvePlan(pr, { revision: pr.planRevision, hash: pr.planHash });
  await B.resumeBuild(room, { revision: pr.planRevision, hash: pr.planHash });
  await idle(room);
  assert.equal(room.status, 'done');
  assert.equal(room.items.b.status, 'passed');
  assert.ok(room.threads['rev:a:review'], "the unchanged item's threads are kept");

  const mgrB = callsFor('Mgr', 'b');
  assert.equal(mgrB.length, 2);
  assert.equal(mgrB[1].resume, false, 'the builder starts a new thread');
  assert.ok(mgrB[1].stdin.includes(newSpec), 'the builder gets the new spec');
  const revAfter = fake.calls().filter((c) => c.seat === 'Rev').slice(revBefore);
  assert.equal(revAfter.length, 1, "only b's review ran after the resume");
  assert.equal(revAfter[0].resume, false, 'the reviewer starts a new thread');
  assert.ok(revAfter[0].stdin.includes(newSpec), "the reviewer's prompt carries the new spec");
});

t('(g) a builder that writes into the project root is quarantined, the build errors and writes turn off', async () => {
  await ensureWrites();
  const escaped = path.join(project, 'escaped.txt');
  scenario(writeA({ writeFiles: [{ path: 'src/a/index.js' }, { path: escaped, content: 'outside\n' }] }), writeB());
  try {
    const room = await start(approvedPlan());
    await idle(room);
    assert.equal(room.items.a.status, 'quarantined');
    assert.match(room.items.a.error, /the main checkout/);
    assert.equal(room.status, 'error');
    assert.equal(room.items.b.status, 'pending');
    assert.equal(fake.calls().filter((c) => c.seat === 'Rev').length, 0, 'no review ran');
    const st = await ctx.app.capability.status();
    assert.equal(st.agents.claude.available, false);
    assert.equal(ctx.app.capability.cached().agents.claude.verified.result, 'fail');
    await rejects409(() => B.resumeBuild(room), 'not-resumable');
  } finally {
    fs.rmSync(escaped, { force: true });
  }
});

test('(j) the build workflow never names a model or seat', { timeout: 30000 }, () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workflows', 'build.js'), 'utf8');
  assert.doesNotMatch(src, /\b(astra|sol|fable|luna|opus|sonnet|haiku|gpt-|claude-)\b/i);
});

t('(m) apply bookkeeping: concurrent independent applies both land, a duplicate is refused, a failed save is not success', async () => {
  await ensureWrites();
  scenario(writeA(), writeC);
  const room = await start(approvedPlan([ITEM_A, ITEM_C]));
  await idle(room);
  assert.equal(room.status, 'done');
  const { a, c } = room.items;
  const rooms = ctx.app.rooms;

  const results = await Promise.allSettled([B.applyItem(room, 'a', a.proposal.hash), B.applyItem(room, 'c', c.proposal.hash)]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], JSON.stringify(results));
  assert.deepEqual([...room.applied].sort(), ['a', 'c'], 'neither item id was lost');
  assert.equal(JSON.parse(ctx.app.store.read(path.join('rooms', room.id + '.json'))).applied.length, 2);

  await rejects409(() => B.applyItem(room, 'a', a.proposal.hash), 'applied');
  assert.deepEqual([...room.applied].sort(), ['a', 'c']);
  resetCheckout();
  assert.equal(worktree.mainState(project).clean, true);

  // A save that fails is reported to the caller, never as success.
  scenario(writeA());
  const r2 = await start(approvedPlan([ITEM_A]));
  await idle(r2);
  const real = rooms.saveRoomStrict;
  rooms.saveRoomStrict = () => { throw new Error('disk full'); };
  let err = null;
  try { await B.applyItem(r2, 'a', r2.items.a.proposal.hash); } catch (e) { err = e; } finally { rooms.saveRoomStrict = real; }
  assert.ok(err, 'a save failure is an error');
  assert.equal(err.code, 'state-not-saved');
  assert.match(err.message, /disk full/);
  // The staged change stays recorded in memory, and the room file holds the same list (the post() calls in the apply
  // path save the room non-strictly), so the list on disk never lags the one in memory.
  assert.ok(r2.applied.includes('a'), 'the staged item is recorded in memory');
  assert.deepEqual(JSON.parse(ctx.app.store.read(path.join('rooms', r2.id + '.json'))).applied, r2.applied, 'the room file matches memory');
  resetCheckout();
});

t('(n) apply-failed: the same reviewed proposal can be applied again, or rebuilt by the owner', async () => {
  await ensureWrites();
  scenario(writeA(), writeB());
  const room = await start(approvedPlan());
  await idle(room);
  assert.equal(room.status, 'done');
  // A transient git failure leaves the item apply-failed with its proposal kept.
  const a = room.items.a;
  a.status = 'apply-failed';
  a.error = 'index.lock exists';
  assert.equal(B.proposalOf(room, 'a').applicable.ok, true, 'a retry is offered');
  await rejects409(() => B.applyItem(room, 'a', 'f'.repeat(64)), 'stale-proposal');
  const res = await B.applyItem(room, 'a', a.proposal.hash);
  assert.equal(res.ok, true);
  assert.equal(a.status, 'applied');
  assert.equal(a.error, null);
  assert.deepEqual(room.applied, ['a']);
  resetCheckout();

  // The owner rebuilds an item whose apply cannot succeed: a finished build resumes, and its dependent starts over.
  scenario(writeA(), writeB());
  const r2 = await start(approvedPlan());
  await idle(r2);
  r2.items.a.status = 'apply-failed';
  r2.items.a.error = 'does not apply';
  const oldHash = r2.items.a.proposal.hash;
  await B.resumeBuild(r2);
  await idle(r2);
  assert.equal(r2.status, 'done');
  for (const id of ['a', 'b']) assert.equal(r2.items[id].status, 'passed');
  assert.ok(r2.items.a.proposal.hash, oldHash);
  // A done build with nothing to rebuild is still not resumable.
  await rejects409(() => B.resumeBuild(r2), 'not-resumable');
  resetCheckout();
});

t('(o) a deleted builder seat: the server refuses deleting it while an item needs it, resume re-seats through the role fallback', async () => {
  await ensureWrites();
  assert.equal((await ctx.post('/api/seats', { name: 'Zed', role: 'Builder', agent: 'claude', effort: 'low', perm: 'write' })).status, 200);
  scenario(writeA({ seat: 'Zed' }));
  const roles = { manager: 'mgr', easy: 'zed', reviewer: 'rev' };
  const room = await start(approvedPlan([ITEM_A]), { roles });
  await idle(room);
  assert.equal(room.items.a.builderId, 'zed');
  // The item goes back to unfinished work (as after a failed attempt).
  room.items.a.status = 'failed';
  room.status = 'needs-you';
  const del = await ctx.post('/api/seats/zed/delete', {});
  assert.equal(del.status, 409);
  assert.match(del.json.error, /unfinished build/);
  assert.ok(ctx.app.seats.seatById('zed'), 'the seat is kept');

  // Removed behind the guard's back: resume must not wedge, and the chain never sees an undefined seat.
  ctx.app.seats.removeSeat(ctx.app.seats.seatById('zed'));
  scenario(writeA({ seat: 'Mgr' }));
  await B.resumeBuild(room);
  await idle(room);
  assert.equal(room.status, 'done', sysTexts(room).join('\n'));
  assert.equal(room.items.a.status, 'passed');
  assert.equal(room.items.a.builderId, 'mgr');
  assert.equal(room.resolved.easy, 'mgr');
  assert.ok(sysTexts(room).some((x) => /are gone; now/.test(x)));

  // Nothing of the build's agents left: a clear 409.
  room.items.a.status = 'failed';
  room.status = 'needs-you';
  room.roles = { easy: 'zed' };
  await rejects409(() => B.resumeBuild(room), 'writes-unavailable');
});

t('(f4) ledger tokens come from the item\'s own turns, not from the seat-wide counter', async () => {
  scenario(writeA({ gate: 'f4-tokens' }));
  const room = await start(approvedPlan([ITEM_A]));
  await fake.waitCalls((c) => c.seat === 'Eva' && c.stdin.includes('Build item "a"'), 1, 30000);
  // Another room using the same seat meanwhile: the seat counter jumps, this item's tokens must not.
  const seat = ctx.app.seats.seatById('eva');
  seat.used = (seat.used || 0) + 5000000;
  fake.openGate('f4-tokens');
  await idle(room);
  assert.equal(room.status, 'done', sysTexts(room).join('\n'));
  const file = path.join(project, '.orchestra', 'records', 'ledger.jsonl');
  const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.room === room.id);
  const sum = (seatId) => room.messages.filter((m) => m.seatId === seatId && Number.isFinite(m.tokens)).reduce((a, m) => a + m.tokens, 0);
  const rec = (role) => recs.find((r) => r.item === 'a' && r.role === role);
  assert.equal(rec('build').tokens, sum('eva'));
  assert.equal(rec('review').tokens, sum('rev'));
  assert.ok(rec('build').tokens < 5000000, 'no seat-wide delta');
});

t('(f4) a failing state save is surfaced and stops new turns until a save succeeds', async () => {
  scenario(writeA());
  const rooms = ctx.app.rooms;
  const real = rooms.saveRoomStrict;
  rooms.saveRoomStrict = () => { throw new Error('disk full'); };
  let room;
  try {
    room = await start(approvedPlan([ITEM_A]));
    await idle(room);
    assert.equal(room.status, 'paused');
    assert.match(room.persistWarning, /disk full/);
    assert.ok(sysTexts(room).some((x) => /could not save the build state/.test(x)));
    assert.equal(callsFor('Eva', 'a').length, 0, 'no turn was started');
  } finally {
    rooms.saveRoomStrict = real;
  }
  await B.resumeBuild(room);
  await idle(room);
  assert.equal(room.status, 'done', sysTexts(room).join('\n'));
  assert.equal(room.persistWarning, undefined);
});

// Runs `fn` with saveRoomStrict failing whenever `failWhen(room)` is true; restores it afterwards.
async function withSaveFailure(failWhen, fn) {
  const rooms = ctx.app.rooms;
  const real = rooms.saveRoomStrict;
  rooms.saveRoomStrict = (r) => { if (failWhen(r)) throw new Error('disk full'); return real(r); };
  try { return await fn(); } finally { rooms.saveRoomStrict = real; }
}

t('(f4) a save failure in the builder phase stops the reviewer turn and the build can resume', async () => {
  scenario(writeA({ gate: 'f4-halt' }));
  const room = await start(approvedPlan([ITEM_A]));
  await fake.waitCalls((c) => c.seat === 'Eva' && c.stdin.includes('Build item "a"'), 1, 30000);
  await withSaveFailure(() => true, async () => {
    fake.openGate('f4-halt');
    await idle(room);
    assert.equal(room.status, 'paused', sysTexts(room).join('\n'));
    assert.match(room.persistWarning, /disk full/);
    assert.equal(fake.calls().filter((c) => c.seat === 'Rev').length, 0, 'the reviewer turn never started');
    assert.equal(room.items.a.status, 'pending');
  });
  await B.resumeBuild(room);
  await idle(room);
  assert.equal(room.status, 'done', sysTexts(room).join('\n'));
  assert.equal(room.persistWarning, undefined);
});

t('(f4) a save failure after the last item completes is surfaced and resume retries it', async () => {
  scenario(writeA());
  const room = await start(approvedPlan([ITEM_A]));
  await withSaveFailure((r) => r.items?.a?.status === 'passed', async () => {
    await idle(room);
    assert.equal(room.status, 'paused', 'not reported as done while unsaved');
    assert.match(room.persistWarning, /disk full/);
    assert.ok(sysTexts(room).some((x) => /final state could not be saved/.test(x)));
  });
  await B.resumeBuild(room);
  await idle(room);
  assert.equal(room.status, 'done', sysTexts(room).join('\n'));
  assert.equal(room.persistWarning, undefined);
});

t('(f4) a save failure when the build pauses is surfaced', async () => {
  scenario(writeA({ gate: 'f4-pause' }));
  const room = await start(approvedPlan([ITEM_A]));
  await fake.waitCalls((c) => c.seat === 'Eva' && c.stdin.includes('Build item "a"'), 1, 30000);
  B.pauseBuild(room);
  await withSaveFailure((r) => r.status === 'paused', async () => {
    fake.openGate('f4-pause');
    await idle(room);
    assert.equal(room.status, 'paused');
    assert.match(room.persistWarning, /disk full/);
  });
  await B.resumeBuild(room);
  await idle(room);
  assert.equal(room.status, 'done', sysTexts(room).join('\n'));
  assert.equal(room.persistWarning, undefined);
});
