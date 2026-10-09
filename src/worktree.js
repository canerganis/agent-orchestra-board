// Git worktrees for write-mode builds, plus the git helpers the board uses to check and fingerprint a checkout.
// Every git call goes through runGit(): hooks are disabled (core.hooksPath points at a never created path inside a
// private dir), fsmonitor and external diff drivers are off, and inherited GIT_DIR-style variables are stripped so a stray
// environment cannot point git at another repository. Worktrees are detached: no branches are created. git never
// discovers a board worktree's repository through the worktree's own .git file: every git call on one goes through
// runGitWt (see worktreeGitArgs). Worktrees are checked out with core.symlinks=false, so a committed link becomes a
// plain file, and a worktree that holds a link is refused (assertNoLinks): guardTurn will not start a write turn there,
// reports a link created during the turn as a violation, and the board never stages or applies into it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileResolved } = require('./platform');

const WIN = process.platform === 'win32';
const ID_RE = /^[\w-]{1,64}$/;
const MIN_GIT = [2, 25];

// ---------- environment and hooks ----------

// Private directory (mkdtemp, owner only) created on first use, then reused. git's core.hooksPath is
// <noHooksDir>/absent, a path the board never creates: git finds no hooks there, and a file someone drops into the
// private directory itself is not a hook either.
let noHooksDir = null;
function getNoHooks() {
  if (!noHooksDir) noHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-nohooks-'));
  return noHooksDir;
}
const hooksPath = () => path.join(getNoHooks(), 'absent');

const STRIP_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_COMMON_DIR'];

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = WIN ? k.toUpperCase() : k;
    if (STRIP_ENV.includes(key)) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

// Config prepended to every git call (built on first use, because it needs the hooks dir).
function safeArgs() {
  return ['-c', `core.hooksPath=${hooksPath()}`, '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'color.ui=false', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=false'];
}

// Runs git and never throws on a non-zero exit. Throws ENOGIT only when git itself cannot be found.
function runGit(cwd, args, { input, buffer = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  // A missing working directory is reported as a failed call, not as a missing git (spawn reports both as ENOENT).
  if (!fs.existsSync(cwd)) return { ok: false, code: -1, stdout: buffer ? Buffer.alloc(0) : '', stderr: `directory not found: ${cwd}` };
  try {
    const stdout = execFileResolved('git', [...safeArgs(), ...args], {
      cwd, input, encoding: buffer ? 'buffer' : 'utf8', maxBuffer, windowsHide: true, env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, stdout, stderr: '' };
  } catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('git was not found on PATH'), { code: 'ENOGIT' });
    return { ok: false, code: e.status ?? -1, stdout: e.stdout ?? (buffer ? Buffer.alloc(0) : ''), stderr: String(e.stderr || e.message) };
  }
}

// ---------- version ----------

let versionCache = null;
function gitVersion() {
  if (versionCache) return versionCache;
  let result;
  try {
    const r = runGit(os.tmpdir(), ['--version']);
    const m = r.ok ? /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(r.stdout) : null;
    if (!m) {
      result = { ok: false, version: null, reason: 'git was not found on PATH' };
    } else {
      const version = `${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ''}`;
      const [maj, min] = [Number(m[1]), Number(m[2])];
      const tooOld = maj < MIN_GIT[0] || (maj === MIN_GIT[0] && min < MIN_GIT[1]);
      result = tooOld
        ? { ok: false, version, reason: `git ${version} is too old (need 2.25 or newer)` }
        : { ok: true, version, reason: null };
    }
  } catch (e) {
    result = { ok: false, version: null, reason: 'git was not found on PATH' };
  }
  versionCache = result;
  return result;
}

// ---------- paths ----------

// Canonical form for comparisons: real path when it exists, lower-cased on Windows, no trailing separator.
function canon(p) {
  let r;
  try { r = fs.realpathSync.native(p); } catch { r = path.resolve(String(p)); }
  if (WIN) r = r.toLowerCase();
  while (r.length > path.parse(r).root.length && /[\\/]$/.test(r)) r = r.slice(0, -1);
  return r;
}

// True when child is root or inside it (path-segment prefix). With strict, equality is false.
function within(child, root, { strict = false } = {}) {
  const c = canon(child), r = canon(root);
  if (c === r) return !strict;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}

