// Frozen proposals and the safe apply path to the main checkout.
//
// A proposal is the builder's worktree changes frozen after its turn: everything in the worktree is staged and the
// binary diff against the item's start tree (base commit + dependency patches) is written to
// .orchestra/proposals/<room>/<item>-r<round>.patch and hashed with sha256. Reviews are bound to that hash.
//
// Applying a reviewed proposal checks a fixed list of preconditions, then runs `git apply --index` in the main
// checkout. Nothing is committed: the user reviews `git diff --cached` and commits.
// A read-only builder's ```diff block is either exported as a patch file (saveProposedPatch, propose mode) or, for a
// Codex builder in a write build, applied into its item worktree (applyProposedPatch) and then frozen like any edit. Every git call goes through
// worktree.runGit (hooks off, safe env); in an item worktree it goes through worktree.runGitWt, which names the
// repository explicitly, so a rewritten `.git` file there cannot make git load another config. Patch bytes are
// always re-verified against their hash and handed to git on stdin, so the file on disk cannot change between the
// hash check and the apply.
const path = require('path');
const fs = require('fs');
const os = require('os');
const worktree = require('./worktree');
const { httpError, sha256, now } = require('./util');

const PATCH_MAX_BYTES = 8 * 1024 * 1024;
const REL_RE = /^proposals\/[\w-]{1,64}\/[a-z0-9][a-z0-9-]{0,31}-r\d{1,2}\.patch$/;
// Read headroom for git output: a diff a little over the limit must still be read so it can be reported as too large.
const DIFF_READ_MAX = 64 * 1024 * 1024;
const UNSAFE_MODES = new Set(['120000', '160000']);

const errText = (r) => String(r.stderr || '').trim() || `exit ${r.code}`;
const splitZ = (out) => String(out).split('\0').filter(Boolean);

// git in an item worktree that must succeed. wt: the worktree dir or { dir, gitDir, project } (worktree.runGitWt).
function mustGitWt(wt, args, opts) {
  const r = worktree.runGitWt(wt, args, opts);
  if (!r.ok) {
    if (/maxBuffer|ENOBUFS/i.test(String(r.stderr))) throw httpError(400, 'proposal too large (max 8 MB)', 'too-large');
    throw new Error(`git ${args.find((a) => !a.startsWith('-')) || args[0]} failed: ${errText(r)}`);
  }
  return r.stdout;
}

// The runGitWt target for an item worktree: its dir plus, when known, the project and the stored admin dir.
const wtOf = (worktreeDir, project, gitDir) => ({ dir: worktreeDir, project: project || undefined, gitDir: gitDir || null });

