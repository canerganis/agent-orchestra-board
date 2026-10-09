// Claude runs watcher (F4, src/watch/claude-runs.js). A temporary Claude home with synthetic sessions and runs, an
// injected clock and injected timers. The fixture run in test/fixtures/claude-wf carries canary strings in every text
// field that must never leave the watcher except through preview().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClaudeRuns, RUNS_MAX } = require('../src/watch/claude-runs');
const { encodeProjectDir } = require('../src/watch/claude-journal');

const FIX = path.join(__dirname, 'fixtures', 'claude-wf');
const FIX_RUN = 'wf_0a1b2c3d-e4f';
const FIX_END = Date.parse('2026-10-08T10:03:00.000Z');
const LIVE_RUN = 'wf_11112222-333';
const OTHER_RUN = 'wf_44445555-666';
const A1 = 'a1111111111111111';
const A2 = 'a2222222222222222';

// ---- helpers ------------------------------------------------------------------------------------------------------

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-runs-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'claude');
  const projects = path.join(home, 'projects');
  const project = path.join(base, 'work', 'orchestra-board');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { base, home, projects, project };
}

// Timers that run only when advance() moves the clock.
function fakeTimers(start) {
  const clock = { t: start };
  const timers = new Map();
  let seq = 0;
  return {
    clock,
    timers,
    now: () => clock.t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock.t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        clock.t = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      clock.t = end;
    },
  };
}

function watcher(t, env, opts = {}) {
  const ft = fakeTimers(opts.start || Date.now());
  const sent = [];
  const w = createClaudeRuns({
    project: env.project, home: env.home, userHome: env.base, scope: opts.scope,
    broadcast: (m) => sent.push(JSON.parse(JSON.stringify(m))),
    now: ft.now, setTimer: ft.setTimer, clearTimer: ft.clearTimer,
  });
  t.after(() => w.stop());
  return { w, ft, sent };
}

const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

// A session in <projects>/<folder> whose main transcript names cwd after a line without one.
function session(env, { cwd, folder, transcript } = {}) {
  const name = folder || encodeProjectDir(cwd);
  const fdir = path.join(env.projects, name);
  const sid = crypto.randomUUID();
  fs.mkdirSync(path.join(fdir, sid), { recursive: true });
  const body = transcript !== undefined ? transcript
    : jsonl([{ type: 'file-history-snapshot' }, { type: 'user', cwd, sessionId: sid, message: { role: 'user', content: 'hi' } }]);
  fs.writeFileSync(path.join(fdir, sid + '.jsonl'), body);
  return { folder: fdir, sid, dir: path.join(fdir, sid) };
}

// The fixture run, every file dated at the summary's end so it reads as completed.
function fixtureRun(sess, runId = FIX_RUN, summary = null) {
  const dir = path.join(sess.dir, 'subagents', 'workflows', runId);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(FIX)) {
    if (f === 'summary.json') continue;
    fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
    fs.utimesSync(path.join(dir, f), FIX_END / 1000, FIX_END / 1000);
  }
  const sumDir = path.join(sess.dir, 'workflows');
  fs.mkdirSync(sumDir, { recursive: true });
  const sumFile = path.join(sumDir, runId + '.json');
  const json = summary || JSON.parse(fs.readFileSync(path.join(FIX, 'summary.json'), 'utf8'));
  fs.writeFileSync(sumFile, JSON.stringify({ ...json, runId }));
  fs.utimesSync(sumFile, FIX_END / 1000, FIX_END / 1000);
  return dir;
}

const started = (agentId, label, phase = 'Build') => ({ type: 'started', key: label, agentId, label, phase });
const assistant = (ts, id, n) => ({
  type: 'assistant', timestamp: new Date(ts).toISOString(),
  message: { id, role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'tu_' + id, name: 'Read', input: {} }],
    usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 1 } },
});

// A live run without a summary: two agents with meta files and one transcript line each, dated now.
function liveRun(sess, runId, now, labels = ['build:I1', 'build:I2']) {
  const dir = path.join(sess.dir, 'subagents', 'workflows', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), jsonl([{ type: 'launched' }, started(A1, labels[0]), started(A2, labels[1])]));
  [A1, A2].forEach((id, i) => {
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ description: 'd', workflowPhase: 'Build', model: 'haiku' }));
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), jsonl([
      { type: 'user', timestamp: new Date(now).toISOString(), message: { role: 'user', content: 'CANARY_LIVE_PROMPT_' + i } },
      assistant(now, 'msg_' + id, 100 + i),
    ]));
  });
  return dir;
}

