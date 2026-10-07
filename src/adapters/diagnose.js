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

// --- Failure classification (runner retry / recovery policy) -------------------------------------------------
// Login problems: Claude's result `is_error` text ("Not logged in · Please run /login", "Invalid API key",
// "OAuth token has expired"), Claude in bare mode (no OAuth, API key only), Codex "Not logged in" / 401.
// HTTP status codes count only in context ("status 401", "API Error: 503", "429 Too Many Requests"), never as a bare
// number: our own diagnostics contain counts ("500 JSON line(s)").
const AUTH = /not logged in|please (run \/login|log ?in)|run \/login|login required|log in again|invalid (api[ _-]?key|x-api-key|bearer|token)|authenticat(ion|e) (failed|error|required)|authentication_error|unauthori[sz]ed|(status( code)?|api error|http\/?[\d.]*)[:=]?\s*401\b|oauth token (has )?(expired|revoked|invalid)|token (has )?expired|no (api key|credentials|auth)|missing (api key|credentials)|credentials? (not found|missing|expired)|codex login|bare mode/i;
// Resumed thread that the CLI no longer has (deleted, expired, different cwd/home), anchored to the CLIs' own
// messages. Claude: "No conversation found with session ID: <id>"; Codex: "no rollout found for thread id <id>".
// A looser "thread/session … not found" only counts when it names the id that was resumed: an error that merely
// mentions a thread ("thread/start failed: model x does not exist", "thread 'main' panicked … not found") must not
// throw a valid thread away.
const RESUME = /no conversation found with session id|no rollout found for (thread|conversation|session)( id)?/i;
const RESUME_LOOSE = /(session|thread|rollout|conversation)( id)?[^\n]{0,60}(not found|does not exist|expired|unknown)|(not found|unknown|invalid|expired)[^\n]{0,20}(session|thread|rollout|conversation)|could not (find|load|resume)|failed to (resume|load|find)/i;
// Worth retrying the same turn: rate limits, overload, 429/5xx, network resets. Plan usage limits that reset in
// hours ("usage limit reached", quota, billing) are not: a retry seconds later fails the same way. A short-lived
// limit ("tokens per min … try again in 1.2s") is transient even when it also says "limit reached".
const STATUS = /(status( code)?|api error|http\/?[\d.]*|error)[:=]?\s*(429|5\d\d)\b|\b(429|5\d\d)\s+(too many requests|internal server error|bad gateway|service unavailable|gateway time-?out|overloaded)/i;
const TRANSIENT = /rate[ _-]?limit(ed)?|too many requests|overloaded|insufficient capacity|internal server error|bad gateway|service unavailable|gateway time-?out|temporarily unavailable|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|socket hang up|fetch failed|network (error|is unreachable)|connection (reset|refused|closed|error|lost|aborted)|stream (disconnected|error|closed)|disconnected before|request timed? ?out|timed out waiting|api_error|server_error/i;
const NOT_TRANSIENT = /usage limit|quota|credit balance|billing|insufficient_quota/i;
const SHORT_LIMIT = /per min(ute)?\b|\b(TPM|RPM)\b|try again in\s*[\d.]+\s*(ms|s|sec|secs|seconds?)\b/i;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// -> 'auth' | 'resume' | 'transient' | 'other'. text: the turn's error plus the stderr tail.
// resumed: the turn resumed an existing thread (only then can a thread-not-found mean a lost thread);
// thread: that thread's id (lets a looser not-found message count when it names this id).
function classifyFailure(text, { resumed = false, thread = null } = {}) {
  const s = String(text || '').replace(ANSI, '');
  if (AUTH.test(s)) return 'auth';
  if (resumed && (RESUME.test(s) || (thread && RESUME_LOOSE.test(s) && new RegExp(escapeRe(thread), 'i').test(s)))) return 'resume';
  if ((TRANSIENT.test(s) || STATUS.test(s)) && (!NOT_TRANSIENT.test(s) || SHORT_LIMIT.test(s))) return 'transient';
  return 'other';
}

// One actionable sentence for a login problem.
// detail: the CLI's error message; context: more text to look at (the stderr tail).
function authMessage(agent, detail = '', context = '') {
  const d = lastLine(detail).slice(0, 200);
  const why = d ? ` (${d})` : '';
  if (agent === 'codex') return `Codex CLI is not logged in${why}. Run \`codex login\` once in a terminal, then try again.`;
  if (/bare mode/i.test(`${detail}\n${context}`)) return `Claude CLI runs in bare mode without your claude.ai login${why}. Unset the bare-mode setting (or set ANTHROPIC_API_KEY), or run \`claude\` once to log in, then try again.`;
  return `Claude CLI is not logged in${why}. Run \`claude\` once to log in, then try again.`;
}

module.exports = { spawnErrorMessage, explainExit, findShim, lastLine, label, classifyFailure, authMessage };
