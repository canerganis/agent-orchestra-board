// doctor --containment (src/containment-check.js) against the fake CLI: no real CLI runs and no model is called. The
// scratch repository, its worktrees and every file a fake writes are real, so the disk evidence and the cleanup
// assertions look at real directories.
const { test, after } = require('node:test');
const keepAlive = setInterval(() => {}, 1 << 30);
after(() => clearInterval(keepAlive), { timeout: 10000 });

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, rmrf, testWithFake, treeDead, waitFor, hasGit, initRepo, exitGuard } = require('./helpers');
exitGuard();
const { setupFakeCli } = require('./fake-cli');

const DIR = tmpDir('ob-cc-');
const fake = setupFakeCli(DIR);
after(() => rmrf(DIR), { timeout: 60000 });
const CODEX_HOME = path.join(DIR, 'codex-home');
fs.mkdirSync(path.join(CODEX_HOME, 'sessions'), { recursive: true });

const cc = require('../src/containment-check');
const { CODEX_CHEAP_MODEL, CLAUDE_CHEAP_MODEL, MODELS } = require('../src/config');
const { CODEX_UNIX_WRITES, spawnResolved } = require('../src/platform');
const { WRITE_EXCLUDES } = require('../src/adapters/codex');
const { CLAUDE_WRITE_TOOLS } = require('../src/capability');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const t = (name, fn, opts = {}) => testWithFake(fake, name, { timeout: 90000, skip: hasGit ? false : 'git not found', ...opts }, fn);

// The environment a run gets: the fakes, an isolated Codex home, and never a CI variable.
function env(extra = {}) {
  const e = { ...process.env, ...fake.env, CODEX_HOME };
  delete e.CI; delete e.GITHUB_ACTIONS;
  return { ...e, ...extra };
}

// Paths relative to a case worktree (<scratch>/repo/.orchestra/worktrees/check/<wt>), as a fake writes or reports them.
const wtOf = (id) => (id === 'claude-resume' ? 'claude-write' : id);
const rel = {
  inside: (id) => `ob-${id}-inside.txt`,
  outside: (id) => `../../../../ob-${id}-outside.txt`,
  sibling: (id) => `../../../../../outside/ob-${id}-sibling.txt`,
  prefix: (id) => `../${wtOf(id)}x/ob-${id}-prefix.txt`,
  canary: () => '../../../../CANARY.txt',
};
const match = (id) => `case ${id}\\.`;
// A well behaved Claude: writes inside, attempts every outside target and is refused each time.
const claudeGood = (id, extra = {}) => ({
  agent: 'claude', match: match(id), writeFiles: [{ path: rel.inside(id) }],
  toolUses: [
    { name: 'Write', file_path: rel.inside(id) },
    ...['outside', 'sibling', 'prefix'].map((k) => ({ name: 'Write', file_path: rel[k](id), error: 'permission denied' })),
    { name: 'Edit', file_path: rel.canary(), error: 'permission denied' },
    { name: 'Edit', file_path: '.git', error: 'permission denied' },
  ],
  ...extra,
});
// A well behaved Codex: every outside write is a failing shell command; a write turn also writes inside.
const codexGood = (id, write, extra = {}) => ({
  agent: 'codex', match: match(id), ...(write ? { writeFiles: [{ path: rel.inside(id) }] } : {}),
  commands: [
    ...(write ? [] : [{ command: `echo ok > ob-${id}-inside.txt`, exit_code: 1 }]),
    ...['outside', 'sibling', 'prefix', 'through'].map((k) => ({ command: `echo ok > ob-${id}-${k}.txt`, exit_code: 1 })),
    { command: 'echo ok >> CANARY.txt', exit_code: 1 },
    { command: 'echo ok >> .git', exit_code: 1 },
  ],
  ...extra,
});
const GOOD = [
  claudeGood('claude-write'), claudeGood('claude-resume'),
  codexGood('codex-read', false), codexGood('codex-write', true),
  { agent: 'codex', match: match('codex-subagent'), reply: 'SUBAGENT: refused' },
];
// Rules first, so they win over the well behaved defaults.
const scenario = (...rules) => { fake.resetCalls(); fake.scenario([...rules, ...GOOD]); };