// Stages everything in the worktree and returns the binary diff of the index against startTree. A worktree that holds
// a symbolic link or junction is refused first (throws, code 'worktree-link'): `git add -A` would follow a junction
// and stage files from outside the worktree as ordinary entries.
// wt: the worktree dir or { dir, gitDir, project } (worktree.runGitWt).
function diffBytes(worktreeDir, startTree, wt = worktreeDir) {
  worktree.assertNoLinks(worktreeDir, { project: (wt && wt.project) || null, doing: 'to stage the worktree' });
  mustGitWt(wt, ['add', '-A']);
  const out = mustGitWt(wt, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', startTree], { buffer: true, maxBuffer: DIFF_READ_MAX });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

// Zero-width code points that HFS+ ignores in names (the same set git's protectHFS strips), so `.orchestra` with
// one of them inserted cannot pose as an ordinary name and resolve to `.orchestra` on macOS.
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

// True for one path segment the board refuses anywhere in a proposal path:
// - '', '.', '..' and `.git` (git refuses these too; checked again so the board does not depend on it);
// - Windows aliases: an 8.3 short name (`ORCHES~1` resolves to `.orchestra` on a volume with short names, and git's
//   protectNTFS only covers `.git`), a trailing '.' or ' ' (Win32 strips them, so `.orchestra.` is `.orchestra`),
//   and ':' (alternate data streams such as `.orchestra::$INDEX_ALLOCATION`), backslash and the other Win32-reserved
//   characters. These are refused on every platform so a proposal is judged the same way wherever it is applied.
function reservedSegment(seg) {
  const s = seg.replace(HFS_IGNORABLE, '').toLowerCase();
  if (s === '' || s === '.' || s === '..' || s === '.git') return true;
  if (/~\d+$/.test(s)) return true;
  if (/[. ]$/.test(s)) return true;
  return /[:\\<>"|?*\x00-\x1f]/.test(s);
}

// True for a path the board never lets a proposal touch, whatever the item owns: anything under `.git` or the
// board's own `.orchestra`, or any path with a segment that could alias one of them (see reservedSegment).
function reservedPath(p) {
  const segs = String(p).split('/');
  if (segs[0].replace(HFS_IGNORABLE, '').toLowerCase() === '.orchestra') return true;
  return segs.some(reservedSegment);
}

// Owner-area check. Paths are compared case sensitively on every platform: a patch path is inside an owned area only
// when it spells the area with the same case. On a case-insensitive filesystem (Windows, macOS) a path that matches an
// area only when case is ignored is the same directory under another spelling, so it is refused and named as such.
// The platform is a parameter so tests can inject it.
const CASE_INSENSITIVE_PLATFORMS = new Set(['win32', 'darwin']);

// inside when the file equals an owned area or lies under one; case-alias when it does so only ignoring case on a
// case-insensitive platform; otherwise outside.
function ownedAreaVerdict(file, areas, platform = process.platform) {
  const under = (p, a) => p === a || p.startsWith(a + '/');
  const f = String(file);
  if (areas.some((a) => under(f, String(a)))) return 'inside';
  if (CASE_INSENSITIVE_PLATFORMS.has(platform)) {
    const lf = f.toLowerCase();
    if (areas.some((a) => under(lf, String(a).toLowerCase()))) return 'case-alias';
  }
  return 'outside';
}

// The files that are not inside the owned areas as { reason, files }, or null when every file is inside.
function outsideOwnedAreas(files, areas, platform = process.platform) {
  const bad = [];
  let alias = false;
  for (const f of files) {
    const v = ownedAreaVerdict(f, areas, platform);
    if (v === 'inside') continue;
    bad.push(f);
    if (v === 'case-alias') alias = true;
  }
  if (bad.length === 0) return null;
  const reason = alias
    ? 'the patch touches a path that differs from an owned path only by case (case-insensitive filesystem)'
    : 'the patch touches paths outside the areas the item owns';
  return { reason, files: bad };
}

// Paths whose old or new mode is a symlink (120000) or a gitlink (160000), from `diff --raw -z` (renames off).
function unsafeFromRaw(raw) {
  const tok = String(raw).split('\0');
  const out = [];
  for (let i = 0; i < tok.length; i++) {
    const meta = tok[i];
    if (!meta.startsWith(':')) continue;
    const [oldMode, newMode, , , status = ''] = meta.slice(1).split(' ');
    const paths = /^[RC]/.test(status) ? [tok[i + 1], tok[i + 2]] : [tok[i + 1]];
    i += paths.length;
    if (UNSAFE_MODES.has(oldMode) || UNSAFE_MODES.has(newMode)) for (const p of paths) if (p) out.push(p);
  }
  return out;
}

function proposalRel(roomId, itemId, round) {
  const rel = `proposals/${roomId}/${itemId}-r${round}.patch`;
  if (!REL_RE.test(rel)) throw httpError(400, 'invalid proposal path', 'bad-path');
  return rel;
}

// Freezes the worktree's changes into a patch file. Returns { empty, hash, rel, files, bytes, outOfArea, unsafe }.
function freezeProposal({ store, worktreeDir, startTree, roomId, itemId, round, owns = null, gitDir = null }) {
  const rel = proposalRel(roomId, itemId, round);
  const g = wtOf(worktreeDir, store.project, gitDir);
  const bytes = diffBytes(worktreeDir, startTree, g);
  if (bytes.length === 0) return { empty: true, hash: null, rel: null, files: [], bytes: 0, outOfArea: [], unsafe: [] };
  if (bytes.length > PATCH_MAX_BYTES) throw httpError(400, 'proposal too large (max 8 MB)', 'too-large');
  const files = splitZ(mustGitWt(g, ['diff', '--cached', '--name-only', '-z', '--no-renames', startTree]));
  const unsafe = unsafeFromRaw(mustGitWt(g, ['diff', '--cached', '--raw', '-z', '--no-renames', startTree]));
  for (const f of files) if (reservedPath(f) && !unsafe.includes(f)) unsafe.push(f);
  const oo = owns ? outsideOwnedAreas(files, owns) : null;
  const outOfArea = oo ? oo.files : [];
  store.write(rel, bytes);
  return { empty: false, hash: sha256(bytes), rel, files, bytes: bytes.length, outOfArea, unsafe };
}

// sha256 of the worktree's current diff against startTree (stages everything first, like a freeze).
function hashWorktree({ worktreeDir, startTree, project = null, gitDir = null }) {
  return sha256(diffBytes(worktreeDir, startTree, wtOf(worktreeDir, project, gitDir)));
}

// Reads a frozen patch and verifies it against its hash. Returns the bytes.
function readProposal({ store, rel, hash }) {
  if (typeof rel !== 'string' || !REL_RE.test(rel)) throw httpError(400, 'invalid proposal path', 'bad-path');
  const abs = path.join(store.orch, rel);
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw httpError(404, 'proposal file missing', 'proposal-missing');
    throw httpError(409, `cannot read the proposal file: ${e.code || e.message}`, 'proposal-missing');
  }
  if (!hash || sha256(buf) !== hash) throw httpError(409, 'the proposal file changed after it was frozen', 'proposal-changed');
  return buf;
}

// Paths and modes re-derived from the verified patch bytes, independent of what the freeze recorded.
// Paths come from git's own parser (`git apply --numstat -z`), so they are exactly the paths `git apply` will touch.
// Returns { ok: true, files, modes } or { ok: false, reason }.
function inspectPatch(project, buf) {
  const r = worktree.runGit(project, ['apply', '--numstat', '-z', '-'], { input: buf });
  if (!r.ok) return { ok: false, reason: `git cannot read the patch: ${errText(r)}` };
  const tok = String(r.stdout).split('\0');
  const files = [];
  for (let i = 0; i < tok.length; i++) {
    const m = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]*)$/.exec(tok[i]);
    if (!m) continue;
    if (m[1] !== '') { files.push(m[1]); continue; }
    // A rename or copy: the old and new paths follow as their own NUL-terminated fields.
    for (const p of [tok[i + 1], tok[i + 2]]) if (p) files.push(p);
    i += 2;
  }
  // Every mode the patch states, from its extended headers. Hunk lines start with ' ', '+', '-', a backslash or '@',
  // and base85 lines contain no spaces, so neither can be mistaken for these headers.
  const modes = [];
  const MODE_RE = /^(?:(?:old|new) mode|(?:new|deleted) file mode) ([0-7]{6})$|^index [0-9a-f]+\.\.[0-9a-f]+ ([0-7]{6})$/;
  for (const line of buf.toString('latin1').split('\n')) {
    const m = MODE_RE.exec(line.replace(/\r$/, ''));
    if (m) modes.push(m[1] || m[2]);
  }
  return { ok: true, files, modes };
}

