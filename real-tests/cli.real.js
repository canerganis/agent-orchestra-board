// Opt-in suite against the REAL CLIs (claude, codex, agy, cursor-agent). Run: OB_REAL=1 npm run test:real
// Lives outside test/ and is named *.real.js, so plain `node --test` / `npm test` never discover it (node:test runs
// every file under a test/ directory). Every test skips unless OB_REAL=1, skips in CI, and skips per CLI when that
// CLI is not installed. Cheap models only, tiny prompts, one throwaway sample project per run. See docs/real-tests.md.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { tmpDir, rmrf, waitFor, exitGuard, startApp, teardown } = require('../test/helpers');
const { createStore } = require(path.join(ROOT, 'src', 'store'));
const { createSeats } = require(path.join(ROOT, 'src', 'seats'));
const { createLimits } = require(path.join(ROOT, 'src', 'limits'));
const { createRunner } = require(path.join(ROOT, 'src', 'runner'));
const { claudeBin, codexBin } = require(path.join(ROOT, 'src', 'config'));
const { resolveExe, spawnResolved, killTree } = require(path.join(ROOT, 'src', 'platform'));
const agy = require(path.join(ROOT, 'src', 'adapters', 'antigravity'));
const cursor = require(path.join(ROOT, 'src', 'adapters', 'cursor'));

const CLAUDE_MODEL = 'claude-haiku-5-5';
const CODEX_MODEL = 'gpt-6-luna';
const AGY_MODEL = 'gemini-3.8-flash-low';
const CURSOR_MODEL = 'auto';

const TURN_MS = 240000;
const FLOW_MS = 600000;

// ---------- gating ----------
const off = process.env.OB_REAL !== '1' ? 'opt-in: set OB_REAL=1 (npm run test:real)'
  : (process.env.CI || process.env.GITHUB_ACTIONS) ? 'never runs in CI' : false;
const bins = {
  claude: off ? null : resolveExe(claudeBin()),
  codex: off ? null : resolveExe(codexBin()),
  agy: off ? null : agy.resolveBin(),
  cursor: off ? null : cursor.resolveBin(),
};
const skipFor = (cli) => off || (bins[cli] ? false : `${cli} CLI not found`);
const skipFlow = () => off || (bins.claude && bins.codex ? false : 'needs both the claude and codex CLIs');

// ---------- state shared by the tests ----------
const root = off ? null : tmpDir('ob-real-');
const project = root ? path.join(root, 'project') : null;
const spent = { tokens: 0, cached: 0, cost: 0, byStep: [] };
const count = (label, tokens = 0, cached = 0, cost = 0) => {
  spent.tokens += tokens || 0; spent.cached += cached || 0; spent.cost += cost || 0; spent.byStep.push(`${label}: ${tokens || 0}`);
};

if (project) {
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# Demo\n\nA tiny sample project. The only code is src/list.js.\n');
  fs.writeFileSync(path.join(project, 'src', 'list.js'), "// Returns the demo items.\nfunction list() {\n  return ['alpha', 'beta', 'gamma'];\n}\nmodule.exports = { list };\n");
}
const LIST_JS = project ? fs.readFileSync(path.join(project, 'src', 'list.js'), 'utf8') : '';

// Wording matters: gpt-6-luna refused to read the file for "name the function it exports, written as a call like name()" in every run on 2026-10-09, and read it every time for this wording.
const PROMPT_READ = 'Read src/list.js and say in one sentence what list() returns.';
const PROMPT_AGAIN = 'Which file did you just read? Answer with the path only.';

// ---------- the board's own runner path (claude and codex) ----------
let runner = null, seatsApi = null;
function boardRunner() {
  if (runner) return runner;
  const store = createStore(project); store.ensure();
  const mk = (id, name, agent, model) => ({ id, name, role: 'Reader', agent, model, effort: 'low', perm: 'read', target: '', budget: 0, color: '#7aa2ff', thread: null, used: 0, cached: 0, cost: 0 });
  store.writeJson('seats.json', [mk('hk', 'Haiku', 'claude', CLAUDE_MODEL), mk('lu', 'Luna', 'codex', CODEX_MODEL)]);
  const broadcast = () => {};
  const limits = createLimits({ store, broadcast });
  seatsApi = createSeats({ store, broadcast });
  runner = createRunner({ store, seats: seatsApi, limits, settings: { lang: 'English' }, broadcast, detectVersions: false });
  return runner;
}

