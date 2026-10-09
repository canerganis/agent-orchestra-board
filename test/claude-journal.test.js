// Claude journal reducer (F3). Synthetic fixtures in test/fixtures/claude-wf plus inline lines.
// Canary strings sit in every text field the reducer must drop (prompts, results, scripts, logs, arguments,
// errors, previews, tool inputs). No output may contain one. Labels, phases and models are kept and carry none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  newRunState, reduceJournal, applyMeta, applyTranscriptLine, applySummary, summaryFields,
  deriveRunStatus, setRunStatus, agentStatus, runSummary, agentById, agentResult, encodeProjectDir,
  isAgentId, isRunId, SETTLE_MS, RUNNING_MS, IDLE_MS,
} = require('../src/watch/claude-journal');

const FIX = path.join(__dirname, 'fixtures', 'claude-wf');
const RUN_ID = 'wf_0a1b2c3d-e4f';
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-08T10:00:00.000Z');
const META_MTIME = Date.parse('2026-10-08T09:59:58.000Z');
const at = (hms) => Date.parse(`2026-10-08T${hms}`);

const ID1 = 'a11111111111';
const ID2 = 'a22222222222';
const ID3 = 'a33333333333';

const RUN_AGENT_KEYS = ['id', 'key', 'label', 'phase', 'model', 'status', 'attempt', 'startedAt', 'lastActivityAt',
  'endedAt', 'tokens', 'net', 'toolCalls', 'lastTool'];
const RUN_SUMMARY_KEYS = ['id', 'engine', 'title', 'project', 'sessionId', 'status', 'startedAt', 'lastActivityAt',
  'endedAt', 'agentCount', 'done', 'failed', 'tokens', 'phases', 'linkedRoomId'];

const started = (agentId, key, extra = {}) => ({ type: 'started', key, agentId, label: key, phase: 'Build', ...extra });
const finished = (agentId, key, result = 'plain result text') => ({ type: 'result', key, agentId, result });
const usageOf = (input, cacheWrite, cacheRead, output) => ({
  input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output,
});
const assistantLine = (timestamp, messageId, u, { model, content = [] } = {}) => ({
  type: 'assistant', timestamp, isSidechain: true,
  message: { id: messageId, type: 'message', role: 'assistant', ...(model ? { model } : {}), content, usage: u },
});
const userLine = (timestamp, text = 'user text') => ({ type: 'user', timestamp, message: { role: 'user', content: text } });
const toolUse = (id, name) => ({ type: 'tool_use', id, name, input: { file_path: 'secret/path.txt' } });

const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const jsonl = (name) => read(name).split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
const summaryJson = () => JSON.parse(read('summary.json'));

// Replays the fixture run the way the watcher will: journal, meta files, transcripts, then the summary.
// summaryFirst reverses the last and first steps, which must not change the result.
function loadFixtureRun({ summaryFirst = false, withSummary = true } = {}) {
  const state = newRunState({ id: RUN_ID, project: 'C:\\fixture\\project', sessionId: 'fixture-session' });
  const applyJournal = () => { for (const line of jsonl('journal.jsonl')) reduceJournal(state, line); };
  const applyMetas = () => {
    for (const f of fs.readdirSync(FIX).filter((n) => n.endsWith('.meta.json'))) {
      const id = f.slice('agent-'.length, -'.meta.json'.length);
      applyMeta(agentById(state, id), JSON.parse(read(f)), state.defaultModel, META_MTIME);
    }
  };
  const applyTranscripts = () => {
    for (const f of fs.readdirSync(FIX).filter((n) => /^agent-.*\.jsonl$/.test(n))) {
      const id = f.slice('agent-'.length, -'.jsonl'.length);
      for (const line of jsonl(f)) applyTranscriptLine(agentById(state, id), line);
    }
  };
  if (summaryFirst && withSummary) applySummary(state, summaryJson());
  applyJournal();
  applyMetas();
  applyTranscripts();
  if (!summaryFirst && withSummary) applySummary(state, summaryJson());
  return state;
}

