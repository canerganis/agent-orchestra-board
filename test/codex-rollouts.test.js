// Codex rollout follower (F5, src/watch/codex-rollouts.js): day folders, the fields kept from session_meta, findByToken,
// and the follower's links, statuses, tokens, sandbox, silence and stop rules, the catch-up rule for closed turns and
// resumed leads in older folders. Synthetic rollouts come from
// test/fixtures/codex-rollouts, and other lines are built in code. Canary strings sit in every field the follower must
// drop, and no output may contain one. Each test uses its own temporary CODEX_HOME. Clocks are injected, and rollouts
// go into the local date folder of their first line (as Codex names them), so the results do not depend on the time zone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  codexHome, dayDirs, scanMeta, findByToken, createRolloutFollower, SILENCE_MS, AGENTS_MAX, DAYS_MAX, LEAD_RETRY_MS,
} = require('../src/watch/codex-rollouts');

const FIX = path.join(__dirname, 'fixtures', 'codex-rollouts');
const LEAD = '019e0a00-0001-7000-8000-000000000001';
const CHILD_A = '019e0a00-0002-7000-8000-000000000002';
const CHILD_B = '019e0a00-0003-7000-8000-000000000003';
const KILLED = '019e0a00-0004-7000-8000-000000000004';
const GRAND = '019e0a00-0005-7000-8000-000000000005';
const GUARDIAN = '019e0a00-0006-7000-8000-000000000006';
const TOKEN = 'obk7q2mz';
const ITEMS = { i1: 'I1', i2: 'I2', i3: 'I3' };
const MIN = 60 * 1000;
const SEC = 1000;

const at = (hms) => Date.parse(`2026-10-07T${hms}Z`);
const SINCE = at('20:59:00');
const pad = (n) => String(n).padStart(2, '0');
// Local time from a 1-based month, so the dates read as they are written (2026, 10, 7 is 7 October).
const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

// A fresh home with an empty sessions/ folder, removed after the test. Removal never follows a link.
function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-codex-'));
  t.after(() => removeTree(dir));
  const home = path.join(dir, '.codex');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  return home;
}

function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  try {
    if (st.isSymbolicLink()) {
      try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
    } else if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  } catch {}
}

// True when the link was made. Windows needs a privilege for file symlinks; folder junctions need none.
function tryLink(target, linkPath, type) {
  try { fs.symlinkSync(target, linkPath, type); return true; } catch { return false; }
}

const fixtureLines = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter((l) => l.trim() !== '');

// The local date folder of a rollout whose first line has this time: sessions/YYYY/MM/DD, as Codex names it.
function dayFolderOf(ms) {
  const d = new Date(ms);
  return path.join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
}