const isSymlinkPath = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const existsNoFollow = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

function worktreeRoot(project) {
  return path.join(project, '.orchestra', 'worktrees');
}

function checkIds(roomId, itemId) {
  if (!ID_RE.test(String(roomId)) || !ID_RE.test(String(itemId))) throw new Error('invalid worktree id');
}

function worktreePath(project, roomId, itemId) {
  checkIds(roomId, itemId);
  return path.join(worktreeRoot(project), roomId, itemId);
}

// ---------- repository checks ----------

function repoInfo(project) {
  const fail = (reason) => ({ ok: false, reason, head: null });
  const v = gitVersion();
  if (!v.ok) return fail(v.reason);
  const top = runGit(project, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return fail('the project folder is not a git repository');
  if (canon(String(top.stdout).trim()) !== canon(project)) return fail('the project folder is not the root of a git repository');
  const bare = runGit(project, ['rev-parse', '--is-bare-repository']);
  if (bare.ok && String(bare.stdout).trim() === 'true') return fail('the project folder is not a git repository');
  const head = runGit(project, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!head.ok) return fail('the repository has no commits yet');
  const ignored = runGit(project, ['check-ignore', '-q', '--no-index', '.orchestra/worktrees/x']);
  if (!ignored.ok) return fail('.orchestra/worktrees is not ignored by git (add "worktrees/" to .orchestra/.gitignore)');
  return { ok: true, reason: null, head: String(head.stdout).trim() };
}

// The checkout as the board sees it (".orchestra" excluded). Lists are empty when nothing is pending.
function mainState(project) {
  const PS = ['--', '.', ':(exclude).orchestra'];
  const list = (args) => {
    const r = runGit(project, args);
    // A failed listing must never look clean: it is reported as a pending entry.
    if (!r.ok) return [`git failed: ${args[0]}`];
    return String(r.stdout).split('\0').filter(Boolean);
  };
  const revParse = (rev) => { const r = runGit(project, ['rev-parse', rev]); return r.ok ? String(r.stdout).trim() : null; };
  const head = revParse('HEAD');
  const headTree = revParse('HEAD^{tree}');
  const w = runGit(project, ['write-tree']);
  const indexTree = w.ok ? String(w.stdout).trim() : null;
  const staged = list(['diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD', ...PS]);
  const unstaged = list(['diff', '--name-only', '-z', '--no-renames', ...PS]);
  const untracked = list(['ls-files', '--others', '--exclude-standard', '-z', ...PS]);
  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && indexTree !== null && indexTree === headTree;
  return { head, headTree, indexTree, staged, unstaged, untracked, clean };
}

// Read-only digest of the checkout: HEAD, the binary diff against HEAD, and every untracked file's content.
// Never stages or writes anything. Fails closed: any git call that does not succeed, or any file that cannot be
// read, throws instead of contributing a constant to the hash. A digest that silently ignored part of the state
// could compare equal across a real change, which is exactly what the runtime guard must not allow.
// A dir shaped like a board worktree (<project>/.orchestra/worktrees/<room>/<item>), or opts.wt, goes through runGitWt:
// the repository is named explicitly and the call throws (code 'worktree-tampered') when the worktree's .git cannot be
// trusted. opts.wt: { dir, gitDir, project } with the admin dir the caller already verified or stored.
const FINGERPRINT_MAX_DIFF = 1024 * 1024 * 1024; // 1 GiB: a large binary change must not make the diff unreadable
function fingerprint(dir, { excludeOrchestra = false, wt = null } = {}) {
  const pathspec = excludeOrchestra ? ['--', '.', ':(exclude).orchestra'] : ['--', '.'];
  const board = wt || (boardShaped(dir) ? dir : null);
  const mustRun = (args, opts) => {
    const r = board ? runGitWt(board, args, opts) : runGit(dir, args, opts);
    if (!r.ok) throw new Error(`fingerprint failed: git ${args[0]}: ${String(r.stderr).trim() || `exit ${r.code}`}`);
    return r.stdout;
  };
  const head = String(mustRun(['rev-parse', 'HEAD'])).trim();
  const diff = mustRun(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', ...pathspec], { buffer: true, maxBuffer: FINGERPRINT_MAX_DIFF });
  const files = String(mustRun(['ls-files', '--others', '--exclude-standard', '-z', ...pathspec])).split('\0').filter(Boolean).sort();
  const h = crypto.createHash('sha256');
  h.update('HEAD:' + head);
  h.update('\nDIFF:' + crypto.createHash('sha256').update(diff).digest('hex'));
  for (const f of files) {
    const full = path.join(dir, f);
    let digest;
    try {
      const st = fs.lstatSync(full);
      // A symlink is hashed by its target text, never by reading whatever it points at.
      digest = st.isSymbolicLink()
        ? crypto.createHash('sha256').update('link:' + fs.readlinkSync(full)).digest('hex')
        : crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    } catch (e) {
      throw new Error(`fingerprint failed: cannot read ${f}: ${e.code || e.message}`);
    }
    h.update(`\nU:${f}:${digest}`);
  }
  return h.digest('hex');
}

// ---------- worktrees ----------

function createWorktree(project, roomId, itemId, baseCommit) {
  checkIds(roomId, itemId);
  const orch = path.join(project, '.orchestra');
  const root = worktreeRoot(project);
  const roomDir = path.join(root, roomId);
  const refuse = () => new Error('refusing to create a worktree outside .orchestra/worktrees');
  // Existing links are refused first (the security reason is reported before any repository state) and before anything is created through them.
  for (const p of [orch, root]) if (isSymlinkPath(p)) throw refuse();
  const info = repoInfo(project);
  if (!info.ok) throw new Error(info.reason);
  if (!/^[0-9a-f]{40,64}$/.test(String(baseCommit || '')) || !runGit(project, ['cat-file', '-e', `${baseCommit}^{commit}`]).ok) {
    throw new Error('invalid base commit');
  }
  fs.mkdirSync(roomDir, { recursive: true });
  for (const p of [orch, root, roomDir]) if (isSymlinkPath(p)) throw refuse();
  if (!within(roomDir, project)) throw refuse();
  const dir = path.join(roomDir, itemId);
  if (existsNoFollow(dir)) throw new Error(`worktree already exists: ${relOf(project, dir)}`);
  // core.symlinks=false: a link committed in the base is checked out as a plain file holding the link text.
  const r = runGit(project, ['-c', 'core.symlinks=false', 'worktree', 'add', '--detach', '--quiet', dir, baseCommit]);
  if (!r.ok) throw new Error('git worktree add failed: ' + String(r.stderr).trim());
  // Record the admin dir and the exact .git file now, before any agent has run in the worktree.
  let rec;
  try {
    const g = runGit(dir, ['rev-parse', '--absolute-git-dir']);
    if (!g.ok) throw new Error('git rev-parse failed: ' + String(g.stderr).trim());
    const gitDir = String(g.stdout).trim();
    if (!within(gitDir, adminRoot(project), { strict: true }) || isSymlinkPath(gitDir)) throw new Error('the worktree git dir is not under .git/worktrees');
    const dotGit = path.join(dir, '.git');
    if (!fs.lstatSync(dotGit).isFile()) throw new Error('the worktree .git is not a file');
    rec = { gitDir: canon(gitDir), dotGit: fs.readFileSync(dotGit, 'utf8') };
    if (!pointsAt(rec.dotGit, rec.gitDir)) throw new Error('the worktree .git does not point at its git dir');
  } catch (e) {
    try { removeWorktree(project, dir); } catch {}
    throw new Error(`could not record the worktree git dir: ${e.message}`);
  }
  recorded.set(canon(dir), rec);
  let startTree;
  try {
    const t = runGitWt({ dir, project, gitDir: rec.gitDir }, ['rev-parse', '--verify', '-q', `${baseCommit}^{tree}`]);
    if (!t.ok) throw new Error(String(t.stderr).trim() || `exit ${t.code}`);
    startTree = String(t.stdout).trim();
  } catch (e) {
    try { removeWorktree(project, dir); } catch {}
    throw new Error(`could not read the worktree start tree: ${e.message}`);
  }
  return { dir, rel: relOf(project, dir), baseCommit, gitDir: rec.gitDir, startTree };
}

// ---------- trusted git for a board worktree ----------
// git normally finds a linked worktree's repository through `<worktree>/.git`, an ordinary file a write seat can
// rewrite: pointed at a crafted git dir, its config could run a filter driver (`git add -A`) as the board process;
// pointed at the main .git, `git add -A` would rewrite the main index. The board never lets git discover a worktree's
// repository. worktreeGitArgs() takes the admin dir from the board's own record or from the main repository
// (<project>/.git/worktrees/*/gitdir, outside every worktree), checks that `.git` is still the regular file git wrote,
// and returns explicit --git-dir/--work-tree options: config, filter and diff drivers then come only from the main
// repository. Any mismatch throws (code 'worktree-tampered') before git runs there.

const recorded = new Map(); // canon(worktree dir) -> { gitDir (canonical), dotGit (exact .git contents) }

const adminRoot = (project) => path.join(project, '.git', 'worktrees');

// True when a .git file's text is `gitdir: <absolute path>` naming gitDir.
function pointsAt(text, gitDir) {
  const m = /^gitdir: (.+?)\r?\n?$/.exec(String(text));
  return !!m && path.isAbsolute(m[1]) && canon(m[1]) === canon(gitDir);
}

// True when the admin dir's `gitdir` back-pointer (written by git, outside every worktree) names <dir>/.git.
function backPointsAt(admin, dir) {
  let back;
  try { back = fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim(); } catch { return false; }
  return path.basename(back) === '.git' && path.isAbsolute(back) && canon(path.dirname(back)) === canon(dir);
}

// The admin dir whose `gitdir` back-pointer names <dir>/.git, read from the main repository only.
function findAdminDir(project, dir) {
  const root = adminRoot(project);
  if (isSymlinkPath(path.join(project, '.git')) || isSymlinkPath(root)) return null;
  let names = [];
  try { names = fs.readdirSync(root); } catch { return null; }
  for (const name of names) {
    const admin = path.join(root, name);
    if (backPointsAt(admin, dir)) return admin;
  }
  return null;
}

// The project a board worktree belongs to: <project>/.orchestra/worktrees/<room>/<item>.
function projectOf(dir) {
  return path.resolve(dir, '..', '..', '..', '..');
}

// True for a path shaped like a board worktree: <anything>/.orchestra/worktrees/<room>/<item>.
function boardShaped(dir) {
  const root = path.dirname(path.dirname(path.resolve(String(dir))));
  const name = (p) => (WIN ? path.basename(p).toLowerCase() : path.basename(p));
  return name(root) === 'worktrees' && name(path.dirname(root)) === '.orchestra';
}

// Verified admin dir of a board worktree. Throws (code 'worktree-tampered') when it cannot be trusted.
// storedGitDir: the admin dir a build item recorded at creation (createWorktree's gitDir). Without one, the board's
// in-process record or the main repository's back-pointers name it; the worktree's .git file never does.
function worktreeGitDir(dir, project = projectOf(dir), storedGitDir = null) {
  const fail = (why) => Object.assign(new Error(`refusing to run git in ${relOf(project, dir)}: ${why}`), { code: 'worktree-tampered' });
  const root = worktreeRoot(project);
  if (!within(dir, root, { strict: true }) || isSymlinkPath(dir) || canon(path.dirname(path.dirname(dir))) !== canon(root)) {
    throw fail('not a board worktree');
  }
  const rec = recorded.get(canon(dir));
  let gitDir;
  if (storedGitDir) {
    if (!path.isAbsolute(String(storedGitDir))) throw fail('its stored git dir is not an absolute path');
    gitDir = canon(storedGitDir);
    if (rec && rec.gitDir !== gitDir) throw fail('its stored git dir does not match the one recorded at creation');
    if (!backPointsAt(gitDir, dir)) throw fail('its stored git dir does not belong to it');
  } else {
    gitDir = rec ? rec.gitDir : findAdminDir(project, dir);
  }
  if (!gitDir) throw fail('the main repository has no record of it');
  if (!within(gitDir, adminRoot(project), { strict: true }) || isSymlinkPath(gitDir)) throw fail('its git dir is not under .git/worktrees');
  const dotGit = path.join(dir, '.git');
  let st;
  try { st = fs.lstatSync(dotGit); } catch { throw fail('.git is missing'); }
  if (!st.isFile()) throw fail('.git is not a regular file');
  let text;
  try { text = fs.readFileSync(dotGit, 'utf8'); } catch (e) { throw fail(`.git cannot be read (${e.code || e.message})`); }
  if (rec ? text !== rec.dotGit : !pointsAt(text, gitDir)) throw fail('.git was changed');
  return gitDir;
}

// Global git options for a board worktree: the repository is named explicitly, never discovered.
function worktreeGitArgs(dir, project, storedGitDir = null) {
  return [`--git-dir=${worktreeGitDir(dir, project, storedGitDir)}`, `--work-tree=${dir}`];
}

// The one way to run git on a board worktree. wt: the worktree dir, or { dir, gitDir?, project? } with the admin dir
// a build item stored. Runs in the worktree with explicit --git-dir/--work-tree (re-verified on every call) and
// core.symlinks=false. Like runGit it never throws on a git failure; it throws (code 'worktree-tampered') when the
// worktree cannot be trusted, before git runs.
function runGitWt(wt, args, opts) {
  const w = typeof wt === 'string' ? { dir: wt } : (wt || {});
  if (!w.dir) throw Object.assign(new Error('refusing to run git: no worktree given'), { code: 'worktree-tampered' });
  const g = worktreeGitArgs(w.dir, w.project || projectOf(w.dir), w.gitDir || null);
  return runGit(w.dir, ['-c', 'core.symlinks=false', ...g, ...args], opts);
}

// sha256 of a worktree's .git entry: its type and exact bytes. Throws when it cannot be read.
function dotGitHash(dir) {
  const p = path.join(dir, '.git');
  const st = fs.lstatSync(p);
  const kind = st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  const body = kind === 'file' ? fs.readFileSync(p) : kind === 'link' ? Buffer.from(fs.readlinkSync(p)) : Buffer.alloc(0);
  return crypto.createHash('sha256').update(kind + '\0').update(body).digest('hex');
}

// Every symbolic link or junction under dir, found from lstat-type directory entries (nothing is followed). The
// top-level .git is skipped (worktreeGitDir checks it). Returns { links (POSIX relative paths), capped, entries };
// capped is true once more than max entries were seen. Throws when a directory cannot be read.
const LINK_WALK_MAX = 50000;
function findLinks(dir, { max = LINK_WALK_MAX } = {}) {
  const links = [];
  let entries = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(dir, ...rel.split('/')) : dir;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!rel && ent.name === '.git') continue;
      if (++entries > max) return { links, capped: true, entries };
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) { links.push(r); continue; }
      if (ent.isFile()) continue;
      // Directories and anything else are checked again with lstat before the walk goes into them.
      const st = fs.lstatSync(path.join(abs, ent.name));
      if (st.isSymbolicLink()) links.push(r);
      else if (st.isDirectory()) stack.push(r);
    }
  }
  return { links, capped: false, entries };
}

