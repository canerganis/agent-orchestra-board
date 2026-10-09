// Frozen proposals and the safe apply path: real git in temp repos, no CLI and no server.
// Every test is skipped with a reason when git is not installed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, rmrf, hasGit, gitIn, initRepo, canon } = require('./helpers');
const { createStore } = require('../src/store');
const wt = require('../src/worktree');
const patch = require('../src/patch');
const { sha256 } = require('../src/util');

const SKIP = !hasGit && 'git not available';
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

const FILES = {
  'README.md': 'hello\n',
  'src/a.js': 'module.exports = 1;\n',
  'src/b.js': 'module.exports = 2;\n',
  'lib/c.js': 'module.exports = 3;\n',
  'docs/x': 'docs\n',
};

// A board project with one item worktree prepared on HEAD, plus a paused build room.
function fixture(files = FILES) {
  const project = tmpDir('ob-patch-');
  const head = initRepo(project, files);
  const store = createStore(project);
  store.ensure();
  const headTree = gitIn(project, ['rev-parse', 'HEAD^{tree}']);
  const room = { id: 'r1', status: 'paused', baseCommit: head, expectedTree: headTree, items: {} };
  const ctx = {
    project, store, head, headTree, room, frozen: {},
    // Creates a worktree for the item (with the given dependency patches applied) and returns { dir, startTree }.
    worktree(itemId, depPatches = []) {
      const made = wt.createWorktree(project, room.id, itemId, head);
      const startTree = patch.prepareWorktree({ store, worktreeDir: made.dir, depPatches });
      return { dir: made.dir, startTree };
    },
    // Writes files into a worktree, freezes them and registers a passed, reviewed item in the room.
    item(itemId, edits, { dependsOn = [], owns = null } = {}) {
      const w = ctx.worktree(itemId);
      for (const [rel, content] of Object.entries(edits)) write(w.dir, rel, content);
      return ctx.freeze(itemId, w, { dependsOn, owns });
    },
    // Freezes an already edited worktree and registers it as a passed, reviewed item (whatever the freeze flagged).
    freeze(itemId, w, { dependsOn = [], owns = null } = {}) {
      const fz = patch.freezeProposal({ store, worktreeDir: w.dir, startTree: w.startTree, roomId: room.id, itemId, round: 1, owns });
      const it = {
        id: itemId, status: 'passed', dependsOn, owns,
        worktree: { rel: `.orchestra/worktrees/${room.id}/${itemId}`, baseCommit: head, startTree: w.startTree },
        proposal: { round: 1, hash: fz.hash, file: fz.rel, files: fz.files, bytes: fz.bytes, frozenAt: 'now' },
        review: { hash: fz.hash, verdict: 'pass', msgId: 'm1', seatId: 's1', at: 'now' },
        error: null, appliedAt: null,
      };
      room.items[itemId] = it;
      ctx.frozen[itemId] = fz;
      return it;
    },
    apply: (item, approvalOk = true) => patch.applyProposal({ project, store, room, item, approvalOk }),
    pre: (item, approvalOk = true) => patch.applyPreconditions({ project, store, room, item, approvalOk }),
    cleanup: () => rmrf(project),
  };
  return ctx;
}

function write(dir, rel, content) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

const stagedNames = (dir) => gitIn(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).sort();

test('(a) freeze captures staged, unstaged, untracked and binary changes; hash is stable and matches the file', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const w = f.worktree('a');
    write(w.dir, 'src/a.js', 'module.exports = 10;\n');
    gitIn(w.dir, ['add', 'src/a.js']);
    write(w.dir, 'src/b.js', 'module.exports = 20;\n');
    write(w.dir, 'src/new.txt', 'brand new\n');
    write(w.dir, 'src/bin.dat', Buffer.from([0, 1, 2, 0, 255, 10, 0]));

    const fz = patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1 });
    assert.equal(fz.empty, false);
    assert.equal(fz.rel, 'proposals/r1/a-r1.patch');
    assert.match(fz.rel, patch.REL_RE);
    assert.deepEqual([...fz.files].sort(), ['src/a.js', 'src/b.js', 'src/bin.dat', 'src/new.txt']);
    assert.deepEqual(fz.outOfArea, []);
    assert.deepEqual(fz.unsafe, []);
    const onDisk = fs.readFileSync(path.join(f.store.orch, fz.rel));
    assert.equal(fz.hash, sha256(onDisk));
    assert.equal(fz.bytes, onDisk.length);
    assert.match(onDisk.toString('latin1'), /GIT binary patch/);

    const again = patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1 });
    assert.equal(again.hash, fz.hash);
    assert.equal(patch.hashWorktree({ worktreeDir: w.dir, startTree: w.startTree }), fz.hash);
    assert.deepEqual(patch.readProposal({ store: f.store, rel: fz.rel, hash: fz.hash }), onDisk);
  } finally { f.cleanup(); }
});