test('encodeProjectDir: every character outside A-Za-z0-9 becomes a dash; non-strings give an empty name', () => {
  assert.equal(encodeProjectDir('C:\\Users\\can02\\Projects\\Crashendo'), 'C--Users-can02-Projects-Crashendo');
  assert.equal(encodeProjectDir('C:/Users/can02/Projects/Crashendo/orchestra-board'), 'C--Users-can02-Projects-Crashendo-orchestra-board');
  assert.equal(encodeProjectDir('/home/me/my project'), '-home-me-my-project');
  assert.equal(encodeProjectDir(undefined), '');
});

test('id checks: agent ids and run ids follow the plan patterns and reject path-like values', () => {
  assert.equal(isAgentId('a3f9c2e1b7d4a8e6'), true);
  assert.equal(isAgentId('a' + '1'.repeat(8)), true, 'eight characters after the a is the minimum');
  for (const bad of ['', 'a1', 'b3f9c2e1b7d4a8e6', '../../x', 'a3f9 c2e1b7d4', 'a'.repeat(50), null, 42]) {
    assert.equal(isAgentId(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(isRunId('wf_0a1b2c3d-e4f'), true);
  assert.equal(isRunId('wf_build-run_1'), true, 'the fallback pattern');
  assert.equal(isRunId('wf_../x'), false);
  assert.equal(isRunId('run_0a1b2c3d-e4f'), false);
});

test('reduceJournal: launched marks the run; started creates a RunAgent with exactly the plan fields', () => {
  const s = newRunState({ id: RUN_ID, project: '/p', sessionId: 's1' });
  assert.equal(reduceJournal(s, { type: 'launched' }), s);
  assert.equal(s.launched, true);
  assert.equal(s.agents.length, 0);
  reduceJournal(s, started(ID1, 'build:I1:haiku'));
  const a = s.agents[0];
  assert.deepEqual(Object.keys(a), RUN_AGENT_KEYS);
  assert.equal(a.id, ID1);
  assert.equal(a.key, 'build:I1:haiku');
  assert.equal(a.label, 'build:I1:haiku');
  assert.equal(a.phase, 'Build');
  assert.equal(a.attempt, 1);
  assert.equal(a.tokens, 0);
  assert.equal(a.net, 0);
  assert.equal(a.toolCalls, 0);
  assert.equal(a.lastTool, null);
  assert.equal(a.status, 'stopped', 'no run status yet, so not live');
  setRunStatus(s, 'running');
  assert.equal(s.agents[0].status, 'running');
});

test('reduceJournal: lines with an unusable agent id are ignored, and so is a result with one', () => {
  const s = newRunState();
  for (const bad of ['', 'x', 'a12', '../a3f9c2e1b7d4a8e6', 'a3f9 c2e1b7d4', 42, undefined]) {
    reduceJournal(s, started(bad, 'k'));
  }
  reduceJournal(s, { type: 'result', key: 'k', agentId: '../x', result: 'r' });
  assert.equal(s.agents.length, 0);
});

test('reduceJournal: a duplicate started line for the same id changes nothing', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  reduceJournal(s, started(ID1, 'k1'));
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].attempt, 1);
});

test('retried key: a key started again later marks the earlier attempt retried, with attempt numbers', () => {
  const s = newRunState();
  setRunStatus(s, 'running');
  reduceJournal(s, started(ID1, 'build:I3:haiku'));
  reduceJournal(s, started(ID2, 'build:I3:haiku'));
  const [first, second] = s.agents;
  assert.equal(first.status, 'retried');
  assert.equal(first.attempt, 1);
  assert.equal(second.status, 'running');
  assert.equal(second.attempt, 2);
});

