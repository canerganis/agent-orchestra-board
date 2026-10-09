// Proposed diffs (plan F10, owner decision Appendix B item 2): the last ```diff block of a read-only builder's reply is
// vetted, then exported as a patch file (propose mode) or applied into the item worktree (Codex patch mode). Unit tests
// use real git in temp repos with no CLI; the two build tests run the in-process board with the fake CLIs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, rmrf, hasGit, gitIn, initRepo, startApp, teardown } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { createStore } = require('../src/store');
const wt = require('../src/worktree');
const patch = require('../src/patch');
const { sha256 } = require('../src/util');
const { createBuild, isReady } = require('../src/workflows/build');
const { validatePlan } = require('../src/workflows/plan-model');

const SKIP = !hasGit && 'git not available';
const FILES = {
  'README.md': 'hello\n',
  'src/a.js': 'module.exports = 1;\n',
  'src/q.sql': 'select 1;\n-- /etc/passwd\n',
  'lib/c.js': 'module.exports = 3;\n',
};

// Files read back from a worktree: git may check them out with CRLF when the user's config sets core.autocrlf.
const readLf = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
const fence = (body) => '```diff\n' + body + '```\n';
const newFile = (p, lines = ['x']) => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`;
const EDIT_A = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 10;\n';
const STALE_A = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-module.exports = 99;\n+module.exports = 10;\n';

function fixture() {
  const project = tmpDir('ob-propose-');
  const head = initRepo(project, FILES);
  const store = createStore(project);
  store.ensure();
  const fp = () => wt.fingerprint(project, { excludeOrchestra: true });
  const room = { id: 'b1' };
  const item = { id: 'i1', owns: ['src'] };
  const save = (text, round = 1, it = item, depPatches = []) => patch.saveProposedPatch({ store, project, room, item: it, round, text, depPatches });
  const proposals = () => { try { return fs.readdirSync(path.join(store.orch, 'proposals', room.id)); } catch { return []; } };
  return { project, head, store, fp, room, item, save, proposals };
}

test('extractLastDiff: the last ```diff block wins, CRLF is normalized, a missing block is null', () => {
  const text = `Plan.\n${fence(newFile('src/one.js'))}Then again:\r\n\`\`\`diff\r\n${EDIT_A.replace(/\n/g, '\r\n')}\`\`\`\r\nDone.`;
  assert.equal(patch.extractLastDiff(text), EDIT_A);
  assert.equal(patch.extractLastDiff('no diff here\n```js\nx\n```\n'), null);
  assert.equal(patch.extractLastDiff('```diff\n\n```\n'), null, 'an empty block counts as missing');
  assert.equal(patch.extractLastDiff('```diff\n+x```\n'), null, 'a fence that is not on its own line does not close a block');
  assert.equal(patch.extractLastDiff('Text\n  ```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n  ```'), '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n', 'an indented fence still counts');
});

test('saveProposedPatch: writes the last block and its sha256, the check passes, the hash is stable, the project is untouched', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const before = f.fp();
    const text = `First try:\n${fence(newFile('src/wrong.js'))}\nFinal:\n${fence(EDIT_A)}\nSummary: one line changed.`;
    const r = f.save(text);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.file, '.orchestra/proposals/b1/i1-r1.patch');
    assert.equal(r.rel, 'proposals/b1/i1-r1.patch');
    assert.deepEqual(r.files, ['src/a.js'], 'only the last block is exported');
    assert.deepEqual(r.check, { ok: true, reason: null });
    assert.equal(r.untested, true);
    assert.match(r.note, /untested/);
    const bytes = fs.readFileSync(path.join(f.project, r.file));
    assert.equal(bytes.toString('utf8'), EDIT_A);
    assert.equal(sha256(bytes), r.hash);
    assert.equal(fs.readFileSync(path.join(f.project, r.file + '.sha256'), 'utf8'), `${r.hash}  i1-r1.patch\n`);
    assert.equal(patch.readProposal({ store: f.store, rel: r.rel, hash: r.hash }).toString('utf8'), EDIT_A);
    // The same diff (with other prose and CRLF line ends) hashes the same.
    const again = f.save(`Other words.\r\n${fence(EDIT_A).replace(/\n/g, '\r\n')}`, 2);
    assert.equal(again.ok, true);
    assert.equal(again.hash, r.hash);
    assert.equal(again.file, '.orchestra/proposals/b1/i1-r2.patch');
    assert.equal(f.fp(), before, 'the project fingerprint is unchanged');
    assert.equal(fs.readFileSync(path.join(f.project, 'src', 'a.js'), 'utf8'), FILES['src/a.js'], 'nothing was applied');
    assert.equal(gitIn(f.project, ['status', '--porcelain', '--', '.', ':(exclude).orchestra']), '');
  } finally { rmrf(f.project); }
});