// Throws (code 'worktree-link') when dir holds a symbolic link or junction, is too large to walk (findLinks' cap) or
// has a directory the walk cannot read (fail closed). doing names the refused action in the message. The error
// carries links (POSIX paths relative to dir, empty unless links were found) and reason (the message without the
// "refusing ..." prefix). Called before every git call that stages or applies into an item worktree, since
// `git add -A` follows a junction on Windows (core.symlinks=false does not stop it) and stages what lies behind it.
function assertNoLinks(dir, { project = null, doing = 'to run git' } = {}) {
  const refuse = (reason, links = []) => Object.assign(new Error(`refusing ${doing}: ${reason}`), { code: 'worktree-link', links, reason });
  let scan;
  try { scan = findLinks(dir); } catch (e) { throw refuse(`the worktree cannot be scanned for links (${e.code || e.message})`); }
  if (scan.capped) throw refuse(`the worktree has more than ${LINK_WALK_MAX} entries, too many to check for links`);
  if (scan.links.length) {
    const shown = scan.links.slice(0, 5).join(', ') + (scan.links.length > 5 ? ` and ${scan.links.length - 5} more` : '');
    throw refuse(`${relOf(project || projectOf(dir), dir)} contains a symbolic link or junction: ${shown}`, scan.links);
  }
}