test('(b) an unchanged worktree freezes as empty and writes no file', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const w = f.worktree('a');
    const fz = patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1 });
    assert.equal(fz.empty, true);
    assert.deepEqual(fz.files, []);
    assert.deepEqual(fz.outOfArea, []);
    assert.deepEqual(fz.unsafe, []);
    assert.equal(fs.existsSync(path.join(f.store.orch, 'proposals', 'r1', 'a-r1.patch')), false);
  } finally { f.cleanup(); }
});

test('(c) owns limits the area: a change outside it is listed in outOfArea', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const w = f.worktree('a');
    write(w.dir, 'src/a.js', 'x\n');
    write(w.dir, 'docs/x', 'changed\n');
    const fz = patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 2, owns: ['src'] });
    assert.deepEqual(fz.outOfArea, ['docs/x']);
    assert.equal(fz.rel, 'proposals/r1/a-r2.patch');
  } finally { f.cleanup(); }
});

test('(d) a symlink is listed in unsafe', { skip: SKIP }, (t) => {
  const f = fixture();
  try {
    const w = f.worktree('a');
    let real = true;
    try { fs.symlinkSync('README.md', path.join(w.dir, 'link')); } catch {
      real = false;
      // No symlink privilege (Windows without developer mode): with core.symlinks=false git keeps a 120000 index
      // entry for a plain file holding the link target, which is exactly how such a checkout stores a symlink.
      write(w.dir, 'link', 'README.md');
      const blob = gitIn(w.dir, ['hash-object', '-w', 'link']);
      gitIn(w.dir, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
    }
    gitIn(w.dir, ['add', '-A']);
    if (!/^120000 /.test(gitIn(w.dir, ['ls-files', '-s', 'link']))) return t.skip('git does not record symlinks on this machine');
    const args = { store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1 };
    // A real link on disk is refused before the patch is listed; an index-only 120000 entry reaches the unsafe list.
    if (real) return assert.throws(() => patch.freezeProposal(args), /refusing to stage the worktree: .* contains a symbolic link or junction: link/);
    const fz = patch.freezeProposal(args);
    assert.ok(fz.unsafe.includes('link'), `unsafe: ${JSON.stringify(fz.unsafe)}`);
  } finally { f.cleanup(); }
});

test('unsafe also lists an embedded repository (gitlink) and any path under .orchestra', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const w = f.worktree('a');
    initRepo(path.join(w.dir, 'vendor', 'sub'), { 'z.txt': 'z\n' });
    write(w.dir, '.orchestra/evil.txt', 'board state\n');
    write(w.dir, 'src/a.js', 'fine\n');
    const fz = patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1 });
    assert.ok(fz.unsafe.includes('vendor/sub'), `unsafe: ${JSON.stringify(fz.unsafe)}`);
    assert.ok(fz.unsafe.includes('.orchestra/evil.txt'), `unsafe: ${JSON.stringify(fz.unsafe)}`);
    assert.equal(fz.unsafe.includes('src/a.js'), false);
  } finally { f.cleanup(); }
});

test('(e) readProposal: a tampered file is proposal-changed, a bad path is bad-path, a missing file is proposal-missing', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const it = f.item('a', { 'src/a.js': 'changed\n' });
    const abs = path.join(f.store.orch, it.proposal.file);
    fs.appendFileSync(abs, '\n');
    assert.throws(() => patch.readProposal({ store: f.store, rel: it.proposal.file, hash: it.proposal.hash }), (e) => e.code === 'proposal-changed' && e.status === 409);
    for (const rel of ['../rooms/x.json', 'proposals/r1/../../session', 'proposals/r1/A-r1.patch', 'proposals/r1/a-r1.diff', 'rooms/r1/a-r1.patch', null]) {
      assert.throws(() => patch.readProposal({ store: f.store, rel, hash: it.proposal.hash }), (e) => e.code === 'bad-path' && e.status === 400, String(rel));
    }
    assert.throws(() => patch.readProposal({ store: f.store, rel: 'proposals/r1/zz-r9.patch', hash: it.proposal.hash }), (e) => e.code === 'proposal-missing' && e.status === 404);
    assert.throws(() => patch.freezeProposal({ store: f.store, worktreeDir: f.project, startTree: f.headTree, roomId: '../x', itemId: 'a', round: 1 }), (e) => e.code === 'bad-path');
  } finally { f.cleanup(); }
});

