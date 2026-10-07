// CLI entry (bin/orchestra-board.js) and the legacy `node server.js [projectDir] [port]` shim: argument parsing,
// real process launch on test ports 4395/4396 with unlaunchable CLI names, doctor --json, --help.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { tmpDir, rmrf, waitFor, request, samePath, freePort } = require('./helpers');
const { parseArgs } = require('../bin/orchestra-board');

const ROOT = path.join(__dirname, '..');
// Child processes get an empty home so neither the board's limits poller nor `doctor` reads the real ~/.codex or ~/.claude.
const HOME = tmpDir('ob-cli-home-');
const ENV = { ...process.env, ORCHESTRA_CLAUDE_BIN: 'fake-claude-not-installed', ORCHESTRA_CODEX_BIN: 'fake-codex-not-installed', NO_COLOR: '1', HOME, USERPROFILE: HOME };
delete ENV.PORT; delete ENV.CODEX_HOME;
after(() => rmrf(HOME));

test('parseArgs: defaults, --port forms, --open, legacy [projectDir] [port], doctor, help', () => {
  assert.deepEqual(pick(parseArgs([])), { projectDir: null, port: null, open: false, help: false, cmd: null });
  assert.deepEqual(pick(parseArgs(['C:/proj', '--port', '4391', '--open'])), { projectDir: 'C:/proj', port: 4391, open: true, help: false, cmd: null });
  assert.deepEqual(pick(parseArgs(['--port=4392', 'proj'])), { projectDir: 'proj', port: 4392, open: false, help: false, cmd: null });
  assert.deepEqual(pick(parseArgs(['proj', '4317'])), { projectDir: 'proj', port: 4317, open: false, help: false, cmd: null }, 'legacy positional port');
  assert.deepEqual(pick(parseArgs(['proj', '4317', '--port', '4390'])), { projectDir: 'proj', port: 4390, open: false, help: false, cmd: null }, '--port beats the legacy positional');
  assert.deepEqual(pick(parseArgs(['doctor'])), { projectDir: null, port: null, open: false, help: false, cmd: 'doctor' });
  assert.deepEqual(pick(parseArgs(['doctor', 'proj'])), { projectDir: 'proj', port: null, open: false, help: false, cmd: 'doctor' });
  assert.equal(parseArgs(['--help']).help, true); assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['proj', 'notaport']).port, null, 'a non-numeric second positional is not a port');
  function pick(a) { return { projectDir: a.projectDir, port: a.port, open: a.open, help: a.help, cmd: a.cmd }; }
});

// Starts a board process, waits for the printed URL, returns {child, url, port, token}. Rejects with code
// 'EADDRINUSE' (child killed) as soon as the child reports the port taken, instead of waiting for the banner.
function launch(args, env = ENV) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', exited = false;
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  child.once('exit', () => { exited = true; });
  const ready = waitFor(() => {
    if (/EADDRINUSE/.test(out) || (exited && !/http:\/\/localhost:/.test(out))) throw Object.assign(new Error('board did not start: ' + out), { code: /EADDRINUSE/.test(out) ? 'EADDRINUSE' : 'EXIT' });
    const m = out.match(/http:\/\/localhost:(\d+)\/\S*/);
    return m && { url: m[0], port: Number(m[1]), token: (m[0].match(/[?&]t=([\w-]+)/) || [])[1] || null };
  }, { timeout: 15000, what: 'board start banner: ' + out });
  return ready.then((info) => ({ child, out: () => out, ...info }), async (e) => { await kill(child); throw e; });
}
const kill = (child) => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(); });

// freePort() probes and releases the port before the child binds it (TOCTOU): when the child loses that race
// (EADDRINUSE from a parallel test file or a smoke test) the launch is retried on the next free port. argsFor(port)
// / envFor(port) build the launch for a candidate; `exclude` keeps a second port of the same test apart.
async function launchOnFreePort(preferred, argsFor, envFor = () => ENV, { exclude = [] } = {}) {
  const tried = [...exclude];
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort(preferred, { exclude: tried });
    tried.push(port);
    try { return { ...(await launch(argsFor(port), envFor(port))), requested: port }; }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('no CLI test port could be bound after 5 attempts');
}