test('string and object results mark the agent done and keep only shape and size', () => {
  const s = newRunState();
  const text = 'plain result text';
  const obj = { verdict: 'pass', items: [1, 2] };
  reduceJournal(s, started(ID1, 'k1'));
  reduceJournal(s, started(ID2, 'k2'));
  reduceJournal(s, started(ID3, 'k3'));
  reduceJournal(s, finished(ID1, 'k1', text));
  reduceJournal(s, finished(ID2, 'k2', obj));
  reduceJournal(s, finished(ID3, 'k3', [1, 2, 3]));
  assert.deepEqual(s.agents.map((a) => a.status), ['done', 'done', 'done']);
  assert.deepEqual(agentResult(s.agents[0]), { shape: 'string', size: Buffer.byteLength(JSON.stringify(text)) });
  assert.deepEqual(agentResult(s.agents[1]), { shape: 'object', size: Buffer.byteLength(JSON.stringify(obj)) });
  assert.equal(agentResult(s.agents[2]).shape, 'array');
  assert.equal(JSON.stringify(s).includes(text), false, 'the result text is never stored');
});

test('an oversized result head marks the agent done; a head without a result still marks it done', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  reduceJournal(s, started(ID2, 'k2'));
  reduceJournal(s, { type: 'result', key: 'k1', agentId: ID1, oversized: true });
  reduceJournal(s, { type: 'result', key: 'k2', agentId: ID2 });
  assert.equal(s.agents[0].status, 'done');
  assert.deepEqual(agentResult(s.agents[0]), { shape: 'oversized', size: null });
  assert.equal(s.agents[1].status, 'done');
  assert.deepEqual(agentResult(s.agents[1]), { shape: 'missing', size: null });
});

test('a failed line with an empty agentId is kept under its key and attaches to no agent', () => {
  const s = newRunState();
  setRunStatus(s, 'running');
  reduceJournal(s, started(ID1, 'review:I3:opus'));
  reduceJournal(s, { type: 'failed', key: 'review:I3:opus', agentId: '' });
  assert.equal(s.agents.length, 2);
  assert.equal(s.agents[0].status, 'running', 'an open attempt is not failed or superseded by an id-less failure');
  const failed = s.agents[1];
  assert.equal(failed.id, null);
  assert.equal(failed.key, 'review:I3:opus');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempt, 2);
});

test('a failed line with a valid id it has not seen creates that agent as failed', () => {
  const s = newRunState();
  reduceJournal(s, { type: 'failed', key: 'k9', agentId: ID3 });
  assert.equal(agentById(s, ID3).status, 'failed');
  assert.equal(agentById(s, ID3).key, 'k9');
});

test('a result line that arrives before its started line is claimed by the started line', () => {
  const s = newRunState();
  reduceJournal(s, finished(ID1, 'k1', 'x'));
  assert.equal(s.agents[0].label, null);
  reduceJournal(s, { type: 'started', key: 'k1', agentId: ID1, label: 'k1:label', phase: 'Build' });
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].label, 'k1:label');
  assert.equal(s.agents[0].phase, 'Build');
  assert.equal(s.agents[0].status, 'done');
  assert.equal(s.agents[0].attempt, 1);
});

test('reduceJournal fails soft: junk, unknown types and missing ids change nothing and never throw', () => {
  const s = newRunState({ id: RUN_ID });
  reduceJournal(s, started(ID1, 'k1'));
  const before = JSON.stringify(s);
  for (const junk of [null, undefined, 'started', 42, [], { type: 'mystery', agentId: ID1 }, { type: 'started' }]) {
    assert.doesNotThrow(() => reduceJournal(s, junk));
  }
  assert.equal(JSON.stringify(s), before);
  assert.equal(reduceJournal(null, started(ID1, 'k1')), null);
});

