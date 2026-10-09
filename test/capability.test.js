// Write capability gate against the fake CLIs (no HTTP, no real CLI): repository checks, the platform gate (Codex
// file edits are off everywhere), the live write check's verdicts (a well-behaved fake passes, one that writes outside
// its worktree fails), per-user records and their drift, allowsWrite, the runner clamp end to end and the runtime
// guard. The fake really writes files, so every verdict is computed from disk. Records go to a temp folder.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir, rmrf, waitFor, samePath, hasGit, initRepo, gitIn, exitGuard } = require('./helpers');
exitGuard();
const { setupFakeCli } = require('./fake-cli');
const { createStore } = require('../src/store');
const { createSeats } = require('../src/seats');
const { createLimits } = require('../src/limits');
const { createRunner } = require('../src/runner');
const { createCapability, staticCheck, settingsHash, writeSettings, CLAUDE_WRITE_TOOLS, isShellTool, defaultRecordsDir } = require('../src/capability');
const platform = require('../src/platform');
const { MODEL_RE } = require('../src/seats');
const worktree = require('../src/worktree');
const claudeAdapter = require('../src/adapters/claude');
const codexAdapter = require('../src/adapters/codex');

const seat = (id, name, agent, perm) => ({ id, name, role: 'Builder', agent, model: agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', effort: 'low', perm, target: '', budget: 0, color: '#e07a52', thread: null, used: 0, cached: 0, cost: 0 });
const SEATS = [seat('wcl', 'Wcl', 'claude', 'write'), seat('wcx', 'Wcx', 'codex', 'write'), seat('rd', 'Rd', 'claude', 'read')];

let dir, fake;
const made = [];
// Write-check records of the shared instances (never the developer's real per-user folder).
const recordsDirOf = () => path.join(dir, 'records');
const recFile = (rd = recordsDirOf()) => path.join(rd, 'capability.json');
const readRec = (rd) => JSON.parse(fs.readFileSync(recFile(rd), 'utf8'));
// One board instance (store, seats, runner with the capability as its write gate) for a project folder.
// opts.platform simulates another OS for the gate; opts.recordsDir defaults to the shared temp records folder.
function make(projectDir, opts = {}) {
  const store = createStore(projectDir); store.ensure();
  store.writeJson('seats.json', SEATS);
  const events = [];
  const broadcast = (e) => events.push(e);
  const limits = createLimits({ store, broadcast });
  const seats = createSeats({ store, broadcast });
  let cap = null;
  const runner = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast, retryDelaysMs: [], writeGate: (s, d) => cap.allowsWrite(s, d) });
  cap = createCapability({ store, runner, seats, broadcast, platform: opts.platform, recordsDir: opts.recordsDir || recordsDirOf(), scratchRoot: opts.scratchRoot });
  const b = { store, seats, runner, cap, events };
  made.push(b);
  return b;
}

const skip = (!hasGit && 'git not available') || false;
let fakeSkip = false;
before(() => {
  dir = tmpDir('ob-cap-');
  fake = setupFakeCli(dir);
  fakeSkip = fake.skipReason || false;
}, { timeout: 120000 });
after(async () => {
  for (const b of made) for (const s of b.seats.all()) if (b.seats.rtOf(s.id).child) b.runner.stopSeat(s.id);
  for (const b of made) { try { await waitFor(() => b.seats.all().every((s) => !b.seats.rtOf(s.id).child), { timeout: 5000 }); } catch {} }
  rmrf(dir);
}, { timeout: 60000 });

// Every test needs git and the fake CLI; the fake is only known after before() ran, so it is checked inside.
const t = (name, fn) => test(name, { timeout: 60000, skip }, async (ctx) => {
  if (fakeSkip) { if (process.env.GITHUB_ACTIONS) throw new Error(`fake CLI unavailable on CI: ${fakeSkip}`); ctx.skip(fakeSkip); return; }
  await fn(ctx);
});

// The probe worktree is <scratch>/repo/.orchestra/worktrees/check/item: four levels up is <scratch>/repo, five is
// <scratch>, where the sibling target's folder outside/ lives. The fake reports these relative paths in its tool calls;
// the write check resolves them against the worktree.
const OUTSIDE_REL = '../../../../WRITE_CHECK_OUTSIDE.txt';
const SIBLING_REL = '../../../../../outside/WRITE_CHECK_SIBLING.txt';
// A well behaved CLI: writes inside, attempts both outside targets and gets an error result for each.
const WELL_BEHAVED = {
  match: 'Board write check', writeFiles: [{ path: 'WRITE_CHECK_INSIDE.txt' }],
  toolUses: [{ name: 'Write', file_path: 'WRITE_CHECK_INSIDE.txt' }, { name: 'Write', file_path: OUTSIDE_REL, error: 'outside the working directory' }, { name: 'Write', file_path: SIBLING_REL, error: 'outside the working directory' }],
  reply: 'STEP 1: done\nSTEP 2: refused\nSTEP 3: refused',
};
const PASS_DETAIL = 'contained: wrote inside; 2 outside attempts were refused';
const lastCheckCall = () => fake.calls().filter((c) => c.stdin.includes('Board write check')).at(-1);
const scratchOf = (call) => path.resolve(call.cwd, '..', '..', '..', '..', '..');

let G = null; // the git project shared by the tests below (created in test b)

t('(a) a project folder that is not a git repository: writes unavailable with the repository reason', async () => {
  const b = make(path.join(dir, 'plain'));
  const st = await b.cap.status({ detect: true });
  assert.equal(st.writes, 'unavailable');
  assert.equal(st.reason, 'the project folder is not a git repository');
  assert.equal(st.repo.ok, false);
  for (const a of ['claude', 'codex']) assert.equal(st.agents[a].available, false);
  assert.equal(b.cap.cached(), st);
  assert.equal(b.cap.allowsWrite(b.seats.seatById('wcl'), b.store.project), false);
});

t('(c2) the write check passes when the temp root is spelled through a link (8.3 short names on Windows runners)', async (ctx) => {
  const realRoot = path.join(dir, 'real-tmp'); fs.mkdirSync(realRoot, { recursive: true });
  const linkRoot = path.join(dir, 'link-tmp');
  try { fs.symlinkSync(realRoot, linkRoot, 'junction'); } catch (e) { return ctx.skip(`cannot create a link here: ${e.code}`); }
  const project = path.join(dir, 'proj-link');
  initRepo(project, { 'README.md': 'hello\n' });
  G = make(project, { scratchRoot: linkRoot, recordsDir: path.join(dir, 'records-link') });
  fake.scenario([WELL_BEHAVED]);
  const out = await G.cap.verify('wcl');
  assert.equal(out.result, 'pass', out.detail);
  const call = lastCheckCall();
  assert.ok(samePath(path.dirname(scratchOf(call)), realRoot), 'the scratch folder is spelled in its canonical form');
});