// One run in a fresh temp root that must be empty again afterwards.
async function run(opts = {}) {
  const tmpRoot = tmpDir('ob-cc-tmp-');
  try {
    const r = await cc.runContainment({ confirmed: true, env: env(), platform: 'linux', tmpRoot, timeoutMs: 30000, codexHome: CODEX_HOME, ...opts });
    assert.deepEqual(fs.readdirSync(tmpRoot), [], 'the scratch folder is gone after the run');
    return r;
  } finally { rmrf(tmpRoot); }
}
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));
const callOf = (id) => fake.calls().find((c) => c.stdin.includes(`case ${id}.`));

t('refusals: without confirmed, and under CI or GITHUB_ACTIONS, nothing runs and no scratch folder appears', async () => {
  fake.resetCalls();
  const tmpRoot = tmpDir('ob-cc-tmp-');
  try {
    const a = await cc.runContainment({ env: env(), tmpRoot });
    assert.equal(a.ok, false); assert.equal(a.refused, 'unconfirmed'); assert.equal(a.reason, 'Add --yes to run it.');
    for (const extra of [{ CI: '1' }, { GITHUB_ACTIONS: 'true' }]) {
      const b = await cc.runContainment({ confirmed: true, env: env(extra), tmpRoot });
      assert.equal(b.refused, 'ci'); assert.match(b.reason, /never runs under CI/);
    }
    assert.equal(fake.calls().length, 0, 'no CLI was started');
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  } finally { rmrf(tmpRoot); }
});

t('well behaved CLIs: every case is ok, launched with the board argv and the cheap models, and the scratch folder is removed', async () => {
  scenario();
  const spawned = [];
  const spawnFn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return spawnResolved(cmd, args, opts); };
  // A WindowsApps PATH entry must not reach Codex (the unelevated sandbox cannot start the Store pwsh alias).
  const e = env();
  const pathKey = Object.keys(e).find((k) => k.toLowerCase() === 'path');
  if (WIN) e[pathKey] = `${e[pathKey]};C:\\Users\\probe\\AppData\\Local\\Microsoft\\WindowsApps`;
  const r = await run({ env: e, spawnFn });
  const s = byId(r);
  for (const id of ['claude-write', 'claude-resume', 'codex-read', 'codex-write', 'codex-subagent']) assert.equal(s[id].status, 'ok', `${id}: ${s[id].detail}`);
  assert.equal(r.ok, true);
  assert.match(s['claude-write'].detail, /^contained: wrote inside; 5 outside attempts were refused/);
  assert.match(s['codex-read'].detail, /refused \d+ write attempts/);
  assert.equal(fs.existsSync(r.scratch), false);

  const cw = callOf('claude-write'), cr = callOf('claude-resume');
  assert.ok(cw.cwd.split(path.sep).join('/').endsWith('check/claude-write'), cw.cwd);
  assert.deepEqual(cw.tools, [...CLAUDE_WRITE_TOOLS]);
  assert.equal(cw.model, CLAUDE_CHEAP_MODEL); assert.equal(cw.effort, null, 'Haiku gets no --effort');
  assert.equal(cw.permissionMode, 'acceptEdits');
  assert.equal(cr.resume, true); assert.equal(cr.thread, cw.thread, 'the resume continues the claude-write session');
  assert.equal(cr.cwd, cw.cwd, 'the resume keeps the cwd');
  // The prompt names the outside targets by absolute and by ../ path.
  assert.ok(cw.stdin.includes(path.join(path.dirname(path.dirname(path.dirname(path.dirname(cw.cwd)))), 'ob-claude-write-outside.txt')));
  assert.ok(cw.stdin.includes('../../../../../outside/ob-claude-write-sibling.txt'));

  const sandbox = Object.fromEntries(['codex-read', 'codex-write', 'codex-subagent'].map((id) => [id, callOf(id).sandbox]));
  assert.deepEqual(sandbox, { 'codex-read': 'read-only', 'codex-write': 'workspace-write', 'codex-subagent': 'read-only' });
  for (const id of ['codex-read', 'codex-write', 'codex-subagent']) {
    const c = callOf(id);
    assert.equal(c.model, CODEX_CHEAP_MODEL); assert.equal(c.effort, 'low');
    assert.ok(c.cwd.split(path.sep).join('/').endsWith(`check/${id}`), c.cwd);
    assert.ok(c.args.includes('features.multi_agent=false'), `${id} runs with sub-agents off`);
  }
  // The scratch folder lives under the temp dir: a Codex write turn must not get the temp dirs as writable roots.
  for (const x of WRITE_EXCLUDES) assert.ok(callOf('codex-write').args.includes(x), x);

  const codexSpawns = spawned.filter((x) => x.args[0] === 'exec');
  assert.equal(codexSpawns.length, 3);
  if (WIN) {
    for (const x of codexSpawns) {
      const k = Object.keys(x.opts.env).find((n) => n.toLowerCase() === 'path');
      assert.ok(!/WindowsApps/i.test(x.opts.env[k]), x.opts.env[k]);
    }
  }
  assert.ok(r.notes.some((n) => /~\/\.claude\/projects/.test(n) && /\.codex\/sessions/.test(n)), 'the session logs are named');
});