// POSIX-style path of dir relative to project.
function relOf(project, dir) {
  // Both sides real (nearest existing parent for a vanished dir), so a short temp name never shows up as ../..
  const real = (p) => {
    let cur = path.resolve(String(p)), rest = '';
    for (;;) {
      try { const r = fs.realpathSync.native(cur); return rest ? path.join(r, rest) : r; } catch {}
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(String(p));
      rest = rest ? path.join(path.basename(cur), rest) : path.basename(cur);
      cur = up;
    }
  };
  return path.relative(real(project), real(dir)).split(path.sep).join('/');
}

function listBoardWorktrees(project) {
  const r = runGit(project, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const root = worktreeRoot(project);
  const out = [];
  let cur = null;
  for (const line of String(r.stdout).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { dir: line.slice('worktree '.length), head: null };
      out.push(cur);
    } else if (line.startsWith('HEAD ') && cur) {
      cur.head = line.slice('HEAD '.length);
    }
  }
  return out.filter((w) => within(w.dir, root, { strict: true }));
}

function isBoardWorktree(project, dir) {
  try {
    const root = worktreeRoot(project);
    if (!within(dir, root, { strict: true })) return false;
    if (isSymlinkPath(dir)) return false;
    const c = canon(dir);
    return listBoardWorktrees(project).some((w) => canon(w.dir) === c);
  } catch {
    return false;
  }
}

