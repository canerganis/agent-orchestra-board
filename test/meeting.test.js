// Debate workflow end-to-end on a temp project with fake CLIs (port 4392): scout brief, parallel round 1,
// unseen-only discussion rounds, user notes, STANCE: CONVERGED early stop, silent agreement, synthesis to BRAINSTORM.md.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, waitFor, startApp, testWithFake, samePath, teardown } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');
const { today } = require('../src/util');

const PORT = 4392;
let dir, project, fake, ctx;

before(async () => {
  dir = tmpDir('ob-meeting-'); project = path.join(dir, 'project'); fs.mkdirSync(project);
  fake = setupFakeCli(dir);
  ctx = await startApp({ port: PORT, projectDir: project });
  for (const s of [
    { name: 'Scout', role: 'Scout', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', perm: 'read' },
    { name: 'Ada', role: 'Architect', agent: 'claude', model: 'claude-opus-5-5', effort: 'high', perm: 'read' },
    { name: 'Bob', role: "Devil's advocate", agent: 'codex', model: 'gpt-6-luna', effort: 'medium', perm: 'read' },
    { name: 'Fay', role: 'Facilitator', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', perm: 'read' },
  ]) assert.equal((await ctx.post('/api/seats', s)).status, 200);
});
after(() => teardown(ctx, dir));

const TOPIC = 'Harden the local security gate';
const BRIEF = 'BRIEF: the gate lives in src/server.js:91; Host and Origin are checked first; there is no auth layer.';
const NOTE = 'Note from me: keep it zero-dependency, please.';
const SYNTH = 'SYNTHESIS: consensus on the allowlist; open: token rotation (Ada vs Bob); recommendation: tests first.';
const done = (roomId) => waitFor(async () => { const r = await ctx.room(roomId); return r && r.status !== 'running' && r; }, { timeout: 25000, what: 'meeting to finish' });

testWithFake(fake, 'full debate: scout brief -> parallel round 1 without tools -> unseen-only round 2 with the user note -> early stop -> synthesis to BRAINSTORM.md', async () => {
  fake.scenario([
    { seat: 'Scout', match: 'Scout task', reply: BRIEF },
    { seat: 'Ada', match: 'Round 1 of 4', reply: 'Idea A: add a per-launch session token.', gate: 'r1' },
    { seat: 'Bob', match: 'Round 1 of 4', reply: 'Idea B: keep the host allowlist only.', gate: 'r1' },
    { seat: 'Ada', match: 'Round 2 of 4', reply: 'Merging with Bob: allowlist first, token later.\nSTANCE: CONVERGED' },
    { seat: 'Bob', match: 'Round 2 of 4', reply: 'Agreed with Ada.\n**STANCE: CONVERGED**' },
    { seat: 'Fay', match: 'facilitator', reply: SYNTH },
  ]);
  const sse = await ctx.sse();
  const start = await ctx.post('/api/meeting', { topic: TOPIC, seatIds: ['ada', 'bob'], rounds: 4, synthId: 'fay', scoutId: 'scout', withContext: false });
  assert.equal(start.status, 200);
  const roomId = start.json.roomId;
  // Round 1 is in flight (both seats parked at the gate): interject a note, then let the round finish.
  await fake.waitCalls((c) => /Round 1 of 4/.test(c.stdin), 2);
  let room = await ctx.room(roomId);
  assert.equal(room.status, 'running'); assert.equal(room.round, 1);
  assert.deepEqual((await ctx.state()).seats.filter((s) => s.status === 'working').map((s) => s.id).sort(), ['ada', 'bob']);
  assert.deepEqual((await ctx.post(`/api/rooms/${roomId}/say`, { text: NOTE })).json, { ok: true });
  fake.openGate('r1');
  room = await done(roomId);
  assert.equal(room.status, 'done');
  sse.close();

  // ---- what the CLIs were asked ----
  const calls = fake.calls();
  assert.equal(calls.length, 6, 'scout + 2 (round 1) + 2 (round 2) + synthesis; rounds 3-4 skipped');
  assert.ok(!calls.some((c) => /Round 3 of 4/.test(c.stdin)));
  const scout = calls.find((c) => c.seat === 'Scout');
  assert.ok(scout.stdin.includes(`Scout task for a meeting. Topic:\n${TOPIC}`));
  assert.deepEqual(scout.tools, ['Read', 'Grep', 'Glob'], 'the scout is the only step with tools');
  assert.equal(scout.effort, 'low'); assert.equal(scout.resume, false);
  const r1 = calls.filter((c) => /Round 1 of 4/.test(c.stdin));
  const r1a = r1.find((c) => c.seat === 'Ada'), r1b = r1.find((c) => c.seat === 'Bob');
  for (const c of [r1a, r1b]) {
    assert.ok(c.stdin.includes(`Meeting topic:\n${TOPIC}`) && c.stdin.includes(`Shared brief (facts gathered by Scout; rely on it instead of re-reading files):\n${BRIEF}`));
    assert.ok(c.stdin.includes('(No tools or commands this turn'));
    assert.ok(!c.stdin.includes(NOTE), 'the note arrived after round 1 was sent');
    assert.ok(c.stdin.startsWith('[You are "'), 'fresh room thread: role header present');
  }
  assert.deepEqual(r1a.tools, [''], 'claude: --tools "" in a no-tools round'); assert.equal(r1a.effort, 'high');
  assert.ok(samePath(r1b.cwd, path.join(project, '.orchestra', 'empty')), 'codex: no-tools turn runs in .orchestra/empty'); assert.equal(r1b.sandbox, 'read-only');
  const r2 = calls.filter((c) => /Round 2 of 4/.test(c.stdin));
  assert.deepEqual(r2.map((c) => c.seat), ['Ada', 'Bob'], 'discussion goes around in seat order');
  const [r2a, r2b] = r2;
  assert.equal(r2a.resume, true); assert.equal(r2a.args[r2a.args.indexOf('--resume') + 1], r1a.args[r1a.args.indexOf('--session-id') + 1], 'per-room thread resumed');
  assert.ok(!r2a.stdin.includes('Meeting topic:') && !r2a.stdin.startsWith('['), 'a resumed thread gets neither background nor header');
  assert.ok(r2a.stdin.includes('New messages since your last turn:\n\nBob: Idea B: keep the host allowlist only.'));
  assert.ok(r2a.stdin.includes(`User (the human running this meeting): ${NOTE}`), 'the note is delivered in round 2');
  assert.ok(!r2a.stdin.includes('Idea A'), 'own messages are never re-sent');
  assert.equal(r2a.effort, 'medium', 'discussion effort capped at medium (seat effort is high)'); assert.deepEqual(r2a.tools, ['']);
  assert.deepEqual(r2b.args.slice(0, 3), ['exec', 'resume', r1b.thread]);
  assert.ok(r2b.stdin.includes('Ada: Idea A') && r2b.stdin.includes('Ada: Merging with Bob') && r2b.stdin.includes(NOTE));
  assert.ok(!r2b.stdin.includes('Idea B')); assert.equal(r2b.effort, 'medium');
  assert.ok(/End with exactly one line: "STANCE: CONVERGED"/.test(r2b.stdin));
  const synth = calls.find((c) => c.seat === 'Fay');
  assert.equal(synth.resume, false);
  assert.ok(synth.stdin.includes(`Meeting topic:\n${TOPIC}`) && synth.stdin.includes(BRIEF), 'a facilitator who did not participate gets the background');
  assert.ok(synth.stdin.includes('You are the facilitator. Meeting transcript:'));
  for (const s of ['Ada: Idea A', 'Bob: Idea B', 'Merging with Bob', 'Agreed with Ada', NOTE]) assert.ok(synth.stdin.includes(s), `synthesis sees "${s}"`);
  assert.ok(samePath(synth.cwd, path.join(project, '.orchestra', 'empty')));

  // ---- the room ----
  assert.equal(room.round, 'synthesis'); assert.equal(room.kind, 'meeting'); assert.equal(room.title, TOPIC.slice(0, 60));
  assert.deepEqual({ topic: room.topic, seatIds: room.seatIds, rounds: room.rounds, synthId: room.synthId, scoutId: room.scoutId }, { topic: TOPIC, seatIds: ['ada', 'bob'], rounds: 4, synthId: 'fay', scoutId: 'scout' });
  const msgs = room.messages;
  assert.deepEqual([msgs[0].seatId, msgs[0].text], ['user', TOPIC]);
  const sm = msgs.find((m) => m.seatId === 'scout');
  assert.deepEqual({ round: sm.round, label: sm.label, text: sm.text, tokens: sm.tokens, cached: sm.cached, cost: sm.cost, streaming: sm.streaming, error: sm.error, tools: sm.tools }, { round: 'scout', label: 'scout brief', text: BRIEF, tokens: 15, cached: 5, cost: 0.01, streaming: false, error: null, tools: 'read' });
  const round1 = msgs.filter((m) => m.round === 1 && m.seatId !== 'system');
  assert.deepEqual(round1.map((m) => [m.seatId, m.label, m.tools]).sort(), [['ada', 'independent ideas', 'none'], ['bob', 'independent ideas', 'none']]);
  const round2 = msgs.filter((m) => m.round === 2 && m.seatId !== 'system');
  assert.deepEqual(round2.map((m) => [m.seatId, m.label, m.effort]), [['ada', 'discussion', 'medium'], ['bob', 'discussion', 'medium']]);
  const early = msgs.find((m) => m.seatId === 'system' && /Everyone converged/.test(m.text));
  assert.ok(early && early.earlyStop === 2, 'early stop after round 2');
  assert.ok(msgs.some((m) => m.seatId === 'user' && m.text === NOTE));
  assert.ok(!msgs.some((m) => /^Not delivered/.test(m.text)), 'the note was read');
  const fay = msgs.filter((m) => m.seatId === 'fay');
  assert.equal(fay.length, 1); assert.equal(fay[0].label, 'synthesis'); assert.equal(fay[0].text, SYNTH); assert.equal(room.resultId, fay[0].id);
  assert.deepEqual(room.usage, { tokens: 186, cached: 195, cost: 0.03, perSeat: { scout: 15, ada: 30, bob: 94, fay: 47 } });
  assert.deepEqual(Object.keys(room.threads).sort(), ['ada', 'bob', 'fay', 'scout:scout'], 'scout brief rides in its own thread');
  assert.equal(room.threads.ada, r1a.args[r1a.args.indexOf('--session-id') + 1]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.orchestra', 'rooms', `${roomId}.json`), 'utf8')), room, 'persisted room equals the served one');

  // ---- side effects ----
  const brainstorm = fs.readFileSync(path.join(project, '.orchestra', 'BRAINSTORM.md'), 'utf8');
  assert.ok(brainstorm.startsWith('# Brainstorm\n'));
  assert.ok(brainstorm.includes(`\n## Debate (${today()}): ${TOPIC}\nParticipants: Ada, Bob · rounds: 4 · synthesis: Fay\n\n${SYNTH}\n`));
  const log = fs.readFileSync(path.join(project, '.orchestra', 'LOG.md'), 'utf8');
  assert.ok(log.includes(`| board | Debate "${TOPIC}" done (ada, bob; net 186 tok, cached 195).`), log);
  const seats = JSON.parse(fs.readFileSync(path.join(project, '.orchestra', 'seats.json'), 'utf8'));
  const used = Object.fromEntries(seats.map((s) => [s.id, s.used]));
  assert.equal(used.scout, 15); assert.equal(used.ada, 30); assert.equal(used.bob, 94); assert.equal(used.fay, 47);
  assert.ok((await ctx.state()).seats.every((s) => s.status === 'idle' && s.roomId === null));

  // ---- live events ----
  const runs = sse.of('run'), ends = sse.of('end');
  assert.equal(runs.length, 6); assert.equal(ends.length, 6);
  assert.ok(ends.every((e) => e.ok && e.error === null && e.roomId === roomId));
  // Round 1 runs in parallel, so its two turns may end in either order: compare as sets.
  assert.deepEqual(ends.map((e) => e.runId).sort(), runs.map((e) => e.runId).sort());
  const all = sse.events, lastBobEnd = all.map((e) => e.t === 'end' && e.seatId === 'bob').lastIndexOf(true);
  assert.ok(all.findIndex((e) => e.t === 'run' && e.seatId === 'fay') > lastBobEnd, 'synthesis starts only after the discussion ended');
  assert.equal(sse.of('delta').filter((e) => e.seatId === 'ada' && e.runId === round1.find((m) => m.seatId === 'ada').id).map((e) => e.text).join(''), 'Idea A: add a per-launch session token.');
  const rounds = sse.of('room').filter((e) => e.room.id === roomId).map((e) => e.room.round);
  for (const r of ['scout', 1, 2, 'synthesis']) assert.ok(rounds.includes(r), `room event for round ${r}`);
  assert.ok(sse.of('room').every((e) => !('messages' in e.room)), 'room events carry meta only');
  assert.ok(sse.of('msg').some((e) => e.roomId === roomId && e.msg.text === NOTE));
  assert.ok(sse.of('msg').some((e) => e.msg.seatId === 'fay' && e.msg.text === SYNTH && e.msg.streaming === false));
});

testWithFake(fake, 'rounds:1 without a scout: round 1 reads code with the project context; a note nobody could read is reported as not delivered', async () => {
  fake.resetCalls();
  fs.writeFileSync(path.join(project, '.orchestra', 'PLAN.md'), 'Plan: ship v0.1 read-only.\n');
  const before = fs.readFileSync(path.join(project, '.orchestra', 'BRAINSTORM.md'), 'utf8');
  fake.scenario([{ match: 'Second topic', reply: 'fine by me', gate: 'r1b' }]);
  const { json: { roomId } } = await ctx.post('/api/meeting', { topic: 'Second topic: naming', seatIds: ['ada', 'bob'], rounds: 1, withContext: true });
  await fake.waitCalls((c) => /Second topic/.test(c.stdin), 2);
  assert.deepEqual((await ctx.post(`/api/rooms/${roomId}/say`, { text: 'Late note' })).json, { ok: true });
  fake.openGate('r1b');
  const room = await done(roomId);
  assert.equal(room.status, 'done'); assert.equal(room.round, 1);
  const calls = fake.calls();
  assert.equal(calls.length, 2);
  const ada = calls.find((c) => c.seat === 'Ada'), bob = calls.find((c) => c.seat === 'Bob');
  assert.deepEqual(ada.tools, ['Read', 'Grep', 'Glob'], 'no brief: round 1 may read code');
  assert.ok(samePath(bob.cwd, project), 'codex reads the project (not the empty dir)'); assert.equal(bob.sandbox, 'read-only');
  for (const c of [ada, bob]) {
    assert.ok(c.stdin.includes('Round 1 of 1') && !c.stdin.includes('Shared brief'));
    assert.ok(c.stdin.includes('--- ORCHESTRA CONTEXT ---') && c.stdin.includes('## .orchestra/PLAN.md\nPlan: ship v0.1 read-only.'), 'withContext inlines .orchestra notes');
    assert.ok(c.stdin.includes('## .orchestra/LOG.md (tail)'));
  }
  const nd = room.messages.find((m) => m.seatId === 'system' && /^Not delivered/.test(m.text));
  assert.ok(nd && nd.text.includes('"Late note"'), 'undelivered note is flagged');
  assert.equal(room.resultId, undefined);
  assert.equal(fs.readFileSync(path.join(project, '.orchestra', 'BRAINSTORM.md'), 'utf8'), before, 'no synthesis: BRAINSTORM.md untouched');
  assert.equal((await ctx.post(`/api/rooms/${roomId}/say`, { text: 'too late' })).status, 400, 'finished rooms refuse notes');
});

testWithFake(fake, 'silent agreement: a converged seat skips its turn when everything new is also converged; no early stop in the last round', async () => {
  fake.resetCalls();
  fake.scenario([
    { seat: 'Ada', nth: 1, reply: 'A1' }, { seat: 'Ada', nth: 2, reply: 'A2\nSTANCE: OPEN' }, { seat: 'Ada', nth: 3, reply: 'A3\nSTANCE: CONVERGED' },
    { seat: 'Bob', nth: 1, reply: 'B1' }, { seat: 'Bob', nth: 2, reply: 'B2\nSTANCE: CONVERGED' }, { seat: 'Bob', nth: 3, reply: 'B3 must never be asked' },
  ]);
  const { json: { roomId } } = await ctx.post('/api/meeting', { topic: 'Third topic', seatIds: ['ada', 'bob'], rounds: 3 });
  const room = await done(roomId);
  assert.equal(room.status, 'done'); assert.equal(room.round, 3);
  const calls = fake.calls();
  assert.deepEqual(calls.slice(0, 2).map((c) => c.seat).sort(), ['Ada', 'Bob'], 'round 1 is parallel (either order)');
  assert.deepEqual(calls.slice(2).map((c) => c.seat), ['Ada', 'Bob', 'Ada'], 'Bob stays silent in round 3');
  const skip = room.messages.find((m) => m.seatId === 'system' && /agreed silently/.test(m.text));
  assert.ok(skip && skip.text.includes('Bob'), 'system note names the silent seat');
  assert.deepEqual(skip.skip, { seatId: 'bob', round: 3 });
  assert.ok(!room.messages.some((m) => /Everyone converged/.test(m.text)), 'the last round never announces an early stop');
  // Round 1 ran in parallel, so Ada's round-1 idea is still unseen by Bob in round 2; from then on only the new turn.
  assert.ok(calls[2].stdin.includes('Bob: B1') && !calls[2].stdin.includes('A1'), 'Ada round 2 sees Bob round 1, never her own text');
  assert.ok(calls[3].stdin.includes('Ada: A1') && calls[3].stdin.includes('Ada: A2') && !calls[3].stdin.includes('B1'), 'Bob round 2 sees both Ada turns he has not read');
  assert.ok(calls[4].stdin.includes('Bob: B2') && !calls[4].stdin.includes('B1') && !calls[4].stdin.includes('A2'), 'Ada round 3 sees only Bob round 2');
  assert.deepEqual(room.usage.perSeat, { ada: 45, bob: 94 });
});

testWithFake(fake, 'a failing seat does not break the meeting: its message carries the error, the others continue, the room still finishes', async () => {
  fake.resetCalls();
  fake.scenario([{ seat: 'Ada', match: 'Fourth topic', reply: '', crash: 'claude: boom', exit: 1 }, { match: 'Fourth topic', reply: 'B only' }]);
  const { json: { roomId } } = await ctx.post('/api/meeting', { topic: 'Fourth topic', seatIds: ['ada', 'bob'], rounds: 1 });
  const room = await done(roomId);
  assert.equal(room.status, 'done');
  const ada = room.messages.find((m) => m.seatId === 'ada'), bob = room.messages.find((m) => m.seatId === 'bob');
  assert.equal(ada.text, ''); assert.match(ada.error, /boom/); assert.equal(ada.streaming, false);
  assert.equal(bob.text, 'B only'); assert.equal(bob.error, null);
  const seat = await ctx.seat('ada');
  assert.equal(seat.status, 'error'); assert.match(seat.activity, /boom/);
  // The successful turn is accounted in full; a crashed turn may keep whatever partial stream usage it reported.
  assert.equal(room.usage.perSeat.bob, 47);
  assert.ok((room.usage.perSeat.ada || 0) <= 15 && room.usage.tokens === 47 + (room.usage.perSeat.ada || 0));
});

testWithFake(fake, 'unseen-only is marked seen only after a successful turn: a seat whose discussion turn failed gets the same messages again next round, the others only what is new', async () => {
  fake.resetCalls();
  fake.scenario([
    { seat: 'Ada', nth: 1, reply: 'A1' }, { seat: 'Ada', nth: 2, reply: '', crash: 'claude: boom in round 2', exit: 1 }, { seat: 'Ada', nth: 3, reply: 'A3\nSTANCE: OPEN' },
    { seat: 'Bob', nth: 1, reply: 'B1' }, { seat: 'Bob', nth: 2, reply: 'B2\nSTANCE: OPEN' }, { seat: 'Bob', nth: 3, reply: 'B3\nSTANCE: OPEN' },
  ]);
  const { json: { roomId } } = await ctx.post('/api/meeting', { topic: 'Fifth topic: retries', seatIds: ['ada', 'bob'], rounds: 3 });
  const room = await done(roomId);
  assert.equal(room.status, 'done'); assert.equal(room.round, 3);
  const calls = fake.calls();
  assert.equal(calls.length, 6, 'a failed turn is not retried inside the round; the meeting goes on');
  assert.deepEqual(calls.slice(2).map((c) => c.seat), ['Ada', 'Bob', 'Ada', 'Bob']);
  const [ada2, bob2, ada3, bob3] = calls.slice(2);
  // Round 2: Ada was offered Bob's round-1 idea and crashed before answering.
  assert.ok(/Round 2 of 3/.test(ada2.stdin) && ada2.stdin.includes('Bob: B1'));
  const adaMsgs = room.messages.filter((m) => m.seatId === 'ada');
  assert.equal(adaMsgs.length, 3);
  assert.deepEqual([adaMsgs[1].round, adaMsgs[1].text, adaMsgs[1].streaming], [2, '', false]); assert.match(adaMsgs[1].error, /boom in round 2/);
  // Round 3: the failed turn did not mark anything seen, so Ada gets B1 again plus B2; never her own text.
  assert.ok(/Round 3 of 3/.test(ada3.stdin), 'Ada is asked again in round 3');
  assert.ok(ada3.stdin.includes('Bob: B1'), 'B1 is re-delivered after the failed turn');
  assert.ok(ada3.stdin.includes('Bob: B2'), 'plus what Bob said meanwhile');
  assert.ok(!ada3.stdin.includes('A1') && !ada3.stdin.includes('A3'), 'own messages are never re-sent');
  assert.ok(/New messages since your last turn:\n\nBob: B1\n\nBob: B2\nSTANCE: OPEN\n\n/.test(ada3.stdin), 'in transcript order, nothing else in between');
  // Bob's turns succeeded, so he only ever gets what is new since his own last turn (the empty failed message is not a message).
  assert.ok(bob2.stdin.includes('Ada: A1') && !bob2.stdin.includes('B1'));
  assert.ok(bob3.stdin.includes('Ada: A3') && !bob3.stdin.includes('A1') && !bob3.stdin.includes('B1') && !bob3.stdin.includes('B2'), 'Bob round 3 sees only Ada round 3');
  assert.ok(!/Ada:\s*\n/.test(bob3.stdin), 'a failed turn without text is not delivered as an empty message');
  assert.equal(adaMsgs[2].text, 'A3\nSTANCE: OPEN'); assert.equal(adaMsgs[2].error, null);
  assert.ok(!room.messages.some((m) => /^Not delivered/.test(m.text)));
  assert.equal((await ctx.seat('ada')).status, 'idle', 'the seat recovered with its round-3 turn');
});
