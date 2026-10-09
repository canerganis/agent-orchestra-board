// Git and worktree hardening (G3): git never trusts a board worktree's own .git file, worktrees hold no links, and
// hooks never run. Real git in temp repositories; no CLI, no server, no port.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, rmrf, hasGit, gitIn, initRepo, canon, exitGuard } = require('./helpers');
exitGuard();
const { createStore } = require('../src/store');
const { createCapability } = require('../src/capability');
const wt = require('../src/worktree');
const patch = require('../src/patch');

const SKIP = !hasGit && 'git not available';
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const tampered = (e) => e && e.code === 'worktree-tampered';

// A board project (the store's .orchestra/.gitignore ignores worktrees) with a capability whose runner never runs a
// CLI: guardTurn only needs a version for the record it writes on a violation. Records go to a temp folder.
function fixture(files = { 'README.md': 'hello\n', 'src/a.js': 'module.exports = 1;\n' }) {
  const root = tmpDir('ob-gh-');
  const project = path.join(root, 'project');
  const head = initRepo(project, files);
  const store = createStore(project);
  store.ensure();
  const runner = { cliVersions: () => ({ claude: { version: '9.9.9-test' }, codex: { version: '9.9.9-test' } }), detectCli: async () => ({}) };
  const seats = { all: () => [], get: () => null };
  const cap = createCapability({ store, runner, seats, recordsDir: path.join(root, 'records') });
  return { root, project, head, store, runner, seats, cap, cleanup: () => rmrf(root) };
}

function write(dir, rel, content) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

// git marks a worktree's .git file hidden, and Windows refuses to open a hidden file for overwrite: replace it.
const rewrite = (file, text) => { fs.rmSync(file, { force: true }); fs.writeFileSync(file, text); };
const posix = (p) => p.split(path.sep).join('/');

test('createWorktree returns dir, gitDir and startTree; runGitWt names the repository and turns symlinks off', { timeout: 90000, skip: SKIP }, () => {
  const f = fixture();
  try {
    const w = wt.createWorktree(f.project, 'r1', 'a', f.head);
    assert.equal(canon(w.gitDir), canon(path.join(f.project, '.git', 'worktrees', 'a')));
    assert.equal(w.startTree, gitIn(f.project, ['rev-parse', 'HEAD^{tree}']));
    assert.equal(w.baseCommit, f.head);
    assert.equal(w.rel, '.orchestra/worktrees/r1/a');
    const sym = wt.runGitWt(w.dir, ['config', '--get', 'core.symlinks']);
    assert.equal(sym.ok, true);
    assert.equal(String(sym.stdout).trim(), 'false');
    const gd = wt.runGitWt({ dir: w.dir, gitDir: w.gitDir }, ['rev-parse', '--absolute-git-dir']);
    assert.equal(canon(String(gd.stdout).trim()), canon(w.gitDir));
    // A stored gitDir that is not this worktree's admin dir is refused before git runs.
    const other = wt.createWorktree(f.project, 'r1', 'b', f.head);
    assert.throws(() => wt.runGitWt({ dir: w.dir, gitDir: other.gitDir }, ['status']), tampered);
    assert.throws(() => wt.runGitWt({ dir: w.dir, gitDir: 'relative/admin' }, ['status']), tampered);
    // A dir that is not a board worktree is refused.
    assert.throws(() => wt.runGitWt(f.project, ['status']), tampered);
  } finally { f.cleanup(); }
});