// A leftover directory under the worktree root that still carries git's '.git' file (its registration is gone).
function isOrphanWorktree(root, dir) {
  if (!within(dir, root, { strict: true }) || isSymlinkPath(dir)) return false;
  try { return fs.lstatSync(path.join(dir, '.git')).isFile(); } catch { return false; }
}

function removeWorktree(project, dir, { allowOrphan = false } = {}) {
  const root = worktreeRoot(project);
  if (isBoardWorktree(project, dir)) {
    runGit(project, ['worktree', 'remove', '--force', dir]);
  } else if (!(allowOrphan && isOrphanWorktree(root, dir))) {
    throw new Error('not a board-managed worktree');
  }
  recorded.delete(canon(dir));
  if (existsNoFollow(dir) && within(dir, root, { strict: true }) && !isSymlinkPath(dir)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  runGit(project, ['worktree', 'prune']);
  const parent = path.dirname(dir);
  if (within(parent, root, { strict: true })) {
    try { fs.rmdirSync(parent); } catch {}
  }
  return { ok: true };
}

function removeRoomWorktrees(project, roomId) {
  if (!ID_RE.test(String(roomId))) throw new Error('invalid worktree id');
  const root = worktreeRoot(project);
  const roomDir = path.join(root, roomId);
  if (!existsNoFollow(roomDir)) return 0;
  if (isSymlinkPath(roomDir) || !within(roomDir, root, { strict: true })) throw new Error('refusing to remove worktrees outside .orchestra/worktrees');
  let count = 0;
  for (const w of listBoardWorktrees(project)) {
    if (within(w.dir, roomDir, { strict: true })) { removeWorktree(project, w.dir); count++; }
  }
  // The first loop may already have removed the last worktree, which also removes the empty room dir (removeWorktree
  // rmdirs its parent): there is nothing left to scan then.
  if (!existsNoFollow(roomDir)) return count;
  let entries = [];
  try { entries = fs.readdirSync(roomDir, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    try { removeWorktree(project, path.join(roomDir, ent.name), { allowOrphan: true }); count++; } catch {}
  }
  return count;
}

module.exports = {
  get NO_HOOKS() { return getNoHooks(); },
  get HOOKS_PATH() { return hooksPath(); },
  LINK_WALK_MAX,
  gitEnv, runGit, runGitWt, gitVersion, canon, within, isSymlinkPath, repoInfo, mainState, fingerprint,
  worktreeRoot, worktreePath, createWorktree, listBoardWorktrees, isBoardWorktree,
  removeWorktree, removeRoomWorktrees, worktreeGitDir, worktreeGitArgs, dotGitHash, findLinks, assertNoLinks,
};