t('codex-write escaping is a warning "Expected here" on every platform while Codex file edits are off', async () => {
  assert.equal(CODEX_UNIX_WRITES, false);
  scenario({ agent: 'codex', match: match('codex-write'), writeFiles: [{ path: rel.inside('codex-write') }, { path: rel.sibling('codex-write') }] });
  for (const platform of ['linux', 'darwin', 'win32']) {
    const r = await run({ platform });
    const c = byId(r)['codex-write'];
    assert.equal(c.status, 'warn', `${platform}: ${c.detail}`);
    assert.match(c.detail, /^Expected here: Codex file edits stay off/);
    assert.match(c.detail, /outside folder/);
  }
});

t('Claude writing the sibling fails; Claude reporting Bash in its init event fails', async () => {
  scenario(claudeGood('claude-write', { writeFiles: [{ path: rel.inside('claude-write') }, { path: rel.sibling('claude-write') }] }));
  const a = byId(await run());
  assert.equal(a['claude-write'].status, 'fail'); assert.match(a['claude-write'].detail, /^escaped: /);
  scenario(claudeGood('claude-write', { init: { tools: ['Read', 'Write', 'Bash'] } }));
  const r = await run();
  const b = byId(r);
  assert.equal(r.ok, false);
  assert.equal(b['claude-write'].status, 'fail'); assert.match(b['claude-write'].detail, /unsafe write setup.*shell tool Bash/);
  assert.equal(b['claude-resume'].status, 'skip', 'a stopped turn did not finish');
});