test('tokens equal the last assistant line snapshot, not the largest one', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  const a = s.agents[0];
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:05.000Z', 'm1', usageOf(100, 1000, 5000, 10)));
  assert.equal(a.tokens, 6110);
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:10.000Z', 'm2', usageOf(200, 0, 6000, 20)));
  assert.equal(a.tokens, 6220, 'input + cache creation + cache read + output of the last line');
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:12.000Z', 'm3', usageOf(1, 0, 2, 3)));
  assert.equal(a.tokens, 6, 'a smaller last line wins');
});

test('net keeps the last usage per message id, out of order, and leaves cache reads out', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  const a = s.agents[0];
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:05.000Z', 'm1', usageOf(100, 1000, 5000, 10)));
  assert.equal(a.net, 1110);
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:10.000Z', 'm2', usageOf(100, 0, 6000, 20)));
  assert.equal(a.net, 1230);
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:20.000Z', 'm1', usageOf(100, 1000, 5000, 30)));
  assert.equal(a.net, 1250, 'm1 counts once with its last output (30), not twice');
});

test('tool calls count each tool id once; lastTool is the last tool name; id-less tool blocks count each time', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  const a = s.agents[0];
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:01.000Z', 'm1', usageOf(1, 0, 0, 1), { content: [toolUse('t1', 'Grep')] }));
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:02.000Z', 'm1', usageOf(1, 0, 0, 2), { content: [toolUse('t1', 'Grep')] }));
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:03.000Z', 'm2', usageOf(1, 0, 0, 3), {
    content: [toolUse('t2', 'Read'), { type: 'text', text: 'not a tool' }],
  }));
  assert.equal(a.toolCalls, 2);
  assert.equal(a.lastTool, 'Read');
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:04.000Z', 'm3', usageOf(1, 0, 0, 4), {
    content: [{ type: 'tool_use', name: 'Glob', input: {} }],
  }));
  assert.equal(a.toolCalls, 3);
  assert.equal(a.lastTool, 'Glob');
});

test('lastActivityAt keeps the newest valid timestamp and ignores unparseable ones', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  const a = s.agents[0];
  applyTranscriptLine(a, userLine('2026-10-08T10:00:20.000Z'));
  applyTranscriptLine(a, userLine('2026-10-08T10:00:05.000Z'));
  applyTranscriptLine(a, userLine('not a date'));
  assert.equal(a.lastActivityAt, at('10:00:20.000Z'));
});

test('model precedence: the meta model beats a transcript model, which beats the run default', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  reduceJournal(s, started(ID2, 'k2'));
  const metaFirst = agentById(s, ID1);
  applyMeta(metaFirst, { model: 'haiku' }, 'claude-sonnet-5-5', META_MTIME);
  applyTranscriptLine(metaFirst, assistantLine('2026-10-08T10:00:01.000Z', 'm1', usageOf(1, 0, 0, 1), { model: 'claude-haiku-5-5' }));
  assert.equal(metaFirst.model, 'haiku');

  const transcriptOverDefault = agentById(s, ID2);
  applyTranscriptLine(transcriptOverDefault, assistantLine('2026-10-08T10:00:01.000Z', 'm2', usageOf(1, 0, 0, 1), { model: 'claude-opus-5-5' }));
  applyMeta(transcriptOverDefault, {}, 'claude-sonnet-5-5', META_MTIME);
  assert.equal(transcriptOverDefault.model, 'claude-opus-5-5');
});

test('a missing meta model takes the run default', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  const a = agentById(s, ID1);
  applyMeta(a, { description: 'Review item I2', workflowPhase: 'Review' }, 'claude-sonnet-5-5', META_MTIME);
  assert.equal(a.model, 'claude-sonnet-5-5');
  assert.equal(a.phase, 'Build', 'the journal phase wins over the meta phase');
});