const ids = (runs) => runs.map((r) => r.id).sort();
const noCanary = (v, what) => assert.ok(!JSON.stringify(v).includes('CANARY'), `${what} holds no canary`);

// ---- tests --------------------------------------------------------------------------------------------------------

test('discovery: a project session with a finished run is listed, with its agents, and nothing private leaks', (t) => {
  const env = setup(t);
  const sess = session(env, { cwd: env.project });
  fixtureRun(sess);
  const { w, sent } = watcher(t, env);
  assert.equal(w.available(), true);
  assert.deepEqual(w.list(), [], 'nothing is read before a lease');
  assert.equal(w.lease('list'), true);
  const runs = w.list();
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.id, FIX_RUN);
  assert.equal(r.engine, 'claude-code');
  assert.equal(r.title, 'build-v02');
  assert.equal(r.status, 'completed');
  assert.equal(r.sessionId, sess.sid);
  assert.equal(r.project, env.project);
  assert.equal(r.tokens, 123456);
  const wfRuns = sent.filter((m) => m.t === 'wfRuns');
  assert.equal(wfRuns.length, 1);
  assert.deepEqual(ids(wfRuns[0].runs), [FIX_RUN]);
  const detail = w.get(FIX_RUN);
  assert.equal(detail.agents.length, 7);
  assert.equal(detail.agents.filter((a) => a.status === 'done').length, 5);
  assert.equal(detail.agents.filter((a) => a.status === 'retried').length, 1);
  assert.equal(detail.agents.filter((a) => a.status === 'failed').length, 1);
  noCanary(sent, 'broadcasts');
  noCanary(w.list(), 'list()');
  noCanary(w.get(FIX_RUN), 'get()');
});

test('discovery: a second run in an existing session is found by the next discovery pass', (t) => {
  const env = setup(t);
  const sess = session(env, { cwd: env.project });
  fixtureRun(sess);
  const { w, ft, sent } = watcher(t, env);
  w.lease('list');
  assert.deepEqual(ids(w.list()), [FIX_RUN]);
  liveRun(sess, LIVE_RUN, ft.clock.t);
  ft.advance(5000);
  assert.deepEqual(ids(w.list()), [FIX_RUN], 'not before the discovery interval');
  ft.advance(11000);
  assert.deepEqual(ids(w.list()), [FIX_RUN, LIVE_RUN].sort());
  const live = w.list().find((r) => r.id === LIVE_RUN);
  assert.equal(live.status, 'running');
  assert.deepEqual(ids(sent.filter((m) => m.t === 'wfRuns').pop().runs), [FIX_RUN, LIVE_RUN].sort());
});

test('membership: a worktree child folder counts by cwd; a sibling project passing the name prefix does not', (t) => {
  const env = setup(t);
  const wt = path.join(env.project, '.claude', 'worktrees', 'integration');
  fs.mkdirSync(wt, { recursive: true });
  const child = session(env, { cwd: wt, folder: encodeProjectDir(env.project) + '--claude-worktrees-integration' });
  liveRun(child, LIVE_RUN, Date.now());
  const sibling = path.join(env.base, 'work', 'orchestra-board-old');
  fs.mkdirSync(sibling, { recursive: true });
  assert.ok(encodeProjectDir(sibling).startsWith(encodeProjectDir(env.project) + '-'), 'the sibling passes the name prefilter');
  fixtureRun(session(env, { cwd: sibling }), OTHER_RUN);
  const { w } = watcher(t, env);
  w.lease('list');
  assert.deepEqual(ids(w.list()), [LIVE_RUN]);
  assert.equal(w.get(OTHER_RUN), null, 'a run outside the project is not reachable by id');
});

