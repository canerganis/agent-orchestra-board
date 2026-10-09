// Frontend logic (public/app.js) run in a VM with a minimal DOM stub: setup-check normalisation, streamed-text reset,
// and SSE events held while a snapshot loads. Layout and focus are checked by hand in a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { el, boot, json, flush } = require('./ui-harness');

test('setup check: a CLI in the project that the board ignores is a note, not a blocking problem', () => {
  const { app } = boot(async () => json({ checks: [] }));
  const shadow = app.normChecks({ checks: [{ id: 'claude', name: 'Claude Code CLI', status: 'warn',
    detail: '2.1.0 — C:\Users\me\bin\claude.exe; note that claude.exe exists in the project. The board ignores it (CLIs are resolved on PATH, never in the project), but a bare `claude` typed in cmd.exe inside that directory would run it' }] });
  assert.equal(shadow[0].st, 'warn');
  assert.equal(shadow[0].blocking, false);
});

test('setup check: a CLI that cannot be launched (timed out, non-zero exit, shim) still blocks', () => {
  const { app } = boot(async () => json({ checks: [] }));
  const timeout = app.normChecks({ checks: [{ id: 'codex', name: 'Codex CLI', status: 'warn', detail: "'codex --version' timed out after 8s — C:\bin\codex.exe" }] });
  const exit = app.normChecks({ checks: [{ id: 'claude', name: 'Claude Code CLI', status: 'warn', detail: "'claude --version' exited 1 — C:\bin\claude.exe" }] });
  assert.equal(timeout[0].blocking, true);
  assert.equal(exit[0].blocking, true);
});

test('stream reset: a retried turn drops the text of the failed attempt', () => {
  const { app } = boot(async () => json({ checks: [] }));
  app.tw.r1 = { shown: 'first attempt', pending: 'more' };
  app.SSE.delta({ runId: 'r1', text: '', reset: true });
  assert.equal(app.tw.r1.shown, '');
  assert.equal(app.tw.r1.pending, '');
  app.SSE.delta({ runId: 'r1', text: 'second' });
  assert.equal(app.tw.r1.pending, 'second');
});

test('SSE: events that arrive while the snapshot loads are replayed after it, not overwritten by it', async () => {
  let resolveState;
  const state = new Promise((r) => { resolveState = r; });
  const { app, eventSources } = boot((url) => (url === '/api/state' ? state : json({ checks: [] })));
  const es = eventSources[0];
  es.onmessage({ data: JSON.stringify({ t: 'hello' }) }); // starts load(): the snapshot is in flight
  // The final message of the turn is broadcast while the (large) snapshot is still being read.
  es.onmessage({ data: JSON.stringify({ t: 'msg', roomId: 'r1', msg: { id: 'm1', seatId: 'ada', streaming: false, text: 'final answer' } }) });
  resolveState(json({ seats: [], rooms: [{ id: 'r1', title: 'Chat', kind: 'dm', status: 'running', created: new Date().toISOString(), messages: [{ id: 'm1', seatId: 'ada', streaming: true, text: '' }] }] }));
  await flush(); await flush();
  const r = app.S.rooms.r1;
  assert.ok(r, 'room from the snapshot');
  assert.equal(r.messages[0].text, 'final answer');
  assert.equal(r.messages[0].streaming, false);
});

test('reconnect: a reply that was streaming before the connection keeps what it showed and skips the glued tail', async () => {
  const { app, eventSources } = boot((url) => (url === '/api/state'
    ? json({ seats: [], rooms: [{ id: 'r1', title: 'Chat', kind: 'dm', status: 'running', created: '2020-01-01T00:00:00Z',
      messages: [{ id: 'm1', seatId: 'ada', streaming: true, text: '', ts: '2020-01-01T00:00:01Z' }] }] })
    : json({ checks: [] })));
  const es = eventSources[0];
  es.onopen();
  es.onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await flush(); await flush();
  assert.equal(app.tw.m1.gap, true, 'the snapshot marks the in-flight reply');
  app.SSE.delta({ runId: 'm1', text: 'middle of a sentence' });
  assert.equal(app.tw.m1.gapped, true);
  assert.equal(app.tw.m1.pending, '', 'the fragment after the gap is not shown');
  app.SSE.delta({ runId: 'm1', text: ' and more' });
  assert.equal(app.tw.m1.pending, '', 'later deltas stay out until the final message');
});

