// Turn-time enforcement in the runner (plan 5.6) against the fake CLIs: the pre-spawn assertion of a write turn, thread
// homes, the startup check on Claude's init event (with the capability gate closing for the session) and the tool log.
// Every write turn here runs in a real board worktree of a temp repository; no real CLI is ever started.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, rmrf, waitFor, samePath, hasGit, initRepo } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { createStore } = require('../src/store');
const { createSeats } = require('../src/seats');
const { createLimits } = require('../src/limits');
const { createRunner } = require('../src/runner');
const { createCapability } = require('../src/capability');
const worktree = require('../src/worktree');
const claudeAdapter = require('../src/adapters/claude');

const seat = (id, name, agent, perm) => ({ id, name, role: 'Builder', agent, model: agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', effort: 'low', perm, target: '', budget: 0, color: '#e07a52', thread: null, used: 0, cached: 0, cost: 0 });
const SEATS = [seat('wcl', 'Wcl', 'claude', 'write'), seat('cox', 'Cox', 'codex', 'read'), seat('ada', 'Ada', 'claude', 'read')];
// Writes inside its worktree and reports both outside attempts of the write check as refused (plan 5.8: a pass needs
// proof of an attempt). The paths are relative to the check worktree <scratch>/repo/.orchestra/worktrees/check/item.
const WELL_BEHAVED = {
  match: 'Board write check', writeFiles: [{ path: 'WRITE_CHECK_INSIDE.txt' }], reply: 'STEP 1: done\nSTEP 2: refused\nSTEP 3: refused',
  toolUses: [{ name: 'Write', file_path: '../../../../WRITE_CHECK_OUTSIDE.txt', error: 'refused' }, { name: 'Write', file_path: '../../../../../outside/WRITE_CHECK_SIBLING.txt', error: 'refused' }],
};

let root, fake, project, head, store, seats, limits, runner, wtA, wtB;
const made = [];
const skip = (!hasGit && 'git not available') || false;
let fakeSkip = false;

before(() => {
  root = tmpDir('ob-turnguard-');
  fake = setupFakeCli(root);
  fakeSkip = fake.skipReason || false;
  if (skip || fakeSkip) return;
  project = path.join(root, 'project');
  head = initRepo(project, { 'README.md': 'hello\n' });
  store = createStore(project); store.ensure();
  store.writeJson('seats.json', SEATS);
  limits = createLimits({ store, broadcast: () => {} });
  seats = createSeats({ store, broadcast: () => {} });
  runner = createRunner({ store, seats, limits, settings: { lang: 'English' }, broadcast: () => {}, retryDelaysMs: [], writeGate: () => true });
  wtA = worktree.createWorktree(project, 'room1', 'a', head).dir;
  wtB = worktree.createWorktree(project, 'room1', 'b', head).dir;
});
after(async () => {
  const all = [runner, ...made.map((b) => b.runner)].filter(Boolean);
  if (seats) {
    for (const r of all) for (const s of seats.all()) if (seats.rtOf(s.id).child) r.stopSeat(s.id);
    try { await waitFor(() => seats.all().every((s) => !seats.rtOf(s.id).child), { timeout: 5000 }); } catch {}
  }
  for (const b of made) {
    for (const s of b.seats.all()) if (b.seats.rtOf(s.id).child) b.runner.stopSeat(s.id);
    try { await waitFor(() => b.seats.all().every((s) => !b.seats.rtOf(s.id).child), { timeout: 5000 }); } catch {}
  }
  rmrf(root);
});

const t = (name, fn) => test(name, { timeout: 60000, skip }, async (ctx) => {
  if (fakeSkip) { if (process.env.GITHUB_ACTIONS) throw new Error(`fake CLI unavailable on CI: ${fakeSkip}`); ctx.skip(fakeSkip); return; }
  fake.resetCalls();
  await fn(ctx);
});

// ---------- pre-spawn assertion ----------

t('a write argv with a shell tool is refused before the spawn: write turn refused: unsafe write flags ... shell tool Bash', async () => {
  fake.scenario({ default: { reply: 'ok' } });
  const orig = claudeAdapter.buildArgs;
  claudeAdapter.buildArgs = (o) => { const a = orig(o); if (o.mode === 'write') a.push('Bash'); return a; };
  let res;
  try { res = await runner.runSeat('wcl', 'edit', { tools: 'write', worktree: wtA }); }
  finally { claudeAdapter.buildArgs = orig; }
  assert.equal(res.ok, false);
  assert.equal(res.failure, 'containment');
  assert.match(res.error, /^write turn refused: unsafe write flags: .*shell tool Bash/);
  assert.equal(fake.calls().length, 0, 'the CLI never ran');
  assert.equal(seats.rtOf('wcl').status, 'error');
});

t('a worktree path that is a link, or one outside the worktree root, is refused with no CLI call', async () => {
  fake.scenario({ default: { reply: 'ok' } });
  const link = path.join(worktree.worktreeRoot(project), 'room1', 'lnk');
  fs.symlinkSync(wtA, link, process.platform === 'win32' ? 'junction' : 'dir');
  const outside = tmpDir('ob-turnguard-out-');
  try {
    let res = await runner.runSeat('wcl', 'edit', { tools: 'write', worktree: link });
    assert.equal(res.failure, 'containment');
    assert.match(res.error, /^write turn refused: .*symbolic link/);
    res = await runner.runSeat('wcl', 'edit', { tools: 'write', worktree: outside });
    assert.equal(res.failure, 'containment');
    assert.match(res.error, /^write turn refused: .*not inside a board worktree folder/);
    // Inside the worktree root but not a registered worktree.
    const loose = path.join(worktree.worktreeRoot(project), 'room1', 'loose');
    fs.mkdirSync(loose, { recursive: true });
    res = await runner.runSeat('wcl', 'edit', { tools: 'write', worktree: loose });
    assert.equal(res.failure, 'containment');
    assert.match(res.error, /^write turn refused: .*not a registered board worktree/);
    assert.equal(fake.calls().length, 0, 'the CLI never ran');
  } finally {
    try { fs.rmSync(link, { recursive: false, force: true }); } catch { try { fs.unlinkSync(link); } catch {} }
    rmrf(outside);
  }
  // A read turn in the same places is not a write turn: nothing is asserted, the CLI runs.
  const res = await runner.runSeat('wcl', 'look', { tools: 'read', worktree: wtA });
  assert.equal(res.ok, true);
});

// ---------- thread homes ----------

t('thread homes: two write turns in one room and worktree resume the same thread with the same cwd', async () => {
  fake.scenario({ default: { reply: 'ok' } });
  const room = { id: 'home-1', threads: {} };
  const r1 = await runner.runSeat('wcl', 'first', { room, threadKey: 'k', tools: 'write', worktree: wtA });
  const r2 = await runner.runSeat('wcl', 'second', { room, threadKey: 'k', tools: 'write', worktree: wtA });
  assert.equal(r1.ok, true); assert.equal(r2.ok, true);
  assert.equal(r1.mode, 'write'); assert.equal(r2.mode, 'write');
  const [c1, c2] = fake.calls();
  assert.equal(c1.resume, false); assert.equal(c2.resume, true);
  assert.equal(c2.thread, c1.thread);
  assert.ok(samePath(c1.cwd, wtA) && samePath(c2.cwd, wtA));
  assert.equal(r2.recovered, undefined);
  assert.equal(room.threadHomes.k, worktree.canon(wtA));
});

t('thread homes: a thread born in the project (or another worktree) is not resumed by a write turn; it starts fresh with the recap and the note', async () => {
  fake.scenario({ default: { reply: 'ok' } });
  const room = { id: 'home-2', threads: {} };
  const notes = [];
  const r0 = await runner.runSeat('wcl', 'read first', { room, threadKey: 'k', tools: 'read' });
  assert.equal(r0.ok, true);
  const born = room.threads.k;
  assert.ok(born);
  assert.equal(room.threadHomes?.k, undefined, 'a thread born in the project has no worktree home');
  const r1 = await runner.runSeat('wcl', 'write now', { room, threadKey: 'k', tools: 'write', worktree: wtA, recovery: () => 'RECAP OF THE ROOM', onRecover: (n) => notes.push(n) });
  assert.equal(r1.ok, true); assert.equal(r1.mode, 'write'); assert.equal(r1.recovered, true);
  const c1 = fake.calls().at(-1);
  assert.equal(c1.resume, false, 'a fresh thread');
  assert.ok(samePath(c1.cwd, wtA));
  assert.match(c1.stdin, /RECAP OF THE ROOM/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /the thread was started outside this worktree/);
  assert.notEqual(room.threads.k, born);
  assert.equal(room.threadHomes.k, worktree.canon(wtA));
  // The same key in another worktree: fresh again.
  const r2 = await runner.runSeat('wcl', 'write elsewhere', { room, threadKey: 'k', tools: 'write', worktree: wtB, recovery: () => 'RECAP', onRecover: (n) => notes.push(n) });
  assert.equal(r2.ok, true); assert.equal(r2.recovered, true);
  assert.equal(fake.calls().at(-1).resume, false);
  assert.equal(room.threadHomes.k, worktree.canon(wtB));
  // A read turn that starts a new thread in the project drops the home.
  const room2 = { id: 'home-3', threads: { k: 'stale-thread' }, threadHomes: { k: worktree.canon(wtA) } };
  fake.scenario({ rules: [{ resume: true, lostThread: true }], default: { reply: 'ok' } });
  const r3 = await runner.runSeat('wcl', 'read', { room: room2, threadKey: 'k', tools: 'read', recovery: () => 'R', onRecover: () => {} });
  assert.equal(r3.ok, true);
  assert.notEqual(room2.threads.k, 'stale-thread');
  assert.equal(room2.threadHomes.k, undefined);
});

t('thread homes: a room-less write turn neither resumes nor overwrites seat.thread', async () => {
  fake.scenario({ default: { reply: 'ok' } });
  const s = seats.seatById('wcl');
  s.thread = 'keep-me-thread';
  try {
    const res = await runner.runSeat('wcl', 'edit', { tools: 'write', worktree: wtA });
    assert.equal(res.ok, true); assert.equal(res.mode, 'write');
    const c = fake.calls().at(-1);
    assert.equal(c.resume, false);
    assert.ok(!c.args.includes('keep-me-thread'));
    assert.equal(seats.seatById('wcl').thread, 'keep-me-thread');
  } finally { s.thread = null; }
});

// ---------- startup check ----------

// A board instance whose write gate is the capability (Claude verified by one write check) and whose runner reports
// containment stops to it, as server.js wires them.
let recordsDir = null;
async function makeBoard() {
  const st = createStore(project);
  const sts = createSeats({ store: st, broadcast: () => {} });
  let cap = null;
  const r = createRunner({
    store: st, seats: sts, limits, settings: { lang: 'English' }, broadcast: () => {}, retryDelaysMs: [],
    writeGate: (s, d) => cap.allowsWrite(s, d),
    onContainment: (agent, detail) => cap.recordViolation(agent, detail, 'startup'),
  });
  recordsDir ||= path.join(root, 'records');
  cap = createCapability({ store: st, runner: r, seats: sts, broadcast: () => {}, recordsDir });
  const b = { store: st, seats: sts, runner: r, cap };
  made.push(b);
  let status = await cap.status({ detect: true });
  if (!status.agents.claude.available) {
    fake.scenario([WELL_BEHAVED]);
    const v = await cap.verify('wcl');
    assert.equal(v.result, 'pass', `write check: ${v.detail}`);
    status = await cap.status({ detect: true });
  }
  assert.equal(status.agents.claude.available, true, `claude writes: ${status.agents.claude.reason}`);
  fake.resetCalls();
  return b;
}

const CASES = [
  ['init.tools with Bash', () => ({ init: { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] } }), /shell tool Bash/],
  ['init.tools with WebFetch', () => ({ init: { tools: ['Read', 'Write', 'WebFetch'] } }), /tool WebFetch, which a write turn may not have/],
  ['init.tools missing', () => ({ init: { tools: null } }), /init event lacks tools/],
  ['init.cwd set to the project', () => ({ init: { cwd: project } }), /not in the worktree/],
  ['init.permissionMode bypassPermissions', () => ({ init: { permissionMode: 'bypassPermissions' } }), /permission mode bypassPermissions/],
  ['init.mcp_servers not empty', () => ({ init: { mcp_servers: [{ name: 'github', status: 'connected' }] } }), /MCP servers: github/],
  ['a tool_use before init', () => ({ beforeInit: true }), /assistant event before its init event/],
];

for (const [label, rule, why] of CASES) {
  t(`startup check: ${label} stops the write turn (containment, one CLI call, later events ignored, writes off with code startup)`, async () => {
    const b = await makeBoard();
    fake.scenario({ default: { reply: 'ok', ...rule(), toolUses: [{ name: 'Write', file_path: 'late.txt' }] } });
    const res = await b.runner.runSeat('wcl', 'startup case', { tools: 'write', worktree: wtA, collectTools: true });
    assert.equal(res.ok, false);
    assert.equal(res.mode, 'write');
    assert.equal(res.failure, 'containment');
    assert.match(res.error, /^write turn stopped: /);
    assert.match(res.error, why);
    assert.equal(fake.calls().length, 1, 'never retried');
    assert.deepEqual(res.toolLog, [], 'the tool_use after the stop is ignored');
    assert.equal(res.text, '', 'the reply after the stop is ignored');
    const entry = b.cap.cached().agents.claude;
    assert.equal(entry.available, false);
    assert.equal(entry.code, 'startup');
    assert.equal(b.cap.allowsWrite(b.seats.seatById('wcl'), wtA), false, 'the gate is closed for the session');
    assert.equal(b.seats.rtOf('wcl').status, 'error');
    // The same override in a read turn is not checked: it succeeds.
    fake.resetCalls();
    const rd = await b.runner.runSeat('wcl', 'read case', { tools: 'read', worktree: wtA, collectTools: true });
    assert.equal(rd.ok, true, rd.error);
    assert.equal(rd.mode, 'read');
    assert.equal(fake.calls().length, 1);
  });
}

t('startup check: the default fake init passes and the write turn completes', async () => {
  const b = await makeBoard();
  fake.scenario({ default: { reply: 'done' } });
  const res = await b.runner.runSeat('wcl', 'normal write', { tools: 'write', worktree: wtA });
  assert.equal(res.ok, true, res.error); assert.equal(res.mode, 'write'); assert.equal(res.text, 'done');
  assert.equal(b.cap.cached().agents.claude.available, true);
});

// ---------- tool log ----------

t('collectTools: Claude tool uses, results and permission denials in order; nothing without the option', async () => {
  const out = path.join(root, 'outside', 'b.txt');
  fake.scenario({ default: { reply: 'ok', toolUses: [{ name: 'Write', file_path: 'in.txt' }, { name: 'Write', file_path: out, error: 'not allowed' }], denials: [{ tool_name: 'Write', tool_use_id: 'toolu_u2', tool_input: { file_path: out } }] } });
  const res = await runner.runSeat('wcl', 'tools', { tools: 'write', worktree: wtA, collectTools: true });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.toolLog, [
    { kind: 'use', id: 'toolu_u1', name: 'Write', path: 'in.txt' },
    { kind: 'result', id: 'toolu_u1', error: false },
    { kind: 'use', id: 'toolu_u2', name: 'Write', path: out },
    { kind: 'result', id: 'toolu_u2', error: true },
    { kind: 'denial', name: 'Write', id: 'toolu_u2', path: out },
  ]);
  const plain = await runner.runSeat('wcl', 'tools', { tools: 'write', worktree: wtA });
  assert.equal(plain.ok, true);
  assert.equal('toolLog' in plain, false);
  assert.equal(fs.existsSync(path.join(wtA, 'in.txt')), false, 'the tool log is evidence only: the fake wrote nothing');
});

