// Git worktree module: repository checks, board worktrees, fingerprints and the hook/junction safety rules.
// No server and no CLI. Every test needs real git and is skipped with a reason when git is not installed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, rmrf, hasGit, gitIn, initRepo, canon } = require('./helpers');
const { createStore } = require('../src/store');
const wt = require('../src/worktree');

const SKIP = !hasGit && 'git not available';

// A repo with the board's ignore rule in place, as startApp/store.ensure() would leave it.
function boardRepo(files) {
  const dir = tmpDir('ob-wt-');
  const head = initRepo(dir, files);
  createStore(dir).ensure();
  return { dir, head };
}

test('repoInfo: a non-git folder, a subfolder of a repo and a repo without commits are each refused with a reason', { skip: SKIP }, () => {
  const plain = tmpDir('ob-wt-plain-');
  try {
    createStore(plain).ensure();
    assert.deepEqual(wt.repoInfo(plain), { ok: false, reason: 'the project folder is not a git repository', head: null });
  } finally { rmrf(plain); }

  const { dir } = boardRepo({ 'sub/a.txt': 'a\n' });
  try {
    const sub = path.join(dir, 'sub');
    createStore(sub).ensure();
    assert.equal(wt.repoInfo(sub).reason, 'the project folder is not the root of a git repository');
  } finally { rmrf(dir); }

  const empty = tmpDir('ob-wt-empty-');
  try {
    gitIn(empty, ['init', '-q']);
    createStore(empty).ensure();
    assert.equal(wt.repoInfo(empty).reason, 'the repository has no commits yet');
  } finally { rmrf(empty); }
});

test('createWorktree: the dir is .orchestra/worktrees/<room>/<item>, writes inside it never reach the checkout', { skip: SKIP }, () => {
  const { dir, head } = boardRepo();
  try {
    const made = wt.createWorktree(dir, 'r1', 'item-a', head);
    assert.equal(made.rel, '.orchestra/worktrees/r1/item-a');
    assert.equal(canon(made.dir), canon(path.join(dir, '.orchestra', 'worktrees', 'r1', 'item-a')));
    assert.ok(fs.existsSync(path.join(made.dir, 'README.md')));
    fs.writeFileSync(path.join(made.dir, 'inside.txt'), 'only in the worktree\n');
    assert.equal(fs.existsSync(path.join(dir, 'inside.txt')), false);
    assert.equal(wt.mainState(dir).clean, true);
  } finally { rmrf(dir); }
});

test('isBoardWorktree: true for a board worktree; false for the project root, a temp dir and a hand-made dir', { skip: SKIP }, () => {
  const { dir, head } = boardRepo();
  const other = tmpDir('ob-wt-other-');
  try {
    const made = wt.createWorktree(dir, 'r', 'x', head);
    assert.equal(wt.isBoardWorktree(dir, made.dir), true);
    assert.equal(wt.isBoardWorktree(dir, dir), false);
    assert.equal(wt.isBoardWorktree(dir, other), false);
    const handMade = path.join(dir, '.orchestra', 'worktrees', 'r', 'hand');
    fs.mkdirSync(handMade, { recursive: true });
    assert.equal(wt.isBoardWorktree(dir, handMade), false);
  } finally { rmrf(dir); rmrf(other); }
});

test('removeWorktree: refuses the project root and a hand-made dir (both stay); removes a board worktree and unlists it', { skip: SKIP }, () => {
  const { dir, head } = boardRepo();
  try {
    assert.throws(() => wt.removeWorktree(dir, dir), /not a board-managed worktree/);
    assert.ok(fs.existsSync(path.join(dir, 'README.md')));
    const handMade = path.join(dir, '.orchestra', 'worktrees', 'r', 'hand');
    fs.mkdirSync(handMade, { recursive: true });
    assert.throws(() => wt.removeWorktree(dir, handMade), /not a board-managed worktree/);
    assert.ok(fs.existsSync(handMade));

    const made = wt.createWorktree(dir, 'r', 'gone', head);
    assert.deepEqual(wt.removeWorktree(dir, made.dir), { ok: true });
    assert.equal(fs.existsSync(made.dir), false);
    assert.equal(wt.listBoardWorktrees(dir).some((w) => canon(w.dir) === canon(made.dir)), false);
  } finally { rmrf(dir); }
});