// Writes lines (JSON text) into folder dir as rollout <threadId>. complete: false leaves the last line open.
function writeInFolder(dir, ms, lines, threadId, { complete = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-');
  const file = path.join(dir, `rollout-${stamp}-${threadId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + (complete ? '\n' : ''));
  return file;
}

// Writes a rollout under home/sessions in the folder of its first line, and returns its path.
function writeRollout(home, lines, threadId, opts) {
  const ms = Date.parse(JSON.parse(lines[0]).timestamp);
  return writeInFolder(path.join(home, 'sessions', dayFolderOf(ms)), ms, lines, threadId, opts);
}

function appendLines(file, lines) {
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
}

// The standard run: a lead that is running at 21:00:20 in its fixture, two sub-agents (one finished, one running after its
// fixture), a killed sub-agent, a grandchild, and a guardian review thread that must never be followed.
function installRun(home) {
  return {
    lead: writeRollout(home, fixtureLines('lead.jsonl'), LEAD),
    a: writeRollout(home, fixtureLines('child-a.jsonl'), CHILD_A),
    b: writeRollout(home, fixtureLines('child-b.jsonl'), CHILD_B),
    killed: writeRollout(home, fixtureLines('child-killed.jsonl'), KILLED),
    grand: writeRollout(home, fixtureLines('child-grand.jsonl'), GRAND),
    guardian: writeRollout(home, fixtureLines('guardian.jsonl'), GUARDIAN),
  };
}

// Lines built in code, in the shape of the fixtures.
const lineAt = (ms, type, payload) => JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload });

function metaLine(ms, id, { parent = null, depth = 1, agentPath = null, role = 'worker', nickname = 'Test', guardian = false } = {}) {
  let source = 'exec';
  if (guardian) source = { subagent: { other: 'guardian' } };
  else if (parent !== null) {
    source = { subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_path: agentPath, agent_nickname: nickname, agent_role: role } } };
  }
  return lineAt(ms, 'session_meta', {
    id, session_id: id, timestamp: new Date(ms).toISOString(), cwd: '/work/synthetic-project', cli_version: '0.160.0',
    source, creator_user_id: 'CANARY_creator_user', creator_account_id: 'CANARY_creator_account',
    base_instructions: { text: 'CANARY_base_instructions' }, git: { commit_hash: 'CANARY_git_commit', branch: 'main' },
  });
}
const turnStart = (ms, turn = 'turn-x') => lineAt(ms, 'event_msg', { type: 'task_started', turn_id: turn, started_at: Math.floor(ms / SEC) });
const turnDone = (ms, turn = 'turn-x') => lineAt(ms, 'event_msg', {
  type: 'task_complete', turn_id: turn, last_agent_message: 'CANARY_last_agent_message', started_at: Math.floor(ms / SEC), completed_at: Math.floor(ms / SEC), duration_ms: SEC,
});
const policy = (ms, type) => lineAt(ms, 'turn_context', { turn_id: 'turn-x', cwd: '/work/synthetic-project', sandbox_policy: { type, network_access: false }, model: 'gpt-6-luna' });
// A token_count line whose total is input, cached and output. The tokens of a thread are input, less cached, plus output.
const usageLine = (ms, input, cached, output) => lineAt(ms, 'event_msg', {
  type: 'token_count',
  info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } },
  rate_limits: null,
});
// n filler lines of about one kilobyte each, all stamped ms: 2400 of them are about 2.4 MB.
const padding = (n, ms) => Array.from({ length: n }, () => lineAt(ms, 'response_item', { type: 'message', content: 'x'.repeat(1000) }));
const DAY = 24 * 60 * MIN;

// A follower for the standard lead. The clock is clock.t. Polls are explicit (intervalMs 0 starts no timer).
function follow(home, clock, extra = {}) {
  return createRolloutFollower({
    home, parentThreadId: LEAD, sinceMs: SINCE, token: TOKEN, itemMap: ITEMS, intervalMs: 0, now: () => clock.t, ...extra,
  });
}
const byId = (list, id) => list.find((x) => x.id === id);

// Calls fn and returns how many rollout files it opened. The open calls themselves are not changed.
function countRolloutOpens(fn) {
  const real = fs.openSync;
  let n = 0;
  fs.openSync = function countingOpen(file, ...rest) {
    if (String(file).endsWith('.jsonl')) n += 1;
    return real.call(this, file, ...rest);
  };
  try { fn(); } finally { fs.openSync = real; }
  return n;
}

test('dayDirs: from the day before sinceMs through the day of now, in local folders', () => {
  assert.deepEqual(dayDirs(local(2026, 10, 7, 12, 0), local(2026, 10, 9, 9, 0)),
    ['2026/10/06', '2026/10/07', '2026/10/08', '2026/10/09']);
  assert.deepEqual(dayDirs(local(2026, 10, 8, 23, 50), local(2026, 10, 8, 23, 55)), ['2026/10/07', '2026/10/08']);
});

test('dayDirs: folders roll over months and years', () => {
  assert.deepEqual(dayDirs(local(2027, 1, 1, 0, 30), local(2027, 1, 2, 8, 0)), ['2026/12/31', '2027/01/01', '2027/01/02']);
  assert.deepEqual(dayDirs(local(2026, 11, 1, 0, 30), local(2026, 11, 2, 8, 0)), ['2026/10/31', '2026/11/01', '2026/11/02']);
});

test('dayDirs: a window longer than DAYS_MAX keeps the newest folders; bad input and a start after now give none', () => {
  const now = local(2026, 10, 8, 12, 0);
  const dirs = dayDirs(0, now);
  assert.equal(dirs.length, DAYS_MAX);
  assert.equal(dirs.at(-1), '2026/10/08');
  assert.deepEqual(dayDirs(Number.NaN, now), []);
  assert.deepEqual(dayDirs(SINCE, Number.NaN), []);
  assert.deepEqual(dayDirs(local(2026, 10, 12, 12, 0), local(2026, 10, 8, 12, 0)), [], 'a start after now has no folders');
});

test('codexHome: CODEX_HOME when it is set, else ~/.codex', () => {
  const saved = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = '/custom/codex-home';
    assert.equal(codexHome(), '/custom/codex-home');
    delete process.env.CODEX_HOME;
    assert.equal(codexHome(), path.join(os.homedir(), '.codex'));
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});

test('scanMeta keeps only the fields it needs; creator ids, instructions and git data never appear', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const metas = scanMeta(home, SINCE, at('21:03:00'));
  assert.deepEqual(metas.map((m) => m.id).sort(), [LEAD, CHILD_A, CHILD_B, KILLED, GRAND, GUARDIAN].sort());
  const allowed = ['id', 'timestamp', 'cwd', 'cliVersion', 'spawn', 'file'];
  const allowedSpawn = ['parentId', 'depth', 'nickname', 'role', 'agentPath'];
  for (const m of metas) {
    for (const k of Object.keys(m)) assert.ok(allowed.includes(k), `unexpected field ${k}`);
    if (m.spawn !== null) for (const k of Object.keys(m.spawn)) assert.ok(allowedSpawn.includes(k), `unexpected spawn field ${k}`);
    assert.ok(path.isAbsolute(m.file) && m.file.startsWith(home), 'the file path is inside the home');
  }
  const { file, ...a } = metas.find((m) => m.id === CHILD_A);
  assert.ok(file.endsWith('.jsonl'));
  assert.deepEqual(a, {
    id: CHILD_A, timestamp: at('21:00:10'), cwd: '/work/synthetic-project', cliVersion: '0.160.0',
    spawn: { parentId: LEAD, depth: 1, nickname: 'Ada', role: 'worker', agentPath: '/root/obk7q2mz_i1' },
  });
  assert.equal(metas.find((m) => m.id === LEAD).spawn, null, 'the lead has no spawn link');
  assert.equal(metas.find((m) => m.id === GUARDIAN).spawn, null, 'a guardian review thread carries no thread_spawn link');
  const json = JSON.stringify(metas);
  assert.ok(!json.includes('CANARY'), 'no canary text in the scan');
  assert.ok(!json.includes('creator') && !json.includes('base_instructions') && !json.includes('commit_hash'),
    'the dropped fields are not kept under any name');
});

test('scanMeta skips files that are not rollouts, and links to files', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const clock = at('21:03:00');
  const [, second] = dayDirs(SINCE, clock);
  const folder = path.join(home, 'sessions', second);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'notes.jsonl'), `${metaLine(at('21:00:00'), 'x-notes')}\n`);
  fs.writeFileSync(path.join(folder, 'rollout-old.jsonl.zst'), 'compressed rollouts are never read\n');
  const aFile = path.join(home, 'sessions', dayFolderOf(at('21:00:10')), `rollout-2026-10-07T21-00-10-${CHILD_A}.jsonl`);
  const linked = path.join(folder, 'rollout-2026-10-07T21-00-10-link.jsonl');
  const linkMade = tryLink(aFile, linked, 'file');
  const ids = scanMeta(home, SINCE, clock).map((m) => m.id);
  assert.ok(!ids.includes('x-notes'), 'a file that is not a rollout is not read');
  assert.equal(ids.filter((id) => id === CHILD_A).length, 1, 'the real rollout is listed once');
  if (!linkMade) t.diagnostic('no file link on this machine: the link check is skipped');
});

test('scanMeta does not follow a folder that is a link', (t) => {
  const home = tmpHome(t);
  const clock = at('21:03:00');
  const [first, second] = dayDirs(SINCE, clock);
  const realId = '019e0a00-0050-7000-8000-000000000050';
  const controlId = '019e0a00-0051-7000-8000-000000000051';
  const elsewhere = path.join(home, 'elsewhere', 'day');
  writeInFolder(elsewhere, at('21:00:30'), [metaLine(at('21:00:30'), realId)], realId);
  writeInFolder(path.join(home, 'sessions', second), at('21:00:31'), [metaLine(at('21:00:31'), controlId)], controlId);
  const linkPath = path.join(home, 'sessions', first);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (!tryLink(elsewhere, linkPath, 'junction')) return t.skip('this machine cannot create folder links');
  const ids = scanMeta(home, SINCE, clock).map((m) => m.id);
  assert.ok(ids.includes(controlId), 'a real folder in the window is read');
  assert.ok(!ids.includes(realId), 'the folder link is not followed');
});

test('scanMeta reads a first line once: a second scan opens no rollout file', (t) => {
  const home = tmpHome(t);
  installRun(home);
  // A rollout whose first line is not session_meta is decided once as well: it is never followed and never read again.
  writeRollout(home, [lineAt(at('21:00:05'), 'event_msg', { type: 'task_started', turn_id: 'odd' })], 'odd-thread');
  const clock = at('21:03:00');
  const first = countRolloutOpens(() => scanMeta(home, SINCE, clock));
  const second = countRolloutOpens(() => scanMeta(home, SINCE, clock));
  assert.ok(first >= 7, `the first scan reads every first line (${first} opens)`);
  assert.equal(second, 0, 'the second scan reads no first line');
});

test('scanMeta decides a first line only when it is complete', (t) => {
  const home = tmpHome(t);
  const [firstLine] = fixtureLines('child-a.jsonl');
  const file = writeRollout(home, [firstLine], CHILD_A, { complete: false });
  fs.writeFileSync(file, firstLine.slice(0, 60));
  const clock = at('21:03:00');
  assert.deepEqual(scanMeta(home, SINCE, clock), [], 'a half-written first line is not decided');
  fs.writeFileSync(file, `${firstLine}\n`);
  assert.deepEqual(scanMeta(home, SINCE, clock).map((m) => m.id), [CHILD_A], 'once complete it is read');
  assert.equal(countRolloutOpens(() => scanMeta(home, SINCE, clock)), 0, 'the decided first line is not read again');
});

test('findByToken: the lead of the newest direct sub-agent with the token; prefix and time filters apply', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const clock = at('21:03:00');
  assert.equal(findByToken(home, TOKEN, SINCE, clock), LEAD);
  assert.equal(findByToken(home, 'obk7q2m', SINCE, clock), null, 'a shorter token is not a prefix match');
  assert.equal(findByToken(home, TOKEN, at('21:00:13'), clock), LEAD, 'the killed sub-agent started at 21:00:14');
  assert.equal(findByToken(home, TOKEN, at('21:00:15'), clock), null,
    'nothing starts at or after 21:00:15: the grandchild does not name its own parent');
  for (const bad of ['bad/token', 'x'.repeat(65), '', 42, null]) {
    assert.equal(findByToken(home, bad, SINCE, clock), null, `refused: ${String(bad).slice(0, 12)}`);
  }
  assert.equal(findByToken(home, TOKEN, Number.NaN, clock), null);
});

test('findByToken: a sub-agent whose parent is a sub-agent never names a run', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const token = 'obonly01';
  writeRollout(home, [metaLine(at('21:00:50'), 'grand-only', { parent: CHILD_A, depth: 2, agentPath: `/root/${token}_x` })], 'grand-only');
  assert.equal(findByToken(home, token, SINCE, at('21:03:00')), null);
});

test('findByToken: when two leads used the same token, the newer direct sub-agent decides', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const lead2 = '019e0a00-0010-7000-8000-000000000010';
  writeRollout(home, [metaLine(at('21:00:30'), 'second-child', { parent: lead2, depth: 1, agentPath: `/root/${TOKEN}_i1` })], 'second-child');
  assert.equal(findByToken(home, TOKEN, SINCE, at('21:03:00')), lead2);
});

test('the follower links sub-agents through thread_spawn only, skips the guardian, and reports depth and labels', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  const agents = f.agents();
  assert.deepEqual(agents.map((x) => x.id).sort(), [CHILD_A, CHILD_B, KILLED, GRAND].sort(), 'no lead, no guardian');
  const a = byId(agents, CHILD_A);
  assert.equal(a.parentId, LEAD);
  assert.equal(a.depth, 1);
  assert.equal(a.label, 'obk7q2mz_i1');
  assert.equal(a.itemId, 'I1');
  assert.equal(a.role, 'worker');
  assert.equal(a.nickname, 'Ada');
  assert.equal(a.model, 'gpt-6-luna');
  const g = byId(agents, GRAND);
  assert.equal(g.parentId, CHILD_A, 'the grandchild hangs under its own parent');
  assert.equal(g.depth, 2);
  assert.equal(g.itemId, null, 'a label with no item mapping has no item id');
  assert.equal(f.run().agentCount, 4);
});

test('statuses: a finished child, a killed child, and a child that runs again after followup_task', (t) => {
  const home = tmpHome(t);
  const files = installRun(home);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  assert.equal(byId(f.agents(), CHILD_A).status, 'done');
  assert.equal(byId(f.agents(), CHILD_B).status, 'done');
  assert.equal(byId(f.agents(), GRAND).status, 'done');
  assert.equal(byId(f.agents(), KILLED).status, 'running', 'no task_complete yet, and its last line is recent');

  appendLines(files.b, fixtureLines('child-b-followup.jsonl'));
  clock.t = at('21:06:00');
  f.poll();
  assert.equal(byId(f.agents(), CHILD_B).status, 'running', 'a new task_started reopens the turn');
  assert.equal(byId(f.agents(), CHILD_B).endedAt, null);

  appendLines(files.b, [turnDone(at('21:06:30'), 'turn-b-2')]);
  clock.t = at('21:07:00');
  f.poll();
  assert.equal(byId(f.agents(), CHILD_B).status, 'done');
  assert.equal(byId(f.agents(), CHILD_B).endedAt, at('21:06:30'));

  f.stop();
  assert.equal(byId(f.agents(), KILLED).status, 'stopped', 'stop() ends the turn that never completed');
  assert.equal(byId(f.agents(), CHILD_A).status, 'done', 'a finished turn stays finished');
});

test('a turn with no line for more than 15 minutes reads as stopped, and still runs at exactly 15 minutes', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const clock = { t: at('21:00:40') + SILENCE_MS };
  const f = follow(home, clock);
  f.poll();
  assert.equal(byId(f.agents(), KILLED).status, 'running', 'exactly 15 minutes after its last line');
  clock.t += 1;
  f.poll();
  assert.equal(byId(f.agents(), KILLED).status, 'stopped', 'one millisecond later');
  assert.equal(byId(f.agents(), KILLED).endedAt, at('21:00:40'), 'the end is the last line it wrote');
});

test('tokens: input minus cached plus output of the newest total; cached is reported beside it', (t) => {
  const home = tmpHome(t);
  const files = installRun(home);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  const pick = (id) => [byId(f.agents(), id).tokens, byId(f.agents(), id).cached];
  assert.deepEqual(pick(CHILD_A), [650, 400], '1000 - 400 + 50');
  assert.deepEqual(pick(CHILD_B), [320, 0], '300 - 0 + 20');
  assert.deepEqual(pick(KILLED), [160, 50], '200 - 50 + 10');
  assert.deepEqual(pick(GRAND), [null, null], 'no token_count yet: unknown, not zero');
  assert.equal(f.run().tokens, 1570, 'the lead (500 - 100 + 40) and the three counted sub-agents; the guardian is not counted');

  appendLines(files.b, fixtureLines('child-b-followup.jsonl'));
  clock.t = at('21:06:00');
  f.poll();
  assert.deepEqual(pick(CHILD_B), [560, 300], 'the newest total replaces the older one: 800 - 300 + 60');
});

test('sandbox: the type of the newest turn_context; a value outside the enum keeps the last known one', (t) => {
  const home = tmpHome(t);
  const files = installRun(home);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  assert.equal(byId(f.agents(), CHILD_A).sandbox, 'read-only');
  assert.equal(byId(f.agents(), CHILD_B).sandbox, 'workspace-write');
  appendLines(files.b, [policy(at('21:04:00'), 'danger-full-access')]);
  clock.t = at('21:05:00');
  f.poll();
  assert.equal(byId(f.agents(), CHILD_B).sandbox, 'danger-full-access');
  appendLines(files.b, [policy(at('21:04:30'), 'Read Only!')]);
  clock.t = at('21:05:10');
  f.poll();
  assert.equal(byId(f.agents(), CHILD_B).sandbox, 'danger-full-access', 'a value outside the enum is not kept');
});

test('the lead completes the run only when no sub-agent runs', (t) => {
  const home = tmpHome(t);
  const files = installRun(home);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  appendLines(files.lead, fixtureLines('lead-finish.jsonl'));
  f.poll();
  assert.equal(f.run().leadStatus, 'done');
  assert.equal(f.run().status, 'running', 'the killed sub-agent still reads as running');
  clock.t = at('21:16:00');
  f.poll();
  assert.equal(byId(f.agents(), KILLED).status, 'stopped');
  const run = f.run();
  assert.equal(run.status, 'done');
  assert.equal(run.endedAt, at('21:02:10'));
  assert.deepEqual([run.agentCount, run.done, run.running, run.stopped], [4, 3, 0, 1]);
  assert.equal(run.tokens, 1950, 'the lead now counts 900 - 150 + 70 = 820');
  assert.equal(run.id, LEAD);
});

test('a run with nothing in its folders is waiting; without its lead, a finished run reads unknown', (t) => {
  const clock = { t: at('21:03:00') };
  const empty = follow(tmpHome(t), clock);
  empty.poll();
  assert.equal(empty.run().status, 'waiting');
  assert.deepEqual(empty.agents(), []);
  assert.equal(empty.lastActivity(), null);

  const home = tmpHome(t);
  writeRollout(home, fixtureLines('child-a.jsonl'), CHILD_A);
  writeRollout(home, fixtureLines('child-killed.jsonl'), KILLED);
  const f = follow(home, clock);
  f.poll();
  assert.equal(f.run().leadStatus, null);
  assert.equal(f.run().status, 'running', 'a sub-agent runs even though its lead file is not here');
  f.stop();
  assert.equal(f.run().status, 'unknown', 'no lead, and nothing running');
});

test('a run that starts before midnight and continues after it is followed across two day folders', (t) => {
  const home = tmpHome(t);
  const midnight = local(2026, 10, 8, 0, 0, 0);
  const leadId = '019e0a00-0020-7000-8000-000000000020';
  const subId = '019e0a00-0021-7000-8000-000000000021';
  const leadFile = writeRollout(home, [metaLine(midnight - 5 * MIN, leadId), turnStart(midnight - 4 * MIN, 'lead-1')], leadId);
  const subFile = writeRollout(home, [
    metaLine(midnight + 3 * MIN, subId, { parent: leadId, depth: 1, agentPath: `/root/${TOKEN}_m1`, role: 'worker', nickname: 'Night' }),
    turnStart(midnight + 3 * MIN + SEC, 'sub-1'),
  ], subId);
  assert.notEqual(path.dirname(leadFile), path.dirname(subFile), 'the lead and the sub-agent are in different day folders');
  const clock = { t: midnight + 4 * MIN };
  const f = createRolloutFollower({
    home, parentThreadId: leadId, sinceMs: midnight - 10 * MIN, token: TOKEN, itemMap: ITEMS, intervalMs: 0, now: () => clock.t,
  });
  f.poll();
  assert.equal(f.run().status, 'running');
  assert.equal(f.run().agentCount, 1);
  assert.equal(byId(f.agents(), subId).label, 'obk7q2mz_m1');
  appendLines(subFile, [turnDone(midnight + 8 * MIN, 'sub-1')]);
  appendLines(leadFile, [turnDone(midnight + 9 * MIN, 'lead-1')]);
  clock.t = midnight + 10 * MIN;
  f.poll();
  assert.equal(byId(f.agents(), subId).status, 'done');
  assert.equal(f.run().status, 'done');
});

test('a partial last line waits for its newline before it counts', (t) => {
  const home = tmpHome(t);
  const files = installRun(home);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  const [tokenLine, doneLine] = fixtureLines('lead-finish.jsonl');
  appendLines(files.lead, [tokenLine]);
  fs.appendFileSync(files.lead, doneLine.slice(0, 40));
  f.poll();
  assert.equal(f.run().leadStatus, 'running', 'the task_complete line is still half written');
  fs.appendFileSync(files.lead, `${doneLine.slice(40)}\n`);
  f.poll();
  assert.equal(f.run().leadStatus, 'done');
});

test('a rollout that shrank is read again from its start, and nothing derived from the old lines survives', (t) => {
  const home = tmpHome(t);
  const files = installRun(home);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  appendLines(files.lead, fixtureLines('lead-finish.jsonl'));
  f.poll();
  assert.equal(f.run().leadStatus, 'done');
  const head = fixtureLines('lead.jsonl').slice(0, 4);
  fs.writeFileSync(files.lead, `${head.join('\n')}\n`);
  f.poll();
  assert.equal(f.run().leadStatus, 'running', 'the rewritten lead has an open turn and no completion');
  assert.equal(f.run().tokens, 1130, 'the lead has no usage left (its 440 went with the old lines); 650 + 320 + 160 remain');
});

test('the canary: no output of the follower or of the scan carries a field the follower must drop', (t) => {
  const home = tmpHome(t);
  const files = installRun(home);
  const clock = { t: at('21:03:00') };
  const seen = [];
  const f = follow(home, clock, { onAgents: (list, changed, run) => seen.push({ list, changed, run }) });
  f.poll();
  appendLines(files.lead, fixtureLines('lead-finish.jsonl'));
  appendLines(files.b, fixtureLines('child-b-followup.jsonl'));
  clock.t = at('21:06:00');
  f.poll();
  const outputs = [f.agents(), f.run(), seen, scanMeta(home, SINCE, clock.t), findByToken(home, TOKEN, SINCE, clock.t)];
  for (const out of outputs) {
    const json = JSON.stringify(out);
    assert.ok(!json.includes('CANARY'), `canary found in ${json.slice(0, 80)}`);
  }
  assert.ok(JSON.stringify(f.agents()).includes('obk7q2mz_i1'), 'the labels are there, so the check is not vacuous');
});

test('onAgents: the full list and the changed agents; no call on a poll that changed nothing', (t) => {
  const home = tmpHome(t);
  const files = installRun(home);
  const clock = { t: at('21:03:00') };
  const calls = [];
  const f = follow(home, clock, {
    onAgents: (list, changed, run) => calls.push({ count: list.length, changed: changed.map((x) => x.id).sort(), status: run.status }),
  });
  f.poll();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].count, 4);
  assert.deepEqual(calls[0].changed, [CHILD_A, CHILD_B, KILLED, GRAND].sort());
  assert.equal(calls[0].status, 'running');
  f.poll();
  assert.equal(calls.length, 1, 'nothing changed');
  appendLines(files.b, fixtureLines('child-b-followup.jsonl'));
  clock.t = at('21:06:00');
  f.poll();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].changed, [CHILD_B], 'only the agent that changed');
});

test('the timer polls on its own; stop() clears it, freezes the state, and makes later polls do nothing', async (t) => {
  const home = tmpHome(t);
  const files = installRun(home);
  const clock = { t: at('21:03:00') };
  let calls = 0;
  const f = createRolloutFollower({
    home, parentThreadId: LEAD, sinceMs: SINCE, token: TOKEN, itemMap: ITEMS, intervalMs: 5, now: () => clock.t, onAgents: () => { calls += 1; },
  });
  for (let i = 0; i < 300 && calls === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls > 0, 'the timer ran a poll');
  f.stop();
  const before = calls;
  appendLines(files.b, fixtureLines('child-b-followup.jsonl'));
  f.poll();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, before, 'no call after stop()');
  assert.equal(byId(f.agents(), KILLED).status, 'stopped');
  assert.equal(byId(f.agents(), CHILD_B).status, 'done', 'the followup was never read after stop()');
});

test('a line over the tail cap counts as activity, and the turn that ends with such a line still completes', (t) => {
  const home = tmpHome(t);
  const bigId = '019e0a00-0030-7000-8000-000000000030';
  const big = 'x'.repeat(4 * 1024 * 1024 + 4096);
  writeRollout(home, [
    metaLine(at('21:00:30'), bigId, { parent: LEAD, depth: 1, agentPath: `/root/${TOKEN}_big` }),
    turnStart(at('21:00:31'), 'big-1'),
    lineAt(at('21:00:45'), 'response_item', { type: 'message', content: `CANARY_big ${big}` }),
    turnDone(at('21:00:50'), 'big-1'),
  ], bigId);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  for (let i = 0; i < 30 && byId(f.agents(), bigId)?.status !== 'done'; i++) f.poll();
  assert.equal(byId(f.agents(), bigId).status, 'done');
  assert.ok(!JSON.stringify(f.agents()).includes('CANARY'));
});

test('a rollout still being read is not called stopped by silence; once read to its end, the open turn is', (t) => {
  const home = tmpHome(t);
  const longId = '019e0a00-0031-7000-8000-000000000031';
  const filler = Array.from({ length: 2500 }, () => lineAt(at('21:00:32'), 'response_item', { type: 'message', content: 'x'.repeat(1000) }));
  writeRollout(home, [
    metaLine(at('21:00:30'), longId, { parent: LEAD, depth: 1, agentPath: `/root/${TOKEN}_long` }),
    turnStart(at('21:00:31'), 'long-1'),
    ...filler,
  ], longId);
  const clock = { t: at('21:30:00') };
  const f = follow(home, clock);
  f.poll();
  assert.equal(byId(f.agents(), longId).status, 'running', 'one megabyte read; the rest of the file is still unread');
  for (let i = 0; i < 10; i++) f.poll(); // about 2.6 MB in all: three chunks
  assert.equal(byId(f.agents(), longId).status, 'stopped', 'read to the end, 29 minutes of silence: the turn is stopped');
  assert.equal(byId(f.agents(), longId).lastActivityAt, at('21:00:32'));
});

test('agents() keeps the newest sub-agents up to AGENTS_MAX, and run() counts them all', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const extra = AGENTS_MAX + 5;
  for (let i = 0; i < extra; i++) {
    const id = `sub-${String(i).padStart(4, '0')}`;
    writeRollout(home, [metaLine(at('21:00:30') + i * SEC, id, { parent: LEAD, depth: 1, agentPath: `/root/${TOKEN}_c${i}` })], id);
  }
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  const agents = f.agents();
  const starts = [at('21:00:10'), at('21:00:12'), at('21:00:14'), at('21:00:40'),
    ...Array.from({ length: extra }, (_, i) => at('21:00:30') + i * SEC)].sort((x, y) => x - y);
  assert.equal(agents.length, AGENTS_MAX);
  assert.equal(agents[0].startedAt, starts[starts.length - AGENTS_MAX], 'the oldest ones are left out, not the first created');
  assert.equal(agents.at(-1).startedAt, at('21:00:30') + (extra - 1) * SEC, 'the newest sub-agent is kept');
  assert.equal(f.run().agentCount, extra + 4, 'the run counts every sub-agent, the four from the fixtures included');
});

test('lastActivity: the newest line of any followed thread, and null before anything is read', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  assert.equal(f.lastActivity(), null);
  f.poll();
  assert.equal(f.lastActivity(), at('21:01:45'), 'child B wrote its last line at 21:01:45');
});

test('itemMap takes a Map or a plain object, and matches keys the way task names are written', (t) => {
  const home = tmpHome(t);
  installRun(home);
  const clock = { t: at('21:03:00') };
  const asMap = follow(home, clock, { itemMap: new Map([['I1', 'Item-One']]) });
  asMap.poll();
  assert.equal(byId(asMap.agents(), CHILD_A).itemId, 'Item-One');
  const asObject = follow(home, clock, { itemMap: { I2: 'Item-Two' } });
  asObject.poll();
  assert.equal(byId(asObject.agents(), CHILD_B).itemId, 'Item-Two');
  const none = follow(home, clock, { itemMap: null, token: null });
  none.poll();
  assert.equal(byId(none.agents(), CHILD_A).itemId, null);
  assert.equal(byId(none.agents(), CHILD_A).label, 'obk7q2mz_i1', 'the label is still the agent path without /root/');
});

test('the constructor refuses what it cannot follow, and nothing runs until poll() is called', async (t) => {
  const home = tmpHome(t);
  installRun(home);
  const base = { home, parentThreadId: LEAD, sinceMs: SINCE, intervalMs: 0 };
  assert.throws(() => createRolloutFollower({ ...base, parentThreadId: '../etc' }), TypeError);
  assert.throws(() => createRolloutFollower({ ...base, parentThreadId: undefined }), TypeError);
  assert.throws(() => createRolloutFollower({ ...base, home: '' }), TypeError);
  assert.throws(() => createRolloutFollower({ ...base, sinceMs: Number.NaN }), TypeError);
  assert.throws(() => createRolloutFollower({ ...base, intervalMs: -1 }), RangeError);
  assert.throws(() => createRolloutFollower({ ...base, intervalMs: 'soon' }), RangeError);
  let calls = 0;
  const f = createRolloutFollower({ ...base, now: () => at('21:03:00'), onAgents: () => { calls += 1; } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0, 'no timer with intervalMs 0');
  f.stop();
});

test('a closed turn is not final while its rollout is still being read: a lead over 1 MB with an earlier task_complete', (t) => {
  const home = tmpHome(t);
  const leadFile = writeRollout(home, [
    metaLine(at('21:00:00'), LEAD),
    turnStart(at('21:00:01'), 'lead-1'),
    turnDone(at('21:00:05'), 'lead-1'),
    ...padding(2400, at('21:00:06')),
    turnStart(at('21:00:30'), 'lead-2'),
  ], LEAD);
  writeRollout(home, fixtureLines('child-a.jsonl'), CHILD_A);
  assert.ok(fs.statSync(leadFile).size > 1 << 20, 'the lead is over one megabyte');
  const clock = { t: at('21:00:40') };
  const seen = [];
  const f = follow(home, clock, { onAgents: (list, changed, run) => seen.push(run.status) });
  f.poll();
  assert.equal(f.run().leadStatus, 'running', 'one megabyte read: the earlier task_complete is not final yet');
  assert.equal(f.run().status, 'running', 'the finished child does not make the run done');
  for (let i = 0; i < 5; i++) f.poll();
  assert.equal(f.run().status, 'running', 'read to the end: turn 2 is open');
  assert.ok(!seen.includes('done'), `onAgents never saw done, saw ${seen.join(',')}`);
  appendLines(leadFile, [turnDone(at('21:00:50'), 'lead-2')]);
  clock.t = at('21:01:00');
  f.poll();
  assert.equal(f.run().status, 'done', 'turn 2 completed: the run is done');
});

test('a sub-agent whose rollout is still being read does not read done after an earlier closed turn', (t) => {
  const home = tmpHome(t);
  const subId = '019e0a00-0040-7000-8000-000000000040';
  writeRollout(home, [
    metaLine(at('21:00:30'), subId, { parent: LEAD, depth: 1, agentPath: `/root/${TOKEN}_big` }),
    turnStart(at('21:00:31'), 'sub-1'),
    turnDone(at('21:00:35'), 'sub-1'),
    ...padding(2400, at('21:00:36')),
    turnStart(at('21:00:50'), 'sub-2'),
  ], subId);
  const clock = { t: at('21:01:00') };
  const f = follow(home, clock);
  f.poll();
  assert.equal(byId(f.agents(), subId).status, 'running', 'one megabyte read: the first turn is not final');
  for (let i = 0; i < 5; i++) f.poll();
  assert.equal(byId(f.agents(), subId).status, 'running', 'read to the end: turn 2 is open');
});

test('stop() during catch-up reads the run as stopped, never as done', (t) => {
  const home = tmpHome(t);
  writeRollout(home, [
    metaLine(at('21:00:00'), LEAD),
    turnStart(at('21:00:01'), 'lead-1'),
    turnDone(at('21:00:05'), 'lead-1'),
    ...padding(2400, at('21:00:06')),
    turnStart(at('21:00:30'), 'lead-2'),
  ], LEAD);
  writeRollout(home, fixtureLines('child-a.jsonl'), CHILD_A);
  const clock = { t: at('21:00:40') };
  const f = follow(home, clock);
  f.poll();
  f.stop();
  assert.equal(f.run().leadStatus, 'stopped', 'the lead was not read to its end');
  assert.equal(f.run().status, 'stopped');
  assert.equal(byId(f.agents(), CHILD_A).status, 'done', 'a child read to its end keeps its outcome');
});

test('a resumed lead whose rollout was created days before sinceMs is found by its id; only its turns in the window count', (t) => {
  const home = tmpHome(t);
  const created = at('21:00:00') - 3 * DAY;
  const leadFile = writeRollout(home, [
    metaLine(created, LEAD),
    turnStart(created + MIN, 'lead-old'),
    usageLine(created + 2 * MIN, 300, 50, 20),
    turnDone(created + 3 * MIN, 'lead-old'),
  ], LEAD);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  assert.equal(f.run().leadStatus, 'waiting', 'found in its older folder; its only completed turn is before the window');
  assert.equal(f.run().status, 'waiting', 'nothing in the window yet: not done');
  assert.equal(f.run().tokens, 0, 'no usage in the window yet');

  appendLines(leadFile, [turnStart(at('21:00:01'), 'lead-1'), usageLine(at('21:00:20'), 500, 100, 40)]);
  writeRollout(home, fixtureLines('child-a.jsonl'), CHILD_A);
  clock.t = at('21:01:00');
  f.poll();
  assert.equal(f.run().leadStatus, 'running');
  assert.equal(f.run().status, 'running');
  assert.equal(f.run().tokens, (440 - 270) + 650, 'the lead counts 440 - 270 since the window, the child 650');

  appendLines(leadFile, [turnDone(at('21:02:10'), 'lead-1')]);
  clock.t = at('21:03:00');
  f.poll();
  const run = f.run();
  assert.equal(run.status, 'done', 'the lead completed in the window and the child is finished');
  assert.equal(run.id, LEAD);
  assert.equal(run.startedAt, at('21:00:01'), 'a resumed session starts with its first turn in the window');
  assert.equal(run.endedAt, at('21:02:10'));
  assert.equal(run.agentCount, 1);
  assert.equal(run.tokens, (440 - 270) + 650);
});

test('a lead turn that was open when the window began reads as running, and its close in the window ends the run', (t) => {
  const home = tmpHome(t);
  const leadFile = writeRollout(home, [
    metaLine(at('20:50:00'), LEAD),
    turnStart(at('20:51:00'), 'open-1'),
    usageLine(at('20:52:00'), 300, 0, 20),
  ], LEAD);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  assert.equal(f.run().leadStatus, 'running', 'open before the window and 11 minutes after its last line: still running');
  appendLines(leadFile, [turnDone(at('21:04:00'), 'open-1')]);
  clock.t = at('21:05:00');
  f.poll();
  assert.equal(f.run().status, 'done');
  assert.equal(f.run().endedAt, at('21:04:00'));
});

test('a lead whose only completed turn is before sinceMs does not make the run done; it reads as waiting until a turn starts', (t) => {
  const home = tmpHome(t);
  const leadFile = writeRollout(home, [
    metaLine(at('20:50:00'), LEAD),
    turnStart(at('20:50:01'), 'old-1'),
    usageLine(at('20:50:20'), 900, 150, 70),
    turnDone(at('20:51:00'), 'old-1'),
  ], LEAD);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  assert.equal(f.run().status, 'waiting', 'a finished turn from before the window is not this run');
  assert.equal(f.run().endedAt, null);
  appendLines(leadFile, [turnStart(at('21:03:30'), 'new-1')]);
  clock.t = at('21:04:00');
  f.poll();
  assert.equal(f.run().status, 'running', 'the turn that starts in the window runs');
  appendLines(leadFile, [turnDone(at('21:04:30'), 'new-1')]);
  clock.t = at('21:05:00');
  f.poll();
  assert.equal(f.run().status, 'done');
});

test('a lead folder older than the newest DAYS_MAX folders is not looked up', (t) => {
  const home = tmpHome(t);
  const created = at('21:00:00') - (DAYS_MAX + 1) * DAY;
  writeRollout(home, [metaLine(created, LEAD)], LEAD);
  writeRollout(home, fixtureLines('child-a.jsonl'), CHILD_A);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  assert.equal(f.run().leadStatus, null, 'outside the folders the follower looks in');
  assert.equal(f.run().status, 'unknown', 'a finished sub-agent without its lead reads unknown');
});

test('a lead that is not on disk yet is looked up again after LEAD_RETRY_MS, not on every poll', (t) => {
  const home = tmpHome(t);
  const clock = { t: at('21:03:00') };
  const f = follow(home, clock);
  f.poll();
  assert.equal(f.run().leadStatus, null);
  writeRollout(home, [metaLine(at('21:00:00') - 3 * DAY, LEAD), turnStart(at('21:00:01'), 'lead-1')], LEAD);
  clock.t += 5 * SEC;
  f.poll();
  assert.equal(f.run().leadStatus, null, 'inside the retry period the older folders are not searched again');
  clock.t += LEAD_RETRY_MS;
  f.poll();
  assert.equal(f.run().leadStatus, 'running', 'after the retry period the lead is found');
});
