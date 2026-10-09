// Ask backend (plan F8) on a live in-process server with fake CLIs: the first POST
// starts an Ask room and the next one resumes the seat's thread; a seat switch carries the recap in the new seat's first
// prompt with exactly one CLI call; a seat that comes back to its thread gets the messages it has not seen in that same
// call, and a failed turn does not hide them; turns run in order; model and effort reach the CLI args and stay with the
// seat in the conversation; bad input is refused before anything is created; the legacy direct chat still works; stop
// cancels only the running and queued turns; an Ask room interrupted by a restart comes back idle.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, waitFor, startApp, testWithFake, teardown } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');

const HAIKU = 'claude-haiku-5-5';
let dir, project, fake, ctx;

before(async () => {
  dir = tmpDir('ob-ask-');
  project = path.join(dir, 'project');
  fs.mkdirSync(project);
  fake = setupFakeCli(dir);
  ctx = await startApp({ projectDir: project });
  for (const s of [
    { name: 'Ada', role: 'Architect', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', perm: 'read' },
    { name: 'Bob', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'high', perm: 'read' },
  ]) assert.equal((await ctx.post('/api/seats', s)).status, 200);
});
after(() => teardown(ctx, dir));

const roomOf = async (id) => (await ctx.get(`/api/rooms/${id}`)).json;
// Resolves with the room once it is idle (no turn queued or running) and nothing is streaming.
const idle = (id, what = 'Ask room idle') => waitFor(async () => {
  const r = await roomOf(id);
  return r && r.status === 'idle' && r.messages.every((m) => !m.streaming) && r;
}, { timeout: 20000, what });
// The CLI calls whose prompt carries this text (a turn's own message is in its prompt, and so is its recap).
const callsWith = (text) => fake.calls().filter((c) => String(c.stdin).includes(text));

testWithFake(fake, 'create, then continue: the first POST starts an Ask room, the next one resumes the same seat thread with no recap', async () => {
  fake.scenario({ rules: [{ match: 'first question', reply: 'Answer one.' }, { match: 'second question', reply: 'Answer two.' }] });
  const start = await ctx.post('/api/ask', { seatId: 'ada', text: '  first question  ' });
  assert.equal(start.status, 200, start.text);
  const roomId = start.json.roomId;
  const one = await idle(roomId);
  assert.equal(one.kind, 'ask'); assert.equal(one.seatId, 'ada'); assert.equal(one.title, 'first question');
  assert.deepEqual(one.messages.map((m) => [m.seatId, m.text]), [['user', 'first question'], ['ada', 'Answer one.']]);
  const thread = one.threads.ada;
  assert.ok(thread, 'the seat thread is kept in the room');

  const next = await ctx.post('/api/ask', { roomId, seatId: 'ada', text: 'second question' });
  assert.equal(next.status, 200); assert.deepEqual(next.json, { roomId });
  const two = await idle(roomId);
  assert.deepEqual(two.messages.map((m) => [m.seatId, m.text]), [['user', 'first question'], ['ada', 'Answer one.'], ['user', 'second question'], ['ada', 'Answer two.']]);
  assert.equal(two.threads.ada, thread, 'the same thread went on');

  const [first] = callsWith('first question'), [second] = callsWith('second question');
  assert.equal(first.resume, false); assert.equal(first.thread, thread);
  assert.ok(!first.stdin.includes('Context recovery'), 'the first turn of an empty conversation has no recap');
  assert.equal(second.resume, true); assert.equal(second.thread, thread);
  assert.equal(second.stdin, 'second question', 'a resumed turn of the same seat sends only its message');
});

testWithFake(fake, 'switching the seat: the new seat gets the recap in its first prompt, in exactly one CLI call, and the room moves to it', async () => {
  fake.scenario({ rules: [{ seat: 'Ada', reply: 'Ada says: ship the ask backend.' }, { seat: 'Bob', reply: 'Bob agrees.' }] });
  const roomId = (await ctx.post('/api/ask', { seatId: 'ada', text: 'What is the plan?' })).json.roomId;
  await idle(roomId);
  const mark = fake.calls().length;
  const sw = await ctx.post('/api/ask', { roomId, seatId: 'bob', text: 'Anything to add?' });
  assert.deepEqual(sw.json, { roomId });
  const room = await idle(roomId);
  const turn = fake.calls().slice(mark);
  assert.equal(turn.length, 1, 'the switch is one CLI call: the recap is part of its prompt');
  const [bob] = turn;
  assert.equal(bob.seat, 'Bob'); assert.equal(bob.agent, 'codex'); assert.equal(bob.resume, false);
  assert.match(bob.stdin, /^\[You are "Bob"/);
  assert.match(bob.stdin, /Recap of the latest messages/);
  assert.ok(bob.stdin.includes('What is the plan?') && bob.stdin.includes('Ada says: ship the ask backend.'), 'the recap names both earlier messages');
  assert.ok(bob.stdin.endsWith('\n\nAnything to add?'), 'the new message comes last');
  assert.equal(room.seatId, 'bob'); assert.ok(room.threads.bob, 'Bob has a thread in this conversation');
  assert.deepEqual(room.messages.map((m) => m.seatId), ['user', 'ada', 'user', 'bob']);
  assert.equal(room.messages[3].text, 'Bob agrees.');
});

testWithFake(fake, 'turns sent back to back run in order: the second seat sees the first reply, and the room keeps that order', async () => {
  fake.scenario({ rules: [{ seat: 'Ada', reply: 'First reply from Ada.' }, { seat: 'Bob', reply: 'Second reply from Bob.' }] });
  const roomId = (await ctx.post('/api/ask', { seatId: 'ada', text: 'Question one' })).json.roomId;
  assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'bob', text: 'Question two' })).status, 200);
  const room = await idle(roomId);
  assert.deepEqual(room.messages.map((m) => [m.seatId, m.text]), [['user', 'Question one'], ['ada', 'First reply from Ada.'], ['user', 'Question two'], ['bob', 'Second reply from Bob.']]);
  assert.match(callsWith('Question two')[0].stdin, /First reply from Ada\./, 'Bob recap has the reply that came before its turn');
});

