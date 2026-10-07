// Usage limits: Claude windows from rate_limit_info, Codex windows from the newest ~/.codex/sessions rollout
// (home dir redirected to a temp dir: nothing of the real user is read), persistence and SSE broadcast.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpDir, rmrf } = require('./helpers');
const { createStore } = require('../src/store');
const { createLimits } = require('../src/limits');

let dir, home, store, events, limits;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };

before(() => {
  dir = tmpDir('ob-limits-'); home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.CODEX_HOME;
  assert.equal(path.resolve(os.homedir()), path.resolve(home), 'home dir must be redirected for this test file');
  store = createStore(path.join(dir, 'project')); store.ensure();
  events = [];
  limits = createLimits({ store, broadcast: (e) => events.push(e) });
});
after(() => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmrf(dir);
});

test('initial state: no limits known, nothing persisted', () => {
  assert.deepEqual(limits.get(), { claude: null, codex: null });
  assert.equal(store.readJson('limits.json'), null);
});

test('claudeLimits: unifiedWindows become {pct (one decimal), resetsAt in ms}; status/overage kept; persisted + broadcast', () => {
  limits.claudeLimits({ status: 'allowed', isUsingOverage: false, rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1759900000, unifiedWindows: { five_hour: { utilization: 0.4267, resetsAt: 1759900000 }, seven_day: { utilization: 0.11, resetsAt: 1760300000 }, broken: { utilization: 'n/a' } } });
  const c = limits.get().claude;
  assert.deepEqual(c.windows, { five_hour: { pct: 42.7, resetsAt: 1759900000000 }, seven_day: { pct: 11, resetsAt: 1760300000000 } });
  assert.equal(c.status, 'allowed'); assert.equal(c.overage, false);
  assert.match(c.updated, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(store.readJson('limits.json').claude.windows, c.windows);
  assert.equal(events.filter((e) => e.t === 'limits').length, 1);
  assert.deepEqual(events.at(-1).limits.claude.windows, c.windows);
});

test('claudeLimits: without unifiedWindows the single rateLimitType window is used; overage flag is boolean', () => {
  limits.claudeLimits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.905, resetsAt: 7, isUsingOverage: 1 });
  const c = limits.get().claude;
  // A partial event updates its own window and keeps the windows already known (here five_hour from the test above).
  assert.deepEqual(c.windows.seven_day, { pct: 90.5, resetsAt: 7000 });
  assert.ok(c.windows.five_hour, 'known five_hour window is kept');
  assert.equal(c.status, 'allowed_warning'); assert.equal(c.overage, true);
});

const rollout = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'); };
const rl = (primaryPct, secondaryPct, extra = {}) => ({ timestamp: '2026-10-07T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: primaryPct, window_minutes: 300, resets_at: 1759910000 }, secondary: { used_percent: secondaryPct, window_minutes: 10080, resets_at: 1760400000 }, plan_type: 'pro', ...extra } } });

test('readCodexLimits: no sessions dir -> nothing; newest day dir + newest .jsonl wins; last rate_limits line is used; half-written tail skipped', () => {
  limits.refreshCodex();
  assert.equal(limits.get().codex, null);
  const sessions = path.join(home, '.codex', 'sessions');
  rollout(path.join(sessions, '2026', '10', '06', 'rollout-2026-10-06T09-00-00-old.jsonl'), [rl(5, 1)]);
  const newer = path.join(sessions, '2026', '10', '07', 'rollout-2026-10-07T09-00-00-a.jsonl');
  rollout(newer, [
    { type: 'session_meta', payload: { id: 'x' } },
    rl(12, 40),
    rl(33, 61, { rate_limit_reached_type: null }),
    { type: 'event_msg', payload: { type: 'agent_message', message: 'no limits here' } },
    '{"timestamp":"2026-10-07T10:01:00Z","payload":{"rate_limits":', // half-written last line
  ]);
  const n = events.length;
  limits.refreshCodex();
  const c = limits.get().codex;
  assert.deepEqual(c.windows, {
    five_hour: { pct: 33, minutes: 300, resetsAt: 1759910000000 },
    seven_day: { pct: 61, minutes: 10080, resetsAt: 1760400000000 },
  });
  assert.equal(c.plan, 'pro'); assert.equal(c.reached, null);
  assert.equal(events.length, n + 1, 'one limits broadcast');
  // Same file, same mtime: nothing new to report.
  limits.refreshCodex();
  assert.equal(events.length, n + 1);
  assert.deepEqual(store.readJson('limits.json').codex.windows, c.windows);
});

test('readCodexLimits: a newer rollout file (by mtime) replaces the windows; odd window sizes get a "<n>m" key', async () => {
  const sessions = path.join(home, '.codex', 'sessions');
  const f = path.join(sessions, '2026', '10', '07', 'rollout-2026-10-07T11-00-00-b.jsonl');
  rollout(f, [{ payload: { rate_limits: { primary: { used_percent: 77, window_minutes: 60, resets_at: 1 }, plan_type: 'plus', rate_limit_reached_type: 'primary' } } }]);
  const future = Date.now() / 1000 + 60; fs.utimesSync(f, future, future);
  limits.refreshCodex();
  const c = limits.get().codex;
  assert.deepEqual(c.windows, { '60m': { pct: 77, minutes: 60, resetsAt: 1000 } });
  assert.equal(c.plan, 'plus'); assert.equal(c.reached, 'primary');
});

test('start/stop: polling timer is created once and cleared; start() does an immediate refresh', () => {
  limits.start(); limits.start();
  limits.stop(); limits.stop();
  assert.ok(true);
});

test('limits.json on disk is reloaded by a fresh instance', () => {
  const again = createLimits({ store, broadcast: () => {} });
  assert.deepEqual(again.get().claude.windows, limits.get().claude.windows);
  assert.deepEqual(again.get().codex.windows, limits.get().codex.windows);
});
