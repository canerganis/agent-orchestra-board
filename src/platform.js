// OS-specific bits (Windows fixes live here), and the one spawn path every child process of the board goes through.
//
// Why spawns are wrapped: on Windows, libuv looks for a bare program name ('claude', 'codex', 'git', 'taskkill')
// in the CHILD'S cwd before PATH unless NoDefaultCurrentDirectoryInExePath is set, and a normal terminal does not
// set it. The board spawns the CLIs with the project (or a seat's target) as cwd, so a claude.exe at the root of an
// untrusted repository would run as the CLI on the first turn, even for a read-only seat. spawnResolved() therefore
// resolves a bare name on PATH only (never the cwd) and spawns the absolute path, or fails with ENOENT exactly like
// Node does for a missing binary. Nothing else in src/ or bin/ may require child_process (test/spawn.test.js checks).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const child_process = require('child_process');

const WIN = process.platform === 'win32';
const SHIM = /\.(cmd|bat)$/i;
const NO_CWD_VAR = 'NoDefaultCurrentDirectoryInExePath';

// Defence in depth for any spawn that bypasses spawnResolved(): the Win32 lookup rule reads this variable from the
// live process environment (Node's process.env setter calls SetEnvironmentVariableW), so set it for the board itself.
// Children must not inherit a setting the user did not have: spawnResolved() strips it again unless it was set before.
const USER_SET_NO_CWD = Object.prototype.hasOwnProperty.call(process.env, NO_CWD_VAR);
if (WIN && !USER_SET_NO_CWD) process.env[NO_CWD_VAR] = '1';

// The unelevated Windows sandbox cannot launch the Microsoft Store pwsh alias (CreateProcessAsUserW: access
// denied), so Codex children get a PATH without WindowsApps and fall back to Windows PowerShell.
function codexEnv() {
  if (process.platform !== 'win32') return process.env;
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  if (key) env[key] = env[key].split(';').filter((p) => !/\\WindowsApps\\?$/i.test(p)).join(';');
  return env;
}

// ---------- binary resolution (mirrors what spawn() without a shell can actually run) ----------

// A regular file, or a Windows app-execution alias (a reparse point that stat() refuses with EACCES).
function isExecutableFile(f) {
  try { return fs.statSync(f).isFile(); } catch {}
  try { const l = fs.lstatSync(f); return l.isFile() || l.isSymbolicLink(); } catch { return false; }
}

// Where to look for `bin`: a name with a path separator is taken as given (relative to this process's cwd);
// a bare name is searched on PATH only. The child's cwd is deliberately NOT searched (libuv does look there
// unless NoDefaultCurrentDirectoryInExePath is set): a project under review must never supply the CLI binary.
function searchPlan(bin, env) {
  const explicit = bin.includes('/') || (WIN && bin.includes('\\'));
  if (explicit) { const abs = path.resolve(bin); return { dirs: [path.dirname(abs)], name: path.basename(abs) }; }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  // A relative PATH entry (".", "bin") is resolved against the board's own cwd, never the child's.
  return { dirs: (env[pathKey] || '').split(path.delimiter).filter(Boolean).map((d) => path.resolve(d)), name: bin };
}

function walk(dirs, name, exts, keep) {
  const out = [];
  for (const d of dirs) {
    for (const e of exts) {
      const f = path.join(d, name + e);
      if (keep(f) && isExecutableFile(f) && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

// Files spawn() without a shell can actually run, in search order (the first one is what spawn() runs).
// Windows mirrors libuv: a name with an extension is tried as given, then with .com and .exe appended; a bare
// name only with .com/.exe. PATHEXT is not consulted and .cmd/.bat never qualify (Node refuses them: EINVAL).
function resolveBin(bin, env = process.env) {
  const { dirs, name } = searchPlan(String(bin), env);
  if (!WIN) return walk(dirs, name, [''], (f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
  const exts = [...(path.extname(name) ? [''] : []), '.com', '.exe'];
  return walk(dirs, name, exts, (f) => !SHIM.test(f));
}

// .cmd/.bat matches for `bin` (the npm global install leaves only these): `where` finds them, spawn() cannot run
// them (a bare name -> ENOENT, because libuv never tries .cmd; an explicit .cmd -> EINVAL from Node).
function resolveShims(bin, env = process.env) {
  if (!WIN) return [];
  const { dirs, name } = searchPlan(String(bin), env);
  return walk(dirs, name, path.extname(name) ? [''] : ['.cmd', '.bat'], (f) => SHIM.test(f));
}

// The absolute path spawn() should run for `bin`, or null when nothing on PATH (or at the explicit path) qualifies.
const resolveExe = (bin, env = process.env) => resolveBin(bin, env)[0] || null;

// ---------- spawning ----------

// A child that failed before it started, shaped like Node's own: no pid, 'error' then 'close' on the next tick.
function failedChild(cmd, args, code) {
  const child = new EventEmitter();
  child.pid = undefined; child.exitCode = null; child.signalCode = null; child.killed = false;
  child.stdin = null; child.stdout = null; child.stderr = null; child.stdio = [null, null, null];
  child.kill = () => false; child.ref = () => child; child.unref = () => child;
  const err = Object.assign(new Error(`spawn ${cmd} ${code}`), { code, errno: code === 'ENOENT' ? -4058 : -4048, syscall: `spawn ${cmd}`, path: cmd, spawnargs: args });
  process.nextTick(() => { child.emit('error', err); child.emit('close', -2, null); });
  return child;
}

// The environment a child gets: the caller's (or the board's), minus a NoDefaultCurrentDirectoryInExePath the
// board set for itself, so agents and their shells behave exactly as they would from the user's own terminal.
function childEnv(env) {
  const e = env || process.env;
  if (USER_SET_NO_CWD || !Object.prototype.hasOwnProperty.call(e, NO_CWD_VAR)) return e;
  const copy = { ...e }; delete copy[NO_CWD_VAR]; return copy;
}

// spawn() that resolves `cmd` on PATH (or at its explicit path) to an absolute file first, so the child's cwd can
// never supply the executable. Same signature and return value as child_process.spawn; a name that resolves to
// nothing yields a child whose 'error' is ENOENT, as a missing binary does with Node. `shell: true` is refused:
// the board never uses a shell and a shell would reintroduce the cwd lookup.
function spawnResolved(cmd, args = [], opts = {}) {
  if (opts.shell) throw new Error('spawnResolved: shell spawns are not allowed');
  const env = childEnv(opts.env);
  const exe = resolveExe(cmd, opts.env || process.env);
  if (!exe) return failedChild(cmd, args, 'ENOENT');
  return child_process.spawn(exe, args, { ...opts, env });
}

// execFileSync() with the same resolution; throws ENOENT (like Node) when `cmd` resolves to nothing.
function execFileResolved(cmd, args = [], opts = {}) {
  if (opts.shell) throw new Error('execFileResolved: shell spawns are not allowed');
  const exe = resolveExe(cmd, opts.env || process.env);
  if (!exe) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT', syscall: `spawn ${cmd}`, path: cmd, spawnargs: args });
  return child_process.execFileSync(exe, args, { ...opts, env: childEnv(opts.env) });
}

// Kill a CLI child and everything it spawned (Windows: taskkill /T /F; elsewhere SIGTERM).
function killTree(child) {
  if (!child || !child.pid) return;
  if (WIN) spawnResolved('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else child.kill('SIGTERM');
}

module.exports = { codexEnv, killTree, resolveBin, resolveShims, resolveExe, spawnResolved, execFileResolved, isExecutableFile, NO_CWD_VAR };