test('saveProposedPatch: git apply --check runs against the dependency tree, not the main checkout', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const before = f.fp();
    const dep = f.save(fence(newFile('src/dep.js', ['module.exports = 1;'])), 1, { id: 'dep', owns: ['src'] });
    assert.equal(dep.ok, true, dep.reason);
    assert.equal(dep.check.ok, true);
    const EDIT_DEP = 'diff --git a/src/dep.js b/src/dep.js\n--- a/src/dep.js\n+++ b/src/dep.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n';
    const alone = f.save(fence(EDIT_DEP));
    assert.equal(alone.ok, true, alone.reason);
    assert.equal(alone.check.ok, false, 'without the dependency the file does not exist');
    const composed = f.save(fence(EDIT_DEP), 1, f.item, [{ rel: dep.rel, hash: dep.hash }]);
    assert.equal(composed.ok, true, composed.reason);
    assert.deepEqual(composed.check, { ok: true, reason: null });
    const badDep = f.save(fence(EDIT_DEP), 1, f.item, [{ rel: dep.rel, hash: 'f'.repeat(64) }]);
    assert.equal(badDep.check.ok, false, 'a dependency patch that fails verification fails the check');
    assert.equal(f.fp(), before, 'the main checkout is untouched');
    assert.equal(fs.existsSync(path.join(f.project, 'src', 'dep.js')), false);
  } finally { rmrf(f.project); }
});

test('saveProposedPatch: a failing git apply --check is recorded, not thrown', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const before = f.fp();
    const r = f.save(fence(STALE_A));
    assert.equal(r.ok, true);
    assert.equal(r.check.ok, false);
    assert.ok(r.check.reason && r.check.reason.length > 0, 'the reason is kept');
    assert.ok(fs.existsSync(path.join(f.project, r.file)), 'the patch is still written for the user to read');
    assert.equal(f.fp(), before);
  } finally { rmrf(f.project); }
});

test('saveProposedPatch: a removed "-- " line inside a hunk is not read as a header', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const sqlEdit = 'diff --git a/src/q.sql b/src/q.sql\n--- a/src/q.sql\n+++ b/src/q.sql\n@@ -1,2 +1,1 @@\n select 1;\n--- /etc/passwd\n';
    const r = f.save(fence(sqlEdit));
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.files, ['src/q.sql']);
    assert.equal(r.check.ok, true, r.check.reason);
  } finally { rmrf(f.project); }
});