test('membership: an ancestor session counts by cwd; without a cwd in 256 KB only the project folder name counts', (t) => {
  const env = setup(t);
  const filler = jsonl(Array.from({ length: 300 }, () => ({ type: 'progress', pad: 'x'.repeat(1000) })));
  const late = jsonl([{ type: 'user', cwd: path.join(env.base, 'elsewhere') }]);
  // Exact project folder, cwd only after the 256 KB window (and pointing elsewhere): the name decides, so it counts.
  const named = session(env, { folder: encodeProjectDir(env.project), transcript: filler + late });
  fixtureRun(named, FIX_RUN);
  // Ancestor folder with a real ancestor cwd: counts.
  const parent = path.join(env.base, 'work');
  liveRun(session(env, { cwd: parent }), LIVE_RUN, Date.now());
  // Ancestor folder with no cwd at all: the name fallback never takes ancestors.
  fixtureRun(session(env, { folder: encodeProjectDir(parent), transcript: filler }), OTHER_RUN);
  const { w } = watcher(t, env);
  w.lease('list');
  assert.deepEqual(ids(w.list()), [FIX_RUN, LIVE_RUN].sort());
});

test('scope: all takes sessions of every project; switching back to project drops them', (t) => {
  const env = setup(t);
  fixtureRun(session(env, { cwd: env.project }));
  const other = path.join(env.base, 'other');
  fs.mkdirSync(other);
  liveRun(session(env, { cwd: other }), LIVE_RUN, Date.now());
  let scope = 'project';
  const { w, ft } = watcher(t, env, { scope: () => scope });
  w.lease('list');
  assert.deepEqual(ids(w.list()), [FIX_RUN]);
  scope = 'all';
  ft.advance(1000);
  assert.deepEqual(ids(w.list()), [FIX_RUN, LIVE_RUN].sort());
  scope = 'project';
  ft.advance(1000);
  assert.deepEqual(ids(w.list()), [FIX_RUN]);
});

test('wfRun: appending journal lines sends one event with only the changed agents; follow gets every agent first', (t) => {
  const env = setup(t);
  const sess = session(env, { cwd: env.project });
  const now = Date.now();
  const dir = liveRun(sess, LIVE_RUN, now);
  const { w, ft, sent } = watcher(t, env, { start: now });
  const followed = [];
  const unfollow = w.follow(LIVE_RUN, (p) => followed.push(p));
  assert.equal(followed.length, 1);
  assert.deepEqual(followed[0].agents.map((a) => a.id).sort(), [A1, A2]);
  assert.equal(followed[0].run.status, 'running');
  assert.equal(w.lease(LIVE_RUN), true);
  ft.advance(4000);
  sent.length = 0;
  followed.length = 0;
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), jsonl([{ type: 'result', key: 'build:I1', agentId: A1, result: 'CANARY_RESULT_X' }]));
  ft.advance(2000);
  let events = sent.filter((m) => m.t === 'wfRun');
  assert.equal(events.length, 1);
  assert.equal(events[0].run.id, LIVE_RUN);
  assert.deepEqual(events[0].agents.map((a) => [a.id, a.status]), [[A1, 'done']]);
  assert.equal(followed.length, 1);
  assert.deepEqual(followed[0].agents.map((a) => a.id), [A1]);
  ft.advance(6000);
  events = sent.filter((m) => m.t === 'wfRun');
  assert.equal(events.length, 1, 'no event without a change');
  assert.equal(sent.filter((m) => m.t === 'wfRuns').length, 0, 'no list event without a list lease');
  noCanary(sent, 'broadcasts');
  noCanary(followed, 'follow payloads');
  unfollow();
  unfollow();
});