test('applyMeta fills label and phase only when the journal left them empty, and sets startedAt once', () => {
  const s = newRunState();
  reduceJournal(s, { type: 'started', key: 'k1', agentId: ID1, label: 'journal label' });
  const a = agentById(s, ID1);
  applyMeta(a, { description: 'meta description', workflowPhase: 'Review' }, null, META_MTIME);
  assert.equal(a.label, 'journal label');
  assert.equal(a.phase, 'Review', 'a missing journal phase takes the meta phase');
  assert.equal(a.startedAt, META_MTIME);
  applyMeta(a, {}, null, META_MTIME + MIN);
  assert.equal(a.startedAt, META_MTIME, 'startedAt is set once');
  assert.equal(a.model, null, 'no model anywhere and no default gives null');
});

test('applyTranscriptLine and applyMeta tolerate hand-made agents with missing fields', () => {
  const bare = { id: ID1, key: 'k1' };
  applyTranscriptLine(bare, assistantLine('2026-10-08T10:00:01.000Z', 'm1', usageOf(2, 0, 3, 4)));
  assert.equal(bare.tokens, 9);
  assert.equal(bare.net, 6);
  assert.equal(bare.toolCalls, 0);
  applyMeta(bare, { model: 'haiku' }, null, META_MTIME);
  assert.equal(bare.model, 'haiku');
});

test('summaryFields keeps the plan whitelist and drops script, logs, args, result, summary, error and previews', () => {
  const fields = summaryFields(summaryJson());
  assert.deepEqual(Object.keys(fields), ['runId', 'workflowName', 'status', 'startTime', 'timestamp', 'durationMs',
    'agentCount', 'defaultModel', 'totalTokens', 'phases', 'workflowProgress']);
  assert.equal(fields.runId, RUN_ID);
  assert.equal(fields.workflowName, 'build-v02');
  assert.equal(fields.status, 'completed');
  assert.equal(fields.startTime, T0);
  assert.equal(fields.timestamp, '2026-10-08T10:03:00.000Z');
  assert.equal(fields.totalTokens, 123456);
  assert.deepEqual(fields.phases, [{ title: 'Build' }, { title: 'Review' }]);
  assert.equal(fields.workflowProgress.length, 6, 'two phase lines and four agent lines');
  for (const entry of fields.workflowProgress) {
    for (const dropped of ['promptPreview', 'resultPreview', 'lastToolSummary', 'error']) {
      assert.equal(Object.hasOwn(entry, dropped), false, `${dropped} is never kept`);
    }
  }
  const a1 = fields.workflowProgress.find((e) => e.agentId === 'a3f9c2e1b7d4a8e6');
  assert.equal(a1.tokens, 6100);
  assert.equal(a1.toolCalls, 2);
  assert.equal(a1.lastToolName, 'Edit');
  assert.equal(summaryFields(null), null);
  assert.deepEqual(summaryFields({ workflowProgress: 'not a list' }).workflowProgress, []);
});

test('applySummary: a summary figure beats the transcript snapshot, also for an agent that arrives later', () => {
  const s = newRunState();
  applySummary(s, { workflowProgress: [{ type: 'workflow_agent', agentId: ID1, tokens: 500 }] });
  reduceJournal(s, started(ID1, 'k1'));
  const a = agentById(s, ID1);
  assert.equal(a.tokens, 500);
  applyTranscriptLine(a, assistantLine('2026-10-08T10:00:01.000Z', 'm1', usageOf(100, 0, 300, 50)));
  assert.equal(a.tokens, 500, 'a later transcript line does not overwrite the summary figure');
  applySummary(s, { workflowProgress: [] });
  assert.equal(a.tokens, 450, 'a summary that no longer lists the agent falls back to the snapshot 100 + 0 + 300 + 50');
});