test('saveProposedPatch: every refusal writes nothing and leaves the project untouched', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const before = f.fp();
    const big = '+' + 'x'.repeat(100) + '\n';
    const bigLines = Math.ceil((8 * 1024 * 1024) / big.length) + 10;
    const huge = `diff --git a/src/big.txt b/src/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/big.txt\n@@ -0,0 +1,${bigLines} @@\n${big.repeat(bigLines)}`;
    const cases = [
      ['no block', 'Just prose, no diff.', 'no-diff'],
      ['over 8 MB', fence(huge), 'too-large'],
      ['outside owns', fence(newFile('lib/d.js')), 'outside-owns'],
      ['under .git', fence(newFile('.git/hooks/post-checkout')), 'reserved-path'],
      ['under .git in a subfolder', fence(newFile('src/.git/config')), 'reserved-path'],
      ['under .orchestra', fence(newFile('.orchestra/rooms/x.json')), 'reserved-path'],
      ['absolute path', fence('--- /dev/null\n+++ /etc/evil\n@@ -0,0 +1 @@\n+x\n'), 'absolute-path'],
      ['Windows absolute path', fence('--- /dev/null\n+++ C:/Windows/evil\n@@ -0,0 +1 @@\n+x\n'), 'absolute-path'],
      ['dot dot', fence(newFile('src/../evil.js')), 'dotdot-path'],
      ['rename with dot dot', fence('diff --git a/src/a.js b/src/b.js\nsimilarity index 100%\nrename from src/a.js\nrename to src/../../b.js\n'), 'dotdot-path'],
      ['symlink 120000', fence('diff --git a/src/link b/src/link\nnew file mode 120000\n--- /dev/null\n+++ b/src/link\n@@ -0,0 +1 @@\n+../../etc/passwd\n\\ No newline at end of file\n'), 'unsafe-mode'],
      ['gitlink 160000', fence('diff --git a/src/sub b/src/sub\nnew file mode 160000\nindex 0000000..1234567\n--- /dev/null\n+++ b/src/sub\n@@ -0,0 +1 @@\n+Subproject commit 1234567890123456789012345678901234567890\n'), 'unsafe-mode'],
    ];
    for (const [name, text, code] of cases) {
      const r = f.save(text);
      assert.equal(r.ok, false, `${name}: refused`);
      assert.equal(r.code, code, `${name}: ${r.reason}`);
      assert.ok(r.reason, `${name}: has a reason`);
    }
    // An item that owns nothing cannot export anything.
    const none = f.save(fence(EDIT_A), 1, { id: 'i2', owns: [] });
    assert.equal(none.ok, false); assert.equal(none.code, 'outside-owns');
    assert.deepEqual(f.proposals(), [], 'no file was written');
    assert.equal(f.fp(), before, 'the project fingerprint is unchanged');
  } finally { rmrf(f.project); }
});

test('applyProposedPatch: the diff lands in the item worktree only; a refused or stale diff changes nothing', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const before = f.fp();
    const made = wt.createWorktree(f.project, f.room.id, 'i1', f.head);
    const startTree = patch.prepareWorktree({ store: f.store, worktreeDir: made.dir, depPatches: [] });
    const wtHash0 = patch.hashWorktree({ worktreeDir: made.dir, startTree });

    for (const text of [fence(newFile('lib/d.js')), fence(STALE_A), 'no diff']) {
      const bad = patch.applyProposedPatch({ store: f.store, worktreeDir: made.dir, text, owns: ['src'] });
      assert.equal(bad.ok, false);
      assert.equal(patch.hashWorktree({ worktreeDir: made.dir, startTree }), wtHash0, `the worktree is unchanged after ${bad.code}`);
    }

    const r = patch.applyProposedPatch({ store: f.store, worktreeDir: made.dir, text: `Done.\n${fence(EDIT_A + newFile('src/new.js', ['module.exports = 5;']))}`, owns: ['src'] });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.files.sort(), ['src/a.js', 'src/new.js']);
    assert.equal(r.untested, true);
    assert.equal(readLf(made.dir, 'src', 'a.js'), 'module.exports = 10;\n');
    assert.equal(readLf(made.dir, 'src', 'new.js'), 'module.exports = 5;\n');
    // The freeze then covers exactly the applied change.
    const fz = patch.freezeProposal({ store: f.store, worktreeDir: made.dir, startTree, roomId: f.room.id, itemId: 'i1', round: 1, owns: ['src'] });
    assert.deepEqual(fz.files.sort(), ['src/a.js', 'src/new.js']);
    assert.deepEqual(fz.outOfArea, []); assert.deepEqual(fz.unsafe, []);
    // The main checkout never saw any of it.
    assert.equal(f.fp(), before, 'the project fingerprint is unchanged');
    assert.equal(fs.readFileSync(path.join(f.project, 'src', 'a.js'), 'utf8'), FILES['src/a.js']);
    assert.equal(fs.existsSync(path.join(f.project, 'src', 'new.js')), false);
  } finally { rmrf(f.project); }
});