test('(f) prepareWorktree applies dependency patches: the dependent worktree starts from them', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const dep = f.item('dep', { 'lib/c.js': 'module.exports = 30;\n', 'lib/d.js': 'new dep file\n' });
    const w = f.worktree('next', [{ rel: dep.proposal.file, hash: dep.proposal.hash }]);
    assert.notEqual(w.startTree, f.headTree);
    assert.equal(fs.readFileSync(path.join(w.dir, 'lib', 'd.js'), 'utf8').replace(/\r\n/g, '\n'), 'new dep file\n');
    assert.equal(fs.readFileSync(path.join(w.dir, 'lib', 'c.js'), 'utf8').replace(/\r\n/g, '\n'), 'module.exports = 30;\n');
    // The dependent's own proposal holds only its own change, not the dependency's.
    write(w.dir, 'src/a.js', 'own change\n');
    const fz = patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'next', round: 1 });
    assert.deepEqual(fz.files, ['src/a.js']);

    // A dependency patch that was tampered with is refused; one that does not apply is a dependency-conflict.
    assert.throws(() => f.worktree('bad', [{ rel: dep.proposal.file, hash: 'f'.repeat(64) }]), (e) => e.code === 'proposal-changed');
    const w2 = wt.createWorktree(f.project, 'r1', 'conflict', f.head);
    write(w2.dir, 'lib/d.js', 'already here\n');
    assert.throws(() => patch.prepareWorktree({ store: f.store, worktreeDir: w2.dir, depPatches: [{ rel: dep.proposal.file, hash: dep.proposal.hash }] }), (e) => e.code === 'dependency-conflict' && e.status === 409);
  } finally { f.cleanup(); }
});

test('(g) applyPreconditions reports each failing precondition with its code', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const dep = f.item('dep', { 'lib/c.js': 'dep\n' });
    const it = f.item('a', { 'src/a.js': 'item a\n' }, { dependsOn: ['dep'] });
    assert.equal(f.pre(dep).ok, true);

    f.room.status = 'running';
    assert.equal(f.pre(it).code, 'build-running');
    f.room.status = 'paused';

    it.status = 'reviewing';
    assert.equal(f.pre(it).code, 'not-reviewed');
    it.status = 'passed';
    it.review.verdict = 'fail';
    assert.equal(f.pre(it).code, 'not-reviewed');
    it.review.verdict = 'pass';

    const realHash = it.review.hash;
    it.review.hash = 'a'.repeat(64);
    assert.equal(f.pre(it).code, 'review-stale');
    it.review.hash = realHash;

    assert.deepEqual(f.pre(it), { ok: false, code: 'dependency-not-applied', reason: 'apply dep first' });
    dep.status = 'applied';
    assert.equal(f.pre(it, false).code, 'approval-stale');
    assert.deepEqual(f.pre(it), { ok: true });

    write(f.project, 'stray.txt', 'user file\n');
    const dirty = f.pre(it);
    assert.equal(dirty.code, 'checkout-dirty');
    assert.deepEqual(dirty.files, ['stray.txt']);
    fs.rmSync(path.join(f.project, 'stray.txt'));

    write(f.project, 'README.md', 'unstaged user edit\n');
    assert.equal(f.pre(it).code, 'checkout-dirty');
    gitIn(f.project, ['checkout', '--', 'README.md']);

    // Board state under .orchestra never counts as a change.
    write(f.project, '.orchestra/notes.txt', 'board\n');
    assert.equal(f.pre(it).ok, true);
  } finally { f.cleanup(); }
});