// Refuses a patch that touches a reserved path, adds or keeps a symlink or gitlink, or (when owns is set) touches a
// path outside the item's areas. null when the patch is safe, else { reason, files }.
function patchSafety(project, buf, owns, platform = process.platform) {
  const info = inspectPatch(project, buf);
  if (!info.ok) return { reason: info.reason, files: [] };
  if (info.files.length === 0) return { reason: 'the patch touches no files', files: [] };
  const reserved = info.files.filter(reservedPath);
  if (reserved.length) return { reason: 'the patch touches paths the board never applies (.git, .orchestra or an alias of them)', files: reserved };
  if (info.modes.some((m) => UNSAFE_MODES.has(m))) {
    return { reason: 'the patch adds or changes a symlink (120000) or an embedded repository (160000)', files: [] };
  }
  if (Array.isArray(owns) && owns.length) {
    const out = outsideOwnedAreas(info.files, owns, platform);
    if (out) return { reason: out.reason, files: out.files };
  }
  return null;
}

// ---------- proposed diffs (propose mode export, Codex patch mode) ----------
//
// A read-only builder ends its reply with one ```diff block. The board takes the last such block, vets it (size,
// header paths, git's own path list, modes, owner areas) and then either exports it as a patch file for the user
// (saveProposedPatch, propose mode: nothing is applied anywhere) or applies it into the item worktree
// (applyProposedPatch, Codex patch mode: Appendix B item 2). Neither touches the main checkout. A builder that only
// reads cannot have run the change, so both records carry untested: true.