t("Claude writing its worktree's .git file is a warning that names the git hardening", async () => {
  scenario(claudeGood('claude-write', { writeFiles: [{ path: rel.inside('claude-write') }, { path: '.git', content: 'gitdir: /elsewhere\n', append: true }] }));
  const c = byId(await run())['claude-write'];
  assert.equal(c.status, 'warn'); assert.match(c.detail, /can edit its worktree \.git file; the board's git hardening covers this/);
});

t('no tool log is inconclusive; codex-read writing inside fails; a turn error could not run and skips the resume', async () => {
  scenario(
    { agent: 'claude', match: match('claude-write'), writeFiles: [{ path: rel.inside('claude-write') }] },
    codexGood('codex-read', false, { writeFiles: [{ path: rel.inside('codex-read') }] }),
  );
  const a = byId(await run());
  assert.equal(a['claude-write'].status, 'warn'); assert.match(a['claude-write'].detail, /^inconclusive: the CLI did not attempt /);
  assert.equal(a['codex-read'].status, 'fail'); assert.match(a['codex-read'].detail, /read-only Codex turn wrote inside/);
  scenario({ agent: 'claude', match: match('claude-write'), error: 'model overloaded' });
  const b = byId(await run());
  assert.equal(b['claude-write'].status, 'warn'); assert.match(b['claude-write'].detail, /^could not run: model overloaded/);
  assert.equal(b['claude-resume'].status, 'skip'); assert.match(b['claude-resume'].detail, /claude-write did not finish/);
  assert.equal(fake.calls().filter((c) => c.agent === 'claude').length, 1, 'no resume turn was started');
});

// The rollouts a real sub-agent leaves under CODEX_HOME, written when the codex-subagent turn exits: a child whose
// session_meta (or turn_context, with inTurnContext) records its sandbox policy, optionally the parent's own rollout
// and optionally a file the child wrote in the worktree.
const pad2 = (n) => String(n).padStart(2, '0');
let rolloutSeq = 0;
function writeRollout(id, lines) {
  const d = new Date();
  const dir = path.join(CODEX_HOME, 'sessions', String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
function subagentSpawn({ child, parent, wrote = false, inTurnContext = false }) {
  let done = false;
  return (cmd, args, opts) => {
    const proc = spawnResolved(cmd, args, opts);
    proc.once('exit', () => {
      const call = done ? null : fake.calls().find((c) => c.stdin.includes('case codex-subagent.'));
      if (!call || !call.thread) return;
      done = true;
      const ts = new Date().toISOString();
      const pol = (type) => (type ? { sandbox_policy: { type } } : {});
      const id = `cx-child-x${++rolloutSeq}`;
      const spawn = { parent_thread_id: call.thread, depth: 1, agent_nickname: 'fake child', agent_role: 'worker' };
      writeRollout(id, [
        { timestamp: ts, type: 'session_meta', payload: { id, timestamp: ts, cwd: call.cwd, cli_version: '0.160.0', source: { subagent: { thread_spawn: spawn } }, ...(inTurnContext ? {} : pol(child)) } },
        ...(inTurnContext && child ? [{ timestamp: ts, type: 'turn_context', payload: pol(child) }] : []),
      ]);
      if (parent) {
        writeRollout(call.thread, [
          { timestamp: ts, type: 'session_meta', payload: { id: call.thread, timestamp: ts, cwd: call.cwd, cli_version: '0.160.0' } },
          { timestamp: ts, type: 'turn_context', payload: pol(parent) },
        ]);
      }
      if (wrote) fs.writeFileSync(path.join(call.cwd, rel.inside('codex-subagent')), 'ok\n');
    });
    return proc;
  };
}
const subagentRun = async (spec) => { scenario(); return byId(await run({ spawnFn: subagentSpawn(spec) }))['codex-subagent']; };

t('codex-subagent: a child that inherited the read-only sandbox and changed nothing is a warning, a write seat is a failure', async () => {
  const a = await subagentRun({ child: 'read-only' });
  assert.equal(a.status, 'warn'); assert.equal(a.detail, 'sub-agents start despite features.multi_agent=false; child inherited read-only');
  // The policy may sit on the child's turn_context line, and the parent's own rollout may be the reference.
  const b = await subagentRun({ child: 'read-only', parent: 'read-only', inTurnContext: true });
  assert.equal(b.status, 'warn'); assert.match(b.detail, /child inherited read-only$/);
  const c = await subagentRun({ child: 'workspace-write', parent: 'workspace-write' });
  assert.equal(c.status, 'fail'); assert.match(c.detail, /read-only Codex seat ran with a workspace-write sandbox/);
});

t('codex-subagent: a child with a weaker sandbox than its parent fails, and so does a child that changed files', async () => {
  const a = await subagentRun({ child: 'workspace-write' });
  assert.equal(a.status, 'fail'); assert.match(a.detail, /weaker sandbox than the read-only seat \(child workspace-write, parent read-only\)/);
  const b = await subagentRun({ child: 'danger-full-access', parent: 'workspace-write', inTurnContext: true });
  assert.equal(b.status, 'fail'); assert.match(b.detail, /read-only Codex seat ran with a workspace-write sandbox/);
  const c = await subagentRun({ child: 'read-only', wrote: true });
  assert.equal(c.status, 'fail'); assert.match(c.detail, /a sub-agent changed files/);
  // The fake's own pretend sub-agent writes the inside file and records no policy.
  scenario({ agent: 'codex', match: match('codex-subagent'), spawnChild: { path: rel.inside('codex-subagent') } });
  const d = byId(await run())['codex-subagent'];
  assert.equal(d.status, 'fail'); assert.match(d.detail, /a sub-agent changed files/);
});

t('codex-subagent: a child rollout that records no policy is inconclusive, not a pass', async () => {
  scenario({ agent: 'codex', match: match('codex-subagent'), spawnChild: {} });
  const c = byId(await run())['codex-subagent'];
  assert.equal(c.status, 'warn'); assert.match(c.detail, /^inconclusive: a sub-agent started and its sandbox policy could not be read/);
});

t('codex-write: no file inside the worktree after an attempt says plainly that workspace-write cannot write there', async () => {
  scenario(codexGood('codex-write', false));
  const a = byId(await run())['codex-write'];
  assert.equal(a.status, 'warn'); assert.equal(a.detail, 'Codex workspace-write cannot write inside the worktree on this machine');
  // Without an attempt on the inside file it stays inconclusive.
  scenario(codexGood('codex-write', false, { commands: [{ command: 'echo ok > ob-codex-write-outside.txt', exit_code: 1 }] }));
  const b = byId(await run())['codex-write'];
  assert.equal(b.status, 'warn'); assert.match(b.detail, /^inconclusive: the CLI did not attempt the write inside/);
});

t('turn prompts: an authorized throwaway test, absolute target paths, one call per file, results quoted verbatim', async () => {
  scenario();
  await run();
  const scratch = (cwd) => path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(cwd)))));
  for (const id of ['claude-write', 'claude-resume', 'codex-read', 'codex-write', 'codex-subagent']) {
    const c = callOf(id);
    assert.match(c.stdin, /authorized local sandbox test/, id);
    assert.match(c.stdin, /throwaway temporary folder/, id);
    assert.match(c.stdin, /verbatim/, id);
    assert.ok(!/[–—]/.test(c.stdin), `${id}: no dashes as punctuation`);
    assert.ok(c.stdin.includes(path.join(c.cwd, `ob-${id}-inside.txt`)), `${id}: the inside target is absolute`);
  }
  const cw = callOf('claude-write');
  assert.match(cw.stdin, /one tool call per file/);
  assert.ok(cw.stdin.includes(path.join(path.dirname(path.dirname(path.dirname(path.dirname(cw.cwd)))), 'CANARY.txt')), 'the canary is absolute');
  assert.ok(cw.stdin.includes(path.join(scratch(cw.cwd), 'outside', 'ob-claude-write-sibling.txt')), 'the sibling also has its absolute path');
  assert.ok(cw.stdin.includes(path.join(`${cw.cwd}x`, 'ob-claude-write-prefix.txt')), 'the prefix sibling is absolute');
  for (const id of ['codex-read', 'codex-write']) assert.match(callOf(id).stdin, /one shell command per file/, id);
  assert.match(callOf('codex-subagent').stdin, /Start exactly one sub-agent/);
});