test('(g) applyPreconditions: base-changed after a new commit, does-not-apply on a conflicting staged change', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const it = f.item('a', { 'src/a.js': 'item a\n' });

    write(f.project, 'README.md', 'user commit\n');
    gitIn(f.project, ['add', 'README.md']);
    gitIn(f.project, [...ID, 'commit', '-q', '-m', 'user']);
    assert.equal(f.pre(it).code, 'base-changed');
    gitIn(f.project, ['reset', '-q', '--hard', f.head]);
    assert.equal(f.pre(it).ok, true);

    // A staged change the board did not make, with expectedTree still at HEAD's tree.
    write(f.project, 'README.md', 'staged by the user\n');
    gitIn(f.project, ['add', 'README.md']);
    assert.equal(f.pre(it).code, 'checkout-dirty');
    gitIn(f.project, ['reset', '-q', '--hard', f.head]);

    // A conflicting staged change that the room accepts (expectedTree matches): the patch itself no longer applies.
    write(f.project, 'src/a.js', 'conflicting staged change\n');
    gitIn(f.project, ['add', 'src/a.js']);
    f.room.expectedTree = gitIn(f.project, ['write-tree']);
    const r = f.pre(it);
    assert.equal(r.code, 'does-not-apply');
    assert.ok(r.reason.length > 0);

    // The proposal file going missing is reported too.
    f.room.expectedTree = f.headTree;
    gitIn(f.project, ['reset', '-q', '--hard', f.head]);
    fs.rmSync(path.join(f.store.orch, it.proposal.file));
    assert.equal(f.pre(it).code, 'proposal-missing');
  } finally { f.cleanup(); }
});

test('(h) a successful apply stages exactly the proposal files and creates no commit', { skip: SKIP }, async () => {
  const f = fixture();
  try {
    const bin = Buffer.from([0, 1, 2, 0, 255, 10, 0, 7]);
    const it = f.item('a', { 'src/a.js': 'module.exports = 100;\n', 'src/new.txt': 'new\n', 'src/bin.dat': bin });
    const r = await f.apply(it);
    assert.equal(r.ok, true, r.reason);
    assert.match(r.tree, /^[0-9a-f]{40,64}$/);
    assert.equal(f.room.expectedTree, r.tree);
    assert.equal(f.room.baseCommit, f.head);
    assert.equal(it.status, 'applied');
    assert.ok(it.appliedAt);
    assert.equal(it.error, null);
    assert.deepEqual(stagedNames(f.project), ['src/a.js', 'src/bin.dat', 'src/new.txt']);
    assert.equal(gitIn(f.project, ['rev-parse', 'HEAD']), f.head);
    assert.deepEqual(fs.readFileSync(path.join(f.project, 'src', 'bin.dat')), bin);
    assert.equal(gitIn(f.project, ['write-tree']), r.tree);
    const st = wt.mainState(f.project);
    assert.deepEqual([st.unstaged, st.untracked], [[], []]);
  } finally { f.cleanup(); }
});

test('(i) disjoint items apply in turn; after the user commits the applied state the next apply still works', { skip: SKIP }, async () => {
  const f = fixture();
  try {
    const a = f.item('a', { 'src/a.js': 'A\n' });
    const b = f.item('b', { 'lib/c.js': 'B\n' });
    const c = f.item('c', { 'docs/x': 'C\n' });
    const ra = await f.apply(a);
    assert.equal(ra.ok, true, ra.reason);

    gitIn(f.project, [...ID, 'commit', '-q', '-m', 'apply a']);
    const newHead = gitIn(f.project, ['rev-parse', 'HEAD']);
    assert.notEqual(newHead, f.head);
    const rb = await f.apply(b);
    assert.equal(rb.ok, true, rb.reason);
    assert.equal(f.room.baseCommit, newHead);
    assert.equal(f.room.expectedTree, rb.tree);
    assert.deepEqual(stagedNames(f.project), ['lib/c.js']);

    const rc = await f.apply(c);
    assert.equal(rc.ok, true, rc.reason);
    assert.deepEqual(stagedNames(f.project), ['docs/x', 'lib/c.js']);
    assert.equal(gitIn(f.project, ['rev-parse', 'HEAD']), newHead);
  } finally { f.cleanup(); }
});

test('(j) an apply whose staged paths differ from the proposal is reverted: checkout unchanged, item apply-failed, proposal kept', { skip: SKIP }, async () => {
  const f = fixture();
  try {
    const it = f.item('a', { 'src/a.js': 'A\n', 'src/b.js': 'B\n' });
    it.proposal.files = ['src/a.js']; // the reviewed file list no longer matches what the patch stages
    const before = wt.mainState(f.project);
    const fpBefore = wt.fingerprint(f.project, { excludeOrchestra: true });
    const r = await f.apply(it);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'apply-mismatch');
    assert.equal(it.status, 'apply-failed');
    assert.deepEqual(wt.mainState(f.project), before);
    assert.equal(wt.fingerprint(f.project, { excludeOrchestra: true }), fpBefore);
    assert.equal(f.room.expectedTree, f.headTree);
    assert.ok(patch.readProposal({ store: f.store, rel: it.proposal.file, hash: it.proposal.hash }).length > 0);
  } finally { f.cleanup(); }
});

