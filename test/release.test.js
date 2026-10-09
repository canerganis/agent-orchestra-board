// Release checks for v0.2.0. No CLI, no server, no network: both bin names run the same file and answer --version and
// --help; the npm tarball (dry run) carries the board runtime and no tests, docs, bench or state; plan and build logic
// name no agent or model; the Claude write argv and both CLIs pass the static write check; the generated
// .orchestra/.gitignore keeps the session token and the worktrees out of git; the newest CHANGELOG section is the
// package version.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createStore } = require('../src/store');
const { staticCheck } = require('../src/capability');
const claude = require('../src/adapters/claude');

const ROOT = path.join(__dirname, '..');
const BIN = 'bin/agent-orchestra-board.js';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rmTemp = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {} };

test('bin: both names point at the same file, which has a node shebang and answers --version and --help', () => {
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['agent-orchestra-board', 'aob']);
  for (const name of Object.keys(pkg.bin)) assert.equal(pkg.bin[name], BIN, `bin "${name}"`);
  const binPath = path.join(ROOT, BIN);
  assert.ok(fs.existsSync(binPath), `${BIN} exists`);
  assert.equal(fs.readFileSync(binPath, 'utf8').split(/\r?\n/)[0], '#!/usr/bin/env node');
  const version = new RegExp(`(^|\\s)${escapeRe(pkg.version)}\\s*$`, 'm');
  const opts = { cwd: ROOT, encoding: 'utf8', timeout: 20000, windowsHide: true };
  for (const name of Object.keys(pkg.bin)) {
    const v = spawnSync(process.execPath, [binPath, '--version'], opts);
    assert.equal(v.status, 0, `${name} --version: ${v.stderr || (v.error && v.error.message)}`);
    assert.match(v.stdout, version, `${name} --version prints ${pkg.version}`);
    const h = spawnSync(process.execPath, [binPath, '--help'], opts);
    assert.equal(h.status, 0, `${name} --help: ${h.stderr || (h.error && h.error.message)}`);
    assert.match(h.stdout, /Usage: /, `${name} --help prints the usage`);
  }
});

test('npm pack (dry run): the package has the board runtime and no tests, docs, bench or state', (t) => {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT, encoding: 'utf8', shell: win, timeout: 120000, windowsHide: true,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  if ((r.error && r.error.code === 'ENOENT') || (r.status !== 0 && /not recognized|not found|No such file/i.test(output))) {
    return t.skip('npm is not available on this machine');
  }
  assert.equal(r.error, undefined, `npm pack did not run: ${r.error && r.error.message}`);
  assert.equal(r.status, 0, `npm pack failed: ${r.stderr}`);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  const needed = [
    'bin/agent-orchestra-board.js', 'src/server.js', 'src/worktree.js', 'src/capability.js', 'src/patch.js',
    'src/workflows/plan.js', 'src/workflows/plan-model.js', 'src/workflows/build.js', 'public/app.js', 'public/index.html',
  ];
  for (const f of needed) assert.ok(files.includes(f), `${f} is in the package`);
  for (const p of files) {
    if (p.startsWith('bench/demo-rooms/')) continue; // the demo command needs its recorded rooms
    for (const bad of ['test/', '.orchestra/', 'docs/', 'bench/']) assert.ok(!p.startsWith(bad), `${p} must not be in the package`);
  }
});

test('plan and build logic name no agent or model: plan.js, plan-model.js and build.js', () => {
  const forbidden = /\b(astra|sol|fable|luna|opus|sonnet|haiku|gpt-|claude-)\b/i;
  for (const file of ['src/workflows/plan.js', 'src/workflows/plan-model.js', 'src/workflows/build.js']) {
    const hits = readRoot(file).split(/\r?\n/).flatMap((line, i) => (forbidden.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []));
    assert.deepEqual(hits, [], hits.join('\n'));
  }
});

test('safety gate: both CLIs pass the static write check, and the Claude write argv has no shell tool and no skip-permissions flag', () => {
  const cl = staticCheck('claude'), cx = staticCheck('codex');
  assert.equal(cl.ok, true, cl.reason);
  assert.equal(cx.ok, true, cx.reason);
  const argv = claude.buildArgs({ model: 'claude-sonnet-5-5', effort: 'medium', mode: 'write' });
  assert.ok(argv.includes('acceptEdits'), 'write mode auto-approves edits only');
  assert.ok(!argv.includes('Bash'), 'no shell tool in the write argv');
  assert.ok(!argv.includes('--dangerously-skip-permissions'), 'permissions are never skipped');
});

test('the generated .orchestra/.gitignore keeps the session token and the worktrees out of git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-release-'));
  try {
    createStore(dir).ensure();
    const lines = fs.readFileSync(path.join(dir, '.orchestra', '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes('worktrees/'), 'worktrees/ is ignored');
    assert.ok(lines.includes('session'), 'session is ignored');
  } finally { rmTemp(dir); }
});

test('an .orchestra/.gitignore written by v0.1 gains worktrees/ on the next start, exactly once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-release-'));
  try {
    const store = createStore(dir);
    store.ensure();
    const gi = path.join(dir, '.orchestra', '.gitignore');
    fs.writeFileSync(gi, '# written by v0.1\nsession\nempty/\n');
    store.ensure();
    store.ensure();
    const lines = fs.readFileSync(gi, 'utf8').split(/\r?\n/).map((l) => l.trim());
    assert.equal(lines.filter((l) => l === 'worktrees/').length, 1);
    assert.ok(lines.includes('session') && lines.includes('empty/'), 'the existing lines are kept');
  } finally { rmTemp(dir); }
});

test('release metadata: the newest CHANGELOG section is the package version, and the description names Plan → Approve → Build', () => {
  const top = /^## \[(\d+\.\d+\.\d+)\]/m.exec(readRoot('CHANGELOG.md'));
  assert.ok(top, 'CHANGELOG.md has a version section');
  assert.equal(top[1], pkg.version);
  assert.match(pkg.description, /Plan → Approve → Build with per-item git worktrees/);
});
