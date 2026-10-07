// CLI version detection: `<bin> --version` once per configured binary (cached; refresh on demand).
// Used by the runner (diagnostics, SSE 'cli' event), doctor and the UI. Never runs a billable turn.
// The binary is resolved on PATH before the spawn (platform.spawnResolved): the board's own cwd never supplies it.
const { claudeBin, codexBin } = require('../config');
const { codexEnv, killTree, spawnResolved } = require('../platform');
const { spawnErrorMessage, lastLine, label } = require('./diagnose');
const { now } = require('../util');

const bins = { claude: claudeBin, codex: codexBin };
const pending = new Map(); // `${agent}|${bin}` -> Promise<info>
const last = { claude: null, codex: null }; // last settled info per agent

// -> { agent, bin, ok, version|null, raw, error|null, checkedAt }
function detectVersion(agent, bin, { timeoutMs = 10000, spawnFn = spawnResolved } = {}) {
  return new Promise((resolve) => {
    const info = { agent, bin, ok: false, version: null, raw: '', error: null, checkedAt: now() };
    let child;
    try { child = spawnFn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: agent === 'codex' ? codexEnv() : process.env }); }
    catch (e) { info.error = spawnErrorMessage(agent, bin, e); return resolve(info); }
    let out = '', err = '', done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(info); };
    const timer = setTimeout(() => { info.error = `${label(agent)} CLI did not answer --version within ${timeoutMs / 1000}s`; try { killTree(child); } catch {} finish(); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.on('data', (d) => { out = (out + d).slice(-2000); });
    child.stderr?.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => { info.error = spawnErrorMessage(agent, bin, e); });
    child.on('close', (code, signal) => {
      if (!info.error) {
        info.raw = lastLine(out) || lastLine(err);
        const m = info.raw.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
        if (code === 0) { info.ok = true; info.version = m ? m[0] : null; }
        else info.error = `${label(agent)} CLI "${bin}" --version failed (${signal ? `signal ${signal}` : `exit code ${code}`})${info.raw ? `: ${info.raw}` : ''}`;
      }
      finish();
    });
  });
}

// Detect both CLIs with the binaries configured right now. Cached per binary name; {refresh:true} re-runs.
function cliVersions({ refresh = false, spawnFn = spawnResolved } = {}) {
  const jobs = Object.entries(bins).map(([agent, binOf]) => {
    const bin = binOf(), key = `${agent}|${bin}`;
    if (refresh || !pending.has(key)) pending.set(key, detectVersion(agent, bin, { spawnFn }).then((info) => { last[agent] = info; return info; }));
    return pending.get(key);
  });
  return Promise.all(jobs).then(([claude, codex]) => ({ claude, codex }));
}

// Last known result without waiting (null per agent until the first detection settles).
const cliVersionsCached = () => ({ claude: last.claude, codex: last.codex });

module.exports = { detectVersion, cliVersions, cliVersionsCached };