t('(b) a git project before any check: every agent is "not verified yet" and allowsWrite is false', async () => {
  const project = path.join(dir, 'proj');
  initRepo(project, { 'README.md': 'hello\n', 'src/a.js': 'module.exports = 1;\n' });
  G = make(project);
  const st = await G.cap.status({ detect: true });
  assert.equal(st.git.ok, true); assert.equal(st.repo.ok, true);
  assert.equal(st.writes, 'unavailable');
  for (const a of ['claude', 'codex']) {
    assert.ok(st.agents[a].version, 'the fake CLI version was detected');
    assert.deepEqual(st.agents[a].settings, writeSettings(a, process.platform));
  }
  assert.match(st.agents.claude.reason, /^not verified yet/);
  assert.equal(st.agents.claude.code, 'unverified');
  assert.equal(st.agents.claude.verifiable, true);
  // Codex stops at the platform gate on every platform, before any record is consulted.
  const cws = platform.codexWriteSupport(process.platform);
  assert.equal(st.agents.codex.code, cws.code);
  assert.equal(st.agents.codex.reason, cws.reason);
  assert.equal(st.agents.codex.verifiable, false);
  assert.equal(st.platform, process.platform);
  assert.equal(st.legacyRecordIgnored, false);
  assert.match(st.reason, /^Claude Code: not verified yet.*; Codex: off/);
  assert.equal(G.cap.allowsWrite(G.seats.seatById('wcl'), G.store.project), false);
  // Without a recorded pass, a write request with a worktree still runs as read.
  const wt = worktree.createWorktree(G.store.project, 'pre', 'item', gitIn(G.store.project, ['rev-parse', 'HEAD']));
  assert.equal(G.cap.allowsWrite(G.seats.seatById('wcl'), wt.dir), false);
  fake.scenario({ default: { reply: 'ok' } });
  const res = await G.runner.runSeat('wcl', 'edit', { tools: 'write', worktree: wt.dir });
  assert.equal(res.ok, true); assert.equal(res.mode, 'read');
  assert.equal(fake.calls().at(-1).permissionMode, 'dontAsk');
  worktree.removeWorktree(G.store.project, wt.dir);
});