t('collectTools: Codex commands (failed on a non-zero exit) and file changes', async () => {
  fake.scenario({ default: { reply: 'ok', commands: [{ command: 'echo hi', exit_code: 0 }, { command: 'touch ../x', exit_code: 1 }], fileChanges: [{ path: 'a.txt' }, { path: '/abs/b.txt', status: 'failed' }] } });
  const res = await runner.runSeat('cox', 'tools', { tools: 'read', collectTools: true });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.toolLog, [
    { kind: 'use', name: 'command_execution', command: 'echo hi', exitCode: 0, status: 'completed', failed: false },
    { kind: 'use', name: 'command_execution', command: 'touch ../x', exitCode: 1, status: 'failed', failed: true },
    { kind: 'use', name: 'file_change', paths: ['a.txt'], status: 'completed', failed: false },
    { kind: 'use', name: 'file_change', paths: ['/abs/b.txt'], status: 'failed', failed: true },
  ]);
});

t('collectTools: at most 100 entries, strings clipped to 500 characters', async () => {
  const long = 'x'.repeat(700);
  fake.scenario({ default: { reply: 'ok', toolUses: Array.from({ length: 60 }, (_, i) => ({ name: 'Read', file_path: i === 0 ? long : `f${i}.txt` })) } });
  const res = await runner.runSeat('ada', 'many', { tools: 'read', collectTools: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.toolLog.length, 100);
  assert.equal(res.toolLogTruncated, true);
  assert.equal(res.toolLog[0].path.length, 500);
});
