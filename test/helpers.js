// Shared test helpers: temp projects under the OS temp dir, in-process server on an OS assigned port,
// a cookie-aware HTTP/SSE client and polling. No real CLI is ever started: callers point ORCHESTRA_*_BIN at the fakes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, after } = require('node:test');

const tmpDir = (prefix = 'ob-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// Windows may still hold the freshly built fake-cli .exe (antivirus scan, exiting child): retry patiently.
const rmrf = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 }); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rejects with a clear message when `promise` has not settled after `ms`. Every wait on something outside the test
// (a close, an exit, a response) goes through this, so a stalled machine fails one test instead of hanging the suite.
function withDeadline(promise, ms, what = 'operation') {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms); });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
}

// Polls fn (sync or async) until it returns a truthy value, which is resolved. A single call of fn that never
// returns is cut off by the same deadline.
async function waitFor(fn, { timeout = 10000, interval = 25, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const left = Math.max(1, timeout - (Date.now() - t0));
    const v = await withDeadline(fn(), left, what);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await sleep(interval);
  }
}

// Safety net for a test file: node:test only ends a file's process once the event loop drains, so one leaked socket
// or child process would stall the whole run. The guard is registered after the file finished loading, so its hook
// runs after every cleanup hook of the file; only then does the timer start. If the process is still alive ms later
// it prints what happened and exits with a failing code (never 0, which would hide the leak).
function exitGuard(ms = 15000) {
  setImmediate(() => {
    after(() => {
      setTimeout(() => {
        process.stderr.write(`exitGuard: this test file was still running ${ms}ms after its last cleanup hook (leaked socket, timer or child process); exiting with code 1\n`);
        process.exit(1);
      }, ms).unref();
    });
  });
}

// request(port, 'POST', '/api/x', {body, headers, host, cookie}) -> {status, headers, text, json}.
function request(port, method, p, { body, headers = {}, host, cookie, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
    if (host !== undefined) h.host = host;
    if (cookie) h.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: s, json }); });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`${method} ${p} got no answer within ${timeout}ms`)));
    if (data !== null) req.write(data);
    req.end();
  });
}

// Opens /api/events; resolves once the hello event arrived. events: parsed `data:` payloads in order.
function sse(port, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buf = '', hello = false;
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false, headers: cookie ? { cookie } : {} }, (res) => {
      api.status = res.statusCode; api.headers = res.headers;
      if (res.statusCode !== 200) { let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; }); res.on('end', () => { api.text = s; resolve(api); }); return; }
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
        }
        if (!hello && events.some((e) => e.t === 'hello')) { hello = true; resolve(api); }
      });
    });
    req.on('error', (e) => { if (!hello) reject(e); });
    req.setTimeout(30000, () => { if (!hello) req.destroy(new Error('no hello event on /api/events within 30000ms')); });
    const api = {
      events, status: null, headers: null, text: '',
      close: () => req.destroy(),
      waitFor: (pred, opts) => waitFor(() => events.find(pred), { what: 'SSE event', ...opts }),
      of: (t) => events.filter((e) => e.t === t),
    };
  });
}

// In-process suites (startApp) bind port 0 and read the real port from ctx.port. Only the CLI suite, which launches
// real child processes that need a numeric --port, uses the fixed range 4395-4399 through freePort().
const PORT_RANGE = Array.from({ length: 10 }, (_, i) => 4390 + i);
const APP_PORTS = PORT_RANGE.filter((p) => p <= 4394);
const CLI_PORTS = PORT_RANGE.filter((p) => p >= 4395);
const candidates = (preferred, range) => (range.includes(preferred) ? [preferred, ...range.filter((p) => p !== preferred)] : [...range]);
const portFree = (p) => new Promise((resolve) => {
  const s = require('net').createServer(); s.unref();
  s.once('error', () => resolve(false));
  s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
});
// First free port of `range` (default: the CLI half), trying `preferred` first and skipping `exclude`d ports.
async function freePort(preferred, { range = CLI_PORTS, exclude = [] } = {}) {
  for (const p of candidates(preferred, range)) if (!exclude.includes(p) && await portFree(p)) return p;
  throw new Error(`no free test port in ${range[0]}-${range[range.length - 1]}`);
}

// Points HOME and USERPROFILE (what os.homedir() reads) at <dir>/home so nothing under the test ever touches the
// developer's real ~/.codex/sessions, ~/.claude or ~/.claude.json: the limits poller and the codex refresh after
// every codex turn read the newest rollout file from there. APPDATA and XDG_CONFIG_HOME follow, so the per-user
// write-check records (capability.defaultRecordsDir) of a board started without a recordsDir land in the test home
// too, never in the developer's real profile. Returns the home path; idempotent per dir.
function isolateHome(dir) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.OB_TEST_HOME = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming'); process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  delete process.env.CODEX_HOME; // limits.js and doctor honour it: a developer's real Codex home must not leak in
  if (path.resolve(os.homedir()) !== path.resolve(home)) throw new Error(`home dir not redirected: os.homedir() = ${os.homedir()}`);
  const records = require('../src/capability').defaultRecordsDir();
  if (!path.resolve(records).startsWith(path.resolve(home) + path.sep)) throw new Error(`write-check records not redirected: ${records}`);
  return home;
}