test('reconnect: a reply that started after the connection opened is not marked as lost', async () => {
  const { app, eventSources } = boot((url) => (url === '/api/state'
    ? json({ seats: [], rooms: [{ id: 'r1', title: 'Chat', kind: 'dm', status: 'running', created: new Date().toISOString(),
      messages: [{ id: 'm2', seatId: 'ada', streaming: true, text: '', ts: new Date(Date.now() + 1000).toISOString() }] }] })
    : json({ checks: [] })));
  const es = eventSources[0];
  es.onopen();
  es.onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await flush(); await flush();
  assert.equal(app.tw.m2, undefined);
  app.SSE.delta({ runId: 'm2', text: 'hello' });
  assert.equal(app.tw.m2.pending, 'hello');
});

test('capability text: unknown reads as unavailable and says it is being checked', () => {
  const { app } = boot(async () => json({ checks: [] }));
  const unknown = app.capabilityText(null);
  assert.equal(unknown.level, 'off');
  assert.equal(unknown.title, 'File edits: unavailable');
  assert.equal(unknown.reason, 'Checking…');
  const on = app.capabilityText({ writes: 'available', reason: 'Every gate passed for Claude Code' });
  assert.equal(on.level, 'ok');
  assert.equal(on.title, 'File edits: available');
  assert.equal(on.reason, 'Every gate passed for Claude Code');
  const off = app.capabilityText({ writes: 'unavailable', reason: 'git 2.20 is older than 2.25' });
  assert.equal(off.level, 'off');
  assert.equal(off.title, 'File edits: unavailable');
  assert.equal(off.reason, 'git 2.20 is older than 2.25');
});

test('write check text: reads the stored record result; a missing or unknown record is not run', () => {
  const { app } = boot(async () => json({ checks: [] }));
  assert.equal(app.writeCheckText({ result: 'pass', at: '2026-10-08T00:00:00Z', version: '1.0.0', platform: 'win32', settingsHash: 'x', detail: '' }), 'Write check passed');
  assert.equal(app.writeCheckText({ result: 'fail', at: '2026-10-08T00:00:00Z', version: '1.0.0', platform: 'win32', settingsHash: 'x', detail: 'wrote outside' }), 'Write check failed');
  assert.equal(app.writeCheckText(null), 'Write check not run');
  assert.equal(app.writeCheckText(undefined), 'Write check not run');
  assert.equal(app.writeCheckText(true), 'Write check not run', 'a bare boolean is not a stored record');
});

/* ---------- capability card and agent editor: a CLI that cannot be write-checked here (Codex in v0.2) ---------- */
const WIN_CODEX_REASON = 'off: Codex file edits are off in v0.2 on every platform. Codex seats read, review and propose patches that the board applies.';
// A capability as /api/state sends it on Windows: Claude passes, Codex cannot be write-checked (verifiable false).
const capCodexBlocked = (over = {}) => ({ writes: 'available', reason: null, platform: 'win32', legacyRecordIgnored: false,
  agents: {
    claude: { available: true, reason: null, code: null, verifiable: true, version: '2.1.0', verified: { result: 'pass', at: '2026-10-08T00:00:00Z', version: '2.1.0', platform: 'win32', settingsHash: 'h', detail: '' }, settings: ['cwd = the item worktree'] },
    codex: { available: false, reason: WIN_CODEX_REASON, code: 'codex-windows-unelevated', verifiable: false, version: '0.160.0', verified: null, settings: ['Codex file edits are off in v0.2: Codex seats read, review and propose'] },
  }, ...over });
// The whole <button> for one agent in the card HTML (its icon holds tags of its own).
const cardButton = (html, agent) => (html.match(new RegExp(`<button[^>]*data-cap-verify="${agent}"[\\s\\S]*?</button>`)) || [''])[0];
const openTag = (button) => (button.match(/^<button[^>]*>/) || [''])[0];
const isDisabled = (button) => / disabled[\s>]/.test(openTag(button));
const buttonLabel = (button) => button.replace(/<[^>]+>/g, '').trim();
const seatsFor = (app, seats) => { app.S.seats = Object.fromEntries(seats.map((s) => [s.id, s])); app.S.order = seats.map((s) => s.id); };

