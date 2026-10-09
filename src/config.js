// Static configuration: models, efforts, default seats, lean CLI flags, settings defaults and env overrides.
const DEFAULT_PORT = 4317;

const MODELS = {
  codex: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5'],
};
const EFFORTS = { codex: ['low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'xhigh', 'max'] };
const COLORS = ['#e07a52', '#7aa2ff', '#ffcc4d', '#b48cff', '#4fd1a5', '#ff7aa8', '#5ad1e6'];
const DEFAULT_SEATS = [
  { id: 'claude', name: 'Claude', role: 'Builder', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', color: COLORS[0] },
  { id: 'luna', name: 'Luna', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'medium', color: COLORS[1] },
  { id: 'sol', name: 'Sol', role: 'Architect', agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', color: COLORS[2] },
  { id: 'astra', name: 'Astra', role: "Devil's advocate", agent: 'codex', model: 'gpt-6-astra', effort: 'medium', color: COLORS[3] },
];
// Seat fields written to .orchestra/seats.json (runtime status is never persisted).
const PERSISTED = ['id', 'name', 'role', 'agent', 'model', 'effort', 'perm', 'target', 'budget', 'color', 'thread', 'used', 'cached', 'cost'];

// Lean launch: no user plugins, MCP servers, skills, hooks or extra tool families. Measured on 2026-10-07:
// Claude baseline 36k → 6.7k tokens (no tools), Codex 24k → 15k.
// Two parts. ISOLATION keeps the user's and the project's own CLI config (MCP servers, hooks, permission allow rules,
// notify programs, plugins) out of a seat: it is part of the read-only guarantee and stays on in every mode, the naive
// benchmark baseline included (which also keeps that baseline independent of each machine's personal config).
// TOKEN levers only trim the prompt and are what ORCHESTRA_NAIVE=1 turns off.
const CLAUDE_ISOLATION = ['--strict-mcp-config', '--setting-sources', ''];
const CLAUDE_TOKEN = ['--disable-slash-commands', '--exclude-dynamic-system-prompt-sections'];
// project_doc_max_bytes=0: no project AGENTS.md (from the git root down to the cwd) is injected into a seat's thread.
// $CODEX_HOME/AGENTS.md is NOT covered by any flag here (--ignore-user-config skips only config.toml): see README.
const CODEX_ISOLATION = ['--ignore-user-config', '-c', 'features.hooks=false', '-c', 'project_doc_max_bytes=0'];
const CODEX_TOKEN = [...['apps', 'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'memories', 'plugins']
  .flatMap((f) => ['-c', `features.${f}=false`]), '-c', 'web_search="disabled"'];
const CODEX_LEAN = [...CODEX_ISOLATION, ...CODEX_TOKEN];
const CLAUDE_LEAN = [...CLAUDE_ISOLATION, ...CLAUDE_TOKEN];
// tools mode: 'none' (discussion), 'read' (look at code), 'write' (seat must allow it).
const CLAUDE_TOOLS = { none: [''], read: ['Read', 'Grep', 'Glob'], write: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] };
// A tiny Haiku call is the only way to get Claude's rate_limit_event; it costs under $0.01 (lean launch, ~7k tokens).
// Claude Haiku 5.5 is the cheap default: the usage probe and the default model of a Claude scout (New session).
// The CLI prints an 'unrecognized_model' warning for this id on some builds; the call still succeeds, and warnings on
// stderr or non-JSON lines are never read as errors (the turn fails only without a completed result).
// Not verified against the real CLI yet: if the 5.5 probe ends in an error result without a rate_limit_event, the
// usage probe retries once with CLAUDE_PROBE_FALLBACK_MODEL (the id the probe used before 5.5, known to work).
const CLAUDE_CHEAP_MODEL = 'claude-haiku-5-5';
const CLAUDE_PROBE_MODEL = CLAUDE_CHEAP_MODEL;
const CLAUDE_PROBE_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
// The cheap Codex model doctor --containment runs at low effort. Provisional (plan Q4): no real run has confirmed it is
// the cheapest model that still follows the check prompt. It must stay in MODELS.codex.
const CODEX_CHEAP_MODEL = 'gpt-6-luna';

// CLI executables; overridable so tests can point at fake CLIs.
const claudeBin = () => process.env.ORCHESTRA_CLAUDE_BIN || 'claude';
const codexBin = () => process.env.ORCHESTRA_CODEX_BIN || 'codex';

// capEffort (absent or true): Debate discussion rounds run at most at 'medium' effort; false = every turn uses the seat's own effort.
const defaultSettings = () => ({ lang: process.env.ORCHESTRA_LANG || 'English' });

// ORCHESTRA_NAIVE=1: the un-optimized baseline, used only by the token benchmark to measure what the token-lean
// design saves. It disables the scout brief, the token part of the lean CLI flags (CLAUDE_TOKEN / CODEX_TOKEN; the
// isolation flags stay), unseen-only transcripts (every discussion turn gets the whole transcript) and early stop (both
// STANCE: CONVERGED early stop and silent agreement). Never set it for real use: the same meeting costs several times
// more tokens.
const naive = () => process.env.ORCHESTRA_NAIVE === '1';
const claudeLean = () => (naive() ? CLAUDE_ISOLATION : CLAUDE_LEAN);
const codexLean = () => (naive() ? CODEX_ISOLATION : CODEX_LEAN);

// Turn robustness. A transient failure (rate limit, overloaded, 429/5xx, connection reset, idle watchdog) retries
// the same turn up to RETRY_DELAYS_MS.length times, waiting these delays first. ORCHESTRA_RETRY_DELAYS_MS
// (comma-separated ms, e.g. "50,50"; "" = no retries) overrides them (the test suite uses short delays).
const RETRY_DELAYS_MS = [3000, 10000];
function retryDelays() {
  const v = process.env.ORCHESTRA_RETRY_DELAYS_MS;
  if (v === undefined) return RETRY_DELAYS_MS;
  return String(v).split(',').map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 5);
}
// Idle watchdog: a running turn that prints nothing (stdout or stderr) for this long is killed (process tree). The
// runner retries such a turn at most once. Minutes, from settings.idleMinutes, else ORCHESTRA_IDLE_MINUTES, else 5
// (10 for Codex, whose `exec --json` stays silent while it reasons and while a shell command runs). 0 or "off"
// disables the watchdog. High reasoning effort thinks silently for longer: x2 for high, x3 for xhigh/max.
// -> ms (0 = no watchdog), never above setTimeout's limit (a larger delay would fire after 1 ms).
const IDLE_MINUTES = 5;
const IDLE_MINUTES_BY_AGENT = { codex: 10 };
const EFFORT_IDLE_FACTOR = { high: 2, xhigh: 3, max: 3 };
const MAX_TIMEOUT_MS = 2147483647;
function idleTimeoutMs(effort, settings = null, agent = null) {
  let pick = null;
  for (const v of [settings?.idleMinutes, process.env.ORCHESTRA_IDLE_MINUTES]) {
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) continue;
    if (/^\s*off\s*$/i.test(String(v))) return 0;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) { pick = n; break; }
  }
  if (pick === 0) return 0;
  const minutes = pick ?? IDLE_MINUTES_BY_AGENT[agent] ?? IDLE_MINUTES;
  return Math.min(MAX_TIMEOUT_MS, Math.round(minutes * 60000 * (EFFORT_IDLE_FACTOR[effort] || 1)));
}
const defaultSeats = () => DEFAULT_SEATS.map((s) => ({ perm: 'read', target: '', budget: 0, thread: null, used: 0, cost: 0, ...s }));

module.exports = {
  DEFAULT_PORT, MODELS, EFFORTS, COLORS, DEFAULT_SEATS, PERSISTED,
  CODEX_LEAN, CLAUDE_LEAN, CLAUDE_ISOLATION, CODEX_ISOLATION, CLAUDE_TOKEN, CODEX_TOKEN, CLAUDE_TOOLS, CLAUDE_PROBE_MODEL, CLAUDE_PROBE_FALLBACK_MODEL, CLAUDE_CHEAP_MODEL, CODEX_CHEAP_MODEL,
  claudeBin, codexBin, defaultSettings, defaultSeats,
  naive, claudeLean, codexLean, RETRY_DELAYS_MS, retryDelays, IDLE_MINUTES, idleTimeoutMs,
};