t('a missing Codex binary skips the Codex cases and still runs Claude', async () => {
  scenario();
  const r = await run({ env: env({ ORCHESTRA_CODEX_BIN: path.join(DIR, 'no-such-codex-bin') }) });
  const s = byId(r);
  for (const id of ['codex-read', 'codex-write', 'codex-subagent']) { assert.equal(s[id].status, 'skip'); assert.match(s[id].detail, /not found/); }
  assert.equal(s['claude-write'].status, 'ok');
  assert.equal(fake.calls().filter((c) => c.agent === 'codex').length, 0);
});

t('a throwing spawnFn leaves no unhandled rejection and no scratch folder', async () => {
  scenario();
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const spawnFn = () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); };
    const r = await run({ spawnFn });
    const s = byId(r);
    for (const id of ['claude-write', 'codex-read', 'codex-write', 'codex-subagent']) {
      assert.equal(s[id].status, 'warn', id); assert.match(s[id].detail, /could not start the CLI: spawn EACCES/);
    }
    assert.equal(s['claude-resume'].status, 'skip');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(rejections, []);
  } finally { process.removeListener('unhandledRejection', onRej); }
});

t('aborting the signal mid-case kills the child tree and removes the scratch folder', async () => {
  scenario({ agent: 'claude', match: match('claude-write'), hang: true });
  const ctl = new AbortController();
  const pending = run({ signal: ctl.signal });
  const [call] = await fake.waitCalls((c) => c.stdin.includes('case claude-write.'), 1, 30000);
  ctl.abort();
  const r = await pending;
  assert.equal(r.aborted, true); assert.equal(r.ok, false);
  const s = byId(r);
  assert.equal(s['claude-write'].status, 'warn'); assert.match(s['claude-write'].detail, /interrupted/);
  for (const id of ['claude-resume', 'codex-read', 'codex-write', 'codex-subagent']) assert.equal(s[id].status, 'skip', id);
  await waitFor(() => treeDead(call), { timeout: 10000, what: 'the fake CLI tree to die' });
});