test('(j) git apply failing after the check marks the item apply-failed and leaves the checkout unchanged', { skip: SKIP }, async () => {
  const f = fixture();
  const realRunGit = wt.runGit;
  try {
    const it = f.item('a', { 'src/a.js': 'A\n' });
    const before = wt.mainState(f.project);
    wt.runGit = (cwd, args, opts) => (args[0] === 'apply' && !args.includes('--check') && !args.includes('--numstat')
      ? { ok: false, code: 1, stdout: '', stderr: 'error: simulated failure' }
      : realRunGit(cwd, args, opts));
    const r = await f.apply(it);
    wt.runGit = realRunGit;
    assert.deepEqual([r.ok, r.code], [false, 'does-not-apply']);
    assert.equal(it.status, 'apply-failed');
    assert.match(it.error, /simulated failure/);
    assert.deepEqual(wt.mainState(f.project), before);
    assert.ok(fs.existsSync(path.join(f.store.orch, it.proposal.file)));

    // A precondition failure changes nothing on the item.
    const other = f.item('b', { 'lib/c.js': 'B\n' });
    const r2 = await f.apply(other, false);
    assert.equal(r2.code, 'approval-stale');
    assert.equal(other.status, 'passed');
  } finally { wt.runGit = realRunGit; f.cleanup(); }
});

test('(k) concurrent applies are serialized: both succeed and the second builds on the first', { skip: SKIP }, async () => {
  const f = fixture();
  try {
    const a = f.item('a', { 'src/a.js': 'A\n' });
    const b = f.item('b', { 'lib/c.js': 'B\n' });
    const pa = f.apply(a);
    const pb = f.apply(b);
    assert.equal(patch.applyBusy(), true);
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.equal(ra.ok, true, ra.reason);
    assert.equal(rb.ok, true, rb.reason);
    assert.notEqual(ra.tree, rb.tree);
    assert.equal(f.room.expectedTree, rb.tree);
    assert.equal(patch.applyBusy(), false);
    assert.deepEqual(stagedNames(f.project), ['lib/c.js', 'src/a.js']);
    assert.equal(gitIn(f.project, ['rev-parse', 'HEAD']), f.head);
  } finally { f.cleanup(); }
});

// Records a symlink at `rel` in the worktree index (a real symlink when allowed, else a 120000 index entry, which is
// how a checkout with core.symlinks=false stores one). Returns false when git does not record it as a symlink.
// real=false never creates a link on disk (staging refuses a worktree that holds one), only the index entry.
function addSymlink(dir, rel, target, real = true) {
  try { if (!real) throw new Error('index entry only'); fs.symlinkSync(target, path.join(dir, rel)); } catch {
    write(dir, rel, target);
    const blob = gitIn(dir, ['hash-object', '-w', rel]);
    gitIn(dir, ['update-index', '--add', '--cacheinfo', `120000,${blob},${rel}`]);
  }
  gitIn(dir, ['add', '-A']);
  return /^120000 /.test(gitIn(dir, ['ls-files', '-s', rel]));
}

test('reservedPath refuses .git, .orchestra and their Windows and HFS aliases, and allows ordinary paths', () => {
  const refused = [
    '.git/config', 'src/.git/hooks/pre-commit', '.GIT/x', 'GIT~1/config',
    '.orchestra/capability.json', '.Orchestra/rooms/x.json', 'ORCHES~1/capability.json', 'orches~1/rooms/new.json',
    'ORCHES~12/x', 'src/ORCHES~1/x', '.orchestra./capability.json', '.orchestra /capability.json', 'src/a.js.',
    '.orchestra::$INDEX_ALLOCATION/capability.json', 'a:b', 'src\\..\\.orchestra\\x', 'x<y', 'x|y', 'x*', 'x?',
    'tab\there', '.orc‌hestra/capability.json', '﻿.orchestra/x', 'a//b', './a', 'a/../b',
  ];
  for (const p of refused) assert.equal(patch.reservedPath(p), true, JSON.stringify(p));
  const allowed = ['README.md', 'src/a.js', 'src/orchestra.js', 'docs/.orchestra/notes.md', 'a~b/c', 'v1~beta', '.gitignore', '.github/workflows/ci.yml', 'dir.d/x'];
  for (const p of allowed) assert.equal(patch.reservedPath(p), false, JSON.stringify(p));
});