for (const [cli, seatId] of [['claude', 'hk'], ['codex', 'lu']]) {
  test(`real ${cli}: read-only turn through the board runner mentions list() and reports usage`, { skip: skipFor(cli), timeout: TURN_MS }, async () => {
    const res = await boardRunner().runSeat(seatId, PROMPT_READ, { tools: 'read' });
    count(`${cli} turn`, res.tokens, res.cached, res.cost);
    assert.equal(res.ok, true, `turn failed: ${res.error}`);
    assert.match(res.text, /list\(/);
    assert.ok(res.tokens > 0, 'the parser reported usage');
    const seat = seatsApi.seatById(seatId);
    assert.ok(seat.thread, 'a thread id was saved on the seat');
  });

  test(`real ${cli}: resume turn keeps the thread and remembers the file`, { skip: skipFor(cli), timeout: TURN_MS }, async () => {
    const seat = seatsApi.seatById(seatId);
    const before = seat.thread;
    assert.ok(before, 'needs the thread of the previous test');
    const res = await boardRunner().runSeat(seatId, PROMPT_AGAIN, { tools: 'read' });
    count(`${cli} resume`, res.tokens, res.cached, res.cost);
    assert.equal(res.ok, true, `resume failed: ${res.error}`);
    assert.match(res.text, /list\.js/);
    assert.ok(res.tokens > 0);
    assert.equal(seatsApi.seatById(seatId).thread, before, 'same thread after resume');
  });
}

// ---------- agy and cursor-agent: no board seat type yet, so the adapter + the board's spawn helper ----------
function adapterTurn({ bin, args, cwd, parse, timeoutMs = 180000 }) {
  return new Promise((resolve) => {
    const r = { text: '', thread: null, tokens: 0, cached: 0, done: false, errors: [], tools: 0, stderr: '', exit: null, timedOut: false };
    const child = spawnResolved(bin, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { r.timedOut = true; killTree(child); }, timeoutMs);
    let buf = '';
    const handle = (line) => {
      for (const e of parse(line)) {
        if (e.type === 'thread' && e.id) r.thread = e.id;
        else if (e.type === 'text') r.text += e.text;
        else if (e.type === 'tool') r.tools++;
        else if (e.type === 'usage') { r.tokens += e.tokens || 0; r.cached += e.cached || 0; }
        else if (e.type === 'error') r.errors.push(e.message);
        else if (e.type === 'done') r.done = true;
      }
    };
    if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } }); }
    if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', (c) => { r.stderr = (r.stderr + c).slice(-2000); }); }
    child.on('error', (e) => { r.errors.push(e.message); });
    child.on('close', (code) => { clearTimeout(timer); if (buf.trim()) handle(buf); r.exit = code; resolve(r); });
  });
}
const why = (r) => `exit ${r.exit}${r.timedOut ? ' (timed out)' : ''}; errors: ${r.errors.join(' | ')}; stderr: ${r.stderr.slice(-300)}`;