test('capability card: a Codex entry that cannot be write-checked here has a disabled "Not available" button and shows its reason as text', () => {
  const { app } = boot(async () => json({ checks: [] }));
  seatsFor(app, [{ id: 'ada', name: 'Ada', agent: 'claude' }, { id: 'eva', name: 'Eva', agent: 'codex' }]);
  app.S.capability = capCodexBlocked();
  const html = app.capInner();
  const codex = cardButton(html, 'codex');
  assert.equal(isDisabled(codex), true, 'the Codex check button is disabled, even with a Codex seat');
  assert.equal(buttonLabel(codex), 'Not available');
  assert.ok(html.replace(/\stitle="[^"]*"/g, '').includes(WIN_CODEX_REASON), 'the reason is visible text, not only a tooltip');
});

test('capability card: Claude stays enabled when a Claude seat exists; without a Claude seat it is disabled with the usual tip', () => {
  const { app } = boot(async () => json({ checks: [] }));
  seatsFor(app, [{ id: 'ada', name: 'Ada', agent: 'claude' }, { id: 'eva', name: 'Eva', agent: 'codex' }]);
  app.S.capability = capCodexBlocked();
  const html = app.capInner();
  const claude = cardButton(html, 'claude');
  assert.equal(buttonLabel(claude), 'Run write check');
  assert.equal(isDisabled(claude), false, 'Claude has a seat and passed its gate');
  assert.equal(isDisabled(cardButton(html, 'codex')), true);
  seatsFor(app, [{ id: 'eva', name: 'Eva', agent: 'codex' }]);
  const noSeat = cardButton(app.capInner(), 'claude');
  assert.equal(isDisabled(noSeat), true, 'no Claude seat, no check');
  assert.match(noSeat, /Add a Claude Code agent first/);
});

test('writeHelpText: available keeps the explanation; verifiable false gives the reason with no check sentence; otherwise it points to Settings', () => {
  const { app } = boot(async () => json({ checks: [] }));
  assert.equal(app.writeHelpText('claude', { available: true, verifiable: true }, true),
    'When checked, Build sessions may let this agent edit files, each item inside its own git worktree. Unchecked, it proposes changes only.');
  const blocked = app.writeHelpText('codex', capCodexBlocked().agents.codex, true);
  assert.equal(blocked, `Not available for Codex: ${WIN_CODEX_REASON}`);
  assert.ok(!blocked.includes('Run the write check'), 'a CLI that cannot be checked gets no check sentence');
  assert.equal(app.writeHelpText('claude', { available: false, verifiable: true, reason: 'not verified yet: run the write check for this CLI' }, true),
    'Not available for Claude Code: not verified yet: run the write check for this CLI. Run the write check in Settings.');
  assert.equal(app.writeHelpText('claude', null, true), 'Not available for Claude Code: the write check has not passed. Run the write check in Settings.');
  assert.match(app.writeHelpText('claude', null, false), /^Not available for Claude Code: checking/);
});

test('agent editor write box: a Codex seat can opt into patch mode while the Codex gate stays closed; Claude follows its gate', () => {
  const { app } = boot(async () => json({ checks: [] }), { expose: ['seatWriteBox', 'CODEX_PATCH_HELP'] });
  const codex = app.seatWriteBox('codex', capCodexBlocked().agents.codex, true);
  assert.equal(codex.disabled, false, 'patch mode does not depend on the Codex write gate');
  assert.equal(codex.help, app.CODEX_PATCH_HELP);
  assert.match(codex.help, /never edits files itself/);
  assert.match(codex.help, /read only/);
  assert.ok(![...codex.help].some((ch) => ch.codePointAt(0) === 0x2013 || ch.codePointAt(0) === 0x2014), 'no en or em dash');
  const closed = app.seatWriteBox('claude', { available: false, verifiable: true, reason: 'not verified yet: run the write check for this CLI' }, true);
  assert.equal(closed.disabled, true);
  assert.match(closed.help, /Run the write check in Settings/);
  assert.equal(app.seatWriteBox('claude', { available: true, verifiable: true }, true).disabled, false);
  assert.equal(app.seatWriteBox('claude', null, false).disabled, true, 'unknown counts as closed');
});

test('capability card: the legacy note shows when a project capability.json was ignored, and only then', () => {
  const { app } = boot(async () => json({ checks: [] }));
  app.S.capability = capCodexBlocked({ legacyRecordIgnored: true });
  assert.ok(app.capInner().includes('A capability.json in this project is ignored; write checks are stored per user.'));
  app.S.capability = capCodexBlocked();
  assert.ok(!app.capInner().includes('capability.json'), 'no note without a legacy file');
});

test('capability card: an inconclusive write check reads as inconclusive and says to run the check again', () => {
  const { app } = boot(async () => json({ checks: [] }));
  seatsFor(app, [{ id: 'ada', name: 'Ada', agent: 'claude' }]);
  const reason = 'the write check was inconclusive: the CLI did not attempt /tmp/outside.txt. Run the check again';
  app.S.capability = { writes: 'unavailable', reason: `Claude Code: ${reason}`, platform: 'linux', legacyRecordIgnored: false,
    agents: { claude: { available: false, reason, code: 'check-inconclusive', verifiable: true, version: '2.1.0',
      verified: { result: 'inconclusive', at: '2026-10-08T00:00:00Z', version: '2.1.0', platform: 'linux', settingsHash: 'h', detail: 'the CLI did not attempt /tmp/outside.txt' }, settings: [] } } };
  const html = app.capInner();
  assert.ok(html.includes('Write check inconclusive'));
  assert.ok(html.includes('Run the check again'));
  assert.equal(isDisabled(cardButton(html, 'claude')), false, 'a new check can be run');
});

test('capability card and write help: the new strings use no em or en dash', () => {
  const { app } = boot(async () => json({ checks: [] }));
  seatsFor(app, [{ id: 'ada', name: 'Ada', agent: 'claude' }, { id: 'eva', name: 'Eva', agent: 'codex' }]);
  app.S.capability = capCodexBlocked({ legacyRecordIgnored: true });
  const texts = [app.capInner(), app.writeHelpText('codex', capCodexBlocked().agents.codex, true), app.writeHelpText('claude', { available: true, verifiable: true }, true)];
  // Code points 0x2013 (en dash) and 0x2014 (em dash), written as numbers so this line holds no dash character.
  for (const text of texts) assert.ok(![...text].some((ch) => ch.codePointAt(0) === 0x2013 || ch.codePointAt(0) === 0x2014), 'no en or em dash in the card or the help text');
});

test('plan table: escapes titles and lists the owned paths joined', () => {
  const { app } = boot(async () => json({ checks: [] }));
  const html = app.planTableHtml({ items: [{ id: 'a1', title: '<script>alert(1)</script>', difficulty: 'easy', owns: ['src/a.js', 'lib/'], dependsOn: [] }] });
  assert.ok(!html.includes('<script>'), 'the title is escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('src/a.js, lib/'), 'owned paths are joined with a comma');
  assert.equal(app.shortHash('0123456789abcdef0123'), '0123456789ab');
  assert.equal(app.shortHash(null), '');
});

test('role options: an empty choice uses the fallback, and every seat is offered once, the chosen one selected', () => {
  const { app } = boot(async () => json({ checks: [] }));
  app.S.seats = { ada: { id: 'ada', name: 'Ada', agent: 'claude' }, eva: { id: 'eva', name: '<Eva>', agent: 'codex' } };
  app.S.order = ['ada', 'eva'];
  const html = app.roleOptionsHtml('hard', 'eva');
  assert.ok(html.startsWith('<option value="">'), 'the fallback choice comes first');
  assert.equal(html.match(/<option value="ada"/g).length, 1);
  assert.match(html, /<option value="eva" selected>/);
  assert.ok(html.includes('&lt;Eva&gt;'), 'seat names are escaped');
});

test('SSE capability: the event updates the capability state', () => {
  const { app } = boot(async () => json({ checks: [] }));
  assert.equal(app.S.capability, null);
  app.SSE.capability({ t: 'capability', capability: { writes: 'unavailable', reason: 'no repository', agents: {} } });
  assert.equal(app.S.capability.writes, 'unavailable');
  app.SSE.capability({ t: 'capability', capability: { writes: 'available', reason: '', agents: { claude: { available: true } } } });
  assert.equal(app.S.capability.agents.claude.available, true);
});

test('room event for a plan room renders without throwing', () => {
  const { app } = boot(async () => json({ checks: [] }));
  app.S.active = 'p1';
  const room = { id: 'p1', kind: 'plan', title: 'Make the parser faster', status: 'awaiting-approval', created: new Date().toISOString(),
    planRevision: 2, planHash: 'abcdef0123456789', managerId: 'ada', seatIds: [], rounds: 1, approval: null,
    plan: { goal: 'Speed up parsing', items: [{ id: 'p-one', title: 'Tokenizer', spec: 'x', owns: ['src/tok.js'], dependsOn: [], difficulty: 'hard', seatId: null }] } };
  assert.doesNotThrow(() => app.SSE.room({ t: 'room', room }));
  assert.equal(app.S.rooms.p1.kind, 'plan');
  assert.equal(app.S.rooms.p1.messages.length, 0, 'a room event without a transcript starts with an empty one');
});

/* ---------- build session: item table, apply gating, SSE ---------- */
const buildRoom = (over = {}) => ({ id: 'b1', kind: 'build', title: 'Build', status: 'paused', mode: 'write', modeReason: '', order: ['i1', 'i2', 'i3'],
  items: { i1: { id: 'i1', title: 'Parser', difficulty: 'easy', status: 'passed', builderId: null, reviewerId: null, rounds: 1, proposal: { hash: 'abcdef0123456789', files: ['src/a.js'] } },
    i2: { id: 'i2', title: 'Lexer', difficulty: 'medium', status: 'applied', builderId: null, reviewerId: null, rounds: 2, proposal: null },
    i3: { id: 'i3', title: 'Emitter', difficulty: 'hard', status: 'building', builderId: null, reviewerId: null, rounds: 0, proposal: null } },
  ...over });

test('build: canApply is false while the room runs, false in propose mode, true for a passed item in a paused write build', () => {
  const { app } = boot(async () => json({ checks: [] }));
  const paused = buildRoom();
  assert.equal(app.canApply(paused, paused.items.i1), true);
  assert.equal(app.canApply(buildRoom({ status: 'running' }), paused.items.i1), false, 'a running build');
  assert.equal(app.canApply(buildRoom({ mode: 'propose' }), paused.items.i1), false, 'propose mode');
  assert.equal(app.canApply(paused, paused.items.i3), false, 'an item that has not passed');
});

test('build: itemRowHtml escapes the item title and offers Apply and Discard for a passed item', () => {
  const { app } = boot(async () => json({ checks: [] }));
  const room = buildRoom();
  const html = app.itemRowHtml(room, { ...room.items.i1, title: '<img onerror=x>' });
  assert.ok(!html.includes('<img'), 'no raw tag in the row');
  assert.ok(html.includes('&lt;img onerror=x&gt;'));
  assert.match(html, /data-item-apply="i1"/, 'a passed item of a paused write build offers Apply');
  assert.match(html, /data-item-discard="i1"/);
  assert.match(html, />Passed review</);
});

test('build: itemRowHtml offers no Apply or Discard where the rules forbid them', () => {
  const { app } = boot(async () => json({ checks: [] }));
  const room = buildRoom({ status: 'running' });
  const html = app.itemRowHtml(room, room.items.i1);
  assert.ok(!html.includes('data-item-apply'), 'no Apply while running');
  assert.ok(!html.includes('data-item-discard'), 'no Discard while running');
  assert.match(html, /data-item-view="i1"/, 'View is offered when there is a proposal');
  const paused = buildRoom();
  assert.ok(!app.itemRowHtml(paused, paused.items.i2).includes('data-item-discard'), 'an applied item cannot be discarded');
});

test('build: buildSummary counts passed (applied included) and applied items', () => {
  const { app } = boot(async () => json({ checks: [] }));
  assert.equal(app.buildSummary(buildRoom()), '2 of 3 passed · 1 applied');
  assert.equal(app.buildSummary(buildRoom({ order: [], items: {} })), '0 of 0 passed · 0 applied');
  assert.equal(app.ITEM_STATUS['apply-failed'], 'Apply failed');
  assert.equal(app.ITEM_STATUS.quarantined, 'Quarantined');
});

test('build: SSE build event replaces the item in the known room and ignores unknown rooms', () => {
  const { app } = boot(async () => json({ checks: [] }));
  app.S.rooms.b1 = buildRoom();
  app.SSE.build({ t: 'build', roomId: 'b1', itemId: 'i3', item: { id: 'i3', title: 'Emitter', status: 'passed', proposal: null } });
  assert.equal(app.S.rooms.b1.items.i3.status, 'passed');
  app.SSE.build({ t: 'build', roomId: 'nope', itemId: 'i1', item: { id: 'i1', status: 'failed' } });
  assert.equal(app.S.rooms.nope, undefined, 'an unknown room is not created');
});

test('build: SSE apply for an unknown room does not throw', () => {
  const { app } = boot(async () => json({ checks: [] }));
  assert.doesNotThrow(() => app.SSE.apply({ t: 'apply', roomId: 'nope', itemId: 'i1', ok: false, code: 'checkout-dirty', error: 'the checkout has changes' }));
  assert.doesNotThrow(() => app.SSE.apply({ t: 'apply', roomId: 'nope', itemId: 'i1', ok: true, tree: 'abc' }));
});

/* ---------- build session: resume names its plan; a refused apply lists its files ---------- */
test('resume: names the plan revision and hash, so a plan approved again since the build started is adopted', async () => {
  const sent = [];
  const { app } = boot(async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return json({ ok: true }); });
  app.S.rooms.p1 = { id: 'p1', kind: 'plan', planRevision: 3, planHash: 'hash-three' };
  app.S.rooms.b1 = buildRoom({ status: 'needs-approval', planRoomId: 'p1' });
  await app.resumeBuild('b1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/build/b1/resume');
  assert.deepEqual(sent[0].body, { revision: 3, hash: 'hash-three' });
});

test('resume: without the plan room in view the request carries no plan', async () => {
  const sent = [];
  const { app } = boot(async (url, opts) => { sent.push(JSON.parse(opts.body)); return json({ ok: true }); });
  app.S.rooms.b1 = buildRoom({ status: 'paused', planRoomId: 'p-gone' });
  await app.resumeBuild('b1');
  assert.deepEqual(sent, [{}]);
});

test('proposal: a refused apply lists the files the main checkout has changed', () => {
  const { app } = boot(async () => json({ checks: [] }));
  app.S.rooms.b1 = buildRoom();
  const j = { itemId: 'i1', status: 'passed', proposal: { hash: 'abcdef0123456789', files: ['src/a.js'] }, review: null, patch: '', truncated: false,
    applicable: { ok: false, code: 'checkout-dirty', reason: 'the main checkout has changes the board did not make', files: ['notes.txt', 'src/a.js'] } };
  const dlg = el();
  app.paintProposal(dlg, 'b1', 'i1', j, null);
  assert.match(dlg.innerHTML, /checkout-dirty/);
  assert.ok(dlg.innerHTML.includes('<li><code class="inline">notes.txt</code></li>'), 'the changed file is listed under the reason');
});

test('proposal: files the refusal already lists in its error block are not listed twice', () => {
  const { app } = boot(async () => json({ checks: [] }));
  app.S.rooms.b1 = buildRoom();
  const j = { itemId: 'i1', status: 'passed', proposal: { hash: 'abcdef0123456789', files: ['src/a.js'] }, review: null, patch: '', truncated: false,
    applicable: { ok: false, code: 'checkout-dirty', reason: 'the main checkout has changes the board did not make', files: ['notes.txt'] } };
  const err = Object.assign(new Error('the main checkout has changes the board did not make'),
    { code: 'checkout-dirty', body: { error: 'the main checkout has changes the board did not make', code: 'checkout-dirty', files: ['draft.txt'] } });
  const dlg = el();
  app.paintProposal(dlg, 'b1', 'i1', j, err);
  assert.ok(dlg.innerHTML.includes('draft.txt'), 'the error block lists the files it was given');
  assert.ok(!dlg.innerHTML.includes('notes.txt'), 'the Apply row does not repeat them');
});

test('build: an apply-failed item offers Retry apply and a done build offers Resume', () => {
  const { app } = boot(async () => json({ checks: [] }));
  const paused = buildRoom();
  const failed = { ...paused.items.i1, status: 'apply-failed' };
  assert.equal(app.canApply(paused, failed), true, 'apply-failed can be retried');
  assert.match(app.itemRowHtml(paused, failed), /data-item-apply="i1"[^>]*>Retry apply</);
  assert.equal(app.buildResumable({ ...paused, status: 'done', items: { i1: failed } }), true);
  assert.equal(app.buildResumable({ ...paused, status: 'done', items: { i1: paused.items.i1 } }), false);
});