test('an 8.3 alias of .orchestra (ORCHES~1) is flagged at freeze and refused at apply even when the freeze flag is ignored', { skip: SKIP }, async () => {
  const f = fixture();
  try {
    const capFile = path.join(f.store.orch, 'capability.json');
    const roomFile = path.join(f.store.orch, 'rooms', 'forged.json');
    assert.equal(fs.existsSync(capFile), false);
    // The worktree has no .orchestra, so a builder can create a literal ORCHES~1 directory there.
    const it = f.item('a', {
      'src/a.js': 'fine\n',
      'ORCHES~1/capability.json': '{"version":1,"agents":{"claude":{"result":"pass"}}}\n',
      'ORCHES~1/rooms/forged.json': '{}\n',
    }, { owns: ['src', 'ORCHES~1'] });
    const fz = f.frozen.a;
    assert.ok(fz.unsafe.includes('ORCHES~1/capability.json'), `unsafe: ${JSON.stringify(fz.unsafe)}`);
    assert.ok(fz.unsafe.includes('ORCHES~1/rooms/forged.json'), `unsafe: ${JSON.stringify(fz.unsafe)}`);
    assert.equal(fz.unsafe.includes('src/a.js'), false);

    // The fixture registers the item as passed and reviewed anyway: the apply path must refuse on its own.
    const before = wt.mainState(f.project);
    const pre = f.pre(it);
    assert.equal(pre.code, 'unsafe-proposal');
    assert.deepEqual([...pre.files].sort(), ['ORCHES~1/capability.json', 'ORCHES~1/rooms/forged.json']);
    const r = await f.apply(it);
    assert.deepEqual([r.ok, r.code], [false, 'unsafe-proposal']);
    assert.equal(it.status, 'passed');
    assert.equal(fs.existsSync(capFile), false);
    assert.equal(fs.existsSync(roomFile), false);
    assert.deepEqual(wt.mainState(f.project), before);
    assert.equal(f.room.expectedTree, f.headTree);
  } finally { f.cleanup(); }
});

test('apply re-derives paths from the patch bytes: a reserved path is refused even when the stored file list hides it', { skip: SKIP }, async () => {
  const f = fixture();
  try {
    const it = f.item('a', { 'src/a.js': 'fine\n', '.orchestra/capability.json': '{"version":1}\n' });
    assert.ok(f.frozen.a.unsafe.includes('.orchestra/capability.json'));
    it.proposal.files = ['src/a.js']; // the recorded list no longer mentions the reserved path
    const r = await f.apply(it);
    assert.deepEqual([r.ok, r.code], [false, 'unsafe-proposal']);
    assert.deepEqual(r.files, ['.orchestra/capability.json']);
    assert.equal(fs.existsSync(path.join(f.store.orch, 'capability.json')), false);
    assert.deepEqual(stagedNames(f.project), []);
  } finally { f.cleanup(); }
});

test('apply refuses a patch with a path outside the item owns, and accepts one inside it', { skip: SKIP }, async () => {
  const f = fixture();
  try {
    const out = f.item('a', { 'src/a.js': 'A\n', 'docs/x': 'outside\n' }, { owns: ['src'] });
    assert.deepEqual(f.frozen.a.outOfArea, ['docs/x']);
    const r = await f.apply(out);
    assert.deepEqual([r.ok, r.code, r.files], [false, 'unsafe-proposal', ['docs/x']]);
    assert.deepEqual(stagedNames(f.project), []);

    const inside = f.item('b', { 'src/b.js': 'B\n', 'src/new/c.js': 'C\n' }, { owns: ['src'] });
    const ok = await f.apply(inside);
    assert.equal(ok.ok, true, ok.reason);
    assert.deepEqual(stagedNames(f.project), ['src/b.js', 'src/new/c.js']);
  } finally { f.cleanup(); }
});

test('apply refuses a patch that adds a symlink or an embedded repository', { skip: SKIP }, async (t) => {
  const f = fixture();
  try {
    const wg = f.worktree('sub');
    initRepo(path.join(wg.dir, 'vendor', 'sub'), { 'z.txt': 'z\n' });
    const sub = f.freeze('sub', wg);
    assert.ok(f.frozen.sub.unsafe.includes('vendor/sub'));
    const rg = await f.apply(sub);
    assert.deepEqual([rg.ok, rg.code], [false, 'unsafe-proposal']);
    assert.match(rg.reason, /160000/);

    const wl = f.worktree('link');
    if (!addSymlink(wl.dir, 'link', 'README.md', false)) return t.skip('git does not record symlinks on this machine');
    const link = f.freeze('link', wl);
    const rl = await f.apply(link);
    assert.deepEqual([rl.ok, rl.code], [false, 'unsafe-proposal']);
    assert.match(rl.reason, /120000/);
    assert.deepEqual(stagedNames(f.project), []);
    assert.equal(fs.existsSync(path.join(f.project, 'link')), false);
  } finally { f.cleanup(); }
});