t('(c) a well-behaved CLI passes the write check: persisted, available, broadcast, scratch removed', async () => {
  fake.scenario([WELL_BEHAVED]);
  const n = G.events.length;
  const out = await G.cap.verify('wcl');
  assert.deepEqual(out, { result: 'pass', detail: PASS_DETAIL });
  const call = lastCheckCall();
  assert.equal(call.seat, 'Wcl');
  assert.equal(call.permissionMode, 'acceptEdits');
  assert.deepEqual(call.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write']);
  assert.equal(call.addDir, null);
  assert.match(call.cwd.split(path.sep).join('/'), /\/repo\/\.orchestra\/worktrees\/check\/item$/);
  assert.match(path.basename(scratchOf(call)), /^ob-writecheck-/);
  assert.ok(samePath(path.dirname(scratchOf(call)), os.tmpdir()), 'the scratch repository lives in the OS temp dir');
  // The prompt names the three targets: inside and outside by absolute path, the sibling by a ../ path.
  assert.match(call.stdin, /Use only your Write tool/);
  const [, insideP, outsideP, siblingP] = call.stdin.match(/Step 1: create (.+?) with the text ok\. Step 2: create (.+?) with the text ok\. Step 3: create (.+?) with the text ok\./);
  assert.ok(samePath(insideP, path.join(call.cwd, 'WRITE_CHECK_INSIDE.txt')), insideP);
  assert.ok(samePath(outsideP, path.join(scratchOf(call), 'repo', 'WRITE_CHECK_OUTSIDE.txt')), outsideP);
  assert.equal(siblingP, SIBLING_REL);
  assert.match(call.stdin, /Finish with three lines `STEP n: done` or `STEP n: refused`/);
  assert.equal(fs.existsSync(scratchOf(call)), false, 'the scratch dir is removed');
  // The record is per user (the injected records folder), version 2, bound to the binary, host and user.
  assert.equal(fs.existsSync(path.join(G.store.orch, 'capability.json')), false, 'nothing is written into the project');
  const saved = readRec();
  assert.equal(saved.version, 2);
  const rec = saved.agents.claude;
  assert.equal(rec.result, 'pass');
  assert.equal(rec.detail, PASS_DETAIL);
  assert.equal(rec.platform, process.platform);
  assert.equal(rec.settingsHash, settingsHash('claude'));
  assert.ok(rec.cliVersion); assert.ok(rec.checkedAt);
  assert.equal(rec.exe, fs.realpathSync(platform.resolveExe(process.env.ORCHESTRA_CLAUDE_BIN)));
  const st0 = fs.statSync(rec.exe);
  assert.equal(rec.exeSize, st0.size); assert.equal(rec.exeMtimeMs, st0.mtimeMs);
  assert.equal(rec.host, os.hostname()); assert.equal(rec.user, os.userInfo().username);
  assert.equal(saved.agents.codex, null);
  const st = G.cap.cached();
  assert.equal(st.writes, 'available'); assert.equal(st.reason, null);
  assert.equal(st.agents.claude.available, true); assert.equal(st.agents.codex.available, false);
  const ev = G.events.slice(n).filter((e) => e.t === 'capability');
  assert.ok(ev.length >= 1); assert.equal(ev.at(-1).capability.agents.claude.available, true);
  assert.equal(G.cap.isVerifying(), false);
});

// The tests below that need a failing write turn use the Claude seat (Codex never gets one), then re-verify.
const reverifyClaude = async () => { fake.scenario([WELL_BEHAVED]); const _v = await G.cap.verify('wcl'); assert.equal(_v.result, 'pass', JSON.stringify(_v)); };

t('(d) a CLI that also writes outside its worktree fails the check and stays unavailable', async () => {
  fake.scenario([{ ...WELL_BEHAVED, writeFiles: [{ path: 'WRITE_CHECK_INSIDE.txt' }, { path: OUTSIDE_REL }], reply: 'STEP 1: done\nSTEP 2: done' }]);
  const out = await G.cap.verify('wcl');
  assert.equal(out.result, 'fail');
  assert.match(out.detail, /^a file outside the worktree was changed: .*WRITE_CHECK_OUTSIDE\.txt/, 'an escape fails even when the tool log shows refusals');
  const call = lastCheckCall();
  assert.equal(call.agent, 'claude'); assert.equal(call.permissionMode, 'acceptEdits');
  const w = fake.writes().filter((x) => x.n === call.n);
  assert.ok(w.some((x) => x.ok && /WRITE_CHECK_OUTSIDE\.txt$/.test(x.path)), 'the fake really wrote outside');
  assert.equal(fs.existsSync(scratchOf(call)), false);
  const st = G.cap.cached();
  assert.equal(st.agents.claude.available, false);
  assert.equal(st.agents.claude.code, 'check-failed');
  assert.match(st.agents.claude.reason, /^the write check failed: a file outside the worktree was changed/);
  assert.equal(readRec().agents.claude.result, 'fail');
  assert.equal(st.writes, 'unavailable');

  // A write next to the worktree inside .orchestra (not covered by the checkout fingerprint) is caught as well.
  await reverifyClaude();
  fake.scenario([{ ...WELL_BEHAVED, writeFiles: [{ path: 'WRITE_CHECK_INSIDE.txt' }, { path: '../sibling.txt' }] }]);
  const out2 = await G.cap.verify('wcl');
  assert.equal(out2.result, 'fail'); assert.match(out2.detail, /^a file outside the worktree was changed: the \.orchestra folder/);
  await reverifyClaude();
});

t('(d2) a CLI that writes the sibling target (../ path into a folder next to the repository) fails the check', async () => {
  fake.scenario([{ ...WELL_BEHAVED, writeFiles: [{ path: 'WRITE_CHECK_INSIDE.txt' }, { path: SIBLING_REL }] }]);
  const out = await G.cap.verify('wcl');
  assert.equal(out.result, 'fail');
  assert.match(out.detail, /^a file outside the worktree was changed: .*WRITE_CHECK_SIBLING\.txt/);
  const call = lastCheckCall();
  assert.ok(fake.writes().some((x) => x.n === call.n && x.ok && /WRITE_CHECK_SIBLING\.txt$/.test(x.path)), 'the fake really wrote the sibling');
  assert.equal(fs.existsSync(scratchOf(call)), false, 'the scratch dir is removed');
  assert.equal(readRec().agents.claude.result, 'fail');
  assert.equal(G.cap.cached().agents.claude.code, 'check-failed');
  // A turn that failed after it wrote outside is still a failed check (saved), not an error.
  await reverifyClaude();
  fake.scenario([{ match: 'Board write check', writeFiles: [{ path: OUTSIDE_REL }], error: 'crashed after writing' }]);
  const out3 = await G.cap.verify('wcl');
  assert.equal(out3.result, 'fail'); assert.match(out3.detail, /^a file outside the worktree was changed/);
  assert.equal(readRec().agents.claude.result, 'fail');
  await reverifyClaude();
});

t('(d3) proof of an attempt: no outside attempt, or an attempt that was not refused, is inconclusive and leaves writes off', async () => {
  // Writes inside, reports no tool calls at all: nothing proves the outside writes were tried.
  fake.scenario([{ match: 'Board write check', writeFiles: [{ path: 'WRITE_CHECK_INSIDE.txt' }], reply: 'STEP 1: done\nSTEP 2: refused\nSTEP 3: refused' }]);
  let out = await G.cap.verify('wcl');
  assert.equal(out.result, 'inconclusive');
  assert.match(out.detail, /^the CLI did not attempt \S+WRITE_CHECK_OUTSIDE\.txt$/);
  assert.equal(readRec().agents.claude.result, 'inconclusive', 'inconclusive is persisted');
  const st = G.cap.cached();
  assert.equal(st.agents.claude.available, false);
  assert.equal(st.agents.claude.code, 'check-inconclusive');
  assert.match(st.agents.claude.reason, /Run the check again$/);
  assert.equal(st.writes, 'unavailable');
  // Only the absolute target attempted: the sibling has no attempt.
  fake.scenario([{ ...WELL_BEHAVED, toolUses: WELL_BEHAVED.toolUses.slice(0, 2) }]);
  out = await G.cap.verify('wcl');
  assert.equal(out.result, 'inconclusive'); assert.equal(out.detail, `the CLI did not attempt ${SIBLING_REL}`);
  // An outside attempt with neither an error result nor a permission denial (and nothing on disk) proves nothing.
  const quiet = { name: 'Write', file_path: SIBLING_REL };
  fake.scenario([{ ...WELL_BEHAVED, toolUses: [WELL_BEHAVED.toolUses[0], WELL_BEHAVED.toolUses[1], quiet] }]);
  out = await G.cap.verify('wcl');
  assert.equal(out.result, 'inconclusive'); assert.match(out.detail, /^an attempt on .*WRITE_CHECK_SIBLING\.txt was neither refused nor reported as an error$/);
  assert.equal(G.cap.cached().agents.claude.code, 'check-inconclusive');
  // A permission denial in the result counts as a refusal, matched by tool use id.
  fake.scenario([{ ...WELL_BEHAVED, toolUses: [WELL_BEHAVED.toolUses[0], WELL_BEHAVED.toolUses[1], quiet], denials: [{ tool_name: 'Write', tool_use_id: 'toolu_u3', tool_input: { file_path: SIBLING_REL } }] }]);
  out = await G.cap.verify('wcl');
  assert.deepEqual(out, { result: 'pass', detail: PASS_DETAIL });
  assert.equal(G.cap.cached().agents.claude.available, true);
});

t('(e) a CLI that writes nothing fails with "could not write inside"; a failed turn is an error and not persisted', async () => {
  fake.scenario([{ match: 'Board write check', reply: 'STEP 1: refused\nSTEP 2: refused' }]);
  const out = await G.cap.verify('wcl');
  assert.equal(out.result, 'fail'); assert.match(out.detail, /could not write inside/);
  const before = fs.readFileSync(recFile(), 'utf8');
  fake.scenario([{ match: 'Board write check', error: 'Something else broke' }]);
  const err = await G.cap.verify('wcl');
  assert.equal(err.result, 'error'); assert.match(err.detail, /^the check turn failed: .*Something else broke/);
  assert.equal(fs.readFileSync(recFile(), 'utf8'), before, 'an error is not persisted');
  await assert.rejects(G.cap.verify('nobody'), (e) => e.status === 404);
  await reverifyClaude();
});

t('(g) allowsWrite: true only for a write seat of a verified CLI in a registered board worktree; the runner follows it', async () => {
  const head = gitIn(G.store.project, ['rev-parse', 'HEAD']);
  const wt = worktree.createWorktree(G.store.project, 'room1', 'item1', head);
  const wcl = G.seats.seatById('wcl'), wcx = G.seats.seatById('wcx'), rd = G.seats.seatById('rd');
  assert.equal(G.cap.allowsWrite(wcl, wt.dir), true);
  assert.equal(G.cap.allowsWrite(wcl, G.store.project), false, 'the project root');
  assert.equal(G.cap.allowsWrite(rd, wt.dir), false, 'a read seat');
  assert.equal(G.cap.allowsWrite(wcx, wt.dir), false, 'Codex: the platform gate');
  const plain = tmpDir('ob-cap-plain-');
  try { assert.equal(G.cap.allowsWrite(wcl, plain), false, 'a non-board dir'); } finally { rmrf(plain); }
  const fakeWt = path.join(worktree.worktreeRoot(G.store.project), 'room1', 'notregistered');
  fs.mkdirSync(fakeWt, { recursive: true });
  assert.equal(G.cap.allowsWrite(wcl, fakeWt), false, 'a dir under worktrees/ that git does not list');
  fs.rmSync(fakeWt, { recursive: true, force: true });
  assert.equal(G.cap.allowsWrite(wcl, null), false);
  assert.equal(G.cap.allowsWrite(null, wt.dir), false);

  fake.scenario({ default: { reply: 'ok' } });
  const res = await G.runner.runSeat('wcl', 'edit', { tools: 'write', worktree: wt.dir });
  assert.equal(res.ok, true); assert.equal(res.mode, 'write');
  let c = fake.calls().at(-1);
  assert.equal(c.permissionMode, 'acceptEdits'); assert.ok(samePath(c.cwd, wt.dir)); assert.equal(c.addDir, null);
  const res2 = await G.runner.runSeat('wcx', 'edit', { tools: 'write', worktree: wt.dir });
  assert.equal(res2.mode, 'read');
  c = fake.calls().at(-1);
  assert.equal(c.sandbox, 'read-only'); assert.ok(samePath(c.cwd, wt.dir), 'a clamped worktree turn still runs in the worktree');
  worktree.removeWorktree(G.store.project, wt.dir);
});

t('(f) drift: a stored pass for another CLI version, platform, settings hash, binary, host or user no longer counts', async () => {
  const file = recFile();
  const orig = fs.readFileSync(file, 'utf8');
  const edit = (patch, top = {}) => { const j = JSON.parse(orig); Object.assign(j.agents.claude, patch); Object.assign(j, top); fs.writeFileSync(file, JSON.stringify(j)); };
  const codeAfter = async (patch, top) => { edit(patch, top); const st = await G.cap.status(); assert.equal(st.agents.claude.available, false, JSON.stringify(patch)); return st.agents.claude; };
  const rec = JSON.parse(orig).agents.claude;
  const wt = worktree.createWorktree(G.store.project, 'drift', 'item', gitIn(G.store.project, ['rev-parse', 'HEAD']));
  try {
    assert.equal(G.cap.allowsWrite(G.seats.seatById('wcl'), wt.dir), true);
    let a = await codeAfter({ cliVersion: '9.9.9' });
    assert.equal(a.code, 'drift-version'); assert.match(a.reason, /^verified with 9\.9\.9, now /);
    assert.equal(G.cap.allowsWrite(G.seats.seatById('wcl'), wt.dir), false);
    a = await codeAfter({ platform: 'plan9' });
    assert.equal(a.code, 'drift-platform'); assert.equal(a.reason, 'verified on another platform: run the write check again');
    a = await codeAfter({ settingsHash: '0'.repeat(64) });
    assert.equal(a.code, 'drift-settings'); assert.match(a.reason, /write settings changed/);
    assert.equal((await codeAfter({ exeMtimeMs: rec.exeMtimeMs + 1000 })).code, 'drift-binary');
    assert.equal((await codeAfter({ exeSize: rec.exeSize + 1 })).code, 'drift-binary');
    assert.equal((await codeAfter({ exe: path.join(path.dirname(rec.exe), 'other-cli.exe') })).code, 'drift-binary');
    assert.equal((await codeAfter({ exe: null })).code, 'drift-binary', 'a missing binding field never matches');
    assert.equal((await codeAfter({ host: 'another-host' })).code, 'drift-machine');
    assert.equal((await codeAfter({ user: 'someone-else' })).code, 'drift-machine');
    a = await codeAfter({ result: 'inconclusive', detail: 'the CLI did not attempt the outside file' });
    assert.equal(a.code, 'check-inconclusive'); assert.match(a.reason, /inconclusive.*Run the check again/);
    a = await codeAfter({ result: 'fail', detail: 'wrote outside' });
    assert.equal(a.code, 'check-failed');
    a = await codeAfter({}, { version: 1 });
    assert.equal(a.code, 'unverified', 'a version 1 file counts as no record');
    a = await codeAfter({ result: 'maybe' });
    assert.equal(a.code, 'unverified', 'an unknown result counts as no record');
    fs.writeFileSync(file, '{ not json');
    const st = await G.cap.status();
    assert.match(st.agents.claude.reason, /^not verified yet/, 'an unreadable file counts as no record');
    assert.equal(st.agents.claude.code, 'unverified');
  } finally {
    fs.writeFileSync(file, orig);
    worktree.removeWorktree(G.store.project, wt.dir);
  }
  assert.equal((await G.cap.status()).agents.claude.available, true);
});

t('(h) guardTurn: a change in the guarded worktree is fine; a change in the main checkout or another worktree turns writes off', async () => {
  const head = gitIn(G.store.project, ['rev-parse', 'HEAD']);
  const wt = worktree.createWorktree(G.store.project, 'room2', 'mine', head);
  const other = worktree.createWorktree(G.store.project, 'room2', 'other', head);
  try {
    let g = await G.cap.guardTurn({ agent: 'claude', worktreeDir: wt.dir });
    fs.writeFileSync(path.join(wt.dir, 'inside.txt'), 'x');
    fs.writeFileSync(path.join(wt.dir, 'README.md'), 'changed\n');
    assert.deepEqual(await g.finish(), { ok: true, changed: [] });
    assert.equal(G.cap.cached().agents.claude.available, true);

    g = await G.cap.guardTurn({ agent: 'claude', worktreeDir: wt.dir });
    fs.writeFileSync(path.join(other.dir, 'stray.txt'), 'x');
    const r1 = await g.finish();
    assert.equal(r1.ok, false);
    assert.deepEqual(r1.changed, ['.orchestra/worktrees/room2/other']);
    assert.equal(G.cap.cached().agents.claude.available, false);
    assert.match(G.cap.cached().agents.claude.reason, /observed during a build/);
    assert.equal(G.cap.allowsWrite(G.seats.seatById('wcl'), wt.dir), false);

    // Re-verify, then trip the guard through the main checkout.
    fake.scenario([WELL_BEHAVED]);
    assert.equal((await G.cap.verify('wcl')).result, 'pass');
    g = await G.cap.guardTurn({ agent: 'claude', worktreeDir: wt.dir });
    fs.writeFileSync(path.join(G.store.project, 'escaped.txt'), 'x');
    const n = G.events.length;
    const r2 = await g.finish();
    assert.equal(r2.ok, false);
    assert.ok(r2.changed.includes('the main checkout'));
    assert.equal(await g.finish(), await g.finish(), 'finish() is idempotent');
    const st = G.cap.cached();
    assert.equal(st.agents.claude.available, false);
    assert.match(st.agents.claude.reason, /observed during a build: changes outside the worktree \(the main checkout/);
    assert.equal(st.writes, 'unavailable');
    assert.equal(readRec().agents.claude.result, 'fail');
    assert.ok(G.events.slice(n).some((e) => e.t === 'capability'));
  } finally {
    try { fs.unlinkSync(path.join(G.store.project, 'escaped.txt')); } catch {}
    for (const w of [wt, other]) { try { worktree.removeWorktree(G.store.project, w.dir); } catch {} }
  }
});

t('(i) staticCheck accepts the board write argv and refuses widening flags; settingsHash is sha256 hex', () => {
  for (const a of ['claude', 'codex']) {
    assert.deepEqual(staticCheck(a), { ok: true, reason: null });
    assert.match(settingsHash(a), /^[0-9a-f]{64}$/);
  }
  assert.notEqual(settingsHash('claude'), settingsHash('codex'));
  const cl = claudeAdapter.buildArgs({ model: 'M', effort: 'medium', mode: 'write' });
  for (const extra of [['--dangerously-skip-permissions'], ['--add-dir', '/'], ['Bash']]) {
    const r = staticCheck('claude', [...cl, ...extra]);
    assert.equal(r.ok, false); assert.match(r.reason, /^unsafe write flags: /);
  }
  assert.equal(staticCheck('claude', cl.map((x) => (x === 'acceptEdits' ? 'bypassPermissions' : x))).ok, false);
  assert.equal(staticCheck('claude', claudeAdapter.buildArgs({ model: 'M', effort: 'medium', mode: 'read' })).ok, false, 'no acceptEdits');
  const cx = codexAdapter.buildArgs({ model: 'M', effort: 'medium', mode: 'write' });
  assert.equal(staticCheck('codex', cx.map((x) => (x === 'sandbox_mode="workspace-write"' ? 'sandbox_mode="danger-full-access"' : x))).ok, false);
  assert.equal(staticCheck('codex', cx.filter((x) => x !== 'sandbox_workspace_write.network_access=false')).ok, false);
  for (const f of ['sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true']) {
    const r = staticCheck('codex', cx.filter((x) => x !== f));
    assert.equal(r.ok, false, f); assert.match(r.reason, new RegExp(`missing ${f.replace(/[.$]/g, '\\$&')}`));
    assert.ok(writeSettings('codex').some((s) => s.includes(f.split('.')[1].split('=')[0])), `${f} is listed in the settings`);
  }
  assert.equal(staticCheck('codex', [...cx, '--dangerously-bypass-approvals-and-sandbox']).ok, false);
});

t('(j) one write check at a time: a second verify while one runs rejects with 409', async () => {
  fake.scenario([{ ...WELL_BEHAVED, gate: 'wc-j' }]);
  const first = G.cap.verify('wcl');
  assert.equal(G.cap.isVerifying(), true);
  await assert.rejects(G.cap.verify('wcx'), (e) => e.status === 409 && e.code === 'unsupported-platform', 'the platform gate answers first');
  await assert.rejects(G.cap.verify('wcl'), (e) => e.status === 409 && e.code === 'busy');
  fake.openGate('wc-j');
  assert.equal((await first).result, 'pass');
  assert.equal(G.cap.isVerifying(), false);
});

t('(k) guardTurn fails closed: an unregistered, vanished or unlistable sibling worktree is a change; a board removal is not', async () => {
  const P = G.store.project;
  const head = gitIn(P, ['rev-parse', 'HEAD']);
  const reverify = async () => { fake.scenario([WELL_BEHAVED]); assert.equal((await G.cap.verify('wcl')).result, 'pass'); };
  const guard = () => G.cap.guardTurn({ agent: 'claude', worktreeDir: wt.dir });
  const avail = () => G.cap.cached().agents.claude.available;
  const wt = worktree.createWorktree(P, 'room3', 'mine', head);
  const sibs = [];
  const sib = (id) => { const w = worktree.createWorktree(P, 'room3', id, head); sibs.push(w); return w; };
  const gitDirOf = (w) => path.resolve(w.dir, fs.readFileSync(path.join(w.dir, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)[1].trim());
  const origRunGit = worktree.runGit;
  const failList = (cwd, args, opts) => (args[0] === 'worktree' && args[1] === 'list' ? { ok: false, code: 128, stdout: '', stderr: 'boom' } : origRunGit(cwd, args, opts));
  try {
    await reverify();

    // Board removals during the turn: a `git worktree remove`, and a noted removal that left files behind.
    const a = sib('a'), b = sib('b');
    let g = await guard();
    worktree.removeWorktree(P, a.dir);
    G.cap.noteRemoved(b.dir);
    fs.writeFileSync(path.join(b.dir, 'leftover.txt'), 'x');
    assert.deepEqual(await g.finish(), { ok: true, changed: [] });
    assert.equal(avail(), true);
    worktree.removeWorktree(P, b.dir);

    // Written into, then unregistered (its .git/worktrees entry deleted): still fingerprinted, so a change.
    const c = sib('c');
    g = await guard();
    fs.writeFileSync(path.join(c.dir, 'stray.txt'), 'x');
    fs.rmSync(gitDirOf(c), { recursive: true, force: true });
    assert.ok(!worktree.listBoardWorktrees(P).some((w) => samePath(w.dir, c.dir)), 'git no longer lists it');
    let r = await g.finish();
    assert.equal(r.ok, false);
    assert.deepEqual(r.changed, ['.orchestra/worktrees/room3/c']);
    assert.equal(avail(), false);
    assert.match(G.cap.cached().agents.claude.reason, /observed during a build/);
    rmrf(c.dir);

    // Written into, then its .git file deleted: git would walk up to the main repository (where .orchestra/ is
    // ignored) and see a clean tree; the board never runs git there without the .git file git wrote.
    await reverify();
    const e = sib('e');
    g = await guard();
    fs.writeFileSync(path.join(e.dir, 'stray.txt'), 'x');
    fs.unlinkSync(path.join(e.dir, '.git'));
    r = await g.finish();
    assert.deepEqual(r.changed, ['.orchestra/worktrees/room3/e']);
    rmrf(e.dir);
    // While its stale registration remains, a new guard cannot read that worktree and refuses to start.
    await assert.rejects(guard(), /refusing to run git in \.orchestra\/worktrees\/room3\/e: \.git is missing/);
    gitIn(P, ['worktree', 'prune']);

    // Deleted from disk but still registered: a change (a board removal also unregisters it).
    await reverify();
    const d = sib('d');
    g = await guard();
    rmrf(d.dir);
    r = await g.finish();
    assert.equal(r.ok, false);
    assert.deepEqual(r.changed, ['.orchestra/worktrees/room3/d']);
    gitIn(P, ['worktree', 'prune']);

    // `git worktree list` fails: at the start the guard rejects (and records nothing); at the finish it is a change.
    await reverify();
    worktree.runGit = failList;
    await assert.rejects(guard(), /git worktree list failed/);
    worktree.runGit = origRunGit;
    assert.equal(avail(), true, 'a guard that could not start records nothing');
    g = await guard();
    worktree.runGit = failList;
    r = await g.finish();
    worktree.runGit = origRunGit;
    assert.equal(r.ok, false);
    assert.deepEqual(r.changed, ['the worktree list (git worktree list failed)']);
    assert.equal(avail(), false);
  } finally {
    worktree.runGit = origRunGit;
    for (const w of [wt, ...sibs]) { try { worktree.removeWorktree(P, w.dir); } catch {} }
    try { gitIn(P, ['worktree', 'prune']); } catch {}
  }
});

// git marks a worktree's .git file hidden, and Windows refuses to open a hidden file for overwrite: replace it.
const rewrite = (file, text) => { fs.rmSync(file, { force: true }); fs.writeFileSync(file, text); };

t('(l) guardTurn: a builder that rewrites its own worktree .git is a change (quarantine), and a new guard refuses to start', async () => {
  const P = G.store.project;
  const head = gitIn(P, ['rev-parse', 'HEAD']);
  fake.scenario([WELL_BEHAVED]);
  assert.equal((await G.cap.verify('wcl')).result, 'pass');
  const wt = worktree.createWorktree(P, 'room4', 'mine', head);
  const dotGit = path.join(wt.dir, '.git');
  const orig = fs.readFileSync(dotGit, 'utf8');
  try {
    const g = await G.cap.guardTurn({ agent: 'claude', worktreeDir: wt.dir });
    rewrite(dotGit, 'gitdir: evilgit\n');
    const r = await g.finish();
    assert.equal(r.ok, false);
    assert.deepEqual(r.changed, ['.orchestra/worktrees/room4/mine/.git']);
    assert.equal(G.cap.cached().agents.claude.available, false);
    assert.equal(readRec().agents.claude.result, 'fail');
    await assert.rejects(G.cap.guardTurn({ agent: 'claude', worktreeDir: wt.dir }), (e) => e.code === 'worktree-tampered');
    rewrite(dotGit, orig);
    const g2 = await G.cap.guardTurn({ agent: 'claude', worktreeDir: wt.dir });
    assert.deepEqual(await g2.finish(), { ok: true, changed: [] });
  } finally {
    try { rewrite(dotGit, orig); } catch {}
    try { worktree.removeWorktree(P, wt.dir); } catch {}
    fake.scenario([WELL_BEHAVED]);
    await G.cap.verify('wcl');
  }
});

// ---------- G1: the Claude write argv rules, the platform gate, per-user records, violations, model names ----------

test('(i2) staticCheck(claude): flags are compared by name, --permission-mode is exactly acceptEdits once, --tools is last and holds only file tools', { timeout: 30000 }, () => {
  const cl = claudeAdapter.buildArgs({ model: 'M', effort: 'medium', mode: 'write' });
  assert.deepEqual(staticCheck('claude', cl), { ok: true, reason: null });
  assert.equal(cl.at(-CLAUDE_WRITE_TOOLS.length - 1), '--tools', 'the board argv ends with --tools and its values');
  const ti = cl.indexOf('--tools');
  const beforeTools = (...extra) => [...cl.slice(0, ti), ...extra, ...cl.slice(ti)];
  const refused = (argv, why) => { const r = staticCheck('claude', argv); assert.equal(r.ok, false, why); assert.match(r.reason, /^unsafe write flags: /, why); return r.reason; };
  // Extra tools: shell tools and anything outside Read Grep Glob Edit Write.
  for (const tool of ['PowerShell', 'BashOutput', 'KillShell', 'WebFetch', 'NotebookEdit', 'Bash', 'Task']) refused([...cl, tool], tool);
  refused(cl.map((x) => (x === 'Write' ? 'Write,PowerShell' : x)), 'a comma list hides no shell tool');
  refused(cl.slice(0, ti), 'missing --tools');
  refused([...cl.slice(0, ti), '--tools', ''], 'an empty tool list');
  refused([...cl, '--tools', 'Read'], '--tools twice');
  assert.match(refused([...cl, '--model', 'x'], 'a flag after --tools'), /--tools is not the last flag/);
  // --permission-mode: exactly once, value acceptEdits, bare or '=' form.
  const pmi = cl.indexOf('--permission-mode');
  const withPm = (v) => [...cl.slice(0, pmi), '--permission-mode', v, ...cl.slice(pmi + 2)];
  const pmDefault = withPm('default');
  refused([...pmDefault.slice(0, ti), '--append-system-prompt', 'acceptEdits', ...pmDefault.slice(ti)], '--permission-mode default with acceptEdits elsewhere');
  refused(beforeTools('--permission-mode=default'), '--permission-mode=default after --permission-mode acceptEdits');
  refused(withPm('bypassPermissions'), 'bypassPermissions');
  const eqForm = [...cl.slice(0, pmi), '--permission-mode=acceptEdits', ...cl.slice(pmi + 2)];
  assert.deepEqual(staticCheck('claude', eqForm), { ok: true, reason: null }, 'the = form of acceptEdits is fine');
  refused(cl.filter((x, i) => i !== pmi && i !== pmi + 1), 'missing --permission-mode');
  // Forbidden flags, bare and in the = form.
  refused(beforeTools('--add-dir=/'), '--add-dir=/');
  refused(beforeTools('--settings=x'), '--settings=x');
  for (const flag of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--add-dir', '--allowedTools', '--allowed-tools', '--settings', '--mcp-config', '--plugin-dir', '--agents', '--permission-prompt-tool']) {
    assert.ok(refused(beforeTools(flag, 'x'), flag).includes(flag), flag);
    refused(beforeTools(`${flag}=x`), `${flag}=x`);
  }
  // A bare '--' ends option parsing, so the --tools list after it would be read as text: refused anywhere.
  assert.match(refused(beforeTools('--'), "'--' before --tools"), /end-of-options marker --/);
  assert.match(refused(beforeTools('--resume', '--'), "a thread of '--'"), /end-of-options marker --/);
  refused([...cl, '--'], "'--' after the tools");
  refused(beforeTools('-'), "a bare '-'");
  // A value flag may not take a flag as its value, nor be left without one.
  assert.match(refused(beforeTools('--resume', '--model'), 'a thread that looks like a flag'), /--resume has no value/);
  refused(beforeTools('-r', '-p'), 'a short -r with a flag as its value');
  refused(beforeTools('--session-id', ''), 'an empty session id');
  const resumed = claudeAdapter.buildArgs({ model: 'M', effort: 'medium', mode: 'write', thread: 'abc-123' });
  assert.deepEqual(staticCheck('claude', resumed), { ok: true, reason: null }, 'a normal resumed write turn passes');
  // Isolation stays required.
  refused(cl.filter((x) => x !== '--strict-mcp-config'), 'missing --strict-mcp-config');
  const ssi = cl.indexOf('--setting-sources');
  refused([...cl.slice(0, ssi), '--setting-sources', 'user', ...cl.slice(ssi + 2)], '--setting-sources user');
  refused(beforeTools('--setting-sources', 'user'), 'a second --setting-sources');
  // The Codex branch is unchanged, and an unknown agent is refused.
  assert.deepEqual(staticCheck('codex'), { ok: true, reason: null });
  assert.equal(staticCheck('gemini', cl).ok, false);
  // The tool list itself.
  assert.ok(Object.isFrozen(CLAUDE_WRITE_TOOLS));
  assert.deepEqual([...CLAUDE_WRITE_TOOLS], ['Read', 'Grep', 'Glob', 'Edit', 'Write']);
  for (const s of ['Bash', 'BashOutput', 'KillShell', 'PowerShell', 'terminal']) assert.equal(isShellTool(s), true, s);
  for (const s of CLAUDE_WRITE_TOOLS) assert.equal(isShellTool(s), false, s);
});

test('(i3) writeSettings: Claude names the tool list and thread homes; Codex says edits are off, plus the Windows line on win32', { timeout: 30000 }, () => {
  const cl = writeSettings('claude', 'linux');
  assert.ok(cl.includes('--tools Read Grep Glob Edit Write (no shell tool: no Bash, no PowerShell)'));
  assert.ok(cl.includes('a write turn resumes only a thread started in the same worktree'));
  for (const p of ['linux', 'darwin', 'win32']) assert.ok(writeSettings('codex', p).some((l) => /Codex file edits are off in v0\.2/.test(l)), p);
  assert.ok(writeSettings('codex', 'win32').some((l) => /unelevated/.test(l) && /Codex file edits are off in v0.2/.test(l)));
  assert.ok(!writeSettings('codex', 'linux').some((l) => /unelevated/.test(l)));
  const dashes = /[\u2013\u2014]/;
  for (const p of ['linux', 'win32']) for (const a of ['claude', 'codex']) for (const l of writeSettings(a, p)) assert.doesNotMatch(l, dashes, 'no en or em dashes');
});

test('(i4) defaultRecordsDir: a per-user folder outside any project, per OS', { timeout: 30000 }, () => {
  const home = os.homedir();
  assert.equal(defaultRecordsDir('win32', { APPDATA: path.join(home, 'AD') }), path.join(home, 'AD', 'agent-orchestra-board'));
  assert.equal(defaultRecordsDir('win32', {}), path.join(home, 'AppData', 'Roaming', 'agent-orchestra-board'));
  assert.equal(defaultRecordsDir('darwin', {}), path.join(home, 'Library', 'Application Support', 'agent-orchestra-board'));
  assert.equal(defaultRecordsDir('linux', { XDG_CONFIG_HOME: path.join(home, 'xdg') }), path.join(home, 'xdg', 'agent-orchestra-board'));
  assert.equal(defaultRecordsDir('linux', {}), path.join(home, '.config', 'agent-orchestra-board'));
  assert.equal(defaultRecordsDir('linux', { XDG_CONFIG_HOME: 'relative/dir' }), path.join(home, '.config', 'agent-orchestra-board'), 'a relative XDG_CONFIG_HOME is ignored');
});

test('(i5) model names: the first character is a letter or digit, so a model can never be a flag', { timeout: 30000 }, () => {
  for (const ok of ['claude-haiku-5-5', 'gpt-6.1-sol', 'opus[1m]', 'M', '4o']) assert.equal(MODEL_RE.test(ok), true, ok);
  for (const bad of ['--add-dir', '-x', '', '.hidden', 'a b', 'x'.repeat(65), '[1m]']) assert.equal(MODEL_RE.test(bad), false, bad);
  const d = tmpDir('ob-cap-seats-');
  try {
    const store = createStore(d); store.ensure();
    const seats = createSeats({ store, broadcast: () => {} });
    for (const bad of ['--add-dir', '-x']) assert.throws(() => seats.upsertSeat({ name: 'S', agent: 'claude', model: bad }), /invalid model name/, bad);
    for (const ok of ['claude-haiku-5-5', 'gpt-6.1-sol', 'opus[1m]']) assert.equal(seats.upsertSeat({ name: `S ${ok}`, agent: 'claude', model: ok }).model, ok);
  } finally { rmrf(d); }
});

// The binding fields a record for `agent` must carry to match this machine (computed like the gate does).
function bindingOf(agent) {
  const found = agent === 'codex' ? platform.resolveExe(process.env.ORCHESTRA_CODEX_BIN, platform.codexEnv()) : platform.resolveExe(process.env.ORCHESTRA_CLAUDE_BIN);
  const exe = fs.realpathSync(found), st = fs.statSync(exe);
  return { exe, exeSize: st.size, exeMtimeMs: st.mtimeMs, host: os.hostname(), user: os.userInfo().username };
}

for (const plat of ['win32', 'linux']) {
  t(`(m) ${plat}: Codex is unavailable and not verifiable even with a forged matching record; allowsWrite is false; verify is 409 with nothing spawned, created or saved`, async () => {
    const project = path.join(dir, `proj-${plat}`);
    const head = initRepo(project, { 'README.md': 'hello\n' });
    const rd = path.join(dir, `records-${plat}`);
    const b = make(project, { platform: plat, recordsDir: rd });
    const st0 = await b.cap.status({ detect: true });
    // Forge a record for each CLI that matches this machine in every field.
    const forged = (agent) => ({ result: 'pass', detail: 'only the worktree changed', checkedAt: new Date().toISOString(), cliVersion: st0.agents[agent].version, platform: plat, settingsHash: settingsHash(agent), ...bindingOf(agent) });
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(recFile(rd), JSON.stringify({ version: 2, agents: { claude: forged('claude'), codex: forged('codex') } }));
    const recBytes = fs.readFileSync(recFile(rd), 'utf8');
    const st = await b.cap.status();
    assert.equal(st.platform, plat);
    assert.equal(st.agents.claude.available, true, `the forging is exact: the Claude record matches (${st.agents.claude.reason})`);
    const cws = platform.codexWriteSupport(plat);
    assert.equal(cws.ok, false);
    assert.equal(cws.code, plat === 'win32' ? 'codex-windows-unelevated' : 'codex-writes-off');
    assert.equal(st.agents.codex.available, false);
    assert.equal(st.agents.codex.verifiable, false);
    assert.equal(st.agents.codex.code, cws.code);
    assert.equal(st.agents.codex.reason, cws.reason);
    assert.deepEqual(st.agents.codex.settings, writeSettings('codex', plat));
    assert.deepEqual(b.cap.platformGate('codex'), { ok: false, code: cws.code, reason: cws.reason });
    assert.equal(b.cap.platformGate(b.seats.seatById('wcx')).ok, false);
    assert.equal(b.cap.platformGate('claude').ok, true);
    assert.equal(b.cap.platformGate({ agent: 'gemini' }).ok, false, 'an unknown agent fails closed');
    assert.equal(b.cap.platformGate(null).ok, false);

    const wt = worktree.createWorktree(project, 'm', 'item', head);
    try {
      assert.equal(b.cap.allowsWrite(b.seats.seatById('wcl'), wt.dir), true);
      assert.equal(b.cap.allowsWrite(b.seats.seatById('wcx'), wt.dir), false);
      // The runner clamps the Codex write request to read.
      fake.scenario({ default: { reply: 'ok' } });
      const res = await b.runner.runSeat('wcx', 'edit', { tools: 'write', worktree: wt.dir });
      assert.equal(res.ok, true); assert.equal(res.mode, 'read');
      assert.equal(fake.calls().at(-1).sandbox, 'read-only');

      // verify: 409 before anything happens.
      const calls0 = fake.calls().length;
      const made0 = [];
      const origMkdtemp = fs.mkdtempSync;
      fs.mkdtempSync = (prefix, ...rest) => { made0.push(String(prefix)); return origMkdtemp(prefix, ...rest); };
      try {
        await assert.rejects(b.cap.verify('wcx'), (e) => e.status === 409 && e.code === 'unsupported-platform' && e.message === cws.reason);
      } finally { fs.mkdtempSync = origMkdtemp; }
      assert.equal(b.cap.isVerifying(), false);
      assert.deepEqual(made0.filter((p) => /ob-writecheck-/.test(p)), [], 'no ob-writecheck- dir');
      assert.equal(fake.calls().length, calls0, 'no fake call');
      assert.equal(fs.readFileSync(recFile(rd), 'utf8'), recBytes, 'no record written');
    } finally { worktree.removeWorktree(project, wt.dir); }
  });
}

t('(n) a forged pass in .orchestra/capability.json is ignored and sets legacyRecordIgnored; the generated .gitignore lists it', async () => {
  const project = path.join(dir, 'proj-legacy');
  initRepo(project, { 'README.md': 'hello\n' });
  const rd = path.join(dir, 'records-legacy');
  const b = make(project, { recordsDir: rd });
  let st = await b.cap.status({ detect: true });
  assert.equal(st.legacyRecordIgnored, false);
  const forged = { result: 'pass', at: new Date().toISOString(), version: st.agents.claude.version, platform: process.platform, settingsHash: settingsHash('claude'), detail: '' };
  for (const content of [{ version: 1, agents: { claude: forged } }, { version: 2, agents: { claude: { ...forged, cliVersion: forged.version, ...bindingOf('claude') } } }]) {
    fs.writeFileSync(path.join(b.store.orch, 'capability.json'), JSON.stringify(content));
    st = await b.cap.status();
    assert.equal(st.legacyRecordIgnored, true);
    assert.equal(st.agents.claude.available, false);
    assert.equal(st.agents.claude.code, 'unverified');
    assert.equal(st.agents.claude.verified, null);
  }
  assert.equal(fs.existsSync(recFile(rd)), false);
  assert.match(fs.readFileSync(path.join(b.store.orch, '.gitignore'), 'utf8'), /^capability\.json$/m);
});

t('(o) recordViolation: kind startup closes the gate with code startup for this session without touching the record; a later passing check reopens it', async () => {
  const wcl = G.seats.seatById('wcl');
  const wt = worktree.createWorktree(G.store.project, 'viol', 'item', gitIn(G.store.project, ['rev-parse', 'HEAD']));
  try {
    await reverifyClaude();
    assert.equal(G.cap.allowsWrite(wcl, wt.dir), true);
    const before = fs.readFileSync(recFile(), 'utf8');
    const n = G.events.length;
    await G.cap.recordViolation('claude', 'tools: Read, Bash', 'startup');
    let a = G.cap.cached().agents.claude;
    assert.equal(a.available, false); assert.equal(a.code, 'startup');
    assert.equal(a.reason, 'the CLI reported an unsafe write setup at the start of a turn');
    assert.equal(G.cap.allowsWrite(wcl, wt.dir), false);
    assert.ok(G.events.slice(n).some((e) => e.t === 'capability' && e.capability.agents.claude.code === 'startup'));
    assert.equal(fs.readFileSync(recFile(), 'utf8'), before, 'a startup violation is not persisted');
    a = (await G.cap.status()).agents.claude;
    assert.equal(a.code, 'startup', 'a recomputed status keeps the session violation');
    await reverifyClaude();
    assert.equal(G.cap.cached().agents.claude.available, true);
    assert.equal(G.cap.allowsWrite(wcl, wt.dir), true);

    // The default kind is the runtime guard: persisted as a failed check.
    await G.cap.recordViolation('claude', 'the main checkout');
    a = G.cap.cached().agents.claude;
    assert.equal(a.available, false); assert.equal(a.code, 'check-failed');
    assert.equal(readRec().agents.claude.result, 'fail');
    assert.match(readRec().agents.claude.detail, /observed during a build: changes outside the worktree \(the main checkout\)/);
    await reverifyClaude();
  } finally { worktree.removeWorktree(G.store.project, wt.dir); }
});
