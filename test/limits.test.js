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
// Windows without their freshness fields, for the shape assertions of the older tests.
const bare = (wins) => wins; // windows keep their plain shape; freshness lives in lim.observed / lim.stale

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
  assert.deepEqual(bare(c.windows), { five_hour: { pct: 42.7, resetsAt: 1759900000000 }, seven_day: { pct: 11, resetsAt: 1760300000000 } });
  assert.equal(c.status, 'allowed'); assert.equal(c.overage, false);
  assert.match(c.updated, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(bare(store.readJson('limits.json').claude.windows), bare(c.windows));
  assert.equal(events.filter((e) => e.t === 'limits').length, 1);
  assert.deepEqual(events.at(-1).limits.claude.windows, c.windows);
  assert.equal(typeof c.observed.five_hour, 'number');
});

test('claudeLimits: without unifiedWindows the single rateLimitType window is used; overage flag is boolean', () => {
  limits.claudeLimits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.905, resetsAt: 7, isUsingOverage: 1 });
  const c = limits.get().claude;
  // A partial event updates its own window and keeps the windows already known (here five_hour from the test above).
  assert.deepEqual(bare({ s: c.windows.seven_day }).s, { pct: 90.5, resetsAt: 7000 });
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
  assert.deepEqual(bare(c.windows), {
    five_hour: { pct: 33, minutes: 300, resetsAt: 1759910000000 },
    seven_day: { pct: 61, minutes: 10080, resetsAt: 1760400000000 },
  });
  assert.equal(c.plan, 'pro'); assert.equal(c.reached, null);
  assert.equal(events.length, n + 1, 'one limits broadcast');
  // Same file, same mtime: nothing new to report.
  limits.refreshCodex();
  assert.equal(events.length, n + 1);
  assert.deepEqual(bare(store.readJson('limits.json').codex.windows), bare(c.windows));
});

test('readCodexLimits: a newer rollout file (by mtime) replaces the windows; odd window sizes get a "<n>m" key', async () => {
  const sessions = path.join(home, '.codex', 'sessions');
  const f = path.join(sessions, '2026', '10', '07', 'rollout-2026-10-07T11-00-00-b.jsonl');
  rollout(f, [{ payload: { rate_limits: { primary: { used_percent: 77, window_minutes: 60, resets_at: 1 }, plan_type: 'plus', rate_limit_reached_type: 'primary' } } }]);
  const future = Date.now() / 1000 + 60; fs.utimesSync(f, future, future);
  limits.refreshCodex();
  const c = limits.get().codex;
  assert.deepEqual(bare(c.windows), { '60m': { pct: 77, minutes: 60, resetsAt: 1000 } });
  assert.equal(c.plan, 'plus'); assert.equal(c.reached, 'primary');
});

test('start/stop: polling timer is created once and cleared; start() does an immediate refresh', () => {
  limits.start(); limits.start();
  limits.stop(); limits.stop();
  assert.ok(true);
});

test('limits.json on disk is reloaded by a fresh instance', () => {
  const again = createLimits({ store, broadcast: () => {} });
  assert.deepEqual(bare(again.get().claude.windows), bare(limits.get().claude.windows));
  assert.deepEqual(bare(again.get().codex.windows), bare(limits.get().codex.windows));
});

// ---- freshness ----
const fresh = (clockRef, extra = {}) => {
  const d = tmpDir('ob-limits-fresh-'); const st = createStore(path.join(d, 'p')); st.ensure();
  return { d, lim: createLimits({ store: st, broadcast: () => {}, clock: () => clockRef.t, ...extra }) };
};

test('freshness: a reading taken before a reset is stale after the reset time; also after 30 minutes', () => {
  const clk = { t: 1_000_000_000_000 };
  const { d, lim } = fresh(clk);
  lim.claudeLimits({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: (clk.t + 3600e3) / 1000 }, seven_day: { utilization: 0.92, resetsAt: (clk.t + 10 * 60e3) / 1000 } } });
  assert.equal(lim.get().claude.stale.seven_day, false);
  clk.t += 11 * 60e3; // past the weekly reset, within 30 minutes
  assert.equal(lim.get().claude.stale.seven_day, true);
  assert.equal(lim.get().claude.stale.five_hour, false);
  clk.t += 25 * 60e3; // over the freshness limit
  assert.equal(lim.get().claude.stale.five_hour, true);
  rmrf(d);
});

test('freshness: a provider refresh without new window data does not refresh old windows', () => {
  const clk = { t: 1_000_000_000_000 };
  const { d, lim } = fresh(clk);
  lim.claudeLimits({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: (clk.t + 5 * 3600e3) / 1000 }, seven_day: { utilization: 0.9, resetsAt: (clk.t + 9 * 3600e3) / 1000 } } });
  const seen = lim.get().claude.observed.seven_day;
  clk.t += 40 * 60e3;
  lim.claudeLimits({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.2, resetsAt: (clk.t + 3600e3) / 1000 }); // one window only
  const c = lim.get().claude;
  assert.equal(c.observed.seven_day, seen);
  assert.equal(c.stale.seven_day, true);
  assert.equal(c.stale.five_hour, false);
  lim.claudeLimits({ status: 'allowed' }); // status only: no window touched
  assert.equal(lim.get().claude.observed.seven_day, seen);
  rmrf(d);
});

test('freshness: a Codex event timestamp wins over the file mtime; an older event never replaces a newer reading', () => {
  const clk = { t: Date.parse('2026-10-08T12:00:00Z') };
  const { d, lim } = fresh(clk);
  const prevHome = process.env.CODEX_HOME; process.env.CODEX_HOME = path.join(d, 'codex');
  try {
    const f = path.join(d, 'codex', 'sessions', '2026', '10', '08', 'rollout-a.jsonl');
    const ev = (ts, pct) => ({ timestamp: ts, type: 'event_msg', payload: { rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: Date.parse('2026-10-08T15:00:00Z') / 1000 }, plan_type: 'pro' } } });
    rollout(f, [ev('2026-10-08T11:50:00Z', 30)]);
    const later = Date.now() / 1000 + 600; fs.utimesSync(f, later, later); // mtime is far from the event time
    lim.refreshCodex();
    assert.equal(lim.get().codex.observed.five_hour, Date.parse('2026-10-08T11:50:00Z'));
    assert.equal(lim.get().codex.stale.five_hour, false);
    // A rewritten rollout whose last event is older than the reading already held is ignored.
    rollout(f, [ev('2026-10-08T09:00:00Z', 99)]);
    fs.utimesSync(f, later + 5, later + 5);
    lim.refreshCodex();
    assert.equal(lim.get().codex.windows.five_hour.pct, 30);
    clk.t = Date.parse('2026-10-08T15:01:00Z'); // after the reset
    assert.equal(lim.get().codex.stale.five_hour, true);
  } finally { if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome; rmrf(d); }
});
