// v0.1 extras on fake CLIs (port 4391): Claude Haiku 5.5 (listed, usage probe, warnings are never errors), per-session
// model/effort overrides (New session modal -> room.overrides -> CLI args), and the capEffort setting (Debate rounds).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, waitFor, startApp, testWithFake, teardown } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const claude = require('../src/adapters/claude');
const { MODELS, CLAUDE_PROBE_MODEL, CLAUDE_CHEAP_MODEL } = require('../src/config');

const PORT = 4391;
const HAIKU = 'claude-haiku-5-5';
let dir, project, fake, ctx;

before(async () => {
  dir = tmpDir('ob-session-opts-'); project = path.join(dir, 'project'); fs.mkdirSync(project);
  fake = setupFakeCli(dir);
  ctx = await startApp({ port: PORT, projectDir: project });
  for (const s of [
    { name: 'Ada', role: 'Architect', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', perm: 'read' },
    { name: 'Bob', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'high', perm: 'read' },
  ]) assert.equal((await ctx.post('/api/seats', s)).status, 200);
});
after(() => teardown(ctx, dir));

// The effort a CLI call ran at: claude takes --effort, codex a -c model_reasoning_effort="..." pair.
const effortOf = (c) => (c.agent === 'codex'
  ? (c.args.find((a) => a.startsWith('model_reasoning_effort=')) || '').replace(/^model_reasoning_effort="|"$/g, '')
  : (c.args.includes('--effort') ? c.args[c.args.indexOf('--effort') + 1] : undefined));
const modelOf = (c) => (c.agent === 'codex'
  ? (c.args.find((a) => a.startsWith('model=')) || '').replace(/^model="|"$/g, '')
  : c.args[c.args.indexOf('--model') + 1]);
const roomDone = (roomId) => waitFor(async () => { const r = await ctx.room(roomId); return r && r.status !== 'running' && r; }, { timeout: 25000, what: 'session to finish' });

test('Claude Haiku 5.5 is a listed Claude model, the usage probe default, and a valid CLI model argument', () => {
  assert.ok(MODELS.claude.includes(HAIKU));
  assert.ok(MODELS.claude.includes('claude-haiku-4-5-20251001'), 'the other Haiku stays listed');
  assert.equal(CLAUDE_CHEAP_MODEL, HAIKU);
  assert.equal(CLAUDE_PROBE_MODEL, HAIKU);
  const probe = claude.buildProbeArgs();
  assert.equal(probe[probe.indexOf('--model') + 1], HAIKU);
  const args = claude.buildArgs({ model: HAIKU, effort: 'low', mode: 'read' });
  assert.equal(args[args.indexOf('--model') + 1], HAIKU);
});

testWithFake(fake, 'a CLI warning about the model id (stderr or a non-JSON stdout line) does not fail a turn that completed', async () => {
  fake.scenario({ default: { reply: 'Hello from Haiku.', warn: `unrecognized_model: ${HAIKU} (warning, the call still runs)`, noise: 'WARN: model id is not in the known list' } });
  // a seat save without effort falls back to medium (upsert), so send the whole seat
  const ada = { id: 'ada', name: 'Ada', role: 'Architect', agent: 'claude', perm: 'read', effort: 'high' };
  assert.equal((await ctx.post('/api/seats', { ...ada, model: HAIKU })).status, 200);
  const dm = (await ctx.post('/api/seats/ada/send', { text: 'hi' })).json.roomId;
  const msg = await waitFor(async () => { const r = await ctx.room(dm); const m = r && r.messages.find((x) => x.seatId === 'ada' && !x.streaming); return m || null; }, { timeout: 15000, what: 'Haiku reply' });
  assert.equal(msg.failed, false); assert.equal(msg.error, null); assert.equal(msg.text, 'Hello from Haiku.');
  await ctx.post('/api/seats', { ...ada, model: 'claude-sonnet-5-5' });
});

testWithFake(fake, 'per-session overrides reach the CLI args and the room, and never change the seat', async () => {
  fake.scenario({ default: { reply: 'An idea.' } });
  const before = fake.calls().length;
  const overrides = { ada: { model: HAIKU, effort: 'low' }, bob: { effort: 'xhigh' } };
  const start = await ctx.post('/api/meeting', { topic: 'Overrides', seatIds: ['ada', 'bob'], rounds: 1, synthId: null, scoutId: null, withContext: false, overrides });
  assert.equal(start.status, 200);
  const room = await roomDone(start.json.roomId);
  assert.equal(room.status, 'done');
  assert.deepEqual(room.overrides, overrides);
  const calls = fake.calls().slice(before);
  assert.equal(calls.length, 2);
  const adaCall = calls.find((c) => c.seat === 'Ada'), bobCall = calls.find((c) => c.seat === 'Bob');
  assert.equal(modelOf(adaCall), HAIKU); assert.equal(effortOf(adaCall), undefined, 'Haiku takes no --effort');
  assert.equal(modelOf(bobCall), 'gpt-6-luna'); assert.equal(effortOf(bobCall), 'xhigh');
  const adaMsg = room.messages.find((m) => m.seatId === 'ada' && !m.streaming);
  assert.equal(adaMsg.model, HAIKU); assert.equal(adaMsg.effort, 'low');
  const seat = (await ctx.state()).seats.find((s) => s.id === 'ada');
  assert.equal(seat.model, 'claude-sonnet-5-5'); assert.equal(seat.effort, 'high', 'seat defaults are unchanged');
});

testWithFake(fake, 'the Claude scout brief defaults to Haiku for that turn only; the same seat keeps its model elsewhere; a session override wins', async () => {
  fake.scenario({ default: { reply: 'An idea.' } });
  const isScout = (c) => String(c.stdin).includes('Scout task for a meeting');
  let before = fake.calls().length;
  const start = await ctx.post('/api/meeting', { topic: 'Scout default', seatIds: ['ada', 'bob'], rounds: 1, synthId: null, scoutId: 'ada', withContext: false });
  assert.equal(start.status, 200);
  await roomDone(start.json.roomId);
  let calls = fake.calls().slice(before);
  const scout = calls.find(isScout), adaRound1 = calls.find((c) => c.seat === 'Ada' && !isScout(c));
  assert.equal(modelOf(scout), HAIKU, 'scout brief runs on Haiku');
  assert.equal(modelOf(adaRound1), 'claude-sonnet-5-5', 'Ada as participant keeps the seat model');
  assert.equal(effortOf(scout), undefined, 'Haiku takes no --effort');

  before = fake.calls().length;
  const start2 = await ctx.post('/api/meeting', { topic: 'Scout override', seatIds: ['ada', 'bob'], rounds: 1, synthId: null, scoutId: 'ada', withContext: false, overrides: { ada: { model: 'claude-sonnet-5-5' } } });
  assert.equal(start2.status, 200);
  const room2 = await roomDone(start2.json.roomId);
  calls = fake.calls().slice(before);
  assert.equal(modelOf(calls.find(isScout)), 'claude-sonnet-5-5', 'an explicit session override beats the scout default');
  assert.equal(room2.messages.find((m) => m.round === 'scout').model, 'claude-sonnet-5-5', 'the stored scout message names the model it ran on');
});

test('overrides are validated like seats: real agents, supported efforts, CLI-safe model names', async () => {
  const bad = [
    { ghost: { effort: 'low' } },
    { bob: { effort: 'max' } }, // codex has no 'max'
    { ada: { model: 'bad model!' } },
    { ada: 'low' },
    'ada',
  ];
  for (const overrides of bad) {
    const r = await ctx.post('/api/meeting', { topic: 'x', seatIds: ['ada', 'bob'], rounds: 1, overrides });
    assert.equal(r.status, 400, JSON.stringify(overrides));
  }
  const chain = await ctx.post('/api/chain', { task: 'x', builderId: 'ada', reviewerId: 'bob', overrides: { bob: { model: 'a;rm' } } });
  assert.equal(chain.status, 400);
});

testWithFake(fake, 'capEffort: on (default) caps Debate discussion rounds at medium; off keeps the seat effort; persisted in settings.json', async () => {
  fake.scenario({ default: { reply: 'Still open. STANCE: OPEN' } });
  const run = async () => {
    const before = fake.calls().length;
    const start = await ctx.post('/api/meeting', { topic: 'Cap effort', seatIds: ['ada', 'bob'], rounds: 2, synthId: null, scoutId: null, withContext: false });
    const room = await roomDone(start.json.roomId);
    assert.equal(room.status, 'done');
    return fake.calls().slice(before);
  };
  const byRound = (calls, r) => calls.filter((c) => c.stdin.includes(`Round ${r} of 2`)).map(effortOf).sort();

  assert.notEqual((await ctx.state()).settings.capEffort, false, 'default on (absent means on)');
  let calls = await run();
  assert.deepEqual(byRound(calls, 1), ['high', 'high'], 'round 1 is never capped');
  assert.deepEqual(byRound(calls, 2), ['medium', 'medium'], 'discussion rounds capped at medium');

  const off = await ctx.post('/api/settings', { capEffort: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.capEffort, false);
  assert.equal((await ctx.state()).settings.capEffort, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.orchestra', 'settings.json'), 'utf8')).capEffort, false);
  calls = await run();
  assert.deepEqual(byRound(calls, 2), ['high', 'high'], 'with the cap off, discussion keeps the seat effort');

  assert.equal((await ctx.post('/api/settings', { capEffort: true })).json.capEffort, true);
});