let agyThread = null;
test('real agy: read-only turn mentions list() and reports usage', { skip: skipFor('agy'), timeout: TURN_MS }, async () => {
  const r = await adapterTurn({ bin: bins.agy, args: agy.buildArgs({ model: AGY_MODEL, prompt: PROMPT_READ }), cwd: project, parse: agy.parseLine });
  count('agy turn', r.tokens, r.cached);
  assert.ok(r.done && r.errors.length === 0, why(r));
  assert.match(r.text, /list\(/);
  assert.ok(r.tokens > 0, 'the parser reported usage');
  assert.ok(r.thread, 'conversation id present');
  agyThread = r.thread;
});
test('real agy: resume turn keeps the conversation and remembers the file', { skip: skipFor('agy'), timeout: TURN_MS }, async () => {
  assert.ok(agyThread, 'needs the conversation of the previous test');
  const r = await adapterTurn({ bin: bins.agy, args: agy.buildArgs({ model: AGY_MODEL, prompt: PROMPT_AGAIN, resumeId: agyThread }), cwd: project, parse: agy.parseLine });
  count('agy resume', r.tokens, r.cached);
  assert.ok(r.done && r.errors.length === 0, why(r));
  assert.match(r.text, /list\.js/);
  assert.ok(r.tokens > 0);
  assert.equal(r.thread, agyThread);
});

let cursorThread = null;
const cursorTurn = (opts) => adapterTurn({ bin: bins.cursor.cmd, args: [...bins.cursor.prefixArgs, ...cursor.buildArgs({ model: CURSOR_MODEL, ...opts })], cwd: project, parse: cursor.parseLine });
test('real cursor agent: read-only (ask mode) turn mentions list() and reports usage', { skip: skipFor('cursor'), timeout: TURN_MS }, async () => {
  const r = await cursorTurn({ prompt: PROMPT_READ });
  count('cursor turn', r.tokens, r.cached);
  assert.ok(r.done && r.errors.length === 0, why(r));
  assert.match(r.text, /list\(/);
  assert.ok(r.tokens > 0, 'the parser reported usage');
  assert.ok(r.thread, 'session id present');
  assert.equal(fs.readFileSync(path.join(project, 'src', 'list.js'), 'utf8'), LIST_JS, 'read-only: the sample file is untouched');
  cursorThread = r.thread;
});
test('real cursor agent: resume turn keeps the session and remembers the file', { skip: skipFor('cursor'), timeout: TURN_MS }, async () => {
  assert.ok(cursorThread, 'needs the session of the previous test');
  const r = await cursorTurn({ prompt: PROMPT_AGAIN, resumeId: cursorThread });
  count('cursor resume', r.tokens, r.cached);
  assert.ok(r.done && r.errors.length === 0, why(r));
  assert.match(r.text, /list\.js/);
  assert.ok(r.tokens > 0);
  assert.equal(r.thread, cursorThread);
});

// ---------- end to end on an in-process board with the real CLIs ----------
let ctx = null, haikuId = null, lunaId = null;
const settled = (id, what) => waitFor(async () => { const r = await ctx.room(id); return r && r.status !== 'running' && r; }, { timeout: FLOW_MS - 30000, interval: 1000, what });
const okMsgs = (room, seatId) => room.messages.filter((m) => m.seatId === seatId && !m.failed && !m.streaming && m.text);

test('real board: start the in-process server and add the Haiku and Luna seats', { skip: skipFlow(), timeout: 120000 }, async () => {
  runner = null; // the direct runner is done; the board builds its own
  rmrf(path.join(project, '.orchestra'));
  // startApp isolates HOME unless OB_TEST_HOME points at an existing dir. The real CLIs need the real login, so use it.
  process.env.OB_TEST_HOME = os.homedir();
  ctx = await startApp({ projectDir: project, recordsDir: path.join(root, 'ob-records') });
  const a = await ctx.post('/api/seats', { name: 'Haiku', role: 'Panelist', agent: 'claude', model: CLAUDE_MODEL, effort: 'low', perm: 'read' });
  const b = await ctx.post('/api/seats', { name: 'Luna', role: 'Panelist', agent: 'codex', model: CODEX_MODEL, effort: 'low', perm: 'read' });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  haikuId = a.json.id; lunaId = b.json.id;
});

test('real board: two seat Council, one round, reaches a synthesis', { skip: skipFlow(), timeout: FLOW_MS }, async () => {
  assert.ok(ctx, 'needs the board from the previous test');
  const start = await ctx.post('/api/meeting', { topic: 'Should a helper called list() return a copy of its array or the array itself? Reply in at most two sentences.', seatIds: [haikuId, lunaId], rounds: 1, synthId: lunaId, withContext: false });
  assert.equal(start.status, 200, start.text);
  const room = await settled(start.json.roomId, 'the council to finish');
  count('council', room.usage && room.usage.tokens, room.usage && room.usage.cached, room.usage && room.usage.cost);
  assert.equal(room.status, 'done', `council ended as ${room.status}: ${room.messages.filter((m) => m.error).map((m) => m.error).join(' | ')}`);
  assert.ok(okMsgs(room, haikuId).length >= 1, 'Haiku spoke');
  assert.ok(okMsgs(room, lunaId).length >= 1, 'Luna spoke');
  const synth = room.messages.find((m) => m.label === 'synthesis');
  assert.ok(synth && synth.text && !synth.failed, 'a synthesis message exists');
  assert.ok(room.usage.tokens > 0);
});

test('real board: Propose and Review chain, Haiku proposes, Luna reviews, read-only', { skip: skipFlow(), timeout: FLOW_MS }, async () => {
  assert.ok(ctx, 'needs the board from the first board test');
  const start = await ctx.post('/api/chain', { task: 'Propose a one line comment for the function in src/list.js. Do not edit any file.', builderId: haikuId, reviewerId: lunaId, maxRounds: 1, escalate: false, withContext: false });
  assert.equal(start.status, 200, start.text);
  const room = await settled(start.json.roomId, 'the chain to finish');
  count('chain', room.usage && room.usage.tokens, room.usage && room.usage.cached, room.usage && room.usage.cost);
  assert.ok(['passed', 'needs-you'].includes(room.status), `chain ended as ${room.status}: ${room.messages.filter((m) => m.error).map((m) => m.error).join(' | ')}`);
  assert.ok(okMsgs(room, haikuId).length >= 1, 'Haiku proposed');
  const review = okMsgs(room, lunaId).pop();
  assert.ok(review, 'Luna reviewed');
  assert.match(review.text, /VERDICT:\s*\**\s*(PASS|FAIL)/i);
  assert.equal(fs.readFileSync(path.join(project, 'src', 'list.js'), 'utf8'), LIST_JS, 'read-only: the sample file is untouched');
  assert.ok(room.usage.tokens > 0);
});

test('real suite: total tokens', { skip: off, timeout: 60000 }, (t) => {
  const line = `real suite total: ${spent.tokens} tokens net (${spent.cached} cached, reported cost ${spent.cost.toFixed(4)} USD)`;
  t.diagnostic(line); t.diagnostic(spent.byStep.join(', '));
  console.log(`\n${line}\n${spent.byStep.join(', ')}`);
});

after(async () => {
  await teardown(ctx, null);
  if (root) { rmrf(root); if (fs.existsSync(root)) rmrf(root); }
});
exitGuard(30000);