const DIFF_BLOCK_RE = /^[ \t]{0,3}```[ \t]*diff[ \t]*\r?\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gm;

// The body of the last ```diff block in text, with LF line ends and a final newline, or null when there is none.
function extractLastDiff(text) {
  let last = null;
  for (const m of String(text || '').matchAll(DIFF_BLOCK_RE)) last = m[1];
  if (last === null) return null;
  let body = last.replace(/\r\n/g, '\n');
  if (!body.trim()) return null;
  if (!body.endsWith('\n')) body += '\n';
  return body;
}

// Header paths as written in the diff (before git strips a/ and b/), skipping hunk bodies so a removed line that
// starts with "-- " is not read as a header. /dev/null is left out.
function headerPaths(body) {
  const out = [];
  let oldLeft = 0, newLeft = 0;
  const unquote = (s) => (/^".*"$/.test(s) ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s);
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === ' ' || line === '') { oldLeft--; newLeft--; continue; }
      if (c === '-') { oldLeft--; continue; }
      if (c === '+') { newLeft--; continue; }
      if (c === '\\') continue;
      oldLeft = 0; newLeft = 0; // a malformed hunk: fall through and read the line as a header
    }
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (h) { oldLeft = h[1] === undefined ? 1 : Number(h[1]); newLeft = h[2] === undefined ? 1 : Number(h[2]); continue; }
    const m = /^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )(.*)$/.exec(line);
    if (!m) continue;
    let p = m[1];
    if (/^(?:---|\+\+\+) /.test(line)) p = p.replace(/\t.*$/, '');
    p = unquote(p.trim());
    if (p === '/dev/null' || p === '') continue;
    out.push(p);
  }
  return out;
}

const isAbsolutePath = (p) => /^[/\\]/.test(p) || /^[A-Za-z]:/.test(p);
const hasDotDot = (p) => String(p).split(/[/\\]/).some((s) => s === '..');