test('a rewritten worktree .git pointing at a planted git dir with a filter: diffBytes and fingerprint run no filter, the guard reports a change', { timeout: 90000, skip: SKIP }, async () => {
  const f = fixture();
  const out = tmpDir('ob-gh-out-');
  const marker = path.join(out, 'pwned.txt');
  try {
    const w = wt.createWorktree(f.project, 'r1', 'a', f.head);
    const guard = await f.cap.guardTurn({ agent: 'claude', worktreeDir: w.dir });

    // What a write seat can do inside its worktree: a fake git dir whose config defines a clean filter, a
    // .gitattributes applying it to every file, and a .git file pointing at the fake git dir.
    write(w.dir, 'src/a.js', 'module.exports = 10;\n');
    const evil = path.join(w.dir, 'evilgit');
    gitIn(f.project, ['init', '-q', '--bare', evil]);
    gitIn(f.project, [`--git-dir=${evil}`, 'config', 'core.bare', 'false']);
    gitIn(f.project, [`--git-dir=${evil}`, 'config', 'filter.x.clean', `echo pwned > "${posix(marker)}"; cat`]);
    write(w.dir, '.gitattributes', '* filter=x\n');
    const dotGit = path.join(w.dir, '.git');
    const orig = fs.readFileSync(dotGit, 'utf8');
    rewrite(dotGit, 'gitdir: evilgit\n');

    // The attack is real: plain repository discovery in that worktree runs the planted filter.
    wt.runGit(w.dir, ['add', '-A']);
    assert.equal(fs.existsSync(marker), true, 'precondition: discovery through .git runs the filter');
    fs.rmSync(marker);

    assert.throws(() => patch.diffBytes(w.dir, w.startTree), tampered);
    assert.throws(() => patch.diffBytes(w.dir, w.startTree, { dir: w.dir, gitDir: w.gitDir, project: f.project }), tampered);
    assert.throws(() => patch.hashWorktree({ worktreeDir: w.dir, startTree: w.startTree, gitDir: w.gitDir }), tampered);
    assert.throws(() => wt.fingerprint(w.dir), tampered);
    assert.throws(() => wt.fingerprint(w.dir, { excludeOrchestra: true }), tampered);
    assert.equal(fs.existsSync(marker), false, 'no filter ran');

    const r = await guard.finish();
    assert.equal(r.ok, false);
    assert.ok(r.changed.includes('.orchestra/worktrees/r1/a/.git'), JSON.stringify(r.changed));
    assert.equal(fs.existsSync(marker), false, 'no filter ran in the guard');

    // A fresh process (no in-memory record) with the stored gitDir refuses the same way, and works once .git is back.
    const modPath = require.resolve('../src/worktree');
    const cached = require.cache[modPath];
    delete require.cache[modPath];
    try {
      const fresh = require('../src/worktree');
      assert.throws(() => fresh.runGitWt({ dir: w.dir, gitDir: w.gitDir }, ['add', '-A']), tampered);
      assert.throws(() => fresh.fingerprint(w.dir), tampered);
      assert.equal(fs.existsSync(marker), false, 'no filter ran');
      rewrite(dotGit, orig);
      fs.rmSync(evil, { recursive: true, force: true });
      assert.equal(fresh.runGitWt({ dir: w.dir, gitDir: w.gitDir }, ['status', '--porcelain']).ok, true);
      assert.match(fresh.fingerprint(w.dir), /^[0-9a-f]{64}$/);
    } finally { require.cache[modPath] = cached; }
    // The planted .gitattributes alone runs nothing: config comes only from the main repository.
    assert.ok(patch.diffBytes(w.dir, w.startTree).length > 0);
    assert.equal(fs.existsSync(marker), false, 'no filter ran');
  } finally { f.cleanup(); rmrf(out); }
});

test('the guard hashes the worktree .git: a byte change that still points at the right git dir is a change', { timeout: 90000, skip: SKIP }, async () => {
  const f = fixture();
  try {
    const w = wt.createWorktree(f.project, 'r1', 'a', f.head);
    const dotGit = path.join(w.dir, '.git');
    const orig = fs.readFileSync(dotGit, 'utf8');
    const g = await f.cap.guardTurn({ agent: 'claude', worktreeDir: w.dir });
    write(w.dir, 'src/a.js', 'module.exports = 2;\n');
    assert.deepEqual(await g.finish(), { ok: true, changed: [] }, 'a change inside the worktree is fine');

    // Same target, other bytes (CRLF). A board process that did not create the worktree (a restart) has no record of
    // the exact text and accepts it as a pointer; the guard still sees the change because it compares the bytes.
    const mods = ['../src/worktree', '../src/capability'].map((m) => require.resolve(m));
    const saved = mods.map((m) => require.cache[m]);
    for (const m of mods) delete require.cache[m];
    try {
      const freshWt = require('../src/worktree');
      const freshCap = require('../src/capability').createCapability({ store: f.store, runner: f.runner, seats: f.seats, recordsDir: path.join(f.root, 'records') });
      const g2 = await freshCap.guardTurn({ agent: 'claude', worktreeDir: w.dir });
      rewrite(dotGit, orig.replace(/\r?\n$/, '') + '\r\n');
      assert.equal(canon(freshWt.worktreeGitDir(w.dir)), canon(w.gitDir), 'precondition: the CRLF pointer is accepted');
      const r2 = await g2.finish();
      assert.equal(r2.ok, false);
      assert.deepEqual(r2.changed, ['.orchestra/worktrees/r1/a/.git']);
    } finally { mods.forEach((m, i) => { require.cache[m] = saved[i]; }); }
    // .git removed during the turn: a change as well.
    rewrite(dotGit, orig);
    const g3 = await f.cap.guardTurn({ agent: 'claude', worktreeDir: w.dir });
    fs.rmSync(dotGit);
    assert.deepEqual((await g3.finish()).changed, ['.orchestra/worktrees/r1/a/.git']);
  } finally { f.cleanup(); }
});