test('deriveRunStatus: completed and killed only when nothing changed more than 5 s after the summary', () => {
  const ended = at('10:03:00.000Z');
  const completed = { status: 'completed', timestamp: new Date(ended).toISOString() };
  const killed = { status: 'killed', timestamp: new Date(ended).toISOString() };
  assert.equal(SETTLE_MS, 5000);
  assert.equal(deriveRunStatus({ summary: completed, lastChangeMs: ended, now: ended + DAY }), 'completed');
  assert.equal(deriveRunStatus({ summary: completed, lastChangeMs: ended + SETTLE_MS, now: ended + DAY }), 'completed');
  assert.equal(deriveRunStatus({ summary: killed, lastChangeMs: ended - 1000, now: ended + DAY }), 'killed');
  assert.equal(deriveRunStatus({ summary: { status: 'failed', timestamp: new Date(ended).toISOString() }, lastChangeMs: ended, now: ended + DAY }), 'unknown');
});

test('deriveRunStatus: a stale killed summary with a later change is running again', () => {
  const ended = at('10:03:00.000Z');
  const killed = { status: 'killed', timestamp: new Date(ended).toISOString() };
  assert.equal(deriveRunStatus({ summary: killed, lastChangeMs: ended + 6000, now: ended + 36000 }), 'running');
  assert.equal(deriveRunStatus({ summary: killed, lastChangeMs: ended + 6000, now: ended + 6000 + 16 * MIN }), 'unknown',
    'a change after the summary that is over 15 minutes old is not claimed');
});

test('deriveRunStatus: running under 2 minutes, idle from 2 to 15 minutes, unknown after, without a summary', () => {
  const last = at('10:03:00.000Z');
  assert.equal(RUNNING_MS, 2 * MIN);
  assert.equal(IDLE_MS, 15 * MIN);
  assert.equal(deriveRunStatus({ lastChangeMs: last, now: last + 2 * MIN - 1 }), 'running');
  assert.equal(deriveRunStatus({ lastChangeMs: last, now: last + 2 * MIN }), 'idle');
  assert.equal(deriveRunStatus({ lastChangeMs: last, now: last + 15 * MIN }), 'idle');
  assert.equal(deriveRunStatus({ lastChangeMs: last, now: last + 15 * MIN + 1 }), 'unknown');
});

test('deriveRunStatus claims nothing without change information or a clock', () => {
  const ended = at('10:03:00.000Z');
  const completed = { status: 'completed', timestamp: new Date(ended).toISOString() };
  assert.equal(deriveRunStatus({ summary: completed, lastChangeMs: null, now: ended }), 'unknown');
  assert.equal(deriveRunStatus({ lastChangeMs: ended }), 'unknown');
  assert.equal(deriveRunStatus(), 'unknown');
  assert.equal(deriveRunStatus({ summary: { status: 'completed', timestamp: 'soon' }, lastChangeMs: ended, now: ended + 30000 }), 'running',
    'a summary without a usable timestamp falls back to the recency rules');
});

test('agentStatus: a result beats a retry, a failure beats a retry, retried beats live, live and stopped otherwise', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  reduceJournal(s, finished(ID1, 'k1'));
  reduceJournal(s, started(ID2, 'k1'));
  assert.equal(agentStatus(agentById(s, ID1), true), 'done', 'a finished attempt stays done when its key starts again');
  assert.equal(agentStatus(agentById(s, ID2), true), 'running');
  assert.equal(agentStatus(agentById(s, ID2), false), 'stopped');

  reduceJournal(s, started(ID3, 'k2'));
  reduceJournal(s, { type: 'failed', key: 'k2', agentId: ID3 });
  reduceJournal(s, started('a44444444444', 'k2'));
  assert.equal(agentStatus(agentById(s, ID3), true), 'failed');
  assert.equal(agentStatus(agentById(s, 'a44444444444'), true), 'running');

  const open = newRunState();
  reduceJournal(open, started(ID1, 'k3'));
  reduceJournal(open, started(ID2, 'k3'));
  assert.equal(agentStatus(agentById(open, ID1), true), 'retried');
  assert.equal(agentStatus(agentById(open, ID1), false), 'retried', 'retried does not depend on liveness');
});

