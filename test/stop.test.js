// Stop semantics with hanging fake CLIs (port 4394): seat stop in a DM, DM room stop cancelling queued turns,
// meeting stop, deleting a running room; the CLI process tree must really die (taskkill /T on Windows).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, waitFor, startApp, testWithFake, isDead, treeDead, treePids, teardown } = require('./helpers');
const { setupFakeCli } = require('./fake-cli');

const PORT = 4394;
let dir, project, fake, ctx;

before(async () => {
  dir = tmpDir('ob-stop-'); project = path.join(dir, 'project'); fs.mkdirSync(project);
  fake = setupFakeCli(dir);
  ctx = await startApp({ port: PORT, projectDir: project });
  for (const s of [
    { name: 'Ada', role: 'Builder', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', perm: 'read' },
    { name: 'Bob', role: 'Reviewer', agent: 'codex', model: 'gpt-6-luna', effort: 'medium', perm: 'read' },
  ]) assert.equal((await ctx.post('/api/seats', s)).status, 200);
});
after(() => teardown(ctx, dir));

// Every PID must die, including the command that inherits the CLI's stdout/stderr.
const dead = (call) => waitFor(() => treeDead(call), { timeout: 10000, what: `fake CLI tree (${treePids(call).join(' > ')}) to die` });

testWithFake(fake, 'direct chat: stop kills the running turn (error "stopped"), the seat cannot be deleted while running, the DM room goes idle', async () => {
  fake.scenario({ default: { hang: true, spawnChild: true } });
  const sse = await ctx.sse();
  assert.deepEqual((await ctx.post('/api/seats/ada/stop')).json, { ok: false }, 'nothing to stop yet');
  const send = await ctx.post('/api/seats/ada/send', { text: 'hello there' });
  assert.deepEqual(send.json, { roomId: 'dm-ada' });
  const [call] = await fake.waitCalls((c) => c.seat === 'Ada');
  assert.ok(call.childPid, 'the fake CLI spawned a long command');
  assert.equal(isDead(call.childPid), false, 'the command is alive before Stop');
  assert.equal(call.stdin.endsWith('hello there'), true);
  const working = await waitFor(async () => { const s = await ctx.seat('ada'); return s.status === 'working' && s; }, { what: 'seat working' });
  assert.equal(working.roomId, 'dm-ada'); assert.ok(working.startedAt);
  assert.equal((await ctx.room('dm-ada')).status, 'running');
  const del = await ctx.post('/api/seats/ada/delete');
  assert.equal(del.status, 400); assert.deepEqual(del.json, { error: 'cannot delete while running' });
  assert.deepEqual((await ctx.post('/api/seats/ada/stop')).json, { ok: true });
  const end = await sse.waitFor((e) => e.t === 'end' && e.seatId === 'ada', { timeout: 10000 });
  assert.equal(end.ok, false); assert.equal(end.error, 'stopped'); assert.equal(end.roomId, 'dm-ada');
  await dead(call);
  const seat = await ctx.seat('ada');
  assert.equal(seat.status, 'error'); assert.equal(seat.activity, 'stopped'); assert.equal(seat.startedAt, null); assert.equal(seat.roomId, null);
  const room = await waitFor(async () => { const r = await ctx.room('dm-ada'); return r.status === 'idle' && r; }, { what: 'dm idle' });
  assert.equal(room.kind, 'dm'); assert.equal(room.title, 'Chat with Ada');
  const last = room.messages[room.messages.length - 1];
  assert.deepEqual([last.seatId, last.error, last.streaming, last.text], ['ada', 'stopped', false, '']);
  assert.deepEqual((await ctx.post('/api/seats/ada/stop')).json, { ok: false }, 'already stopped');
  sse.close();
});

testWithFake(fake, 'direct chat room stop: the running turn is killed and the queued one is cancelled without ever spawning', async () => {
  fake.resetCalls();
  fake.scenario({ default: { hang: true, spawnChild: true } });
  assert.deepEqual((await ctx.post('/api/seats/bob/send', { text: 'first' })).json, { roomId: 'dm-bob' });
  assert.deepEqual((await ctx.post('/api/seats/bob/send', { text: 'second' })).json, { roomId: 'dm-bob' });
  const [call] = await fake.waitCalls((c) => c.seat === 'Bob');
  await waitFor(async () => (await ctx.seat('bob')).status === 'working', { what: 'bob working' });
  assert.equal((await ctx.room('dm-bob')).messages.filter((m) => m.seatId === 'bob').length, 2, 'two placeholders: one running, one queued');
  assert.deepEqual((await ctx.post('/api/rooms/dm-bob/stop')).json, { ok: true });
  const room = await waitFor(async () => { const r = await ctx.room('dm-bob'); return r.status === 'idle' && r.messages.every((m) => !m.streaming) && r; }, { timeout: 10000, what: 'both turns settled' });
  await dead(call);
  const turns = room.messages.filter((m) => m.seatId === 'bob');
  assert.deepEqual(turns.map((m) => m.error), ['stopped', 'stopped']);
  assert.equal(fake.calls().filter((c) => c.seat === 'Bob').length, 1, 'the queued turn never reached the CLI');
  assert.equal((await ctx.post('/api/rooms/dm-bob/say', { text: 'x' })).status, 400, 'DMs use the seat send endpoint');
});

testWithFake(fake, 'meeting stop: running turns die with "stopped", later rounds never start, the room is stopped and logged', async () => {
  fake.resetCalls();
  fake.scenario({ default: { hang: true, spawnChild: true } });
  const sse = await ctx.sse();
  const { json: { roomId } } = await ctx.post('/api/meeting', { topic: 'Stop me', seatIds: ['ada', 'bob'], rounds: 2 });
  const calls = await fake.waitCalls((c) => /Round 1 of 2/.test(c.stdin), 2);
  await waitFor(async () => (await ctx.state()).seats.filter((s) => s.status === 'working').length === 2, { what: 'both seats working' });
  assert.deepEqual((await ctx.post(`/api/rooms/${roomId}/stop`)).json, { ok: true });
  const room = await waitFor(async () => { const r = await ctx.room(roomId); return r.status !== 'running' && r; }, { timeout: 10000, what: 'meeting stopped' });
  assert.equal(room.status, 'stopped'); assert.equal(room.stopped, true);
  for (const c of calls) await dead(c);
  const turns = room.messages.filter((m) => m.round === 1 && m.seatId !== 'system');
  assert.equal(turns.length, 2); assert.ok(turns.every((m) => m.error === 'stopped' && m.streaming === false));
  assert.equal(fake.calls().length, 2, 'round 2 never started');
  assert.ok(!room.messages.some((m) => m.round === 2));
  const ends = sse.of('end').filter((e) => e.roomId === roomId);
  assert.equal(ends.length, 2); assert.ok(ends.every((e) => e.ok === false && e.error === 'stopped'));
  assert.ok(sse.of('room').some((e) => e.room.id === roomId && e.room.status === 'stopped'));
  assert.ok(fs.readFileSync(path.join(project, '.orchestra', 'LOG.md'), 'utf8').includes('Debate "Stop me" stopped (ada, bob; net 0 tok, cached 0).'));
  assert.equal((await ctx.post(`/api/rooms/${roomId}/say`, { text: 'x' })).status, 400, 'a stopped room refuses notes');
  assert.ok((await ctx.state()).seats.every((s) => s.status !== 'working'));
  sse.close();
});

testWithFake(fake, 'deleting a running room stops its turns, removes the file and broadcasts roomGone', async () => {
  fake.resetCalls();
  fake.scenario({ default: { hang: true, spawnChild: true } });
  const sse = await ctx.sse();
  const { json: { roomId } } = await ctx.post('/api/chain', { task: 'Delete me', builderId: 'ada', reviewerId: 'bob', maxRounds: 1 });
  const [call] = await fake.waitCalls((c) => c.seat === 'Ada');
  const file = path.join(project, '.orchestra', 'rooms', `${roomId}.json`);
  assert.ok(fs.existsSync(file));
  assert.deepEqual((await ctx.post(`/api/rooms/${roomId}/delete`)).json, { ok: true });
  await sse.waitFor((e) => e.t === 'roomGone' && e.id === roomId);
  assert.ok(!fs.existsSync(file));
  assert.equal(await ctx.room(roomId), undefined);
  await dead(call);
  await waitFor(async () => (await ctx.seat('ada')).status !== 'working', { what: 'ada released' });
  assert.ok(!fs.existsSync(file), 'a finishing workflow must not resurrect a deleted room');
  assert.equal(fake.calls().length, 1, 'the reviewer never ran');
  sse.close();
});

testWithFake(fake, 'after a stop the seat works again on its next turn', async () => {
  fake.scenario({ default: { reply: 'back to normal' } });
  assert.deepEqual((await ctx.post('/api/seats/ada/send', { text: 'again' })).json, { roomId: 'dm-ada' });
  const room = await waitFor(async () => { const r = await ctx.room('dm-ada'); return r.status === 'idle' && r.messages[r.messages.length - 1].text === 'back to normal' && r; }, { what: 'reply' });
  assert.equal(room.messages[room.messages.length - 1].error, null);
  assert.equal((await ctx.seat('ada')).status, 'idle');
});