test('follow: a summary written after the run was found is read without a list lease, and the run completes', (t) => {
  const env = setup(t);
  const sess = session(env, { cwd: env.project });
  const now = Date.now();
  const dir = liveRun(sess, LIVE_RUN, now);
  const { w, ft, sent } = watcher(t, env, { start: now });
  const followed = [];
  w.follow(LIVE_RUN, (p) => followed.push(p));
  assert.equal(followed[0].run.status, 'running');
  ft.advance(60000);
  const end = ft.clock.t;
  const journal = path.join(dir, 'journal.jsonl');
  fs.appendFileSync(journal, jsonl([
    { type: 'result', key: 'build:I1', agentId: A1, result: 'r1' },
    { type: 'result', key: 'build:I2', agentId: A2, result: 'r2' },
  ]));
  fs.utimesSync(journal, end / 1000, end / 1000);
  const sumDir = path.join(sess.dir, 'workflows');
  fs.mkdirSync(sumDir, { recursive: true });
  const sumFile = path.join(sumDir, LIVE_RUN + '.json');
  fs.writeFileSync(sumFile, JSON.stringify({ runId: LIVE_RUN, timestamp: new Date(end).toISOString(), status: 'completed', workflowName: 'live' }));
  fs.utimesSync(sumFile, end / 1000, end / 1000);
  followed.length = 0;
  ft.advance(4000);
  assert.ok(followed.length >= 1, 'the follower hears about the summary');
  assert.equal(followed[followed.length - 1].run.status, 'completed');
  ft.advance(21 * 60000);
  assert.equal(followed[followed.length - 1].run.status, 'completed', 'a finished run stays completed');
  assert.equal(sent.filter((m) => m.t === 'wfRuns').length, 0, 'no list lease was taken');
  assert.equal(w.get(LIVE_RUN).run.status, 'completed');
});

test('leases: when the list lease expires the loop ends and no file is touched again', (t) => {
  const env = setup(t);
  liveRun(session(env, { cwd: env.project }), LIVE_RUN, Date.now());
  const { w, ft } = watcher(t, env);
  const spies = ['lstatSync', 'statSync', 'readdirSync', 'openSync', 'readFileSync'].map((m) => t.mock.method(fs, m));
  const calls = () => spies.reduce((n, s) => n + s.mock.callCount(), 0);
  w.lease('list');
  ft.advance(30000);
  assert.ok(calls() > 0, 'the watcher reads while leased');
  assert.equal(ft.timers.size, 1, 'one timer while leased');
  ft.advance(31000);
  assert.equal(ft.timers.size, 0, 'no timer after the lease ended');
  const before = calls();
  ft.advance(120000);
  assert.equal(calls(), before, 'no stat, list, open or read after expiry');
  w.list();
  assert.equal(calls(), before, 'list() reads nothing');
});

test('ids: bad run ids, bad agent ids and path tricks give null before any file access', (t) => {
  const env = setup(t);
  fixtureRun(session(env, { cwd: env.project }));
  const { w } = watcher(t, env);
  w.lease('list');
  const spies = ['lstatSync', 'statSync', 'readdirSync', 'openSync', 'readFileSync'].map((m) => t.mock.method(fs, m));
  for (const bad of ['..', '../x', 'wf_../x', 'wf_0a1b2c3d-e4f/../x', 'wf_' + 'a'.repeat(60), '', null, 42, {}]) {
    assert.equal(w.get(bad), null, `get ${String(bad)}`);
    assert.equal(w.preview(bad, 'a3f9c2e1b7d4a8e6'), null, `preview run ${String(bad)}`);
    assert.equal(w.lease(bad === null || typeof bad === 'object' ? bad : String(bad)), false);
    assert.equal(typeof w.follow(bad, () => {}), 'function');
  }
  for (const bad of ['..', '../agent', 'a3f9c2e1b7d4a8e6/..', 'b3f9c2e1b7d4a8e6', '']) {
    assert.equal(w.preview(FIX_RUN, bad), null, `preview agent ${bad}`);
  }
  assert.deepEqual(w.findByToken('../x', 0), []);
  assert.equal(spies.reduce((n, s) => n + s.mock.callCount(), 0), 0, 'no file access for refused ids');
  assert.equal(w.preview(FIX_RUN, 'a1234567890abcdef'), null, 'an agent that is not in the run');
});

