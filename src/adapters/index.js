// Adapter registry: one entry per agent CLI, all with the same shape for the board and the contract tests.
// Each entry: { name, MODELS, readOnly, buildArgs(opts), parseLine(line) }.
//   name:      the registry key.
//   MODELS:    non-empty array of model ids the CLI accepts for a seat.
//   readOnly:  one sentence on how a read-only turn is enforced.
//   buildArgs: argv array for one turn. Options: model, effort, mode ('read' | 'write' | 'none'), plus per-CLI
//              fields (claude: thread, sessionId, addDir; antigravity: prompt, required, resumeId; cursor: prompt, required).
//   parseLine: normalized events for one stdout line (see docs/adapters.md).
const config = require('../config');
const claude = require('./claude');
const codex = require('./codex');
const antigravity = require('./antigravity');
const cursor = require('./cursor');

// claude and codex parse with a stateful createParser (the runner uses that). parseLine is a stateless view of a
// single line, built on the same parser, for tooling and contract checks. Cross-line state is not kept here.
function lineParser(mod) {
  return (line) => {
    const out = [];
    const parser = mod.createParser({
      thread: (id) => out.push({ type: 'thread', id }),
      delta: (text) => { if (text) out.push({ type: 'text', text }); },
      toolUse: (t) => out.push({ type: 'tool', ...t }),
      usage: (u) => out.push({ type: 'usage', ...u }),
      error: (message) => out.push({ type: 'error', message, fatal: true }),
      completed: (c) => out.push({ type: 'done', result: c.result }),
    });
    parser.feed(`${String(line ?? '')}\n`);
    parser.end();
    return out;
  };
}

const registry = {
  claude: {
    name: 'claude',
    MODELS: config.MODELS.claude,
    readOnly: 'claude -p with --permission-mode dontAsk and --tools limited to Read, Grep and Glob, so any other tool is denied without a prompt.',
    buildArgs: claude.buildArgs,
    parseLine: lineParser(claude),
  },
  codex: {
    name: 'codex',
    MODELS: config.MODELS.codex,
    readOnly: 'codex exec with sandbox_mode read-only, so the sandbox blocks writes outside the read set.',
    buildArgs: codex.buildArgs,
    parseLine: lineParser(codex),
  },
  antigravity: {
    name: 'antigravity',
    MODELS: antigravity.AGY_MODELS,
    readOnly: 'agy -p with --mode plan and --sandbox, and never --dangerously-skip-permissions, --add-dir or accept-edits. Verified against one real turn of agy 1.2.17.',
    buildArgs: antigravity.buildArgs,
    parseLine: antigravity.parseLine,
  },
  cursor: {
    name: 'cursor',
    MODELS: cursor.CURSOR_MODELS,
    readOnly: 'cursor-agent --mode ask with --sandbox enabled, and never --force or --yolo. UNVERIFIED until tested with the real CLI.',
    buildArgs: cursor.buildArgs,
    parseLine: cursor.parseLine,
  },
};

// Structural check of one adapter. Returns the list of problems (an empty array means the adapter is valid).
function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') return ['adapter must be an object'];
  const errors = [];
  if (typeof adapter.name !== 'string' || !adapter.name) errors.push('name must be a non-empty string');
  if (typeof adapter.buildArgs !== 'function') errors.push('buildArgs must be a function');
  if (typeof adapter.parseLine !== 'function') errors.push('parseLine must be a function');
  if (!Array.isArray(adapter.MODELS) || adapter.MODELS.length === 0 || !adapter.MODELS.every((m) => typeof m === 'string' && m)) {
    errors.push('MODELS must be a non-empty array of model id strings');
  }
  if (typeof adapter.readOnly !== 'string' || !adapter.readOnly.trim()) errors.push('readOnly must be a non-empty description string');
  return errors;
}

module.exports = { registry, validateAdapter };