testWithFake(fake, 'switch back: a seat that resumes its thread gets only the messages posted since its last reply, in the same CLI call', async () => {
  fake.scenario({ rules: [
    { seat: 'Ada', match: 'alpha one', reply: 'Ada reply one.' },
    { seat: 'Bob', match: 'beta two', reply: 'Bob reply two.' },
    { seat: 'Ada', match: 'gamma three', reply: 'Ada reply three.' },
  ] });
  const roomId = (await ctx.post('/api/ask', { seatId: 'ada', text: 'alpha one' })).json.roomId;
  const thread = (await idle(roomId)).threads.ada;
  assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'bob', text: 'beta two' })).status, 200);
  await idle(roomId);
  const mark = fake.calls().length;
  assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'ada', text: 'gamma three' })).status, 200);
  const room = await idle(roomId);
  const turn = fake.calls().slice(mark);
  assert.equal(turn.length, 1, 'the switch back is one CLI call: the missed messages are part of its prompt');
  const [ada] = turn;
  assert.equal(ada.seat, 'Ada'); assert.equal(ada.resume, true); assert.equal(ada.thread, thread, 'Ada resumes her own thread');
  assert.match(ada.stdin, /Bob reply two\./, 'the reply from Bob, which Ada has not seen, is in the prompt');
  assert.match(ada.stdin, /beta two/, 'so is the user message that went to Bob');
  assert.ok(!ada.stdin.includes('alpha one'), 'what Ada already has is not sent again');
  assert.ok(ada.stdin.endsWith('\n\ngamma three'), 'the new message comes last');
  assert.equal(room.threads.ada, thread, 'the thread did not change');
  assert.deepEqual(room.messages.map((m) => m.seatId), ['user', 'ada', 'user', 'bob', 'user', 'ada']);
  assert.equal(room.messages[5].text, 'Ada reply three.');
});

