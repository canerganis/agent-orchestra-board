// Claude Code workflow journal reducer (plan 4.1 to 4.5). Pure: no file, network or clock access.
// The watcher reads the files and passes every time in.
//
// Every input is untrusted file content. Only labels, phases, models, statuses, counts, token figures and
// tool names are kept. Prompt, result, script, log, argument, error and preview text is never stored: a
// result keeps its shape and encoded size only.
//
// Journal heads: a line over the tail cap arrives as { type, key, agentId, oversized: true }, built from the
// matched fields. It marks its agent done or failed like a full line, with result shape 'oversized'.
//
// State and agent objects are plain data. Internal bookkeeping (usage per message id, tool ids, flags)
// lives in WeakMaps, so JSON.stringify of a state or agent shows only the public fields.

const AGENT_ID_RE = /^a\w{8,40}$/;
const RUN_ID_RE = /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/;
const RUN_ID_FALLBACK_RE = /^wf_[\w-]{1,40}$/;

// Status windows from plan 4.4, in milliseconds.
const SETTLE_MS = 5 * 1000;        // a summary is final when nothing changed more than this after its timestamp
const RUNNING_MS = 2 * 60 * 1000;  // a change less than this old means running
const IDLE_MS = 15 * 60 * 1000;    // a change at most this old (and not running) means idle

const TEXT_MAX = 200;
const TOOL_MAX = 100;
const MODEL_MAX = 80;
const KEY_MAX = 300;
const MSG_ID_MAX = 200;
const PHASES_MAX = 200;
const PROGRESS_MAX = 2000;

// Model precedence: the agent's own meta file beats the transcript, which beats the run default.
const MODEL_RANK = { default: 1, transcript: 2, meta: 3 };

const AGENT_DEFAULTS = {
  id: null, key: null, label: null, phase: null, model: null, status: 'stopped', attempt: 1,
  startedAt: null, lastActivityAt: null, endedAt: null, tokens: 0, net: 0, toolCalls: 0, lastTool: null,
};

