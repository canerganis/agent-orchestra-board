// Static configuration: models, efforts, default seats, lean CLI flags, settings defaults and env overrides.
const DEFAULT_PORT = 4317;

const MODELS = {
  codex: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'],
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
const CODEX_LEAN = ['--ignore-user-config', ...['apps', 'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'memories', 'plugins', 'hooks']
  .flatMap((f) => ['-c', `features.${f}=false`]), '-c', 'web_search="disabled"'];
const CLAUDE_LEAN = ['--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--exclude-dynamic-system-prompt-sections'];
// tools mode: 'none' (discussion), 'read' (look at code), 'write' (seat must allow it).
const CLAUDE_TOOLS = { none: [''], read: ['Read', 'Grep', 'Glob'], write: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] };
// A tiny Haiku call is the only way to get Claude's rate_limit_event; it costs a few cents at most.
const CLAUDE_PROBE_MODEL = 'claude-haiku-4-5-20251001';

// CLI executables; overridable so tests can point at fake CLIs.
const claudeBin = () => process.env.ORCHESTRA_CLAUDE_BIN || 'claude';
const codexBin = () => process.env.ORCHESTRA_CODEX_BIN || 'codex';

const defaultSettings = () => ({ lang: process.env.ORCHESTRA_LANG || 'English' });
const defaultSeats = () => DEFAULT_SEATS.map((s) => ({ perm: 'read', target: '', budget: 0, thread: null, used: 0, cost: 0, ...s }));

module.exports = {
  DEFAULT_PORT, MODELS, EFFORTS, COLORS, DEFAULT_SEATS, PERSISTED,
  CODEX_LEAN, CLAUDE_LEAN, CLAUDE_TOOLS, CLAUDE_PROBE_MODEL,
  claudeBin, codexBin, defaultSettings, defaultSeats,
};
