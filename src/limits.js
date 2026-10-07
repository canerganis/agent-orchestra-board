// Usage limits. Claude: rate_limit_event from every `claude -p` stream. Codex: last rate_limits in the newest session rollout under $CODEX_HOME (default ~/.codex).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeBin, CLAUDE_PROBE_MODEL, CLAUDE_PROBE_FALLBACK_MODEL } = require('./config');
const { killTree, spawnResolved } = require('./platform'); // the probe's cwd is the temp dir: resolve claude on PATH first
const claude = require('./adapters/claude');
const { spawnErrorMessage, explainExit, classifyFailure, authMessage } = require('./adapters/diagnose');
const { now } = require('./util');

const PROBE_TIMEOUT_MS = 90000;

// spawnFn is injectable so tests never start the real CLI.
function createLimits({ store, broadcast, spawnFn = spawnResolved }) {
  const stored = store.readJson('limits.json');
  const limits = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : { claude: null, codex: null };

  // A write failure (antivirus lock, full disk) must not take the board down: the in-memory value still shows.
  const persist = () => { try { store.writeJson('limits.json', limits); } catch (e) { console.error(`orchestra-board: could not save limits.json: ${e.message}`); } };
  function setLimits(agent, data) {
    limits[agent] = { ...data, updated: now() };
    persist(); broadcast({ t: 'limits', limits });
  }
  // Keeps the last known windows AND their `updated` stamp (the UI treats `updated` as the data's age: a failed
  // refresh must not make months-old windows look fresh). The failure itself is dated separately in `errorAt`.
  function setError(agent, message) {
    const prev = limits[agent] && typeof limits[agent] === 'object' ? limits[agent] : {};
    limits[agent] = { ...prev, error: String(message), errorAt: now() };
    persist(); broadcast({ t: 'limits', limits });
  }
  // rate_limit_info fields are undocumented and often partial: any of them may be missing. resetsAt is epoch seconds
  // (ms or an ISO string tolerated). An event that carries no usable window keeps the windows already known.
  const resetMs = (v) => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string' && v) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000; const d = Date.parse(v); return Number.isFinite(d) ? d : null; }
    return null;
  };
  const pctOf = (u) => (typeof u === 'number' && Number.isFinite(u) ? Math.round(u * 1000) / 10 : null);
  function claudeLimits(info) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) return;
    const wins = {};
    const uw = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
    for (const [k, v] of Object.entries(uw)) if (v && typeof v === 'object' && pctOf(v.utilization) !== null) wins[k] = { pct: pctOf(v.utilization), resetsAt: resetMs(v.resetsAt) };
    if (!Object.keys(wins).length && typeof info.rateLimitType === 'string' && info.rateLimitType && pctOf(info.utilization) !== null) wins[info.rateLimitType] = { pct: pctOf(info.utilization), resetsAt: resetMs(info.resetsAt) };
    const prev = limits.claude && typeof limits.claude === 'object' ? limits.claude : {};
    const known = Object.keys(wins).length > 0;
    if (!known && typeof info.status !== 'string' && info.isUsingOverage == null) return; // nothing usable
    setLimits('claude', {
      // A partial event (one window only) updates that window and keeps the others already known.
      windows: known ? { ...(prev.windows && typeof prev.windows === 'object' ? prev.windows : {}), ...wins } : prev.windows || {},
      status: typeof info.status === 'string' ? info.status : prev.status,
      overage: info.isUsingOverage != null ? !!info.isUsingOverage : !!prev.overage,
    });
  }
  // The most recently modified rollout under dir (directories nested up to `depth` levels). Every file is compared:
  // a session resumed today lives in an older date folder, so folder names alone do not say which one is current.
  function newestFile(dir, depth) {
    let best = null, bestMt = -1;
    (function walk(d, lvl) {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && lvl < depth) walk(p, lvl + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          let mt; try { mt = fs.statSync(p).mtimeMs; } catch { continue; }
          if (mt > bestMt || (mt === bestMt && best && p > best)) { bestMt = mt; best = p; } // equal mtimes: the later path (newer date folder) wins
        }
      }
    })(dir, 0);
    return best;
  }
  // rate_limits is one {primary, secondary, plan_type, limit_id?} object; newer CLIs may tag it with a limit_id or
  // report several limits (an array, or a map keyed by limit id). Prefer the "codex" limit, else the first one.
  function pickCodexLimits(rl) {
    const isLim = (x) => x && typeof x === 'object' && !Array.isArray(x) && ('primary' in x || 'secondary' in x);
    if (isLim(rl)) return rl;
    const list = Array.isArray(rl) ? rl.filter(isLim) : rl && typeof rl === 'object' ? Object.entries(rl).filter(([, v]) => isLim(v)).map(([k, v]) => ({ limit_id: k, ...v })) : [];
    return list.find((x) => x.limit_id === 'codex') || list[0] || null;
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
      rl = pickCodexLimits(rl);
      if (!rl) continue;
      const wins = {};
      // Tolerant: secondary may be null, a window may lack window_minutes / resets_at, used_percent may be missing.
      for (const w of [rl.primary, rl.secondary]) {
        if (!w || typeof w !== 'object' || typeof w.used_percent !== 'number') continue;
        const mins = typeof w.window_minutes === 'number' && w.window_minutes > 0 ? w.window_minutes : null;
        const key = mins === null ? (wins.primary ? 'secondary' : 'primary') : mins >= 10080 ? 'seven_day' : mins >= 300 ? 'five_hour' : `${mins}m`;
        wins[key] = { pct: w.used_percent, minutes: mins, resetsAt: resetMs(w.resets_at) };
      }
      if (!Object.keys(wins).length && rl.plan_type === undefined) continue;
      return setLimits('codex', { windows: wins, plan: rl.plan_type ?? null, reached: rl.rate_limit_reached_type ?? null, ...(typeof rl.limit_id === 'string' ? { limitId: rl.limit_id } : {}) });
    }
  }
  const refreshCodex = () => { try { readCodexLimits(); } catch {} };

  let timer = null;
  function start() { if (timer) return; timer = setInterval(refreshCodex, 30000); timer.unref(); refreshCodex(); }
  // stop() (board shutdown) also kills a running Claude limits probe, so it cannot outlive the board as an orphan.
  let closing = false, activeProbe = null;
  function stop() {
    closing = true;
    if (timer) clearInterval(timer); timer = null;
    if (activeProbe) { try { killTree(activeProbe); } catch {} activeProbe = null; }
  }

  // A tiny Haiku call is the only way to get Claude's rate_limit_event; it costs under $0.01.
  // One probe at a time. Failures become a visible limits.claude.error that names the real cause: a missing CLI,
  // the CLI's own error result (not logged in, invalid API key, ...), a clean turn without rate_limit_event
  // (API-key logins never report subscription windows), or an exit without any result (explained from the stream).
  let probing = null;
  // The first probe uses CLAUDE_PROBE_MODEL. If it ends in an error result without a rate_limit_event (an unknown model
  // id is the likely cause; auth errors are not retried), one retry runs on CLAUDE_PROBE_FALLBACK_MODEL.
  function probeClaude() {
    if (probing) return probing;
    probing = runClaudeProbe(CLAUDE_PROBE_MODEL, true)
      .then((r) => (r.retryable ? runClaudeProbe(CLAUDE_PROBE_FALLBACK_MODEL, false) : r))
      .then((r) => ({ ok: r.ok, error: r.error }))
      .finally(() => { probing = null; });
    return probing;
  }
  function runClaudeProbe(model, canRetry) {
    return new Promise((resolve) => {
      const bin = claudeBin();
      let got = false, completed = false, turnError = null, spawnErr = null, stderr = '', done = false, timer = null;
      const parser = claude.createParser({
        rateLimit: (info) => { got = true; claudeLimits(info); },
        completed: () => { completed = true; },
        error: (m) => { turnError = String(m || 'claude error'); },
      });
      let probe;
      if (closing) return resolve({ ok: false, error: 'stopped' });
      try { probe = spawnFn(bin, claude.buildProbeArgs(model), { cwd: os.tmpdir(), windowsHide: true }); }
      catch (e) { const m = spawnErrorMessage('claude', bin, e, process.env); setError('claude', m); return resolve({ ok: false, error: m }); }
      activeProbe = probe;
      const finish = (code, signal) => {
        if (done) return; done = true; clearTimeout(timer);
        if (activeProbe === probe) activeProbe = null;
        if (closing) return resolve({ ok: false, error: 'stopped', retryable: false }); // a killed probe is not a limits error
        parser.end();
        let error = null;
        if (spawnErr) error = spawnErr;
        else if (got) error = null; // the windows were recorded even if the turn then failed
        else if (turnError) error = `Claude limits probe failed: ${classifyFailure(`${turnError}\n${stderr}`) === 'auth' ? authMessage('claude', turnError, stderr) : turnError}`;
        else if (completed) error = 'Claude limits probe completed but got no rate_limit_event: the Claude CLI reports subscription usage windows only for a claude.ai login (API-key and cloud-provider logins have no such windows).';
        else error = `Claude limits probe got no rate_limit_event: ${explainExit({ agent: 'claude', bin, code, signal, stats: parser.stats, stderr })}`;
        const retryable = canRetry && !got && !spawnErr && !!turnError && classifyFailure(`${turnError}
${stderr}`) !== 'auth';
        if (error && !retryable) setError('claude', error); // a retryable failure is reported only if the retry fails too
        resolve({ ok: !error, error, retryable });
      };
      timer = setTimeout(() => { spawnErr = `Claude limits probe did not finish within ${PROBE_TIMEOUT_MS / 1000}s`; try { killTree(probe); } catch {} finish(null, null); }, PROBE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      probe.stdout?.on('data', (d) => parser.feed(d));
      probe.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      probe.on('error', (e) => { spawnErr = spawnErrorMessage('claude', bin, e, process.env); setTimeout(() => finish(null, null), 1000).unref?.(); });
      probe.on('close', finish);
      if (probe.stdin) { probe.stdin.on('error', () => {}); probe.stdin.end('Reply with: ok'); }
    });
  }

  return { get: () => limits, setLimits, claudeLimits, readCodexLimits, refreshCodex, start, stop, probeClaude };
}

module.exports = { createLimits };