test('a symlink committed in the base checks out as a plain file in a board worktree', { timeout: 90000, skip: SKIP }, async () => {
  const f = fixture();
  try {
    // Commit a symlink without needing the privilege to create one: a blob plus a 120000 index entry.
    gitIn(f.project, ['config', 'core.symlinks', 'true']);
    const h = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.project, input: '../../outside', encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(h.status, 0, h.stderr);
    gitIn(f.project, ['update-index', '--add', '--cacheinfo', `120000,${h.stdout.trim()},link`]);
    gitIn(f.project, [...ID, 'commit', '-q', '-m', 'add a link']);
    const head = gitIn(f.project, ['rev-parse', 'HEAD']);
    assert.match(gitIn(f.project, ['ls-tree', head, 'link']), /^120000 /);

    const w = wt.createWorktree(f.project, 'r1', 'a', head);
    const st = fs.lstatSync(path.join(w.dir, 'link'));
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
    assert.equal(fs.readFileSync(path.join(w.dir, 'link'), 'utf8'), '../../outside');
    // Consistent afterwards: nothing pending, and the write guard starts (no link in the worktree).
    assert.equal(patch.diffBytes(w.dir, w.startTree).length, 0);
    assert.deepEqual(wt.findLinks(w.dir).links, []);
    const g = await f.cap.guardTurn({ agent: 'claude', worktreeDir: w.dir });
    assert.deepEqual(await g.finish(), { ok: true, changed: [] });
  } finally { f.cleanup(); }
});

test('a link created in the worktree makes the next write turn refuse with its relative path', { timeout: 90000, skip: SKIP }, async () => {
  const f = fixture();
  const outside = tmpDir('ob-gh-outside-');
  let link = null;
  try {
    const w = wt.createWorktree(f.project, 'r1', 'a', f.head);
    link = path.join(w.dir, 'src', 'out');
    // A junction needs no privilege on Windows; elsewhere a directory symlink.
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(wt.findLinks(w.dir), { links: ['src/out'], capped: false, entries: 4 });
    await assert.rejects(f.cap.guardTurn({ agent: 'claude', worktreeDir: w.dir }), (e) => {
      assert.equal(e.code, 'worktree-link');
      assert.match(e.message, /^refusing the write turn: \.orchestra\/worktrees\/r1\/a contains a symbolic link or junction: src\/out$/);
      return true;
    });
    // Refusing is not a violation: nothing was recorded for the CLI.
    assert.equal(fs.existsSync(path.join(f.root, 'records', 'capability.json')), false);

    // Without the link the turn may start again.
    try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
    link = null;
    const g = await f.cap.guardTurn({ agent: 'claude', worktreeDir: w.dir });
    assert.deepEqual(await g.finish(), { ok: true, changed: [] });

    // A file symlink, where this machine allows creating one.
    let fileLink = path.join(w.dir, 'doc-link');
    try { fs.symlinkSync(path.join(outside, 'x.txt'), fileLink, 'file'); } catch { fileLink = null; }
    if (fileLink) {
      await assert.rejects(f.cap.guardTurn({ agent: 'claude', worktreeDir: w.dir }), (e) => e.code === 'worktree-link' && /doc-link$/.test(e.message));
      fs.unlinkSync(fileLink);
    }
  } finally {
    if (link) { try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch {} } }
    f.cleanup(); rmrf(outside);
  }
});

test('a junction made during the write turn is a violation and never reaches a frozen proposal', { timeout: 90000, skip: SKIP }, async () => {
  const f = fixture();
  const outside = tmpDir('ob-gh-outside-');
  const link = () => path.join(f.project, '.orchestra', 'worktrees', 'r1', 'a', 'j');
  const unlink = (p) => { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch {} } };
  try {
    write(outside, 'secret.txt', 'outside the worktree\n');
    const w = wt.createWorktree(f.project, 'r1', 'a', f.head);
    const g = await f.cap.guardTurn({ agent: 'claude', worktreeDir: w.dir });
    // What a builder can do in its last turn: a junction (no privilege needed on Windows), elsewhere a dir symlink.
    write(w.dir, 'src/a.js', 'module.exports = 4;\n');
    fs.symlinkSync(outside, link(), process.platform === 'win32' ? 'junction' : 'dir');

    const r = await g.finish();
    assert.equal(r.ok, false);
    assert.deepEqual(r.changed, ['.orchestra/worktrees/r1/a/j (a symbolic link or junction)']);
    // A guard violation is persisted as a failed write check.
    const rec = JSON.parse(fs.readFileSync(path.join(f.root, 'records', 'capability.json'), 'utf8'));
    assert.match(JSON.stringify(rec), /symbolic link or junction/);

    // The board never stages through the link, whatever path leads there.
    const isLink = (e) => e && e.code === 'worktree-link' && /contains a symbolic link or junction: j$/.test(e.message) && e.links.join() === 'j';
    assert.throws(() => patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1, gitDir: w.gitDir }), isLink);
    assert.throws(() => patch.hashWorktree({ worktreeDir: w.dir, startTree: w.startTree, project: f.project, gitDir: w.gitDir }), isLink);
    assert.throws(() => patch.diffBytes(w.dir, w.startTree), isLink);
    assert.throws(() => patch.prepareWorktree({ store: f.store, worktreeDir: w.dir, gitDir: w.gitDir }), (e) => e.code === 'worktree-link' && /^refusing to apply into the worktree: /.test(e.message));
    assert.equal(fs.existsSync(path.join(f.store.orch, 'proposals')), false, 'no proposal was written');
    const staged = wt.runGitWt({ dir: w.dir, gitDir: w.gitDir }, ['diff', '--cached', '--name-only']);
    assert.equal(String(staged.stdout).trim(), '', 'nothing was staged');

    // Without the link the freeze works and holds only the file inside the worktree.
    unlink(link());
    const fr = patch.freezeProposal({ store: f.store, worktreeDir: w.dir, startTree: w.startTree, roomId: 'r1', itemId: 'a', round: 1, gitDir: w.gitDir });
    assert.deepEqual(fr.files, ['src/a.js']);
    assert.deepEqual(fr.unsafe, []);
  } finally {
    unlink(link());
    f.cleanup(); rmrf(outside);
  }
});

