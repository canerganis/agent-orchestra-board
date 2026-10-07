// Usage limits. Claude: rate_limit_event from every `claude -p` stream. Codex: last rate_limits in the newest session rollout under $CODEX_HOME (default ~/.codex).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeBin } = require('./config');
const { killTree, spawnResolved } = require('./platform'); // the probe's cwd is the temp dir: resolve claude on PATH first
const claude = require('./adapters/claude');
const { spawnErrorMessage, explainExit } = require('./adapters/diagnose');
const { now } = require('./util');

const PROBE_TIMEOUT_MS = 90000;

// spawnFn is injectable so tests never start the real CLI.
function createLimits({ store, broadcast, spawnFn = spawnResolved }) {
  const stored = store.readJson('limits.json');
  const limits = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : { claude: null, codex: null };

  function setLimits(agent, data) {
    limits[agent] = { ...data, updated: now() };
    store.writeJson('limits.json', limits); broadcast({ t: 'limits', limits });
  }
  // Keeps the last known windows AND their `updated` stamp (the UI treats `updated` as the data's age: a failed
  // refresh must not make months-old windows look fresh). The failure itself is dated separately in `errorAt`.
  function setError(agent, message) {
    const prev = limits[agent] && typeof limits[agent] === 'object' ? limits[agent] : {};
    limits[agent] = { ...prev, error: String(message), errorAt: now() };
    store.writeJson('limits.json', limits); broadcast({ t: 'limits', limits });
  }
  function claudeLimits(info) {
    if (!info || typeof info !== 'object') return;
    const wins = {};
    for (const [k, v] of Object.entries(info.unifiedWindows || {})) if (v && typeof v.utilization === 'number') wins[k] = { pct: Math.round(v.utilization * 1000) / 10, resetsAt: v.resetsAt ? v.resetsAt * 1000 : null };
    if (!Object.keys(wins).length && info.rateLimitType) wins[info.rateLimitType] = { pct: Math.round((info.utilization || 0) * 1000) / 10, resetsAt: info.resetsAt ? info.resetsAt * 1000 : null };
    setLimits('claude', { windows: wins, status: info.status, overage: !!info.isUsingOverage });
  }
  function newestFile(dir, depth) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    ents = ents.map((e) => ({ e, p: path.join(dir, e.name) })).sort((a, b) => b.e.name.localeCompare(a.e.name));
    for (const { e, p } of ents) {
      if (depth > 0 && e.isDirectory()) { const f = newestFile(p, depth - 1); if (f) return f; }
      if (depth === 0 && e.isFile() && e.name.endsWith('.jsonl')) return ents.filter((x) => x.e.isFile() && x.e.name.endsWith('.jsonl')).map((x) => x.p).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    }
    return null;
  }
  let codexLimitFile = null, codexLimitMtime = 0;
  // Same home as the CLI (and as doctor): CODEX_HOME when set, else ~/.codex.
  const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  function readCodexLimits() {
    const f = newestFile(path.join(codexHome(), 'sessions'), 3); if (!f) return;
    const mt = fs.statSync(f).mtimeMs; if (f === codexLimitFile && mt === codexLimitMtime) return;
    codexLimitFile = f; codexLimitMtime = mt;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let rl; try { rl = JSON.parse(lines[i]).payload?.rate_limits; } catch { continue; } // a half-written last line is skipped
      if (!rl || typeof rl !== 'object') continue;
      const win = (w) => w && { pct: w.used_percent, minutes: w.window_minutes, resetsAt: w.resets_at ? w.resets_at * 1000 : null };
      const wins = {};
      for (const w of [rl.primary, rl.secondary].filter((w) => w && typeof w === 'object')) wins[w.window_minutes >= 10080 ? 'seven_day' : w.window_minutes >= 300 ? 'five_hour' : `${w.window_minutes}m`] = win(w);
      return setLimits('codex', { windows: wins, plan: rl.plan_type, reached: rl.rate_limit_reached_type });
    }
  }
  const refreshCodex = () => { try { readCodexLimits(); } catch {} };

  let timer = null;
  function start() { if (timer) return; timer = setInterval(refreshCodex, 30000); timer.unref(); refreshCodex(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  // A tiny Haiku call is the only way to get Claude's rate_limit_event; it costs under $0.01.
  // One probe at a time. Failures become a visible limits.claude.error that names the real cause: a missing CLI,
  // the CLI's own error result (not logged in, invalid API key, ...), a clean turn without rate_limit_event
  // (API-key logins never report subscription windows), or an exit without any result (explained from the stream).
  let probing = null;
  function probeClaude() {
    if (probing) return probing;
    probing = new Promise((resolve) => {
      const bin = claudeBin();
      let got = false, completed = false, turnError = null, spawnErr = null, stderr = '', done = false, timer = null;
      const parser = claude.createParser({
        rateLimit: (info) => { got = true; claudeLimits(info); },
        completed: () => { completed = true; },
        error: (m) => { turnError = String(m || 'claude error'); },
      });
      let probe;
      try { probe = spawnFn(bin, claude.buildProbeArgs(), { cwd: os.tmpdir(), windowsHide: true }); }
      catch (e) { const m = spawnErrorMessage('claude', bin, e, process.env); setError('claude', m); return resolve({ ok: false, error: m }); }
      const finish = (code, signal) => {
        if (done) return; done = true; clearTimeout(timer);
        parser.end();
        let error = null;
        if (spawnErr) error = spawnErr;
        else if (got) error = null; // the windows were recorded even if the turn then failed
        else if (turnError) error = `Claude limits probe failed: ${turnError}`;
        else if (completed) error = 'Claude limits probe completed but got no rate_limit_event: the Claude CLI reports subscription usage windows only for a claude.ai login (API-key and cloud-provider logins have no such windows).';
        else error = `Claude limits probe got no rate_limit_event: ${explainExit({ agent: 'claude', bin, code, signal, stats: parser.stats, stderr })}`;
        if (error) setError('claude', error);
        resolve({ ok: !error, error });
      };
      timer = setTimeout(() => { spawnErr = `Claude limits probe did not finish within ${PROBE_TIMEOUT_MS / 1000}s`; try { killTree(probe); } catch {} finish(null, null); }, PROBE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      probe.stdout?.on('data', (d) => parser.feed(d));
      probe.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      probe.on('error', (e) => { spawnErr = spawnErrorMessage('claude', bin, e, process.env); setTimeout(() => finish(null, null), 1000).unref?.(); });
      probe.on('close', finish);
      if (probe.stdin) { probe.stdin.on('error', () => {}); probe.stdin.end('Reply with: ok'); }
    }).finally(() => { probing = null; });
    return probing;
  }

  return { get: () => limits, setLimits, claudeLimits, readCodexLimits, refreshCodex, start, stop, probeClaude };
}

module.exports = { createLimits };
