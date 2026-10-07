// Shared test helpers: temp projects under the OS temp dir, in-process server on a test port (4390-4399),
// a cookie-aware HTTP/SSE client and polling. No real CLI is ever started: callers point ORCHESTRA_*_BIN at the fakes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test } = require('node:test');

const tmpDir = (prefix = 'ob-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// Windows may still hold the freshly built fake-cli .exe (antivirus scan, exiting child): retry patiently.
const rmrf = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 }); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls fn (sync or async) until it returns a truthy value, which is resolved.
async function waitFor(fn, { timeout = 10000, interval = 25, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await sleep(interval);
  }
}

// request(port, 'POST', '/api/x', {body, headers, host, cookie}) -> {status, headers, text, json}.
function request(port, method, p, { body, headers = {}, host, cookie } = {}) {
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
    const api = {
      events, status: null, headers: null, text: '',
      close: () => req.destroy(),
      waitFor: (pred, opts) => waitFor(() => events.find(pred), { what: 'SSE event', ...opts }),
      of: (t) => events.filter((e) => e.t === t),
    };
  });
}

// Test servers may only use 4390-4399. In-process suites (startApp) live on 4390-4394 and the CLI suite, which
// launches real child processes, on 4395-4399: a busy preferred port falls back to the next free one in its own
// half only, so an in-process fallback can never race a CLI test for the port it just probed. Every suite reads
// the port from the returned ctx.
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
// every codex turn read the newest rollout file from there. Returns the home path; idempotent per dir.
function isolateHome(dir) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.OB_TEST_HOME = home;
  delete process.env.CODEX_HOME; // limits.js and doctor honour it: a developer's real Codex home must not leak in
  if (path.resolve(os.homedir()) !== path.resolve(home)) throw new Error(`home dir not redirected: os.homedir() = ${os.homedir()}`);
  return home;
}

// Starts the board in-process and returns a client bound to it (cookie from the per-project token the server
// persists in <project>/.orchestra/session).
// The home dir is isolated before createServer() (whose start() runs the limits poller) unless the caller already
// did so through isolateHome()/setupFakeCli(); a home created here is removed again by ctx.stop().
async function startApp({ port: preferred, projectDir }) {
  const { createServer } = require('../src/server');
  let ownHome = null;
  if (!process.env.OB_TEST_HOME || !fs.existsSync(process.env.OB_TEST_HOME)) { ownHome = tmpDir('ob-home-'); isolateHome(ownHome); }
  let app = null, info = null, port = null, lastErr = null;
  // Suites run in parallel and each holds its port for its whole life: when all five app ports are busy, wait for one.
  for (let attempt = 0; attempt < 60 && !app; attempt++) {
    for (const p of candidates(preferred, APP_PORTS)) {
      const candidate = createServer({ projectDir, port: p });
      try { info = await candidate.start(); app = candidate; port = p; break; }
      catch (e) { lastErr = e; try { await candidate.close(); } catch {} if (e && e.code !== 'EADDRINUSE') throw e; }
    }
    if (!app) await sleep(250);
  }
  if (!app) { if (ownHome) rmrf(ownHome); throw lastErr || new Error('no free test port in 4390-4394'); }
  app.__testHome = ownHome;
  const token = app.token || (String(info.url).match(/[?&]t=([\w-]+)/) || [])[1] || null;
  const cookie = token ? `ob_session_${port}=${token}` : null;
  const ctx = {
    app, port, token, cookie, info,
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
  await app.close();
  if (app.__testHome) rmrf(app.__testHome);
}

// Declares a test that is skipped (with the reason) when the fake CLI could not be built on this machine.
const testWithFake = (fake, name, opts, fn) => {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
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

module.exports = { tmpDir, rmrf, sleep, waitFor, startApp, stopApp, request, sse, testWithFake, isDead, treePids, treeDead, canon, samePath, freePort, isolateHome, teardown, PORT_RANGE, APP_PORTS, CLI_PORTS };