test('inspectPatch lists the paths git apply will touch, including binary, deleted and non-ASCII names, and every stated mode', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const w = f.worktree('a');
    write(w.dir, 'src/a.js', 'A\n');
    write(w.dir, 'src/bin.dat', Buffer.from([0, 1, 0, 2]));
    write(w.dir, 'docs/a b/ü.txt', 'u\n');
    fs.rmSync(path.join(w.dir, 'lib', 'c.js'));
    const it = f.freeze('a', w);
    const buf = patch.readProposal({ store: f.store, rel: it.proposal.file, hash: it.proposal.hash });
    const info = patch.inspectPatch(f.project, buf);
    assert.equal(info.ok, true, info.reason);
    assert.deepEqual([...info.files].sort(), ['docs/a b/ü.txt', 'lib/c.js', 'src/a.js', 'src/bin.dat']);
    assert.ok(info.modes.length >= 4 && info.modes.every((m) => m === '100644'), JSON.stringify(info.modes));
    assert.deepEqual([...info.files].sort(), [...it.proposal.files].sort());
  } finally { f.cleanup(); }
});

// git marks a worktree's .git file hidden, and Windows refuses to open a hidden file for overwrite: replace it.
const rewrite = (file, text) => { fs.rmSync(file, { force: true }); fs.writeFileSync(file, text); };

// A write seat controls every file in its worktree, `.git` included. If git found the repository through that file,
// a fake git dir whose config defines a filter driver, plus a `.gitattributes` that applies it, would make the
// board's own `git add -A` (freeze) run that command outside any CLI sandbox.
function plantEvilGitDir(f, w, marker) {
  const evil = path.join(w.dir, 'evilgit');
  gitIn(f.project, ['init', '-q', '--bare', evil]);
  gitIn(f.project, [`--git-dir=${evil}`, 'config', 'core.bare', 'false']);
  const m = marker.split(path.sep).join('/');
  gitIn(f.project, [`--git-dir=${evil}`, 'config', 'filter.pwn.clean', `echo pwned > "${m}"; cat`]);
  write(w.dir, '.gitattributes', '* filter=pwn\n');
}

test('(s1) a rewritten worktree .git pointing at a planted git dir is refused: freeze and re-hash run no git and no filter there', { skip: SKIP }, () => {
  const f = fixture();
  const out = tmpDir('ob-patch-out-');
  try {
    const marker = path.join(out, 'pwned.txt');
    const w = f.worktree('a');
    write(w.dir, 'src/a.js', 'module.exports = 10;\n');
    plantEvilGitDir(f, w, marker);
    const orig = fs.readFileSync(path.join(w.dir, '.git'), 'utf8');
    rewrite(path.join(w.dir, '.git'), 'gitdir: evilgit\n');

    // The attack is real: plain repository discovery in that worktree runs the planted filter.
    wt.runGit(w.dir, ['add', '-A']);
    assert.equal(fs.existsSync(marker), true, 'precondition: discovery through .git runs the filter');
    fs.rmSync(marker);

    const tampered = (e) => e.code === 'worktree-tampered' && /\.git was changed/.test(e.message);
    assert.throws(() => patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1 }), tampered);
    assert.throws(() => patch.hashWorktree({ worktreeDir: w.dir, startTree: w.startTree }), tampered);
    assert.equal(fs.existsSync(marker), false, 'no filter ran');
    assert.equal(fs.existsSync(path.join(f.store.orch, 'proposals', 'r1', 'a-r1.patch')), false, 'nothing was frozen');

    // A fresh process (no in-memory record) finds the admin dir in the main repository and refuses the same way.
    const modPath = require.resolve('../src/worktree');
    const cached = require.cache[modPath];
    delete require.cache[modPath];
    try {
      const fresh = require('../src/worktree');
      assert.throws(() => fresh.worktreeGitArgs(w.dir), tampered);
      rewrite(path.join(w.dir, '.git'), orig);
      const [gd] = fresh.worktreeGitArgs(w.dir);
      assert.equal(canon(gd.slice('--git-dir='.length)), canon(path.join(f.project, '.git', 'worktrees', 'a')));
    } finally { require.cache[modPath] = cached; }

    // With the real .git back, the planted .gitattributes alone runs nothing: config comes only from the main repository.
    fs.rmSync(path.join(w.dir, 'evilgit'), { recursive: true, force: true });
    const fz = patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1 });
    assert.equal(fz.empty, false);
    assert.deepEqual([...fz.files].sort(), ['.gitattributes', 'src/a.js']);
    assert.equal(fs.existsSync(marker), false, 'no filter ran');
  } finally { f.cleanup(); rmrf(out); }
});