testWithFake(fake, 'a failed turn does not count as seen: the seat\'s next turn still gets the messages it missed', async () => {
  fake.scenario({ rules: [
    { seat: 'Ada', match: 'fourth call', reply: 'Ada reply four.' },
    { seat: 'Ada', match: 'third call', error: 'Something else broke' },
    { seat: 'Ada', match: 'first call', reply: 'Ada reply one.' },
    { seat: 'Bob', match: 'second call', reply: 'Bob reply two.' },
  ] });
  const roomId = (await ctx.post('/api/ask', { seatId: 'ada', text: 'first call' })).json.roomId;
  const thread = (await idle(roomId)).threads.ada;
  assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'bob', text: 'second call' })).status, 200);
  await idle(roomId);
  assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'ada', text: 'third call' })).status, 200);
  const failed = await idle(roomId);
  assert.equal(failed.messages[failed.messages.length - 1].failed, true, 'the third call failed');
  const mark = fake.calls().length;
  assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'ada', text: 'fourth call' })).status, 200);
  const room = await idle(roomId);
  const [ada] = fake.calls().slice(mark);
  assert.equal(ada.resume, true); assert.equal(ada.thread, thread, 'the same thread went on');
  assert.match(ada.stdin, /Bob reply two\./, 'the failed turn did not count as seen, so the reply from Bob is sent again');
  assert.ok(ada.stdin.endsWith('\n\nfourth call'), 'the new message comes last');
  assert.equal(room.messages[room.messages.length - 1].text, 'Ada reply four.');
});

testWithFake(fake, 'a long gap keeps the latest eight messages, and the prompt says how many earlier ones were left out', async () => {
  fake.scenario({ rules: [
    { seat: 'Ada', match: 'gap start', reply: 'Ada reply start.' },
    { seat: 'Ada', match: 'gap end', reply: 'Ada reply end.' },
  ], default: { reply: 'Bob reply.' } });
  const roomId = (await ctx.post('/api/ask', { seatId: 'ada', text: 'gap start' })).json.roomId;
  await idle(roomId);
  for (let i = 1; i <= 5; i++) assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'bob', text: `gap bob ${i}` })).status, 200);
  await idle(roomId);
  const mark = fake.calls().length;
  assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'ada', text: 'gap end' })).status, 200);
  await idle(roomId);
  const [ada] = fake.calls().slice(mark);
  assert.match(ada.stdin, /; 2 earlier not shown\)/, 'the two oldest messages are left out, and the prompt says so');
  assert.ok(ada.stdin.includes('gap bob 2') && ada.stdin.includes('gap bob 5'), 'the latest eight messages are kept');
  assert.ok(!ada.stdin.includes('gap bob 1'), 'the oldest message is not sent');
});

testWithFake(fake, 'a model and effort reach the CLI argv and stay with the seat in this conversation; an empty value clears them', async () => {
  fake.scenario({ default: { reply: 'Ok.' } });
  const roomId = (await ctx.post('/api/ask', { seatId: 'ada', text: 'Pick a model', model: HAIKU, effort: 'low' })).json.roomId;
  let room = await idle(roomId);
  const [haiku] = callsWith('Pick a model');
  assert.equal(haiku.model, HAIKU); assert.equal(haiku.args[haiku.args.indexOf('--model') + 1], HAIKU, 'the override is on the claude argv');
  assert.deepEqual(room.overrides, { ada: { model: HAIKU, effort: 'low' } });

  await ctx.post('/api/ask', { roomId, seatId: 'ada', text: 'Keep it' });
  await idle(roomId);
  assert.equal(callsWith('Keep it')[0].model, HAIKU, 'the override stays with the seat');

  await ctx.post('/api/ask', { roomId, seatId: 'ada', text: 'Back to default', model: '', effort: null });
  room = await idle(roomId);
  assert.equal(callsWith('Back to default')[0].model, 'claude-sonnet-5-5', 'an empty value falls back to the seat model');
  assert.deepEqual(room.overrides, {});

  await ctx.post('/api/ask', { roomId, seatId: 'bob', text: 'Codex turn', model: 'gpt-6-luna', effort: 'xhigh' });
  room = await idle(roomId);
  const [codex] = callsWith('Codex turn');
  assert.equal(codex.model, 'gpt-6-luna'); assert.equal(codex.effort, 'xhigh', 'the effort is on the codex argv');
  assert.deepEqual(room.overrides, { bob: { model: 'gpt-6-luna', effort: 'xhigh' } });
});