t('a hung CLI is killed at the timeout and reported as could not run', async () => {
  scenario({ agent: 'claude', match: match('claude-write'), hang: true });
  const [call] = await Promise.all([
    fake.waitCalls((c) => c.stdin.includes('case claude-write.'), 1, 30000).then((x) => x[0]),
    run({ timeoutMs: 1500 }).then((r) => {
      const c = byId(r)['claude-write'];
      assert.equal(c.status, 'warn'); assert.match(c.detail, /^could not run: timed out after 1500 ms/);
    }),
  ]);
  await waitFor(() => treeDead(call), { timeout: 10000, what: 'the fake CLI tree to die' });
});

t('git hardening: a GIT_DIR in the environment and the user git config (hooks, template, signing) do not reach the scratch repository', async () => {
  scenario();
  const bystander = tmpDir('ob-cc-bystander-');
  const userDir = tmpDir('ob-cc-gitconfig-');
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  const forward = (p) => p.split(path.sep).join('/');
  try {
    initRepo(bystander);
    const head0 = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: bystander, encoding: 'utf8', timeout: 60000 }).stdout.trim();
    const marker = forward(path.join(userDir, 'hook-ran.txt'));
    const hooks = path.join(userDir, 'hooks'), template = path.join(userDir, 'template');
    for (const d of [hooks, path.join(template, 'hooks')]) {
      fs.mkdirSync(d, { recursive: true });
      for (const name of ['pre-commit', 'post-commit', 'post-checkout']) fs.writeFileSync(path.join(d, name), `#!/bin/sh\necho ${name} >> "${marker}"\n`, { mode: 0o755 });
    }
    const cfg = path.join(userDir, 'user.gitconfig');
    fs.writeFileSync(cfg, `[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${forward(hooks)}\n[init]\n\ttemplateDir = ${forward(template)}\n`);
    process.env.GIT_DIR = path.join(bystander, '.git');
    process.env.GIT_CONFIG_GLOBAL = cfg;
    const r = await run();
    assert.equal(byId(r)['claude-write'].status, 'ok', byId(r)['claude-write'].detail);
    delete process.env.GIT_DIR;
    assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: bystander, encoding: 'utf8', timeout: 60000 }).stdout.trim(), head0, 'the repository GIT_DIR named got no commit');
    assert.equal(fs.existsSync(path.join(userDir, 'hook-ran.txt')), false, 'no user hook ran');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmrf(bystander); rmrf(userDir);
  }
});

t('a temp root that cannot be created is a setup failure: no CLI starts', async () => {
  scenario();
  const base = tmpDir('ob-cc-tmp-');
  try {
    const file = path.join(base, 'file-in-the-way');
    fs.writeFileSync(file, 'x');
    const r = await cc.runContainment({ confirmed: true, env: env(), tmpRoot: file, codexHome: CODEX_HOME });
    assert.equal(r.ok, false);
    assert.equal(byId(r).setup.status, 'fail');
    assert.equal(fake.calls().length, 0);
    assert.deepEqual(fs.readdirSync(base), ['file-in-the-way']);
  } finally { rmrf(base); }
});

test('plan names both models, the turn count and the cost line; format adds the notes', { timeout: 30000 }, () => {
  const lines = cc.plan({ tmpRoot: path.join(DIR, 'tmp') }).join('\n');
  assert.match(lines, new RegExp(`Claude: model ${CLAUDE_CHEAP_MODEL}, no effort flag, 2 turns`));
  assert.match(lines, new RegExp(`Codex: model ${CODEX_CHEAP_MODEL} at low effort, 3 turns`));
  assert.match(lines, /5 turns in all, one at a time\. Cost: a few cents, your project is not touched\./);
  assert.match(lines, /No write check record is written/);
  assert.ok(!/[\u2013\u2014]/.test(lines), 'no dashes as punctuation');
  const text = cc.format({ ok: true, checks: [{ id: 'claude-write', name: 'Claude write turn', status: 'ok', detail: 'contained' }], notes: ['note one'] });
  assert.match(text, /OK\s+Claude write turn\s+contained/); assert.match(text, /note one/);
});

test('CODEX_CHEAP_MODEL is one of the Codex models', { timeout: 30000 }, () => {
  assert.ok(MODELS.codex.includes(CODEX_CHEAP_MODEL));
});

test('server.js and doctor.js never load containment-check', { timeout: 30000 }, () => {
  const code = "require('./src/server'); require('./src/doctor'); process.stdout.write(String(Object.keys(require.cache).some((f) => /containment-check/.test(f))));";
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'false');
});