// ---------- builds with the fake CLIs ----------

let dir, project, fake, ctx, B;
const GOAL = 'Add module a';
const ITEM_A = { id: 'a', title: 'Module a', spec: 'Create src/a/index.js exporting "a".', owns: ['src/a'], dependsOn: [], difficulty: 'easy', seatId: null };
const DIFF_A = newFile('src/a/index.js', ['module.exports = "a";']);
const REVIEW_PASS = { seat: 'Rev', reply: 'Looks right.\nVERDICT: PASS' };

const bt = (name, fn) => test(name, { timeout: 90000, skip: SKIP }, async (tc) => {
  if (fake.skipReason) { if (process.env.GITHUB_ACTIONS) throw new Error(`fake CLI unavailable on CI: ${fake.skipReason}`); tc.skip(fake.skipReason); return; }
  fake.resetCalls();
  await fn();
});

const ITEM_B = { id: 'b', title: 'Module b', spec: 'Create src/b/index.js.', owns: ['src/b'], dependsOn: ['a'], difficulty: 'hard', seatId: null };
const EDIT_IDX = newFile('src/b/index.js', ['module.exports = "b";']);
const STALE_KEEP = 'diff --git a/src/keep.js b/src/keep.js\n--- a/src/keep.js\n+++ b/src/keep.js\n@@ -1 +1 @@\n-module.exports = 99;\n+module.exports = 1;\n';
const KEEP_OWNER = { ...ITEM_A, owns: ['src/keep.js'] };

function approvedPlan(items = [ITEM_A]) {
  const pr = ctx.app.rooms.newRoom('plan', 'Plan', {
    goal: GOAL, topic: GOAL, seatIds: [], rounds: 1, scoutId: null, synthId: null, managerId: 'mgr', withContext: false, overrides: {},
    phase: 'plan', plan: null, planRevision: 0, planHash: null, revisions: [], approval: null, buildIds: [],
  });
  ctx.app.planApi.setRevision(pr, validatePlan({ goal: GOAL, items }), 'manager');
  pr.status = 'awaiting-approval';
  ctx.app.planApi.approvePlan(pr, { revision: pr.planRevision, hash: pr.planHash });
  return pr;
}
async function start(easy, mode, items) {
  const pr = approvedPlan(items);
  const room = await B.startBuild(pr, { revision: pr.planRevision, hash: pr.planHash, roles: { manager: 'mgr', easy, reviewer: 'rev' }, maxRounds: 2, mode });
  assert.equal(await B.whenIdle(room, 60000), true, 'the build loop ended');
  return room;
}

before(async () => {
  if (SKIP) return;
  dir = tmpDir('ob-propose-build-');
  fake = setupFakeCli(dir);
  if (fake.skipReason) return;
  project = path.join(dir, 'project');
  initRepo(project, { 'README.md': 'hello\n', 'src/keep.js': 'module.exports = 0;\n' });
  ctx = await startApp({ projectDir: project });
  for (const s of [
    { name: 'Mgr', role: 'Manager', agent: 'claude', effort: 'low', perm: 'read' },
    { name: 'Pia', role: 'Builder', agent: 'claude', effort: 'low', perm: 'read' },
    { name: 'Cody', role: 'Builder', agent: 'codex', effort: 'low', perm: 'write' },
    { name: 'Rev', role: 'Reviewer', agent: 'codex', effort: 'low', perm: 'read' },
  ]) {
    const res = await ctx.post('/api/seats', s);
    assert.equal(res.status, 200);
  }
  B = createBuild({ store: ctx.app.store, seats: ctx.app.seats, rooms: ctx.app.rooms, chain: ctx.app.chain, capability: ctx.app.capability, patch, worktree: wt, plan: ctx.app.planApi, broadcast: ctx.app.broadcast });
});
after(() => { if (dir) return teardown(ctx, dir); });