// Starts the board in-process and returns a client bound to it (cookie from the per-project token the server
// persists in <project>/.orchestra/session).
// The home dir is isolated before createServer() (whose start() runs the limits poller) unless the caller already
// did so through isolateHome()/setupFakeCli(); a home created here is removed again by ctx.stop().
// platform simulates another OS for the write gate; recordsDir is where write-check records go (default: a folder in
// the isolated test home, so a restarted board in the same suite sees the records of the one before).
async function startApp({ projectDir, platform, recordsDir }) {
  const { createServer } = require('../src/server');
  let ownHome = null;
  if (!process.env.OB_TEST_HOME || !fs.existsSync(process.env.OB_TEST_HOME)) { ownHome = tmpDir('ob-home-'); isolateHome(ownHome); }
  const records = recordsDir || path.join(process.env.OB_TEST_HOME, 'ob-records');
  // Port 0: the OS hands out a free port, so overlapping test runs can never collide. start() reports the real one.
  const app = createServer({ projectDir, port: 0, platform, recordsDir: records });
  let info;
  try { info = await app.start(); } catch (e) { try { await app.close(); } catch {} if (ownHome) rmrf(ownHome); throw e; }
  const port = info.port;
  app.__testHome = ownHome;
  const token = app.token || (String(info.url).match(/[?&]t=([\w-]+)/) || [])[1] || null;
  const cookie = token ? `ob_session_${port}=${token}` : null;
  const ctx = {
    app, port, token, cookie, info, recordsDir: records,
    request: (method, p, o = {}) => request(port, method, p, { cookie, ...o }),
    get: (p, o = {}) => request(port, 'GET', p, { cookie, ...o }),
    post: (p, body, o = {}) => request(port, 'POST', p, { cookie, ...o, body: body === undefined ? {} : body }),
    sse: (o = {}) => sse(port, { cookie, ...o }),
    state: async () => (await request(port, 'GET', '/api/state', { cookie })).json,
    room: async (id) => (await ctx.state()).rooms.find((r) => r.id === id),
    seat: async (id) => (await ctx.state()).seats.find((s) => s.id === id),
    stop: () => stopApp(app),
  };
  return ctx;
}

// Stops any running seat children (process tree) and closes the server.
async function stopApp(app) {
  if (!app) return;
  for (const s of app.seats.all()) if (app.seats.rtOf(s.id).child) app.runner.stopSeat(s.id);
  try { await waitFor(() => app.seats.all().every((s) => !app.seats.rtOf(s.id).child), { timeout: 8000, what: 'seat children to exit' }); } catch {}
  if (typeof app.server.closeAllConnections === 'function') app.server.closeAllConnections();
  try { await withDeadline(app.close(), 20000, 'the board server to close'); } finally { if (app.__testHome) rmrf(app.__testHome); }
}

// Declares a test that is skipped (with the reason) when the fake CLI could not be built on this machine.
// On GitHub Actions the same situation fails instead, so a runner without csc.exe cannot pass with silent skips.
const testWithFake = (fake, name, opts, fn) => {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  if (fake.skipReason && process.env.GITHUB_ACTIONS) {
    return test(name, { timeout: 30000, ...opts }, () => { throw new Error(`fake CLI unavailable on CI: ${fake.skipReason}`); });
  }
  return test(name, { timeout: 30000, ...opts, skip: fake.skipReason || false }, fn);
};

// True when the process no longer exists (signal 0 probe).
const isDead = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH' || e.code === 'EPERM' ? e.code === 'ESRCH' : true; } };
// The pids a fake CLI call's process tree consists of, from its logged {pid, ppid}. On Windows the runner starts
// the compiled shim (ppid) which starts node (pid), so both must die. On POSIX the sh wrapper `exec`s node, so
// node keeps the wrapper's pid and its parent is the runner itself (this test process when the app runs
// in-process). A spawned long command (childPid) belongs to the tree on either platform.
const treePids = (call) => [...(process.platform === 'win32' && call.ppid && call.ppid !== process.pid ? [call.pid, call.ppid] : [call.pid]), ...(call.childPid ? [call.childPid] : [])];
const treeDead = (call) => treePids(call).every(isDead);

// Path equality that survives Windows case differences, 8.3 names and symlinked temp dirs.
const canon = (p) => { let r = String(p); try { r = (fs.realpathSync.native || fs.realpathSync)(r); } catch {} return process.platform === 'win32' ? r.toLowerCase() : r; };
const samePath = (a, b) => canon(a) === canon(b);

// Cleanup for `after` hooks: stop the app if it started, then remove the temp dir, never throwing.
async function teardown(ctx, dir) {
  try { if (ctx) await ctx.stop(); } catch {}
  if (!dir) return;
  rmrf(dir);
  if (fs.existsSync(dir)) { await sleep(300); rmrf(dir); }
}

// Git helpers for worktree tests: a real repository in a temp dir, created with a fixed identity.
const hasGit = (() => { try { return require('child_process').spawnSync('git', ['--version'], { windowsHide: true, timeout: 30000 }).status === 0; } catch { return false; } })();
// Upper bound for one git call in a test (a stalled antivirus scan or a lock wait must fail the test, not hang it).
const GIT_TIMEOUT_MS = 120000;
function gitIn(dir, args) {
  const r = require('child_process').spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS });
  if (r.error) throw new Error(`git ${args.join(' ')} did not finish: ${r.error.message}`);
  if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(' ')} failed`);
  return String(r.stdout).trim();
}
// Creates a repository with one commit holding `files` ({relative path: content}); returns the HEAD sha.
function initRepo(dir, files = { 'README.md': 'hello\n' }) {
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, ['init', '-q']);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  return gitIn(dir, ['rev-parse', 'HEAD']);
}

module.exports = { withDeadline, exitGuard, GIT_TIMEOUT_MS, tmpDir, rmrf, sleep, waitFor, startApp, stopApp, request, sse, testWithFake, isDead, treePids, treeDead, canon, samePath, freePort, isolateHome, teardown, hasGit, gitIn, initRepo, PORT_RANGE, APP_PORTS, CLI_PORTS };