test('preview: summary previews first, else the transcript and journal; clipped to 400; never broadcast', (t) => {
  const env = setup(t);
  const summary = JSON.parse(fs.readFileSync(path.join(FIX, 'summary.json'), 'utf8'));
  const entry = summary.workflowProgress.find((p) => p.agentId === 'a3f9c2e1b7d4a8e6');
  entry.promptPreview = 'CANARY_' + 'p'.repeat(1000);
  entry.resultPreview = 'CANARY_' + '\u{1F600}'.repeat(300);
  fixtureRun(session(env, { cwd: env.project }), FIX_RUN, summary);
  const { w, ft, sent } = watcher(t, env);
  w.lease('list');
  w.lease(FIX_RUN);
  const p = w.preview(FIX_RUN, 'a3f9c2e1b7d4a8e6');
  assert.equal(p.prompt.length, 400);
  assert.ok(p.prompt.startsWith('CANARY_ppp'));
  assert.ok(p.result.length <= 400 && p.result.length >= 399, 'no half surrogate pair');
  assert.equal(Buffer.from(p.result, 'utf8').toString('utf8'), p.result);
  const fallback = w.preview(FIX_RUN, 'a6f0e3c5a7b9d1f3');
  assert.deepEqual(fallback, { prompt: 'CANARY_USERTEXT_9a0b', result: 'CANARY_RESULT_RETRY_2d3e' });
  const obj = w.preview(FIX_RUN, 'a7c1e9b3d5f2a4c6');
  assert.equal(obj.prompt, 'CANARY_PREVIEW_PROMPT_3d4e');
  ft.advance(10000);
  noCanary(sent, 'broadcasts after previews');
  noCanary(w.get(FIX_RUN), 'get() after previews');
});

test('findByToken: runs with a started label "<token>:" that began at or after sinceMs', (t) => {
  const env = setup(t);
  const sess = session(env, { cwd: env.project });
  const now = Date.now();
  liveRun(sess, LIVE_RUN, now, ['tok42:build:I1', 'tok42:build:I2']);
  fixtureRun(sess);
  const { w } = watcher(t, env, { start: now + 1000 });
  const found = w.findByToken('tok42', now - 60000);
  assert.deepEqual(ids(found), [LIVE_RUN], 'found without any lease');
  assert.equal(found[0].engine, 'claude-code');
  assert.deepEqual(w.findByToken('tok42', now + 3600000), [], 'started before sinceMs');
  assert.deepEqual(w.findByToken('tok4', now - 60000), [], 'the token must be followed by a colon');
  assert.deepEqual(w.findByToken('haiku', 0), [], 'a label that only contains the token later');
  assert.deepEqual(ids(w.findByToken('build', FIX_END - 3600000)), [FIX_RUN], 'a finished run starts at its summary startTime');
  assert.deepEqual(w.findByToken('tok42', Number.NaN), []);
});

test('stop(): no timer is left, and later calls do nothing', (t) => {
  const env = setup(t);
  liveRun(session(env, { cwd: env.project }), LIVE_RUN, Date.now());
  const { w, ft } = watcher(t, env);
  w.lease('list');
  w.lease(LIVE_RUN);
  w.follow(LIVE_RUN, () => {});
  assert.equal(ft.timers.size, 1);
  w.stop();
  assert.equal(ft.timers.size, 0);
  assert.equal(w.lease('list'), false);
  assert.equal(typeof w.follow(LIVE_RUN, () => {}), 'function');
  assert.equal(w.get(LIVE_RUN), null);
  assert.equal(ft.timers.size, 0);
});

test('available(): false without a projects folder; the list holds at most RUNS_MAX runs', (t) => {
  const env = setup(t);
  const { w } = watcher(t, { ...env, home: path.join(env.base, 'missing') });
  assert.equal(w.available(), false);
  w.lease('list');
  assert.deepEqual(w.list(), []);
  assert.equal(RUNS_MAX, 100);
});

test('byte caps: a journal over 1 MB catches up over several ticks', (t) => {
  const env = setup(t);
  const sess = session(env, { cwd: env.project });
  const dir = path.join(sess.dir, 'subagents', 'workflows', LIVE_RUN);
  fs.mkdirSync(dir, { recursive: true });
  const pad = 'x'.repeat(10000);
  const lines = Array.from({ length: 300 }, (_, i) => ({ ...started('a' + String(i).padStart(16, '0'), `k${i}`), pad }));
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), jsonl(lines));
  const { w, ft } = watcher(t, env);
  w.lease(LIVE_RUN);
  const first = w.get(LIVE_RUN).agents.length;
  assert.ok(first > 0 && first < 300, `one tick reads at most 1 MB of one file (read ${first} lines)`);
  ft.advance(8000);
  assert.equal(w.get(LIVE_RUN).agents.length, 300);
});