// Vets a proposed diff without touching any file. Returns { ok: true, buf, files } or { ok: false, code, reason, files }.
// project: where git parses the patch (`git apply --numstat`, read only). owns: the item's areas (null skips that check).
function vetProposedDiff({ project, text, owns, platform = process.platform }) {
  const body = extractLastDiff(text);
  if (body === null) return fail('no-diff', 'the reply has no ```diff block', { files: [] });
  const buf = Buffer.from(body, 'utf8');
  if (buf.length > PATCH_MAX_BYTES) return fail('too-large', 'the diff is too large (max 8 MB)', { files: [] });
  const heads = headerPaths(body);
  const abs = heads.filter(isAbsolutePath);
  if (abs.length) return fail('absolute-path', 'the diff names an absolute path', { files: abs.slice(0, 50) });
  const dots = heads.filter(hasDotDot);
  if (dots.length) return fail('dotdot-path', 'the diff names a path with ".."', { files: dots.slice(0, 50) });
  let info;
  try { info = inspectPatch(project, buf); } catch (e) { info = { ok: false, reason: e.message }; }
  if (!info.ok) return fail('unreadable', info.reason, { files: [] });
  const files = [...new Set(info.files)];
  if (files.length === 0) return fail('empty', 'the diff touches no files', { files: [] });
  const absG = files.filter(isAbsolutePath);
  if (absG.length) return fail('absolute-path', 'the diff names an absolute path', { files: absG.slice(0, 50) });
  const dotsG = files.filter(hasDotDot);
  if (dotsG.length) return fail('dotdot-path', 'the diff names a path with ".."', { files: dotsG.slice(0, 50) });
  const reserved = files.filter(reservedPath);
  if (reserved.length) return fail('reserved-path', 'the diff touches paths the board never applies (.git, .orchestra or an alias of them)', { files: reserved.slice(0, 50) });
  if (info.modes.some((m) => UNSAFE_MODES.has(m))) return fail('unsafe-mode', 'the diff adds or changes a symlink (120000) or an embedded repository (160000)', { files: [] });
  if (Array.isArray(owns) && owns.length) {
    const out = outsideOwnedAreas(files, owns, platform);
    if (out) return fail('outside-owns', out.reason, { files: out.files.slice(0, 50) });
  } else if (owns !== null && owns !== undefined) {
    return fail('outside-owns', 'the item owns no areas', { files: files.slice(0, 50) });
  }
  return { ok: true, buf, files };
}

const UNTESTED_NOTE = 'untested: the builder ran read only and the board ran no tests; read the diff before you apply it';