bt('propose build: a review PASS exports the diff as item.exported; nothing is applied', async () => {
  fake.scenario([REVIEW_PASS, { seat: 'Pia', reply: `I would add the module.\n${fence(DIFF_A)}` }]);
  const before = wt.fingerprint(project, { excludeOrchestra: true });
  const room = await start('pia');
  assert.equal(room.mode, 'propose');
  assert.equal(room.status, 'done');
  const it = room.items.a;
  assert.equal(it.status, 'passed');
  const ex = it.exported;
  assert.ok(ex && ex.file, JSON.stringify(ex));
  assert.equal(ex.file, `.orchestra/proposals/${room.id}/a-r1.patch`);
  assert.deepEqual(ex.files, ['src/a/index.js']);
  assert.deepEqual(ex.check, { ok: true, reason: null });
  assert.equal(ex.untested, true);
  assert.equal(sha256(fs.readFileSync(path.join(project, ex.file))), ex.hash);
  assert.ok(fake.calls().some((c) => c.seat === 'Pia' && c.stdin.includes('End with exactly one unified diff in a ```diff block, git format, paths relative to the repository root.')), 'the propose instruction asks for the diff block');
  assert.deepEqual(B.proposalOf(room, 'a').exported, ex, 'the proposal view returns exported');
  assert.equal(fs.existsSync(path.join(project, 'src', 'a', 'index.js')), false, 'nothing was applied');
  assert.equal(wt.fingerprint(project, { excludeOrchestra: true }), before);
});

bt('propose build: a reply without a diff block is needs-artifact with a reason, not passed or done', async () => {
  fake.scenario([REVIEW_PASS, { seat: 'Pia', reply: 'Create src/a/index.js with one export.' }]);
  const room = await start('pia');
  const ex = room.items.a.exported;
  assert.equal(room.items.a.status, 'needs-artifact');
  assert.match(room.items.a.error, /no usable patch/);
  assert.equal(isReady(room.items.a, 'propose'), false);
  assert.equal(room.status, 'needs-you');
  assert.equal(ex.file, null);
  assert.equal(ex.refused, 'no-diff');
  assert.equal(ex.check.ok, false);
  assert.equal(ex.untested, true);
});

const startDeps = (items = [ITEM_A, ITEM_B]) => start('pia', 'propose', items);
const said = (text) => ({ reply: text });

bt('propose build: a refused export (outside the owned areas) is needs-artifact, the dependent never starts, the build is not done', async () => {
  fake.scenario([
    { seat: 'Pia', match: 'Build item "a"', ...said(`Done.\n${fence(newFile('README2.md'))}`) },
    { seat: 'Mgr', match: 'Build item "b"', ...said(`Done.\n${fence(EDIT_IDX)}`) },
    REVIEW_PASS,
  ]);
  const room = await startDeps();
  const a = room.items.a;
  assert.equal(a.status, 'needs-artifact');
  assert.equal(a.exported.refused, 'outside-owns');
  assert.ok(a.error && a.error.length > 0);
  assert.equal(isReady(a, 'propose'), false);
  assert.equal(room.items.b.status, 'blocked');
  assert.equal(fake.calls().filter((c) => c.seat === 'Mgr' && c.stdin.includes('Build item "b"')).length, 0, 'the dependent never ran');
  assert.equal(room.status, 'needs-you');
});