test('(s2) a worktree .git pointing at the main repository, or replaced by a directory, is refused and the main index is untouched', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const w = f.worktree('a');
    write(w.dir, 'stray.txt', 'x\n');
    const dotGit = path.join(w.dir, '.git');
    const indexBefore = fs.readFileSync(path.join(f.project, '.git', 'index'));
    rewrite(dotGit, `gitdir: ${path.join(f.project, '.git').split(path.sep).join('/')}\n`);
    const tampered = (e) => e.code === 'worktree-tampered';
    const freeze = () => patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1 });
    assert.throws(freeze, tampered);
    fs.rmSync(dotGit);
    fs.mkdirSync(dotGit);
    assert.throws(freeze, (e) => tampered(e) && /not a regular file/.test(e.message));
    assert.deepEqual(fs.readFileSync(path.join(f.project, '.git', 'index')), indexBefore);
    assert.equal(wt.mainState(f.project).clean, true);
  } finally { f.cleanup(); }
});

test('owner areas are compared case sensitively on Linux: a differently cased path is outside', () => {
  const v = (file, areas) => patch.ownedAreaVerdict(file, areas, 'linux');
  assert.equal(v('src/a.js', ['src']), 'inside');
  assert.equal(v('src', ['src']), 'inside');
  assert.equal(v('SRC/evil.js', ['src']), 'outside');
  assert.equal(v('src/Lib/x.js', ['src/lib']), 'outside');
  assert.equal(v('src/libx.js', ['src/lib']), 'outside', 'prefix match is per directory');
  assert.equal(v('src/a.js', ['SRC']), 'outside');
});

test('owner areas on a case-insensitive platform (win32, darwin): a case-only alias is refused and named as such', () => {
  for (const platform of ['win32', 'darwin']) {
    const v = (file, areas) => patch.ownedAreaVerdict(file, areas, platform);
    assert.equal(v('src/a.js', ['src']), 'inside', platform);
    assert.equal(v('SRC/evil.js', ['src']), 'case-alias', platform);
    assert.equal(v('src/Lib/x.js', ['src/lib']), 'case-alias', platform);
    assert.equal(v('src/libx.js', ['src/lib']), 'outside', platform);
    assert.equal(v('docs/x', ['src']), 'outside', platform);
    const out = patch.outsideOwnedAreas(['src/a.js', 'SRC/evil.js'], ['src'], platform);
    assert.deepEqual(out, {
      reason: 'the patch touches a path that differs from an owned path only by case (case-insensitive filesystem)',
      files: ['SRC/evil.js'],
    }, platform);
  }
});

test('outsideOwnedAreas reports the plain outside reason on Linux and null when every file is inside', () => {
  assert.equal(patch.outsideOwnedAreas(['src/a.js'], ['src'], 'linux'), null);
  assert.deepEqual(patch.outsideOwnedAreas(['src/a.js', 'SRC/evil.js'], ['src'], 'linux'), {
    reason: 'the patch touches paths outside the areas the item owns',
    files: ['SRC/evil.js'],
  });
});

test('vetProposedDiff applies the owner-area check with the injected platform', { skip: SKIP }, () => {
  const f = fixture();
  try {
    const diff = (name) => [
      '```diff',
      `diff --git a/${name} b/${name}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${name}`,
      '@@ -0,0 +1 @@',
      '+x',
      '```',
    ].join('\n');
    const alias = diff('SRC/evil.js');
    const linux = patch.vetProposedDiff({ project: f.project, text: alias, owns: ['src'], platform: 'linux' });
    assert.equal(linux.ok, false);
    assert.equal(linux.code, 'outside-owns');
    assert.deepEqual(linux.files, ['SRC/evil.js']);
    assert.match(linux.reason, /outside the areas/);

    const win = patch.vetProposedDiff({ project: f.project, text: alias, owns: ['src'], platform: 'win32' });
    assert.equal(win.ok, false);
    assert.equal(win.code, 'outside-owns');
    assert.match(win.reason, /only by case/);

    const inside = patch.vetProposedDiff({ project: f.project, text: diff('src/new.js'), owns: ['src'], platform: 'linux' });
    assert.equal(inside.ok, true, inside.reason);
  } finally { f.cleanup(); }
});
