// CLI entry (bin/agent-orchestra-board.js) and the legacy `node server.js [projectDir] [port]` shim: argument parsing,
// real process launch on test ports 4395/4396 with unlaunchable CLI names, doctor --json, --help.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { tmpDir, rmrf, waitFor, request, samePath, freePort } = require('./helpers');
const { parseArgs } = require('../bin/agent-orchestra-board');

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
    // The CLI words a taken port as "port N is already in use" (which itself contains an http://localhost: URL).
    const conflict = /EADDRINUSE|is already in use/.test(out);
    if (conflict || (exited && !/http:\/\/localhost:\d+\/\?t=/.test(out))) throw Object.assign(new Error('board did not start: ' + out), { code: conflict ? 'EADDRINUSE' : 'EXIT' });
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

test('launchOnFreePort retries on another port when the first candidate is held (real CLI children)', { timeout: 45000 }, async () => {
  const project = tmpDir('ob-cli-');
  const held = require('net').createServer();
  await new Promise((r) => held.listen(0, '127.0.0.1', r));
  const heldPort = held.address().port;
  try {
    // A child asked for the held port must report a conflict, not hang or look started.
    await assert.rejects(launch(['bin/agent-orchestra-board.js', project, '--port', String(heldPort)]), (e) => e.code === 'EADDRINUSE');
    // The retry loop moves on: the first candidate is forced to the held port via a stubbed freePort sequence.
    const seen = [];
    const b = await launchOnFreePort(4395, (port) => { seen.push(port); return ['bin/agent-orchestra-board.js', project, '--port', String(seen.length === 1 ? heldPort : port)]; });
    try {
      assert.ok(seen.length >= 2, 'first attempt hit the held port and was retried');
      assert.notEqual(b.port, heldPort);
    } finally { await kill(b.child); }
  } finally { await new Promise((r) => held.close(r)); rmrf(project); }
});

test('`orchestra-board <project> --port <n>` wins over $PORT; the board binds only 127.0.0.1', { timeout: 30000 }, async () => {
  const project = tmpDir('ob-cli-');
  // $PORT must name a port nobody binds during this test: in-process suites never fall back into the CLI half
  // (helpers.APP_PORTS), and the launch below never takes it either (excluded from its candidates).
  const envPort = await freePort(4399);
  const b = await launchOnFreePort(4396, (port) => ['bin/agent-orchestra-board.js', project, '--port', String(port)], () => ({ ...ENV, PORT: String(envPort) }), { exclude: [envPort] });
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
    const r = spawnSync(process.execPath, ['bin/agent-orchestra-board.js', missing, '--port', '4399'], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /project directory does not exist/);
    assert.equal(fs.existsSync(missing), false, 'the typo is not created');
    const file = path.join(base, 'notes.txt'); fs.writeFileSync(file, 'x');
    const r2 = spawnSync(process.execPath, ['bin/agent-orchestra-board.js', file, '--port', '4399'], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(r2.status, 2, r2.stdout + r2.stderr); assert.match(r2.stderr, /not a directory/);
    assert.deepEqual(fs.readdirSync(base), ['notes.txt'], 'nothing else appeared next to it');
  } finally { rmrf(base); }
});

test('`orchestra-board doctor --json` prints a JSON report with a checks array and never starts a model call', { timeout: 30000 }, () => {
  const project = tmpDir('ob-cli-');
  try {
    const r = spawnSync(process.execPath, ['bin/agent-orchestra-board.js', 'doctor', project, '--json'], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    assert.ok(Array.isArray(json.checks));
    for (const c of json.checks) assert.ok(c.id && c.name && ['ok', 'warn', 'fail', 'skip'].includes(c.status) && typeof c.detail === 'string', JSON.stringify(c));
    if ('ok' in json) assert.equal(json.ok, !json.checks.some((c) => c.status === 'fail'));
  } finally { rmrf(project); }
});

test('`orchestra-board --help` prints usage and exits 0', () => {
  const r = spawnSync(process.execPath, ['bin/agent-orchestra-board.js', '--help'], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: agent-orchestra-board \[projectDir\] \[--port <n>\] \[--open\]/);
  assert.match(r.stdout, /orchestra-board doctor/);
  assert.match(r.stdout, /doctor --containment \[--yes\] \[--json\]/);
});

test('parseArgs: --containment and --yes belong to doctor, and --yes needs --containment', () => {
  const a = parseArgs(['doctor', '--containment', '--yes', '--json']);
  assert.deepEqual([a.cmd, a.containment, a.yes, a.json], ['doctor', true, true, true]);
  assert.deepEqual([parseArgs(['doctor']).containment, parseArgs(['doctor']).yes], [false, false]);
  for (const argv of [['--containment'], ['--yes'], ['proj', '--containment', '--yes'], ['doctor', '--yes']]) {
    assert.throws(() => parseArgs(argv), (e) => e.exitCode === 2 && /works only with doctor/.test(e.message), argv.join(' '));
  }
});

// The containment check must never start under CI, and without --yes it only prints its plan. Neither case may create
// anything in the temp dir (TMP/TEMP/TMPDIR point at an empty one).
test('`orchestra-board doctor --containment`: the plan without --yes (exit 2), a refusal under CI (exit 2), nothing created', { timeout: 30000 }, () => {
  const tmp = tmpDir('ob-cli-tmp-');
  try {
    const base = { ...ENV, TMP: tmp, TEMP: tmp, TMPDIR: tmp };
    delete base.CI; delete base.GITHUB_ACTIONS;
    const r = spawnSync(process.execPath, ['bin/agent-orchestra-board.js', 'doctor', '--containment'], { cwd: ROOT, env: base, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /claude-haiku-5-5/); assert.match(r.stdout, /gpt-6-luna/);
    assert.match(r.stdout, /a few cents, your project is not touched/);
    assert.match(r.stdout, /Add --yes to run it\./);
    for (const ci of [{ CI: '1' }, { GITHUB_ACTIONS: 'true' }]) {
      const c = spawnSync(process.execPath, ['bin/agent-orchestra-board.js', 'doctor', '--containment', '--yes'], { cwd: ROOT, env: { ...base, ...ci }, encoding: 'utf8', windowsHide: true, timeout: 25000 });
      assert.equal(c.status, 2, c.stdout + c.stderr);
      assert.match(c.stderr, /never runs under CI/);
      assert.doesNotMatch(c.stdout, /claude-haiku/, 'nothing is planned under CI');
    }
    const j = spawnSync(process.execPath, ['bin/agent-orchestra-board.js', 'doctor', '--containment', '--json'], { cwd: ROOT, env: base, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(j.status, 2);
    const json = JSON.parse(j.stdout);
    assert.equal(json.refused, 'unconfirmed'); assert.ok(json.plan.some((l) => /gpt-6-luna/.test(l)));
    assert.deepEqual(fs.readdirSync(tmp), [], 'the temp dir stays empty');
    const bad = spawnSync(process.execPath, ['bin/agent-orchestra-board.js', '--containment'], { cwd: ROOT, env: base, encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(bad.status, 2); assert.match(bad.stderr, /--containment works only with doctor/);
  } finally { rmrf(tmp); }
});