bt('propose build: an inapplicable patch is needs-artifact, the dependent does not start, the build is not done', async () => {
  fake.scenario([
    { seat: 'Pia', match: 'Build item "a"', ...said(`Done.\n${fence(STALE_KEEP)}`) },
    { seat: 'Mgr', match: 'Build item "b"', ...said(`Done.\n${fence(EDIT_IDX)}`) },
    REVIEW_PASS,
  ]);
  const room = await startDeps([KEEP_OWNER, ITEM_B]);
  const a = room.items.a;
  assert.equal(a.exported.file !== null, true, 'the patch file is still exported');
  assert.equal(a.exported.check.ok, false);
  assert.equal(a.status, 'needs-artifact');
  assert.ok(a.error.includes(a.exported.check.reason));
  assert.equal(room.items.b.status, 'blocked');
  assert.equal(fake.calls().filter((c) => c.seat === 'Mgr' && c.stdin.includes('Build item "b"')).length, 0);
  assert.equal(room.status, 'needs-you');
});

bt('propose build: successful exports satisfy readiness, a dependent is checked against its dependency tree, the prompt is honest', async () => {
  fake.scenario([
    { seat: 'Pia', match: 'Build item "a"', ...said(`Done.\n${fence(DIFF_A)}`) },
    { seat: 'Mgr', match: 'Build item "b"', ...said(`Done.\n${fence(EDIT_IDX)}`) },
    REVIEW_PASS,
  ]);
  const room = await startDeps();
  assert.equal(room.items.a.status, 'passed');
  assert.equal(room.items.b.status, 'passed');
  assert.deepEqual(room.items.b.exported.check, { ok: true, reason: null }, 'the dependency tree is composed for the check');
  assert.equal(isReady(room.items.a, 'propose'), true);
  assert.equal(isReady(room.items.b, 'propose'), true);
  assert.equal(room.status, 'done');
  assert.equal(fs.existsSync(path.join(project, 'src', 'a', 'index.js')), false, 'nothing was applied');
  const call = fake.calls().find((c) => c.seat === 'Mgr' && c.stdin.includes('Build item "b"'));
  assert.ok(call && call.stdin.includes('NOT in your files'), 'the prompt does not claim the dependencies are present');
  assert.ok(!call.stdin.includes('present in your files'));
});

test('isReady: needs a passing review and a usable artifact in either mode', () => {
  const pass = { status: 'passed', review: { verdict: 'pass', hash: 'h' }, proposal: { file: 'p', hash: 'h' }, exported: { file: 'f', hash: 'x', check: { ok: true } } };
  assert.equal(isReady(pass, 'write'), true);
  assert.equal(isReady(pass, 'propose'), true);
  assert.equal(isReady({ ...pass, status: 'applied' }, 'write'), true);
  assert.equal(isReady({ ...pass, review: { verdict: 'fail', hash: 'h' } }, 'propose'), false);
  assert.equal(isReady({ ...pass, proposal: null }, 'write'), false);
  assert.equal(isReady({ ...pass, proposal: { file: 'p', hash: 'other' } }, 'write'), false);
  assert.equal(isReady({ ...pass, exported: null }, 'propose'), false);
  assert.equal(isReady({ ...pass, exported: { file: null, hash: null, check: { ok: false } } }, 'propose'), false);
  assert.equal(isReady({ ...pass, exported: { file: 'f', hash: 'x', check: { ok: false, reason: 'r' } } }, 'propose'), false);
  assert.equal(isReady({ ...pass, status: 'needs-artifact' }, 'propose'), false);
  assert.equal(isReady(null, 'propose'), false);
});