test('setRunStatus moves open attempts between running and stopped and keeps finished ones; endedAt follows activity', () => {
  const s = newRunState();
  reduceJournal(s, started(ID1, 'k1'));
  reduceJournal(s, started(ID2, 'k2'));
  reduceJournal(s, finished(ID2, 'k2'));
  applyTranscriptLine(agentById(s, ID2), userLine('2026-10-08T10:00:30.000Z'));
  setRunStatus(s, 'running');
  assert.equal(agentById(s, ID1).status, 'running');
  assert.equal(agentById(s, ID1).endedAt, null);
  assert.equal(agentById(s, ID2).status, 'done');
  assert.equal(agentById(s, ID2).endedAt, at('10:00:30.000Z'));
  setRunStatus(s, 'unknown');
  assert.equal(agentById(s, ID1).status, 'stopped');
  setRunStatus(s, 'idle');
  assert.equal(agentById(s, ID1).status, 'running');
});

test('fixture run: each agent gets the figures the transcript and journal say', () => {
  const state = loadFixtureRun();
  setRunStatus(state, 'completed');
  assert.equal(state.agents.length, 7);
  const get = (id) => agentById(state, id);

  const a1 = get('a3f9c2e1b7d4a8e6');
  assert.equal(a1.key, 'build:I1:haiku');
  assert.equal(a1.label, 'build:I1:haiku');
  assert.equal(a1.phase, 'Build');
  assert.equal(a1.model, 'haiku', 'the meta model beats the transcript');
  assert.equal(a1.status, 'done');
  assert.equal(a1.attempt, 1);
  assert.equal(a1.startedAt, META_MTIME);
  assert.equal(a1.tokens, 6100, 'the summary figure beats the transcript snapshot of 6130');
  assert.equal(a1.net, 1250);
  assert.equal(a1.toolCalls, 2);
  assert.equal(a1.lastTool, 'Edit');
  assert.equal(a1.lastActivityAt, at('10:00:20.000Z'));
  assert.equal(a1.endedAt, at('10:00:20.000Z'));

  const a2 = get('a7c1e9b3d5f2a4c6');
  assert.equal(a2.model, 'claude-sonnet-5-5');
  assert.equal(a2.status, 'done');
  assert.equal(a2.tokens, 8335, 'no summary figure, so the last line decides');
  assert.equal(a2.net, 475);
  assert.equal(a2.toolCalls, 2, 'the streamed duplicate of toolu_0003a counts once');
  assert.equal(a2.lastTool, 'Read');

  const a3 = get('a2b4d6f8a0c2e4b6');
  assert.equal(a3.status, 'retried');
  assert.equal(a3.attempt, 1);
  assert.equal(a3.model, 'claude-haiku-5-5', 'no meta file, so the transcript model');
  assert.equal(a3.startedAt, null);
  assert.equal(a3.tokens, 2055);
  assert.equal(a3.net, 55);
  assert.equal(a3.toolCalls, 0);

  const a4 = get('a6f0e3c5a7b9d1f3');
  assert.equal(a4.key, 'build:I3:haiku');
  assert.equal(a4.attempt, 2);
  assert.equal(a4.status, 'done');
  assert.equal(a4.model, 'haiku');
  assert.equal(a4.tokens, 9120);
  assert.equal(a4.net, 120);
  assert.equal(a4.lastActivityAt, at('10:01:31.000Z'));

  const a5 = get('a5d2f8e4c1b9a3f7');
  assert.equal(a5.phase, 'Review');
  assert.equal(a5.model, 'opus');
  assert.equal(a5.status, 'done');
  assert.equal(a5.tokens, 41000, 'the summary figure beats the snapshot of 41050');
  assert.equal(a5.net, 1050);

  const a6 = get('a9e6b2d8f4c0a1e3');
  assert.equal(a6.model, 'claude-sonnet-5-5', 'no meta model and no transcript model: the run default');
  assert.equal(a6.status, 'done');
  assert.equal(a6.tokens, 2250);
  assert.equal(a6.net, 250);

  const failed = state.agents[4];
  assert.equal(failed.id, null);
  assert.equal(failed.key, 'review:I3:opus');
  assert.equal(failed.status, 'failed');
});

