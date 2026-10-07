// Seat target scope: project confinement (realpath), directory listing, prompt preface and git diff of the target.
const fs = require('fs');
const path = require('path');
const { execFileResolved } = require('./platform'); // `git` resolved on PATH: a git.exe inside the target dir is never run

const realpath = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const within = (child, root) => { const c = norm(child), r = norm(root); return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };

// Confines a seat target to the project. Returns { abs, rel, exists } or throws for anything that resolves
// outside the project: absolute paths elsewhere, '..' escapes, UNC/drive tricks and symlinks that point out.
// A target that does not exist yet is allowed when its nearest existing ancestor is (really) inside the project.
// The project may itself be opened through a junction/symlink/subst drive (or /tmp -> /private/tmp): an absolute
// target is accepted when it is lexically inside either the project path as given or its real path; it is then
// mapped to a relative path and resolved under the real root, where the realpath checks below guard escapes.
function confineTarget(target, project) {
  const t = String(target ?? '').trim();
  if (!t) return { abs: project, rel: '', exists: true };
  if (t.includes('\0') || t.length > 1024) throw new Error('invalid target path');
  const given = path.resolve(project);
  const root = realpath(given);
  let rel = t;
  if (path.isAbsolute(t) || /^[A-Za-z]:/.test(t)) {
    const a = path.resolve(t);
    const base = within(a, given) ? given : within(a, root) ? root : null;
    if (!base) throw new Error('target must be inside the project');
    rel = path.relative(base, a);
  }
  const abs = path.resolve(root, rel);
  if (!within(abs, root)) throw new Error('target must be inside the project');
  // Walk up to the first existing ancestor and check where it really lives (symlink escape).
  let probe = abs, exists = true;
  for (;;) {
    if (fs.existsSync(probe)) break;
    exists = false;
    const up = path.dirname(probe); if (up === probe) throw new Error('target must be inside the project'); probe = up;
  }
  if (!within(realpath(probe), root)) throw new Error('target must be inside the project');
  if (exists && fs.lstatSync(abs).isSymbolicLink() && !within(realpath(abs), root)) throw new Error('target must be inside the project');
  return { abs, rel: path.relative(root, abs).split(path.sep).join('/'), exists };
}

function listDir(dir, depth = 2, max = 150) {
  const out = [];
  (function walk(d, pre, lvl) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max || /^(node_modules|\.git|\.venv|dist|build)$/.test(e.name)) continue;
      out.push(pre + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory() && lvl < depth) walk(path.join(d, e.name), pre + '  ', lvl + 1);
    }
  })(dir, '', 1);
  return out.join('\n');
}

// The target is also inlined into the prompt so the agent has it without running commands.
// A target outside the project (hand-edited seats.json, symlink swapped after saving) falls back to the project.
function resolveTarget(seat, project) {
  if (!seat.target) return { cwd: project, preface: '' };
  let c; try { c = confineTarget(seat.target, project); } catch { return { cwd: project, preface: `(Note: target "${seat.target}" is outside the project and was ignored.)\n\n` }; }
  const t = c.abs;
  if (!c.exists) return { cwd: project, preface: `(Note: target "${seat.target}" does not exist.)\n\n` };
  if (fs.statSync(t).isDirectory()) return { cwd: t, dir: t, preface: `Your scope is the directory ${t}. Stay inside it.\nFiles:\n${listDir(t)}\n\n` };
  const body = fs.readFileSync(t, 'utf8').slice(0, 60000);
  return { cwd: path.dirname(t), dir: path.dirname(t), preface: `Your target is the file ${t}.\n--- ${path.basename(t)} ---\n${body}\n--- end ---\n\n` };
}

// Changes inside the target directory only, including new (untracked) files.
function gitDiff(dir) {
  const git = (args) => { try { return execFileResolved('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 4e6, windowsHide: true }); } catch { return ''; } };
  const diff = git(['diff', 'HEAD', '--', '.']);
  const added = git(['ls-files', '--others', '--exclude-standard', '--', '.']).trim();
  return (diff + (added ? `\nNew files:\n${added}\n` : '')).slice(0, 30000).trim();
}

module.exports = { confineTarget, listDir, resolveTarget, gitDiff };