const stateData = new WeakMap();
const agentData = new WeakMap();

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = TEXT_MAX) => (typeof v === 'string' ? (v.replace(/\s+/g, ' ').trim().slice(0, max) || null) : null);
const keyOf = (v) => (typeof v === 'string' && v !== '' && v.length <= KEY_MAX ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tokenCount = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const msOf = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const agentIdOf = (v) => (typeof v === 'string' && AGENT_ID_RE.test(v) ? v : null);

function stateInfo(state) {
  let d = stateData.get(state);
  if (!d) { d = { byId: new Map(), byKey: new Map(), progressTokens: new Map(), live: false }; stateData.set(state, d); }
  return d;
}

function agentInfo(agent) {
  let d = agentData.get(agent);
  if (!d) {
    d = { live: false, done: false, failed: false, superseded: false, result: null,
      usage: new Map(), toolIds: new Set(), snapshot: null, progressTokens: null, modelSource: null };
    agentData.set(agent, d);
  }
  return d;
}

// Fills RunAgent fields that a caller left undefined, so the apply functions never produce NaN.
function ensureFields(agent) {
  for (const k of Object.keys(AGENT_DEFAULTS)) if (agent[k] === undefined) agent[k] = AGENT_DEFAULTS[k];
}

function setModel(agent, model, source) {
  const current = agentInfo(agent).modelSource;
  if (current !== null && MODEL_RANK[current] > MODEL_RANK[source]) return;
  agent.model = model;
  agentInfo(agent).modelSource = source;
}

// Status from the internal flags (plan 4.4). A result is done; a failed line is failed; an attempt whose
// key was started again later is retried; anything else is running while the run is live, else stopped.
function agentStatus(agent, runLive) {
  const ai = isObj(agent) ? agentInfo(agent) : {};
  if (ai.done) return 'done';
  if (ai.failed) return 'failed';
  if (ai.superseded) return 'retried';
  return runLive === true ? 'running' : 'stopped';
}

function refreshAgent(agent) {
  agent.status = agentStatus(agent, agentInfo(agent).live);
  agent.endedAt = agent.status === 'running' ? null : agent.lastActivityAt;
}

// Shape and encoded size of a result. The result itself is never kept.
function resultShape(item) {
  if (item.oversized === true) return { shape: 'oversized', size: null };
  if (!('result' in item)) return { shape: 'missing', size: null };
  const v = item.result;
  const shape = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  let size = null;
  try {
    const encoded = JSON.stringify(v);
    if (typeof encoded === 'string') size = Buffer.byteLength(encoded, 'utf8');
  } catch { size = null; }
  return { shape, size };
}

// Puts an agent under its key. A started line supersedes every earlier attempt with the same key.
function attach(state, agent, key, supersede) {
  agent.key = key;
  if (key === null) { agent.attempt = 1; return; }
  const info = stateInfo(state);
  const list = info.byKey.get(key) || [];
  if (supersede) {
    for (const prev of list) { agentInfo(prev).superseded = true; refreshAgent(prev); }
  }
  list.push(agent);
  info.byKey.set(key, list);
  agent.attempt = list.length;
}

function addRecord(state, id, item, supersede) {
  const info = stateInfo(state);
  const agent = {
    id, key: null, label: text(item.label), phase: text(item.phase), model: null, status: 'stopped', attempt: 1,
    startedAt: null, lastActivityAt: null, endedAt: null, tokens: 0, net: 0, toolCalls: 0, lastTool: null,
  };
  const ai = agentInfo(agent);
  ai.live = info.live;
  if (id) {
    info.byId.set(id, agent);
    if (info.progressTokens.has(id)) { ai.progressTokens = info.progressTokens.get(id); agent.tokens = ai.progressTokens; }
  }
  if (state.defaultModel) setModel(agent, state.defaultModel, 'default');
  attach(state, agent, keyOf(item.key), supersede);
  state.agents.push(agent);
  refreshAgent(agent);
  return agent;
}

// A started line for an agent that a result line created first: fills the fields the result did not carry.
function claim(state, agent, item) {
  if (!agent.label) agent.label = text(item.label);
  if (!agent.phase) agent.phase = text(item.phase);
  if (agent.key === null) attach(state, agent, keyOf(item.key), true);
  refreshAgent(agent);
}

function newRunState(opts = {}) {
  const o = isObj(opts) ? opts : {};
  const state = {
    id: typeof o.id === 'string' ? o.id : null,
    project: typeof o.project === 'string' ? o.project.slice(0, 4096) : null,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId.slice(0, 200) : null,
    title: null,
    status: 'unknown',
    launched: false,
    defaultModel: null,
    summary: null,
    linkedRoomId: null,
    agents: [],
  };
  stateInfo(state);
  return state;
}

// Applies one journal line or one oversized head. Mutates and returns the state.
// Lines with an invalid agent id are ignored. A failed line without an id is kept under its key.
function reduceJournal(state, item) {
  if (!isObj(state) || !isObj(item)) return state;
  const info = stateInfo(state);
  switch (item.type) {
    case 'launched':
      state.launched = true;
      break;
    case 'started': {
      const id = agentIdOf(item.agentId);
      if (!id) break;
      const known = info.byId.get(id);
      if (known) claim(state, known, item);
      else addRecord(state, id, item, true);
      break;
    }
    case 'result': {
      let id = null;
      if (typeof item.agentId === 'string' && item.agentId !== '') {
        id = agentIdOf(item.agentId);
        if (!id) break;
      }
      const agent = (id && info.byId.get(id)) || addRecord(state, id, item, false);
      const ai = agentInfo(agent);
      ai.done = true;
      ai.result = resultShape(item);
      refreshAgent(agent);
      break;
    }
    case 'failed': {
      // An empty agentId is never run through the id check: the failure is kept without an id.
      const id = agentIdOf(item.agentId);
      const agent = (id && info.byId.get(id)) || addRecord(state, id, item, false);
      agentInfo(agent).failed = true;
      refreshAgent(agent);
      break;
    }
    default:
      break;
  }
  return state;
}

// Applies an agent-<id>.meta.json. mtimeMs is the meta file's mtime, which becomes startedAt once.
function applyMeta(agent, meta, defaultModel, mtimeMs) {
  if (!isObj(agent) || !isObj(meta)) return agent;
  ensureFields(agent);
  if (!agent.label) agent.label = text(meta.description);
  if (!agent.phase) agent.phase = text(meta.workflowPhase);
  const own = text(meta.model, MODEL_MAX);
  const fallback = text(defaultModel, MODEL_MAX);
  if (own) setModel(agent, own, 'meta');
  else if (fallback) setModel(agent, fallback, 'default');
  const started = num(mtimeMs);
  if (!agent.startedAt && started !== null) agent.startedAt = started;
  refreshAgent(agent);
  return agent;
}

// Applies one line of agent-<id>.jsonl, in file order.
// tokens: the last assistant line's input + cache creation + cache read + output, unless the summary has a
// figure for this agent. net: per message id, the last usage seen, counting input + cache creation + output.
// Cache reads are left out of net and summed nowhere else.
function applyTranscriptLine(agent, line) {
  if (!isObj(agent) || !isObj(line)) return agent;
  ensureFields(agent);
  const ai = agentInfo(agent);
  const t = msOf(line.timestamp);
  if (t !== null && (agent.lastActivityAt === null || t > agent.lastActivityAt)) agent.lastActivityAt = t;
  const m = isObj(line.message) ? line.message : null;
  if (m) {
    const model = text(m.model, MODEL_MAX);
    if (model) setModel(agent, model, 'transcript');
    const usage = isObj(m.usage) ? m.usage : null;
    if (usage && (line.type === 'assistant' || m.role === 'assistant')) applyUsage(agent, ai, m, usage);
    if (Array.isArray(m.content)) applyToolUses(agent, ai, m.content);
  }
  refreshAgent(agent);
  return agent;
}

function applyUsage(agent, ai, m, usage) {
  const input = tokenCount(usage.input_tokens);
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const output = tokenCount(usage.output_tokens);
  ai.snapshot = input + cacheWrite + cacheRead + output;
  agent.tokens = ai.progressTokens !== null ? ai.progressTokens : ai.snapshot;
  if (typeof m.id !== 'string' || m.id === '' || m.id.length > MSG_ID_MAX) return;
  const prev = ai.usage.get(m.id);
  const prevNet = prev ? prev.input + prev.cacheWrite + prev.output : 0;
  ai.usage.set(m.id, { input, cacheWrite, output });
  agent.net += input + cacheWrite + output - prevNet;
}

// A streamed transcript repeats a tool_use block on several lines; the tool id counts once.
function applyToolUses(agent, ai, content) {
  for (const b of content) {
    if (!isObj(b) || b.type !== 'tool_use') continue;
    if (typeof b.id === 'string' && b.id !== '' && b.id.length <= MSG_ID_MAX) {
      if (ai.toolIds.has(b.id)) continue;
      ai.toolIds.add(b.id);
    }
    agent.toolCalls += 1;
    const name = text(b.name, TOOL_MAX);
    if (name) agent.lastTool = name;
  }
}

// Whitelist of one workflowProgress entry (plan 4.1). The two preview fields, and the error and lastToolSummary
// text, are dropped with everything else that is not listed here.
function progressFields(p) {
  return {
    type: text(p.type, 40),
    index: num(p.index),
    label: text(p.label),
    phaseIndex: num(p.phaseIndex),
    phaseTitle: text(p.phaseTitle),
    agentId: agentIdOf(p.agentId),
    model: text(p.model, MODEL_MAX),
    state: text(p.state, 40),
    startedAt: num(p.startedAt),
    queuedAt: num(p.queuedAt),
    attempt: num(p.attempt),
    lastToolName: text(p.lastToolName, TOOL_MAX),
    lastProgressAt: num(p.lastProgressAt),
    tokens: num(p.tokens),
    toolCalls: num(p.toolCalls),
    durationMs: num(p.durationMs),
    cached: typeof p.cached === 'boolean' ? p.cached : null,
    isolation: text(p.isolation, 40),
    promptFramed: typeof p.promptFramed === 'boolean' ? p.promptFramed : null,
  };
}

// Whitelist of a <session>/workflows/<runId>.json summary (plan 4.1).
function summaryFields(json) {
  if (!isObj(json)) return null;
  const phases = Array.isArray(json.phases)
    ? json.phases.slice(0, PHASES_MAX).filter(isObj).map((p) => ({ title: text(p.title) }))
    : [];
  const workflowProgress = Array.isArray(json.workflowProgress)
    ? json.workflowProgress.slice(0, PROGRESS_MAX).filter(isObj).map(progressFields)
    : [];
  return {
    runId: text(json.runId, 64),
    workflowName: text(json.workflowName),
    status: text(json.status, 40),
    startTime: num(json.startTime),
    timestamp: text(json.timestamp, 40),
    durationMs: num(json.durationMs),
    agentCount: num(json.agentCount),
    defaultModel: text(json.defaultModel, MODEL_MAX),
    totalTokens: num(json.totalTokens),
    phases,
    workflowProgress,
  };
}

// Applies the summary. Its per-agent tokens take precedence over transcript snapshots, from now on and for
// agents that appear later. Its defaultModel fills any agent without a model of its own.
function applySummary(state, json) {
  if (!isObj(state)) return state;
  const fields = summaryFields(json);
  if (!fields) return state;
  const info = stateInfo(state);
  state.summary = fields;
  if (fields.defaultModel) state.defaultModel = fields.defaultModel;
  info.progressTokens = new Map();
  for (const p of fields.workflowProgress) {
    if (p.agentId && p.tokens !== null) info.progressTokens.set(p.agentId, p.tokens);
  }
  for (const agent of state.agents) {
    const ai = agentInfo(agent);
    if (state.defaultModel) setModel(agent, state.defaultModel, 'default');
    const figure = agent.id ? info.progressTokens.get(agent.id) : undefined;
    ai.progressTokens = figure === undefined ? null : figure;
    if (ai.progressTokens !== null) agent.tokens = ai.progressTokens;
    else if (ai.snapshot !== null) agent.tokens = ai.snapshot;
    refreshAgent(agent);
  }
  return state;
}

// Run status (plan 4.4). lastChangeMs is the newest change of the run's own files: journal, agent transcripts
// and the agents' meta files. Do not include the main session transcript: it keeps growing after a run ends.
// Without a finite lastChangeMs nothing is claimed, so the result is unknown.
function deriveRunStatus(input = {}) {
  const o = isObj(input) ? input : {};
  const last = num(o.lastChangeMs);
  if (last === null) return 'unknown';
  const summary = isObj(o.summary) ? o.summary : null;
  const ended = summary ? msOf(summary.timestamp) : null;
  if (ended !== null && last - ended <= SETTLE_MS) {
    if (summary.status === 'completed') return 'completed';
    if (summary.status === 'killed') return 'killed';
    return 'unknown';
  }
  const now = num(o.now);
  if (now === null) return 'unknown';
  const age = now - last;
  if (age < RUNNING_MS) return 'running';
  if (age <= IDLE_MS) return 'idle';
  return 'unknown';
}

// Sets the run status and refreshes every agent's status. running and idle count as live.
function setRunStatus(state, status) {
  if (!isObj(state)) return state;
  state.status = typeof status === 'string' ? status : 'unknown';
  const live = state.status === 'running' || state.status === 'idle';
  stateInfo(state).live = live;
  for (const agent of state.agents) {
    agentInfo(agent).live = live;
    refreshAgent(agent);
  }
  return state;
}

// RunSummary (plan section 3.1 and 4.6). Built from the state only; contains no text beyond labels and phases.
function runSummary(state) {
  if (!isObj(state)) return null;
  const sum = isObj(state.summary) ? state.summary : null;
  const finished = state.status === 'completed' || state.status === 'killed';
  const endedAt = finished && sum ? msOf(sum.timestamp) : null;
  let lastActivityAt = endedAt;
  let startedMin = null;
  let agentTokens = 0;
  let done = 0;
  let failed = 0;
  const phases = [];
  for (const a of state.agents) {
    if (a.lastActivityAt !== null && (lastActivityAt === null || a.lastActivityAt > lastActivityAt)) lastActivityAt = a.lastActivityAt;
    if (a.startedAt !== null && (startedMin === null || a.startedAt < startedMin)) startedMin = a.startedAt;
    agentTokens += a.tokens;
    if (a.status === 'done') done += 1;
    if (a.status === 'failed') failed += 1;
    if (a.phase && !phases.includes(a.phase)) phases.push(a.phase);
  }
  const summaryPhases = sum ? sum.phases.map((p) => p.title).filter(Boolean) : [];
  return {
    id: state.id,
    engine: 'claude-code',
    title: (sum && sum.workflowName) || state.title || null,
    project: state.project,
    sessionId: state.sessionId,
    status: state.status,
    startedAt: sum && sum.startTime !== null ? sum.startTime : startedMin,
    lastActivityAt,
    endedAt,
    agentCount: sum && sum.agentCount !== null ? sum.agentCount : state.agents.length,
    done,
    failed,
    tokens: sum && sum.totalTokens !== null ? sum.totalTokens : agentTokens,
    phases: summaryPhases.length ? summaryPhases : phases,
    linkedRoomId: state.linkedRoomId,
  };
}

function agentById(state, id) {
  if (!isObj(state) || typeof id !== 'string') return null;
  return stateInfo(state).byId.get(id) || null;
}

// { shape, size } of an agent's result line, or null when no result has been seen.
function agentResult(agent) {
  return isObj(agent) ? agentInfo(agent).result : null;
}

// Project folder name under <claudeHome>/projects: every character outside A-Za-z0-9 becomes '-'.
// Used as a name prefilter only; membership is confirmed by the session cwd.
function encodeProjectDir(dir) {
  return typeof dir === 'string' ? dir.replace(/[^A-Za-z0-9]/g, '-') : '';
}

const isAgentId = (v) => agentIdOf(v) !== null;
const isRunId = (v) => typeof v === 'string' && (RUN_ID_RE.test(v) || RUN_ID_FALLBACK_RE.test(v));

module.exports = {
  AGENT_ID_RE, RUN_ID_RE, SETTLE_MS, RUNNING_MS, IDLE_MS,
  isAgentId, isRunId, encodeProjectDir,
  newRunState, reduceJournal, applyMeta, applyTranscriptLine, applySummary, summaryFields,
  deriveRunStatus, setRunStatus, agentStatus, runSummary, agentById, agentResult,
};