test('fixture run: runSummary uses the summary figures once the run has completed', () => {
  const state = loadFixtureRun();
  setRunStatus(state, 'completed');
  const sum = runSummary(state);
  assert.deepEqual(Object.keys(sum), RUN_SUMMARY_KEYS);
  assert.equal(sum.id, RUN_ID);
  assert.equal(sum.engine, 'claude-code');
  assert.equal(sum.title, 'build-v02');
  assert.equal(sum.project, 'C:\\fixture\\project');
  assert.equal(sum.sessionId, 'fixture-session');
  assert.equal(sum.status, 'completed');
  assert.equal(sum.startedAt, T0);
  assert.equal(sum.endedAt, at('10:03:00.000Z'));
  assert.equal(sum.lastActivityAt, at('10:03:00.000Z'));
  assert.equal(sum.agentCount, 7);
  assert.equal(sum.done, 5);
  assert.equal(sum.failed, 1);
  assert.equal(sum.tokens, 123456);
  assert.deepEqual(sum.phases, ['Build', 'Review']);
  assert.equal(sum.linkedRoomId, null);
});

test('fixture run without a summary: figures come from the transcripts and the status stays open', () => {
  const state = loadFixtureRun({ withSummary: false });
  const sum = runSummary(state);
  assert.equal(sum.status, 'unknown');
  assert.equal(sum.title, null);
  assert.equal(sum.endedAt, null);
  assert.equal(sum.startedAt, META_MTIME);
  assert.equal(sum.agentCount, 7);
  assert.equal(sum.done, 5);
  assert.equal(sum.failed, 1);
  assert.equal(sum.tokens, 68940, 'the sum of the transcript snapshots');
  assert.deepEqual(sum.phases, ['Build', 'Review']);
  assert.equal(sum.lastActivityAt, at('10:02:55.000Z'));
});

test('fixture run: the order of replay does not change the result', () => {
  const normal = loadFixtureRun();
  const summaryFirst = loadFixtureRun({ summaryFirst: true });
  setRunStatus(normal, 'completed');
  setRunStatus(summaryFirst, 'completed');
  assert.equal(JSON.stringify(summaryFirst.agents), JSON.stringify(normal.agents));
  assert.deepEqual(runSummary(summaryFirst), runSummary(normal));
});

test('fixture run: the summary gives a completed status when nothing changed after it', () => {
  const summary = summaryFields(summaryJson());
  assert.equal(deriveRunStatus({ summary, lastChangeMs: at('10:02:55.000Z'), now: at('10:03:01.000Z') }), 'completed');
  assert.equal(deriveRunStatus({ summary, lastChangeMs: at('10:03:30.000Z'), now: at('10:03:40.000Z') }), 'running',
    'a change 30 seconds after the summary is not final');
});

test('no canary text reaches any output of the reducer, while the figures stay correct', () => {
  const canaries = new Set();
  for (const f of fs.readdirSync(FIX)) {
    for (const m of read(f).match(/CANARY_[A-Za-z0-9_]+/g) || []) canaries.add(m);
  }
  assert.ok(canaries.size >= 30, `the fixtures carry canaries (${canaries.size})`);

  const state = loadFixtureRun();
  setRunStatus(state, 'completed');
  const outputs = JSON.stringify([
    state, state.agents, runSummary(state), summaryFields(summaryJson()),
    deriveRunStatus({ summary: summaryFields(summaryJson()), lastChangeMs: T0, now: T0 }),
  ]);
  for (const c of canaries) assert.equal(outputs.includes(c), false, `canary ${c} must not be stored`);
  assert.ok(outputs.includes('build-v02'), 'kept fields are still there');
});
