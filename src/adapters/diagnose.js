// Human-readable failure messages for CLI turns: spawn errors (missing binary) and exits without a recognised result.
const fs = require('fs');
const path = require('path');
const { codexEnv } = require('../platform');

const LABEL = { claude: 'Claude', codex: 'Codex' };
const ENV = { claude: 'ORCHESTRA_CLAUDE_BIN', codex: 'ORCHESTRA_CODEX_BIN' };
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const WIN = process.platform === 'win32';

const label = (agent) => LABEL[agent] || agent;
const lastLine = (text) => String(text || '').replace(ANSI, '').trim().split(/\r?\n/).filter((l) => l.trim()).pop() || '';
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

// Windows: the npm global install of a CLI (`npm i -g @openai/codex`) leaves only `codex.cmd` on PATH. libuv tries
// just .com/.exe for a bare name, so spawn() reports ENOENT although `where codex` finds it. This returns the first
// <bin>.cmd/.bat on the given PATH (same lookup as doctor.resolveShims) or null; only bare names are searched.
function findShim(bin, env = process.env) {
  if (!WIN || !bin || bin.includes('/') || bin.includes('\\')) return null;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const exts = path.extname(bin) ? [''] : ['.cmd', '.bat'];
  for (const dir of (env[pathKey] || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) { const f = path.join(dir, bin + ext); if (/\.(cmd|bat)$/i.test(f) && isFile(f)) return f; }
  }
  return null;
}

// child.on('error') / spawn() throw -> one explicit sentence that says what to fix.
// env: the environment the child was spawned with (defaults to the one the runner uses for that agent).
function spawnErrorMessage(agent, bin, e, env = null) {
  const name = label(agent), code = e && e.code, envVar = ENV[agent] || 'the CLI path';
  if (code === 'ENOENT') {
    const shim = findShim(bin, env || (agent === 'codex' ? codexEnv() : process.env));
    const where = agent === 'codex'
      ? 'an npm install keeps the vendored codex.exe inside <npm prefix>\\node_modules\\@openai\\codex\\, or use the native build from github.com/openai/codex/releases'
      : 'the npm package may ship no .exe at all: use the native installer from https://claude.com/claude-code';
    if (shim) return `${name} CLI "${bin}" is on PATH only as the ${path.extname(shim)} shim ${shim}, which Node cannot spawn without a shell. Set ${envVar} to the full path of the native .exe (${where}).`;
    return `${name} CLI not found: "${bin}" is not on PATH. Install it or set ${envVar} to its full path.`;
  }
  if (code === 'EACCES' || code === 'EPERM') return `${name} CLI "${bin}" is not executable (${code}).`;
  if (code === 'EINVAL' && WIN) return `${name} CLI "${bin}" cannot be launched directly (EINVAL; a .cmd/.bat shim?). Point ${envVar} at the .exe.`;
  return `${name} CLI "${bin}" failed to start: ${(e && e.message) || e}`;
}

// The process ended without a completed turn. stats come from the adapter parser (jsonl feeder).
function explainExit({ agent, bin, code, signal, stats = {}, stderr = '', version = null }) {
  const name = label(agent);
  const ver = version ? ` (${bin} ${version})` : '';
  const tail = lastLine(stderr);
  const exit = signal ? `signal ${signal}` : `exit code ${code}`;
  const why = tail ? `: ${tail.slice(0, 300)}` : '';
  if (!stats.lines) return `${name} CLI exited (${exit}) without any output${why}`;
  if (!stats.json) return `${name} CLI printed no JSON (${exit}; output format changed?)${why || (stats.lastNoise ? `: ${stats.lastNoise}` : '')}`;
  // A handler that threw is our bug, not a schema change: the feeder does not count such lines as events, so check it first.
  if (stats.handlerErrors) return `${name} CLI output could not be processed${ver}: ${stats.lastHandlerError}`;
  if (!stats.events) return `Unrecognised ${name} CLI output${ver}: ${stats.json} JSON line(s) of unknown type${stats.unknownTypes?.length ? ` [${stats.unknownTypes.join(', ')}]` : ''}. The CLI's JSON schema may have changed; update Orchestra Board${why}`;
  return `${name} CLI ended (${exit}) before reporting a result${stats.unknown ? ` (${stats.unknown} unknown event(s): ${stats.unknownTypes.join(', ')})` : ''}${why}`;
}

module.exports = { spawnErrorMessage, explainExit, findShim, lastLine, label };