test('bad input is refused before anything is created: text, seat, room, model and effort', async () => {
  const rooms = async () => (await ctx.get('/api/state')).json.roomIndex.length;
  const count = await rooms();
  const refused = [
    [{ seatId: 'ada', text: '' }, 400, 'empty message'],
    [{ seatId: 'ada', text: '   ' }, 400, 'empty message'],
    [{ seatId: 'ada' }, 400, 'empty message'],
    [{ seatId: 'ada', text: 42 }, 400, 'text must be a string'],
    [{ seatId: 'ada', text: 'x'.repeat(20001) }, 400, 'text is too long (max 20000 characters)'],
    [{ text: 'hi' }, 400, 'seatId is required'],
    [{ seatId: 'nobody', text: 'hi' }, 404, 'no such agent'],
    [{ seatId: 'ada', text: 'hi', roomId: 'nope' }, 404, 'no such room'],
    [{ seatId: 'ada', text: 'hi', model: 'bad model!' }, 400, 'invalid model name'],
    [{ seatId: 'ada', text: 'hi', model: 7 }, 400, 'invalid model name'],
    [{ seatId: 'bob', text: 'hi', effort: 'max' }, 400, 'effort "max" is not supported by Bob'],
  ];
  for (const [body, status, error] of refused) {
    const r = await ctx.post('/api/ask', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.deepEqual(r.json, { error }, JSON.stringify(body));
  }
  assert.equal(await rooms(), count, 'no room was created by a refused request');
});

testWithFake(fake, 'the legacy direct chat still works through /api/seats/:id/send, and Ask refuses a direct chat room', async () => {
  fake.scenario({ default: { reply: 'Hello from the chat.' } });
  assert.deepEqual((await ctx.post('/api/seats/bob/send', { text: 'hello bob' })).json, { roomId: 'dm-bob' });
  const dm = await idle('dm-bob');
  assert.equal(dm.kind, 'dm');
  assert.deepEqual(dm.messages.map((m) => [m.seatId, m.text]), [['user', 'hello bob'], ['bob', 'Hello from the chat.']]);
  const refused = await ctx.post('/api/ask', { roomId: 'dm-bob', seatId: 'bob', text: 'hi' });
  assert.equal(refused.status, 400); assert.deepEqual(refused.json, { error: 'not an Ask room' });
});

testWithFake(fake, 'stop cancels the running and the queued turn of an Ask room, the queued one never reaches the CLI, and the room takes new turns', async () => {
  fake.resetCalls();
  // Anchored to the end: a later turn's recap also quotes this message, and that turn must not hang.
  fake.scenario({ rules: [{ match: 'hang please\\s*$', hang: true }], default: { reply: 'Back again.' } });
  const roomId = (await ctx.post('/api/ask', { seatId: 'ada', text: 'hang please' })).json.roomId;
  assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'ada', text: 'queued behind it' })).status, 200);
  await fake.waitCalls((c) => String(c.stdin).includes('hang please'));
  assert.deepEqual((await ctx.post(`/api/rooms/${roomId}/stop`)).json, { ok: true });
  const stopped = await idle(roomId, 'stopped Ask room idle');
  assert.deepEqual(stopped.messages.filter((m) => m.seatId === 'ada').map((m) => m.error), ['stopped', 'stopped']);
  assert.equal(callsWith('queued behind it').length, 0, 'the queued turn never reached the CLI');
  // The conversation is not stopped for good: its next turn runs.
  assert.equal((await ctx.post('/api/ask', { roomId, seatId: 'ada', text: 'still there?' })).status, 200);
  const again = await idle(roomId);
  assert.equal(again.messages[again.messages.length - 1].text, 'Back again.');
});

test('an Ask room that was running when the board stopped comes back idle, and its interrupted turn is failed', async () => {
  const id = 'askrestart1';
  const rooms = path.join(project, '.orchestra', 'rooms');
  fs.mkdirSync(rooms, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(rooms, id + '.json'), JSON.stringify({
    id, kind: 'ask', title: 'Interrupted', status: 'running', created: at, round: 0, seatId: 'ada', overrides: {}, threads: {},
    messages: [
      { id: 'u1', ts: at, seatId: 'user', name: 'You', text: 'before the restart', streaming: false },
      { id: 'a1', ts: at, seatId: 'ada', name: 'Ada', text: '', streaming: true },
    ],
  }));
  const again = await startApp({ projectDir: project });
  try {
    const room = (await again.get(`/api/rooms/${id}`)).json;
    assert.equal(room.status, 'idle');
    assert.equal(room.messages[1].failed, true); assert.equal(room.messages[1].streaming, false);
    assert.match(room.messages[1].error, /^interrupted/);
  } finally {
    await again.stop();
  }
});
