// Seat target scope: directory listing, prompt preface and git diff of the target.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
function resolveTarget(seat, project) {
  if (!seat.target) return { cwd: project, preface: '' };
  const t = path.resolve(project, seat.target);
  if (!fs.existsSync(t)) return { cwd: project, preface: `(Note: target "${seat.target}" does not exist.)\n\n` };
  if (fs.statSync(t).isDirectory()) return { cwd: t, dir: t, preface: `Your scope is the directory ${t}. Stay inside it.\nFiles:\n${listDir(t)}\n\n` };
  const body = fs.readFileSync(t, 'utf8').slice(0, 60000);
  return { cwd: path.dirname(t), dir: path.dirname(t), preface: `Your target is the file ${t}.\n--- ${path.basename(t)} ---\n${body}\n--- end ---\n\n` };
}

// Changes inside the target directory only, including new (untracked) files.
function gitDiff(dir) {
  const git = (args) => { try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 4e6, windowsHide: true }); } catch { return ''; } };
  const diff = git(['diff', 'HEAD', '--', '.']);
  const added = git(['ls-files', '--others', '--exclude-standard', '--', '.']).trim();
  return (diff + (added ? `\nNew files:\n${added}\n` : '')).slice(0, 30000).trim();
}

module.exports = { listDir, resolveTarget, gitDiff };