test('findLinks: skips only the top-level .git, does not follow links, and reports the cap', { timeout: 90000, skip: SKIP }, () => {
  const dir = tmpDir('ob-gh-walk-');
  const outside = tmpDir('ob-gh-walk-out-');
  try {
    write(dir, '.git', 'gitdir: x\n');
    write(dir, 'a/b/c.txt', 'c');
    write(dir, 'a/.git/HEAD', 'ref');
    write(outside, 'deep/inner.txt', 'x');
    fs.symlinkSync(outside, path.join(dir, 'a', 'b', 'j'), process.platform === 'win32' ? 'junction' : 'dir');
    const r = wt.findLinks(dir);
    assert.deepEqual(r, { links: ['a/b/j'], capped: false, entries: 6 });
    assert.equal(wt.findLinks(dir, { max: 3 }).capped, true);
    assert.equal(wt.LINK_WALK_MAX, 50000);
    assert.throws(() => wt.findLinks(path.join(dir, 'missing')));
    try { fs.unlinkSync(path.join(dir, 'a', 'b', 'j')); } catch { fs.rmdirSync(path.join(dir, 'a', 'b', 'j')); }
  } finally { rmrf(dir); rmrf(outside); }
});

test('hooks: core.hooksPath is <private dir>/absent, never created, and a hook placed in the private dir does not run', { timeout: 90000, skip: SKIP }, () => {
  const f = fixture();
  const out = tmpDir('ob-gh-hook-');
  const marker = path.join(out, 'hook-ran.txt');
  const hooks = ['pre-commit', 'post-commit'].map((h) => path.join(wt.NO_HOOKS, h));
  try {
    const hp = wt.HOOKS_PATH;
    assert.equal(path.basename(hp), 'absent');
    assert.equal(path.dirname(hp), wt.NO_HOOKS);
    assert.equal(fs.existsSync(hp), false);
    const got = wt.runGit(f.project, ['config', '--get', 'core.hooksPath']);
    assert.equal(String(got.stdout).trim(), hp);

    for (const h of hooks) { fs.writeFileSync(h, `#!/bin/sh\necho ran >> "${posix(marker)}"\n`); fs.chmodSync(h, 0o755); }
    // Precondition: the same hooks run when hooksPath names the private dir itself.
    assert.equal(wt.runGit(f.project, ['-c', `core.hooksPath=${wt.NO_HOOKS}`, ...ID, 'commit', '-q', '--allow-empty', '-m', 'probe']).ok, true);
    assert.equal(fs.existsSync(marker), true, 'precondition: a hook in that dir runs when it is the hooks path');
    fs.rmSync(marker);

    assert.equal(wt.runGit(f.project, [...ID, 'commit', '-q', '--allow-empty', '-m', 'no hooks']).ok, true);
    const w = wt.createWorktree(f.project, 'r1', 'a', gitIn(f.project, ['rev-parse', 'HEAD']));
    write(w.dir, 'src/a.js', 'module.exports = 3;\n');
    assert.equal(wt.runGitWt(w.dir, [...ID, 'commit', '-q', '-am', 'in the worktree']).ok, true);
    assert.equal(fs.existsSync(marker), false, 'no hook ran');
    assert.equal(fs.existsSync(hp), false);
  } finally {
    for (const h of hooks) fs.rmSync(h, { force: true });
    f.cleanup(); rmrf(out);
  }
});
