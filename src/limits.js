// Usage limits. Claude: rate_limit_event from every `claude -p` stream. Codex: last rate_limits in the newest ~/.codex session rollout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { claudeBin } = require('./config');
const claude = require('./adapters/claude');
const { now } = require('./util');

function createLimits({ store, broadcast }) {
  const limits = store.readJson('limits.json') || { claude: null, codex: null };

  function setLimits(agent, data) {
    limits[agent] = { ...data, updated: now() };
    store.writeJson('limits.json', limits); broadcast({ t: 'limits', limits });
  }
  function claudeLimits(info) {
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
  function readCodexLimits() {
    const f = newestFile(path.join(os.homedir(), '.codex', 'sessions'), 3); if (!f) return;
    const mt = fs.statSync(f).mtimeMs; if (f === codexLimitFile && mt === codexLimitMtime) return;
    codexLimitFile = f; codexLimitMtime = mt;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let rl; try { rl = JSON.parse(lines[i]).payload?.rate_limits; } catch { continue; }
      if (!rl) continue;
      const win = (w) => w && { pct: w.used_percent, minutes: w.window_minutes, resetsAt: w.resets_at ? w.resets_at * 1000 : null };
      const wins = {};
      for (const w of [rl.primary, rl.secondary].filter(Boolean)) wins[w.window_minutes >= 10080 ? 'seven_day' : w.window_minutes >= 300 ? 'five_hour' : `${w.window_minutes}m`] = win(w);
      return setLimits('codex', { windows: wins, plan: rl.plan_type, reached: rl.rate_limit_reached_type });
    }
  }
  const refreshCodex = () => { try { readCodexLimits(); } catch {} };

  let timer = null;
  function start() { if (timer) return; timer = setInterval(refreshCodex, 30000); timer.unref(); refreshCodex(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  // A tiny Haiku call is the only way to get Claude's rate_limit_event; it costs a few cents at most.
  function probeClaude() {
    const probe = spawn(claudeBin(), claude.buildProbeArgs(), { cwd: os.tmpdir(), windowsHide: true });
    const parser = claude.createParser({ rateLimit: claudeLimits });
    probe.stdout.on('data', (d) => parser.feed(d));
    probe.on('error', () => {}); probe.stdin.end('Reply with: ok');
  }

  return { get: () => limits, setLimits, claudeLimits, readCodexLimits, refreshCodex, start, stop, probeClaude };
}

module.exports = { createLimits };
