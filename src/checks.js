// Acceptance checks: shell commands a plan item carries (only when the owner turned them on for the plan), run in the
// item worktree after the patch is frozen. Model-free: spawn with the platform shell and a minimal environment, kill the
// whole process tree on exit, timeout or stop, cap the output. They are NOT sandboxed: they run with the owner's rights.
const { killTree, spawnResolved } = require('./platform');

const WIN = process.platform === 'win32';
// The project's shell: cmd.exe on Windows, sh elsewhere. spawnResolved refuses shell:true, so the shell is the executable.
const shellSpawn = (cmd, cwd, env) => (WIN
  ? spawnResolved('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawnResolved('sh', ['-c', cmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }));

// Variables a check keeps (compared in lower case: Windows env names are case-insensitive). Everything else, secrets
// included (*_TOKEN, *_KEY, AWS_*, GITHUB_*, SSH_AUTH_SOCK, proxy credentials...), is dropped.
const ENV_KEEP = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'systemdrive', 'temp', 'tmp', 'tmpdir',
  'home', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'programfiles', 'programfiles(x86)',
  'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)', 'commonprogramw6432', 'os', 'number_of_processors',
  'processor_architecture', 'lang', 'lc_all', 'lc_ctype', 'tz', 'term', 'shell', 'user', 'username', 'logname']);
// A kept name never looks like a secret either (defence for a future allowlist change).
const SECRET_NAME = /(?:TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|PRIVATE_?KEY|(?:^|_)KEY$|^AWS_|^GITHUB_|^GH_|^NPM_CONFIG_)/i;

// The environment a check gets: the allowlisted variables of `base` only, plus CI=1 so tools do not prompt.
function checkEnv(base = process.env) {
  const env = {};
  for (const k of Object.keys(base)) {
    if (base[k] === undefined || !ENV_KEEP.has(k.toLowerCase()) || SECRET_NAME.test(k)) continue;
    env[k] = base[k];
  }
  env.CI = '1';
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// True while any process of the child's group is alive (POSIX). Windows has no group probe: it is never "alive" here.
function groupAlive(child) {
  if (WIN || !child || !child.pid) return false;
  try { process.kill(-child.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Kills the child's whole tree and waits for it to drain, so nothing the check started outlives it. Safe to call after
// the shell exited: on POSIX the group lives as long as a member does (SIGTERM, then SIGKILL after a short grace); on
// Windows taskkill /T walks the tree from the pid, which reaches what is still linked to it. A grandchild already
// orphaned from the shell (start /b after the shell exited) is beyond taskkill: that needs a job object.
// KNOWN GAP (Windows): once the shell has exited its pid may be reused by an unrelated process, so taskkill is NOT
// called then and a check that backgrounds a child (start /b ...) and exits can leave that child running. Only
// timeout and stop, where the shell is still alive, kill the tree. Closing this needs a job object.
// `kill` is the tree-kill helper (injectable for tests); `win` overrides the platform check for the same reason.
async function reapTree(child, { kill = killTree, win = WIN } = {}) {
  if (!child || !child.pid) return;
  const shellGone = child.exitCode !== null || child.signalCode !== null;
  // On Windows a dead shell's pid may already belong to an unrelated process: never taskkill it. Background processes a
  // check starts may outlive it there. POSIX keeps the process-group kill on a normal exit.
  if (win && shellGone) return;
  try { kill(child); } catch {}
  if (win) { await sleep(150); return; }
  const t0 = Date.now();
  let hard = false;
  while (groupAlive(child) && Date.now() - t0 < 2000) {
    await sleep(25);
    if (!hard && Date.now() - t0 > 300) { hard = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
}

// Returns { name, ok, code, ms, tail }. tail is the last maxOutput characters of stdout+stderr. code is null on timeout,
// stop or spawn failure. The tree is killed when the check exits, times out or `stopped()` turns true.
function runOne(cwd, check, { timeoutMs, maxOutput, stopped, env, kill, win }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '', done = false, timedOut = false, wasStopped = false, reaping = false, closed = false, child, exitCode = null;
    let timer, poll, onClosed = null;
    const finish = (c, extra = '') => {
      if (done) return;
      done = true; clearTimeout(timer); clearInterval(poll);
      const note = timedOut ? (extra || `\n[timed out after ${timeoutMs} ms]`) : wasStopped ? '\n[stopped]' : extra;
      let tail = out + note;
      if (tail.length > maxOutput) tail = '…' + tail.slice(tail.length - maxOutput);
      resolve({ name: check.name, ok: c === 0 && !timedOut && !wasStopped, code: timedOut || wasStopped ? null : c, ms: Date.now() - t0, tail });
    };
    // Kill everything the check started, then report. Used for exit, timeout and stop alike; runs once.
    const reapThen = (c, extra) => {
      if (reaping) return;
      reaping = true;
      // After the kill, give the pipes a moment to deliver the last output before reporting.
      const drained = () => (closed ? null : new Promise((r) => { onClosed = r; setTimeout(r, 500).unref(); }));
      reapTree(child, { kill, win }).catch(() => {}).then(drained).then(() => finish(c, extra));
    };
    timer = setTimeout(() => {
      timedOut = true;
      reapThen(null, `\n[timed out after ${timeoutMs} ms]`);
    }, timeoutMs);
    if (typeof stopped === 'function') {
      poll = setInterval(() => {
        if (done || reaping || !stopped()) return;
        wasStopped = true; reapThen(null);
      }, 200);
      poll.unref();
    }
    try {
      child = shellSpawn(check.cmd, cwd, env);
    } catch (e) { return finish(null, `[could not start: ${e.message}]`); }
    const onData = (d) => { out += d.toString('utf8'); if (out.length > maxOutput * 4) out = out.slice(out.length - maxOutput * 2); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', (e) => finish(null, `[could not start: ${e.message}]`));
    // The shell exited (or its pipes closed): whatever it left running, a backgrounded grandchild included, dies now,
    // before the check is reported.
    child.on('exit', (c) => { exitCode = c; reapThen(c); });
    child.on('close', (c) => { closed = true; if (onClosed) onClosed(); reapThen(exitCode ?? c); });
  });
}

// Returns [{ name, ok, code, ms, tail }] in order; every check runs even after a failure so the builder sees all of them.
// opts: timeoutMs, maxOutput, stopped() (true ends the run: the running check is killed, the rest are skipped), env
// (the base environment to filter, default process.env), kill/win (test hooks for the tree-kill helper and platform). Each check gets checkEnv(env).
async function runChecks(cwd, checks, { timeoutMs = 120000, maxOutput = 8000, stopped = null, env = process.env, kill = killTree, win = WIN } = {}) {
  const results = [];
  const childEnv = checkEnv(env);
  for (const c of checks || []) {
    if (typeof stopped === 'function' && stopped()) break;
    results.push(await runOne(cwd, c, { timeoutMs, maxOutput, stopped, env: childEnv, kill, win }));
  }
  return results;
}

// Plain-text summary for a prompt: one line per check, failure tails indented.
function formatChecks(results) {
  return results.map((r) => `- ${r.name}: ${r.ok ? 'PASS' : 'FAIL'} (exit ${r.code === null ? 'none' : r.code}, ${r.ms} ms)`
    + (r.ok || !r.tail ? '' : '\n' + r.tail.split(/\r?\n/).map((l) => '    ' + l).join('\n'))).join('\n');
}

module.exports = { runChecks, formatChecks, checkEnv, reapTree };