bt('write build with a Codex builder: read-only turn, the board applies its diff in the worktree, the checkout is untouched', async () => {
  fake.scenario([REVIEW_PASS, { seat: 'Cody', reply: `Added the module.\n${fence(DIFF_A)}` }]);
  const before = wt.fingerprint(project, { excludeOrchestra: true });
  const room = await start('cody');
  assert.equal(room.mode, 'write', room.modeReason || '');
  assert.equal(room.status, 'done', JSON.stringify(room.items.a.error));
  const it = room.items.a;
  assert.equal(it.status, 'passed');
  assert.equal(it.proposal.via, 'diff');
  assert.equal(it.proposal.untested, true);
  assert.deepEqual(it.proposal.files, ['src/a/index.js']);
  assert.equal(it.review.hash, it.proposal.hash);
  const call = fake.calls().find((c) => c.seat === 'Cody');
  assert.ok(call, 'Cody ran');
  assert.ok(call.stdin.includes('```diff block'), 'the builder was asked for a diff block');
  assert.ok(call.args.some((x) => x.includes('sandbox_mode="read-only"')), `Codex ran read-only: ${call.args.join(' ')}`);
  assert.ok(!call.args.some((x) => /workspace-write|danger-full-access/.test(x)), `Codex had no write access: ${call.args.join(' ')}`);
  assert.equal(readLf(project, it.worktree.rel, 'src', 'a', 'index.js'), 'module.exports = "a";\n', 'the diff landed in the item worktree');
  assert.equal(fs.existsSync(path.join(project, 'src', 'a', 'index.js')), false, 'the main checkout has no new file');
  assert.equal(wt.fingerprint(project, { excludeOrchestra: true }), before, 'the project fingerprint is unchanged');
});

bt('write build with a Codex builder: a file written during the read-only turn quarantines the item, nothing is applied', async () => {
  fake.scenario([REVIEW_PASS, { seat: 'Cody', writeFiles: [{ path: 'src/a/sneaky.js', content: 'x\n' }], reply: `Added it.\n${fence(DIFF_A)}` }]);
  const before = wt.fingerprint(project, { excludeOrchestra: true });
  const room = await start('cody');
  const it = room.items.a;
  assert.equal(it.status, 'quarantined');
  assert.equal(room.status, 'error');
  assert.equal(it.proposal, null, 'nothing was frozen');
  assert.equal(fake.calls().filter((c) => c.seat === 'Rev').length, 0, 'no review ran');
  assert.equal(fs.existsSync(path.join(project, it.worktree.rel, 'src', 'a', 'index.js')), false, 'the diff was not applied');
  assert.equal(wt.fingerprint(project, { excludeOrchestra: true }), before);
});

bt('a Codex write builder without a usable repository: an automatic build proposes instead of failing, and write is 409', async () => {
  const noRepo = { status: async () => ({ repo: { ok: false, reason: 'the project is not a git repository' }, agents: { claude: { available: false }, codex: { available: false } } }) };
  const B2 = createBuild({ store: ctx.app.store, seats: ctx.app.seats, rooms: ctx.app.rooms, chain: ctx.app.chain, capability: noRepo, patch, worktree: wt, plan: ctx.app.planApi, broadcast: ctx.app.broadcast });
  const pr = approvedPlan();
  const opts = { revision: pr.planRevision, hash: pr.planHash, roles: { manager: 'mgr', easy: 'cody', reviewer: 'rev' }, maxRounds: 1 };
  await assert.rejects(B2.startBuild(pr, { ...opts, mode: 'write' }), (e) => e.status === 409 && e.code === 'writes-unavailable' && /not a git repository/.test(e.message));
  fake.scenario([REVIEW_PASS, { seat: 'Cody', reply: `Added it.\n${fence(DIFF_A)}` }]);
  const room = await B2.startBuild(pr, opts);
  assert.equal(room.mode, 'propose');
  assert.match(room.modeReason, /not a git repository/);
  assert.equal(await B2.whenIdle(room, 60000), true, 'the build loop ended');
  assert.equal(room.items.a.worktree, null, 'no worktree in propose mode');
});

bt('write build with a Codex builder: a diff outside the owner areas is sent back, never applied', async () => {
  fake.scenario([REVIEW_PASS, { seat: 'Cody', reply: `Added it.\n${fence(newFile('README2.md'))}` }]);
  const room = await start('cody');
  const it = room.items.a;
  assert.equal(it.status, 'needs-you');
  assert.equal(it.proposal, null, 'nothing was frozen');
  assert.equal(fake.calls().filter((c) => c.seat === 'Rev').length, 0, 'no review ran');
  assert.ok(room.messages.some((m) => m.seatId === 'system' && /diff was not applied/.test(m.text)));
  assert.equal(fs.existsSync(path.join(project, it.worktree.rel, 'README2.md')), false);
});