test('legacy launch `node server.js <project> <port>`: serves the board on 127.0.0.1:<port> for that project', { timeout: 30000 }, async () => {
  const project = tmpDir('ob-cli-');
  const b = await launchOnFreePort(4395, (port) => ['server.js', project, String(port)]);
  const port = b.port;
  try {
    assert.equal(b.port, b.requested, 'the banner names the requested port');
    let cookie = null;
    if (b.token) {
      const x = await request(port, 'GET', `/?t=${b.token}`);
      assert.equal(x.status, 303);
      cookie = String(x.headers['set-cookie']).split(';')[0];
    }
    const home = await request(port, 'GET', '/', { cookie });
    assert.equal(home.status, 200); assert.match(home.headers['content-type'], /text\/html/);
    const st = await request(port, 'GET', '/api/state', { cookie });
    assert.equal(st.status, 200); assert.ok(samePath(st.json.project, project));
    assert.ok(fs.existsSync(path.join(project, '.orchestra')), '.orchestra/ is created for the project');
    assert.match(fs.readFileSync(path.join(project, '.orchestra', '.gitignore'), 'utf8'), /^session$/m, '.orchestra/.gitignore keeps the session token out of git');
    assert.equal((await request(port, 'GET', '/api/state', { host: 'evil.example' })).status, 403);
  } finally { await kill(b.child); rmrf(project); }
});

test('`orchestra-board <project> --port <n>` wins over $PORT; the board binds only 127.0.0.1', { timeout: 30000 }, async () => {
  const project = tmpDir('ob-cli-');
  // $PORT must name a port nobody binds during this test: in-process suites never fall back into the CLI half
  // (helpers.APP_PORTS), and the launch below never takes it either (excluded from its candidates).
  const envPort = await freePort(4399);
  const b = await launchOnFreePort(4396, (port) => ['bin/orchestra-board.js', project, '--port', String(port)], () => ({ ...ENV, PORT: String(envPort) }), { exclude: [envPort] });
  const port = b.port;
  try {
    assert.equal(port, b.requested, '--port wins over $PORT'); assert.notEqual(port, envPort);
    assert.equal((await request(port, 'GET', '/app.css')).status, 200);
    await assert.rejects(request(envPort, 'GET', '/app.css'), 'nothing listens on $PORT');
  } finally { await kill(b.child); rmrf(project); }
});

test('start: a missing project path or a file exits 2 with a clear message and creates nothing', { timeout: 30000 }, () => {
  const base = tmpDir('ob-cli-');
  try {
    const missing = path.join(base, 'typo');
    const r = spawnSync(process.execPath, ['bin/orchestra-board.js', missing, '--port', '4399'], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /project directory does not exist/);
    assert.equal(fs.existsSync(missing), false, 'the typo is not created');
    const file = path.join(base, 'notes.txt'); fs.writeFileSync(file, 'x');
    const r2 = spawnSync(process.execPath, ['bin/orchestra-board.js', file, '--port', '4399'], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(r2.status, 2, r2.stdout + r2.stderr); assert.match(r2.stderr, /not a directory/);
    assert.deepEqual(fs.readdirSync(base), ['notes.txt'], 'nothing else appeared next to it');
  } finally { rmrf(base); }
});

test('`orchestra-board doctor --json` prints a JSON report with a checks array and never starts a model call', { timeout: 30000 }, () => {
  const project = tmpDir('ob-cli-');
  try {
    const r = spawnSync(process.execPath, ['bin/orchestra-board.js', 'doctor', project, '--json'], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    assert.ok(Array.isArray(json.checks));
    for (const c of json.checks) assert.ok(c.id && c.name && ['ok', 'warn', 'fail', 'skip'].includes(c.status) && typeof c.detail === 'string', JSON.stringify(c));
    if ('ok' in json) assert.equal(json.ok, !json.checks.some((c) => c.status === 'fail'));
  } finally { rmrf(project); }
});

test('`orchestra-board --help` prints usage and exits 0', () => {
  const r = spawnSync(process.execPath, ['bin/orchestra-board.js', '--help'], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: agent-orchestra-board \[projectDir\] \[--port <n>\] \[--open\]/);
  assert.match(r.stdout, /orchestra-board doctor/);
});