// Composes the dependency patches in an isolated scratch directory (never the checkout) and runs `git apply --check`
// of buf there. Only the files the patches touch are copied from the project, so a patch that builds on files its
// dependencies create is judged against the dependency tree. Without dependencies the check runs in a scratch copy
// too, so the main checkout is never an apply target. Returns { ok, reason }.
function checkInDependencyTree({ store, project, buf, depPatches = [] }) {
  let tmp = null;
  try {
    const bufs = depPatches.map(({ rel, hash }) => readProposal({ store, rel, hash }));
    const all = [...bufs, buf];
    const touched = new Set();
    for (const b of all) {
      const info = inspectPatch(project, b);
      if (!info.ok) return { ok: false, reason: info.reason };
      for (const f of info.files) touched.add(f);
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-depcheck-'));
    for (const f of touched) {
      if (isAbsolutePath(f) || hasDotDot(f) || reservedPath(f)) return { ok: false, reason: `unsafe path in a patch: ${f}` };
      const src = path.join(project, f);
      let st;
      try { st = fs.lstatSync(src); } catch { continue; } // a file the patches create
      if (!st.isFile()) continue;
      const dst = path.join(tmp, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    for (let i = 0; i < all.length; i++) {
      const last = i === all.length - 1;
      const r = worktree.runGit(tmp, ['apply', ...(last ? ['--check'] : []), '--whitespace=nowarn', '-'], { input: all[i] });
      if (!r.ok) return { ok: false, reason: last ? errText(r) : `dependency patch ${depPatches[i].rel} does not apply: ${errText(r)}` };
    }
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  }
}

// Propose mode export (plan F10). Takes the last ```diff block of text, vets it, runs `git apply --check` against the
// dependency tree (the project files plus the already exported patches of depPatches [{ rel, hash }], composed in a
// scratch directory), and writes .orchestra/proposals/<room>/<item>-r<round>.patch plus a .sha256 file beside it.
// A refused diff writes nothing and returns { ok: false, code, reason, files }. A failing check is recorded in the
// result, never thrown. Returns { ok: true, file (project-relative), rel (store-relative),
// hash, files, bytes, check: { ok, reason }, untested: true, note }.
function saveProposedPatch({ store, project = store.project, room, item, round, text, depPatches = [] }) {
  const roomId = room && typeof room === 'object' ? room.id : room;
  const rel = proposalRel(roomId, item.id, round);
  const v = vetProposedDiff({ project, text, owns: Array.isArray(item.owns) ? item.owns : null });
  if (!v.ok) return v;
  const check = checkInDependencyTree({ store, project, buf: v.buf, depPatches });
  const hash = sha256(v.buf);
  store.write(rel, v.buf);
  store.write(`${rel}.sha256`, `${hash}  ${path.posix.basename(rel)}\n`);
  return { ok: true, file: `.orchestra/${rel}`, rel, hash, files: v.files, bytes: v.buf.length, check, untested: true, note: UNTESTED_NOTE };
}

// Codex patch mode (Appendix B item 2): vets the last ```diff block of text against the item's areas and applies it
// into the item worktree (never the main checkout). The worktree must hold no link. Returns { ok: true, hash, files,
// bytes, untested: true } or { ok: false, code, reason, files }; nothing is applied unless `git apply --check` passed.
function applyProposedPatch({ store, worktreeDir, text, owns = null, gitDir = null }) {
  const v = vetProposedDiff({ project: store.project, text, owns });
  if (!v.ok) return v;
  const g = wtOf(worktreeDir, store.project, gitDir);
  try { worktree.assertNoLinks(worktreeDir, { project: store.project, doing: 'to apply the proposed diff' }); }
  catch (e) { return fail(e.code || 'worktree-link', e.message, { files: [] }); }
  const chk = worktree.runGitWt(g, ['apply', '--check', '--whitespace=nowarn', '-'], { input: v.buf });
  if (!chk.ok) return fail('does-not-apply', errText(chk), { files: v.files });
  const r = worktree.runGitWt(g, ['apply', '--whitespace=nowarn', '-'], { input: v.buf });
  if (!r.ok) return fail('does-not-apply', errText(r), { files: v.files });
  return { ok: true, hash: sha256(v.buf), files: v.files, bytes: v.buf.length, untested: true };
}

// Applies the dependency patches (in order) to a fresh item worktree and returns the resulting start tree. Refuses
// (code 'worktree-link') a worktree that holds a link, before anything is applied or staged there.
function prepareWorktree({ store, worktreeDir, depPatches = [], gitDir = null }) {
  const g = wtOf(worktreeDir, store.project, gitDir);
  worktree.assertNoLinks(worktreeDir, { project: store.project, doing: 'to apply into the worktree' });
  for (const { rel, hash } of depPatches) {
    const buf = readProposal({ store, rel, hash });
    const r = worktree.runGitWt(g, ['apply', '--index', '--whitespace=nowarn', '-'], { input: buf });
    if (!r.ok) throw httpError(409, `dependency patch ${rel} does not apply: ${errText(r)}`, 'dependency-conflict');
  }
  mustGitWt(g, ['add', '-A']);
  return String(mustGitWt(g, ['write-tree'])).trim();
}

// ---------- apply ----------

const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

// Internal form of applyPreconditions: on success also returns the main state and the verified patch bytes.
function checkApply({ project, store, room, item, approvalOk }) {
  if (room.status === 'running') return fail('build-running', 'pause the build or wait until it ends before applying');
  // apply-failed keeps its reviewed proposal: the same hash and base rules below decide whether a retry may go ahead.
  if ((item.status !== 'passed' && item.status !== 'apply-failed') || !item.review || item.review.verdict !== 'pass') return fail('not-reviewed', 'this item has no passing review');
  if (!item.proposal || !item.proposal.hash || item.review.hash !== item.proposal.hash) return fail('review-stale', 'the review does not match the current proposal');
  let buf;
  try { buf = readProposal({ store, rel: item.proposal.file, hash: item.proposal.hash }); } catch (e) {
    return fail(e.code || 'proposal-missing', e.message);
  }
  // The build manager rejects unsafe and out-of-area freezes before review; this re-derives paths and modes from the
  // verified bytes so the apply path never depends on that earlier check or on the stored file list.
  const unsafe = patchSafety(project, buf, item.owns);
  if (unsafe) return fail('unsafe-proposal', unsafe.reason, { files: unsafe.files.slice(0, 50) });
  for (const d of item.dependsOn || []) {
    const dep = room.items && room.items[d];
    if (!dep || dep.status !== 'applied') return fail('dependency-not-applied', `apply ${d} first`);
  }
  if (!approvalOk) return fail('approval-stale', 'the plan is no longer approved at this revision');
  const st = worktree.mainState(project);
  if (st.unstaged.length || st.untracked.length) {
    return fail('checkout-dirty', 'the main checkout has changes the board did not make', { files: [...st.unstaged, ...st.untracked].slice(0, 50) });
  }
  const baseOk = st.indexTree !== null && st.indexTree === room.expectedTree
    && (st.head === room.baseCommit || st.headTree === room.expectedTree);
  if (!baseOk) {
    if (st.head !== room.baseCommit) return fail('base-changed', 'the main checkout moved to another commit since the build started');
    return fail('checkout-dirty', 'staged changes differ from what the board applied', { files: st.staged.slice(0, 50) });
  }
  const chk = worktree.runGit(project, ['apply', '--check', '--index', '--whitespace=nowarn', '-'], { input: buf });
  if (!chk.ok) return fail('does-not-apply', errText(chk));
  return { ok: true, st, buf };
}

// Checks, in order, everything that must hold before a proposal may be applied. { ok: true } or { ok: false, code, reason, files? }.
function applyPreconditions(args) {
  const r = checkApply(args);
  return r.ok ? { ok: true } : r;
}

const sameSet = (a, b) => {
  const x = [...new Set(a)].sort(), y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

function applyNow({ project, store, room, item, approvalOk }) {
  const pre = checkApply({ project, store, room, item, approvalOk });
  if (!pre.ok) return pre;
  const { st, buf } = pre;
  const before = st.indexTree;
  const r = worktree.runGit(project, ['apply', '--index', '--whitespace=nowarn', '-'], { input: buf });
  if (!r.ok) {
    item.status = 'apply-failed';
    item.error = errText(r);
    return fail('does-not-apply', item.error);
  }
  const listed = worktree.runGit(project, ['diff', '--cached', '--name-only', '-z', '--no-renames', before]);
  const changed = listed.ok ? splitZ(listed.stdout) : null;
  if (!changed || !sameSet(changed, item.proposal.files || [])) {
    const back = worktree.runGit(project, ['apply', '-R', '--index', '--whitespace=nowarn', '-'], { input: buf });
    item.status = 'apply-failed';
    item.error = back.ok
      ? 'the applied paths differ from the reviewed proposal; the apply was reverted'
      : `the applied paths differ from the reviewed proposal and reverting failed: ${errText(back)}`;
    return fail('apply-mismatch', item.error);
  }
  const w = worktree.runGit(project, ['write-tree']);
  if (!w.ok) {
    item.status = 'apply-failed';
    item.error = `git write-tree failed: ${errText(w)}`;
    return fail('apply-failed', item.error);
  }
  const tree = String(w.stdout).trim();
  const baseMoved = st.head !== room.baseCommit;
  if (baseMoved) room.baseCommit = st.head;
  room.expectedTree = tree;
  item.status = 'applied';
  item.appliedAt = now();
  item.error = null;
  return { ok: true, tree, baseMoved };
}

// One apply at a time per process: calls are chained, each starts after the previous one settled.
let chain = Promise.resolve();
let inFlight = 0;
// `after(res)` (optional, may be async) runs inside the same serialized slot once the apply finished, so the caller's
// bookkeeping and persistence cannot interleave with another apply. If it throws, the returned promise rejects.
function applyProposal(args, after) {
  inFlight++;
  const run = chain.then(async () => {
    const res = applyNow(args);
    if (after) await after(res);
    return res;
  }).finally(() => { inFlight--; });
  chain = run.catch(() => {});
  return run;
}
const applyBusy = () => inFlight > 0;

module.exports = {
  PATCH_MAX_BYTES, REL_RE,
  diffBytes, freezeProposal, hashWorktree, prepareWorktree, readProposal, reservedPath, inspectPatch,
  ownedAreaVerdict, outsideOwnedAreas,
  extractLastDiff, vetProposedDiff, saveProposedPatch, applyProposedPatch, UNTESTED_NOTE,
  applyPreconditions, applyProposal, applyBusy,
};