test('fingerprint: stable across calls; changes after a tracked edit and after a new untracked file; excludeOrchestra ignores .orchestra', { skip: SKIP }, () => {
  const { dir } = boardRepo();
  try {
    const f1 = wt.fingerprint(dir);
    assert.equal(wt.fingerprint(dir), f1);
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
    const f2 = wt.fingerprint(dir);
    assert.notEqual(f2, f1);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    const f3 = wt.fingerprint(dir);
    assert.notEqual(f3, f2);

    const ex1 = wt.fingerprint(dir, { excludeOrchestra: true });
    fs.mkdirSync(path.join(dir, '.orchestra'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestra', 'note.txt'), 'board state\n');
    assert.equal(wt.fingerprint(dir, { excludeOrchestra: true }), ex1);
    assert.notEqual(wt.fingerprint(dir), f3);
  } finally { rmrf(dir); }
});

test('createWorktree: a post-checkout hook in .git/hooks does not run', { skip: SKIP }, () => {
  const { dir, head } = boardRepo();
  try {
    const marker = path.join(dir, 'hook-ran.marker');
    const hook = path.join(dir, '.git', 'hooks', 'post-checkout');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`);
    fs.chmodSync(hook, 0o755);
    wt.createWorktree(dir, 'r', 'hooked', head);
    assert.equal(fs.existsSync(marker), false);
  } finally { rmrf(dir); }
});

test('invalid room or item ids throw "invalid worktree id"', { skip: SKIP }, () => {
  const { dir, head } = boardRepo();
  try {
    assert.throws(() => wt.createWorktree(dir, '../escape', 'item', head), /invalid worktree id/);
    assert.throws(() => wt.createWorktree(dir, 'room', 'a/b', head), /invalid worktree id/);
    assert.throws(() => wt.createWorktree(dir, 'room', '', head), /invalid worktree id/);
    assert.throws(() => wt.worktreePath(dir, 'r'.repeat(65), 'item'), /invalid worktree id/);
    assert.throws(() => wt.removeRoomWorktrees(dir, '..'), /invalid worktree id/);
  } finally { rmrf(dir); }
});

test('createWorktree: a .orchestra/worktrees junction to an outside dir is refused and the outside dir stays empty', { skip: SKIP }, (t) => {
  const { dir, head } = boardRepo();
  const outside = tmpDir('ob-wt-outside-');
  const link = path.join(dir, '.orchestra', 'worktrees');
  try {
    try { fs.symlinkSync(outside, link, 'junction'); } catch (e) { return t.skip(`cannot create a junction here: ${e.code}`); }
    assert.throws(() => wt.createWorktree(dir, 'r', 'item', head), /refusing to create a worktree outside \.orchestra\/worktrees/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    try { fs.rmdirSync(link); } catch {}
    rmrf(dir); rmrf(outside);
  }
});

test('repoInfo: a repo whose .orchestra does not ignore worktrees/ is refused with the ignore reason', { skip: SKIP }, () => {
  const dir = tmpDir('ob-wt-noignore-');
  try {
    const head = initRepo(dir);
    assert.ok(head);
    fs.mkdirSync(path.join(dir, '.orchestra'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestra', '.gitignore'), 'session\n');
    assert.deepEqual(wt.repoInfo(dir), {
      ok: false,
      reason: '.orchestra/worktrees is not ignored by git (add "worktrees/" to .orchestra/.gitignore)',
      head: null,
    });
  } finally { rmrf(dir); }
});

test('gitVersion: reports a usable git on this machine', { skip: SKIP }, () => {
  const v = wt.gitVersion();
  assert.equal(v.ok, true, v.reason);
  assert.match(v.version, /^\d+\.\d+/);
});

test('removeRoomWorktrees: removes the room\'s worktrees and an orphan dir, returns the count, and leaves no room dir behind', { skip: SKIP }, () => {
  const { dir, head } = boardRepo();
  try {
    const a = wt.createWorktree(dir, 'room1', 'a', head);
    const b = wt.createWorktree(dir, 'room1', 'b', head);
    const orphan = path.join(dir, '.orchestra', 'worktrees', 'room1', 'orphan');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, '.git'), 'gitdir: nowhere\n');
    const count = wt.removeRoomWorktrees(dir, 'room1');
    assert.equal(count, 3);
    assert.equal(fs.existsSync(path.join(dir, '.orchestra', 'worktrees', 'room1')), false);
    assert.equal(fs.existsSync(a.dir), false);
    assert.equal(fs.existsSync(b.dir), false);
    assert.deepEqual(wt.listBoardWorktrees(dir), []);
  } finally { rmrf(dir); }
});

test('fingerprint: throws instead of hashing a failed git call (non-repo dir); never equal to itself', { skip: SKIP }, () => {
  const plain = tmpDir('ob-wt-fp-');
  try {
    assert.throws(() => wt.fingerprint(plain), /fingerprint failed/);
  } finally { rmrf(plain); }
});
