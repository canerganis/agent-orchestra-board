// U1: modes, mode homes and the Ask picker (public/app.js in the VM harness).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { el, boot, json, flush, hasDash } = require('./ui-harness');

const quiet = async () => json({ checks: [] });
const seats = [
  { id: 'claude1', name: 'Claude', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', status: 'idle' },
  { id: 'luna', name: 'Luna', agent: 'codex', model: 'gpt-6-luna', effort: 'medium', status: 'working' },
  { id: 'sol', name: 'Sol', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', status: 'idle' },
];
const MODELS = { claude: ['claude-sonnet-5-5', 'claude-haiku-5-5'], codex: ['gpt-6-luna', 'gpt-6.1-sol'] };
const EFFORTS = { claude: ['low', 'medium', 'high'], codex: ['low', 'medium', 'high'] };
function setup(app, { claude = 'ok', codex = 'ok', codexDetail = '', watch = true } = {}) {
  app.S.seats = Object.fromEntries(seats.map((s) => [s.id, { ...s }]));
  app.S.order = seats.map((s) => s.id);
  app.S.models = MODELS; app.S.efforts = EFFORTS;
  app.S.watch = { claude: watch };
  app.S.doctor = { loading: false, at: Date.now(), checks: app.normChecks({ checks: [
    { id: 'claude', name: 'Claude Code CLI', status: claude === 'ok' ? 'ok' : claude === 'missing' ? 'fail' : 'warn', state: claude, detail: claude === 'missing' ? 'not found on PATH' : '2.1.0' },
    { id: 'codex', name: 'Codex CLI', status: codex === 'ok' ? 'ok' : codex === 'missing' ? 'fail' : 'warn', state: codex, detail: codexDetail || (codex === 'missing' ? 'not found on PATH' : '0.160.0') },
  ] }) };
}
// The visible text of some HTML: tags and attributes (title, aria-label) removed.
const visible = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('modeOf: every kind goes to its mode, and an unknown kind goes to Workflow', () => {
  const { app } = boot(quiet);
  const want = { dm: 'ask', ask: 'ask', meeting: 'council', plan: 'workflow', build: 'workflow', chain: 'workflow', run: 'workflow' };
  for (const [kind, mode] of Object.entries(want)) assert.equal(app.modeOf({ kind }), mode, kind);
  assert.equal(app.modeOf({ kind: 'something-new' }), 'workflow');
  assert.deepEqual([...app.MODES.map((m) => m.id)], ['ask', 'council', 'workflow', 'runs']);
});

test('a legacy direct chat is listed under Ask as a chat with its agent, with agent memory', () => {
  const { app } = boot(quiet);
  setup(app);
  app.S.rooms = { d1: { id: 'd1', kind: 'dm', seatId: 'luna', title: 'Luna', status: 'idle', created: new Date().toISOString(), messages: [] },
    m1: { id: 'm1', kind: 'meeting', title: 'Split runner.js?', status: 'done', created: new Date().toISOString(), seatIds: ['luna', 'sol'], messages: [] } };
  app.S.mode = 'ask';
  const html = app.sessionListHtml();
  assert.ok(html.includes('Chat with Luna (agent memory)'));
  assert.ok(!html.includes('Split runner.js?'), 'a council is not listed under Ask');
  app.S.mode = 'council';
  assert.ok(app.sessionListHtml().includes('Split runner.js?'));
});

test('Ask picker: a Codex-missing payload hides every Codex choice and says so', () => {
  const { app } = boot(quiet);
  setup(app, { codex: 'missing' });
  const choices = app.seatChoices();
  assert.ok(choices.length > 0);
  assert.ok(choices.every((c) => c.agent === 'claude'), 'only Claude rows');
  const html = app.askPickerHtml(null);
  assert.ok(!html.includes('gpt-6-luna') && !html.includes('seat Luna') && !html.includes('seat Sol'), 'no Codex model or seat');
  assert.match(visible(html), /Codex is not installed, so its models are hidden/);
});

test('Ask picker: rows show the model id, the vendor and the seat; an override row and a busy seat are marked', () => {
  const { app } = boot(quiet);
  setup(app);
  const choices = app.seatChoices();
  const haiku = choices.find((c) => c.model === 'claude-haiku-5-5');
  assert.ok(haiku && haiku.override && haiku.seatId === 'claude1', 'a model no seat uses is offered on a seat as an override');
  assert.equal(choices.filter((c) => c.model === 'gpt-6-luna').length, 1, 'a model a seat uses is not repeated');
  const text = visible(app.askPickerHtml(null));
  assert.match(text, /claude-haiku-5-5 Anthropic seat Claude \(override\)/);
  assert.match(text, /gpt-6-luna OpenAI seat Luna busy/);
  // The default pick skips a busy seat; a remembered pick is used when it is still offered.
  assert.notEqual(app.currentPick(null).seatId, 'luna');
});

test('Ask picker: a broken CLI is shown disabled with its reason as text and a Fix link', () => {
  const { app } = boot(quiet);
  const reason = 'only a codex.cmd shim was found, which the board cannot start';
  setup(app, { codex: 'broken', codexDetail: reason });
  const html = app.askPickerHtml(null);
  const sol = (html.match(/<button[^>]*data-ask-pick="sol\|[^"]*"[^>]*>/) || [''])[0];
  assert.match(sol, / disabled[\s>]/, 'the Codex row is disabled');
  assert.ok(visible(html).includes(reason), 'the reason is visible text, not only a tooltip');
  assert.match(html, /data-ask-fix/);
  assert.ok(!app.seatChoices().filter((c) => !c.disabled).some((c) => c.agent === 'codex'));
  assert.equal(app.currentPick(null).agent, 'claude', 'a disabled row is never picked');
});

test('modes: Runs is hidden when watch.claude is false, shown when true', () => {
  const { app } = boot(quiet);
  setup(app, { watch: false });
  assert.deepEqual([...app.visibleModes().map((m) => m.id)], ['ask', 'council', 'workflow']);
  assert.ok(!app.modeNavHtml().includes('data-mode="runs"'));
  app.S.watch = { claude: true };
  assert.deepEqual([...app.visibleModes().map((m) => m.id)], ['ask', 'council', 'workflow', 'runs']);
  const nav = app.modeNavHtml();
  assert.ok(nav.includes('data-mode="runs"'));
  assert.match(nav, /experimental/);
});

test('mode nav: the current mode carries aria-current, and a mode with a running room gets a dot, not a count', () => {
  const { app } = boot(quiet);
  setup(app);
  app.S.view = 'mode'; app.S.mode = 'council';
  app.S.roomIndex = { p1: { id: 'p1', kind: 'plan', title: 'Plan', status: 'running', created: new Date().toISOString() } };
  const nav = app.modeNavHtml();
  assert.match(nav, /data-mode="council" aria-current="page"/);
  const wf = (nav.match(/<button[^>]*data-mode="workflow"[\s\S]*?<\/button>/) || [''])[0];
  assert.match(wf, /dot run/);
  const ask = (nav.match(/<button[^>]*data-mode="ask"[\s\S]*?<\/button>/) || [''])[0];
  assert.ok(!/dot run/.test(ask));
  assert.ok(!/\d+<\/span>/.test(visible(wf).replace(/\(\d\)/, '')), 'no count');
});

test('a room only in roomIndex is listed and fetched on open', async () => {
  const urls = [];
  const full = { id: 'old1', kind: 'meeting', title: 'Old council', status: 'done', created: '2026-01-01T00:00:00Z', seatIds: ['luna', 'sol'],
    messages: [{ id: 'm1', seatId: 'luna', name: 'Luna', text: 'idea', ts: '2026-01-01T00:00:01Z' }] };
  const { app } = boot(async (url) => { urls.push(url); return url === '/api/rooms/old1' ? json(full) : json({ checks: [] }); });
  setup(app);
  app.S.roomIndex = { old1: { id: 'old1', kind: 'meeting', title: 'Old council', status: 'done', created: '2026-01-01T00:00:00Z' } };
  app.S.mode = 'council';
  assert.ok(app.sessionListHtml().includes('data-room="old1"'), 'listed from the index');
  app.openRoom('old1');
  await flush(); await flush();
  assert.ok(urls.includes('/api/rooms/old1'), 'the room is fetched on open');
  assert.equal(app.S.rooms.old1.messages.length, 1, 'the full room with its transcript');
  assert.equal(app.S.mode, 'council');
});

test('a room in the snapshot is opened without a fetch, and a 404 drops it from the index', async () => {
  const urls = [];
  const { app } = boot(async (url) => { urls.push(url); return url === '/api/rooms/gone' ? json({ error: 'no such room' }, 404) : json({ checks: [] }); });
  setup(app);
  app.S.rooms = { r1: { id: 'r1', kind: 'ask', seatId: 'claude1', title: 'Q', status: 'idle', created: new Date().toISOString(), messages: [] } };
  app.S.roomIndex = { gone: { id: 'gone', kind: 'plan', title: 'Gone', status: 'done', created: '2026-01-01T00:00:00Z' } };
  app.openRoom('r1');
  await flush();
  assert.ok(!urls.some((u) => u.startsWith('/api/rooms/')));
  assert.equal(app.S.mode, 'ask');
  app.openRoom('gone');
  await flush(); await flush();
  assert.ok(urls.includes('/api/rooms/gone'));
  assert.equal(app.S.roomIndex.gone, undefined);
  assert.equal(app.S.active, null);
});

test('sendAsk posts the seat, the text and only a model that differs from the seat', async () => {
  const sent = [];
  const { app } = boot(async (url, opts) => { if (url === '/api/ask') { sent.push(JSON.parse(opts.body)); return json({ roomId: 'a1' }); } return json({ checks: [] }); });
  setup(app);
  assert.equal(await app.sendAsk(null, '  hello  ', { seatId: 'claude1', model: 'claude-sonnet-5-5', effort: '' }), 'a1');
  assert.equal(await app.sendAsk('a1', 'next', { seatId: 'claude1', model: 'claude-haiku-5-5', effort: 'high' }), 'a1');
  assert.deepEqual(sent[0], { seatId: 'claude1', text: 'hello' });
  assert.deepEqual(sent[1], { seatId: 'claude1', text: 'next', roomId: 'a1', model: 'claude-haiku-5-5' }, 'Haiku takes no effort');
  assert.equal(await app.sendAsk(null, '   ', { seatId: 'claude1' }), null, 'empty text is not sent');
  assert.equal(sent.length, 2);
});

test('ob.mode and ob.ask.pick are remembered, and a throwing localStorage does not break the page', async () => {
  const storage = new Map([['ob.mode', 'council'], ['ob.ask.pick', JSON.stringify({ seatId: 'sol', model: 'gpt-6.1-sol' })]]);
  const { app } = boot(async (url) => (url === '/api/ask' ? json({ roomId: 'a9' }) : json({ checks: [] })), { storage });
  assert.equal(app.S.mode, 'council');
  setup(app);
  assert.equal(app.currentPick(null).seatId, 'sol');
  app.setMode('workflow');
  assert.equal(storage.get('ob.mode'), 'workflow');
  await app.sendAsk(null, 'hi', { seatId: 'claude1', model: 'claude-haiku-5-5', effort: '' });
  assert.equal(JSON.parse(storage.get('ob.ask.pick')).model, 'claude-haiku-5-5');

  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const b = boot(quiet, { localStorage: broken }).app;
  assert.equal(b.S.mode, 'ask');
  setup(b);
  assert.doesNotThrow(() => b.setMode('council'));
  assert.ok(b.currentPick(null), 'a pick is still made');
});

test('keys 1 to 4 switch modes when not typing; 4 does nothing while Runs is hidden; N in Council opens the council form', () => {
  const { app, ctx } = boot(quiet);
  setup(app, { watch: false });
  ctx.document.querySelector = (s) => (/dialog/.test(s) ? null : el());
  const key = (k, target = el()) => app.onKey({ key: k, target, preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  key('2'); assert.equal(app.S.mode, 'council');
  key('3'); assert.equal(app.S.mode, 'workflow');
  key('4'); assert.equal(app.S.mode, 'workflow', 'Runs is hidden');
  key('1', Object.assign(el(), { tagName: 'TEXTAREA' })); assert.equal(app.S.mode, 'workflow', 'typing in a field');
  key('1'); assert.equal(app.S.mode, 'ask');
  app.S.watch = { claude: true };
  key('4'); assert.equal(app.S.mode, 'runs');
});

test('no CLI: the four home cards still show, disabled, each with its reason as text', () => {
  const { app } = boot(quiet);
  setup(app, { claude: 'missing', codex: 'missing', watch: false });
  const html = app.modeCardsHtml();
  for (const id of ['ask', 'council', 'workflow', 'runs']) {
    const card = (html.match(new RegExp(`<button[^>]*data-mode-card="${id}"[\\s\\S]*?</button>`)) || [''])[0];
    assert.match(card, / disabled[\s>]/, `${id} is disabled`);
    assert.match(card, /tpl-why/, `${id} gives its reason`);
  }
  assert.match(visible(html), /Neither Claude Code nor Codex is installed/);
  assert.match(visible(app.modeHomeHtml('council')), /Neither Claude Code nor Codex is installed/);
});

test('Council home: the single-vendor text, the presets and the Full estimate', () => {
  const { app } = boot(quiet);
  setup(app, { codex: 'missing' });
  const text = visible(app.modeHomeHtml('council'));
  assert.match(text, /With only one vendor installed, Council is one model family arguing with itself/);
  assert.match(text, /Quick 2 agents, 1 round/);
  assert.match(text, /Full: about 460k tokens in one measured run \(n=1\)/);
  setup(app);
  assert.ok(!visible(app.modeHomeHtml('council')).includes('only one vendor'));
});

test('mode homes, nav, cards and picker strings use no em or en dash', () => {
  const { app } = boot(quiet);
  setup(app, { codex: 'broken', codexDetail: 'cannot start' });
  const texts = [app.modeNavHtml(), app.modeCardsHtml(), app.askPickerHtml(null), app.sessionListHtml(),
    ...app.MODES.map((m) => app.modeHomeHtml(m.id))];
  setup(app, { claude: 'missing', codex: 'missing', watch: false });
  texts.push(app.modeCardsHtml(), app.askPickerHtml(null), ...app.MODES.map((m) => app.modeHomeHtml(m.id)));
  for (const t of texts) assert.equal(hasDash(t), false, t.slice(0, 120));
});

test('home capability card: collapsed to one line by default, Details expands and is remembered', () => {
  const store = new Map();
  const { app } = boot(quiet, { storage: store, expose: ['capCardHtml', 'capSummary', 'capOpen'] });
  setup(app);
  app.S.capability = { writes: 'unavailable', reason: 'no write check', agents: { claude: { available: false }, codex: { available: false } } };
  assert.equal(app.capSummary(), 'File edits: off · Claude needs a write check · Codex proposes patches');
  let html = app.capCardHtml(true);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /id="capDetails" class="cap-details" hidden/);
  assert.match(visible(html), /File edits: off · Claude needs a write check · Codex proposes patches/);
  store.set('ob.cap.open', '1');
  const { app: app2 } = boot(quiet, { storage: store, expose: ['capCardHtml', 'capOpen'] });
  setup(app2); app2.S.capability = app.S.capability;
  html = app2.capCardHtml(true);
  assert.match(html, /aria-expanded="true"/);
  assert.doesNotMatch(html, /class="cap-details" hidden/);
  assert.match(html, /cap-agents/);
  // Settings keeps the full card, no toggle.
  assert.doesNotMatch(app.capCardHtml(false), /data-cap-toggle/);
});

test('home capability card: a throwing localStorage still renders collapsed', () => {
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const { app } = boot(quiet, { localStorage: bad, expose: ['capCardHtml'] });
  setup(app);
  assert.match(app.capCardHtml(true), /aria-expanded="false"/);
});

// Runs the real click handler bound by bindCap on a fake root holding one toggle button.
function clickToggle(app) {
  const btn = el();
  app.bindCap({ querySelectorAll: (sel) => (sel === '[data-cap-toggle]' ? [btn] : []) });
  btn.onclick();
}
test('home capability card: the real toggle handler flips the state and stores it', () => {
  const store = new Map();
  const { app } = boot(quiet, { storage: store, expose: ['capCardHtml', 'capOpen', 'bindCap'] });
  setup(app);
  assert.equal(app.capOpen(), false);
  clickToggle(app);
  assert.equal(app.capOpen(), true);
  assert.equal(store.get('ob.cap.open'), '1');
  assert.match(app.capCardHtml(true), /aria-expanded="true"/);
  clickToggle(app);
  assert.equal(app.capOpen(), false);
  assert.equal(store.get('ob.cap.open'), '0');
});

test('home capability card: the toggle still works when localStorage throws', () => {
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const { app } = boot(quiet, { localStorage: bad, expose: ['capCardHtml', 'capOpen', 'bindCap'] });
  setup(app);
  clickToggle(app);
  assert.equal(app.capOpen(), true);
  assert.match(app.capCardHtml(true), /aria-expanded="true"/);
  clickToggle(app);
  assert.equal(app.capOpen(), false);
  assert.match(app.capCardHtml(true), /aria-expanded="false"/);
});

test('home mode cards use the grid classes and the CSS has four, two and one column rules', () => {
  const { app } = boot(quiet);
  setup(app);
  const html = app.modeCardsHtml();
  assert.match(html, /class="tpls mode-cards"/);
  assert.equal((html.match(/data-mode-card=/g) || []).length, 4);
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.match(css, /\.mode-cards \{[^}]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 1100px\) \{ \.mode-cards \{[^}]*repeat\(2,/);
  assert.match(css, /@media \(max-width: 600px\) \{ \.mode-cards \{[^}]*minmax\(0, 1fr\); \}/);
});

// Home: Recent rooms, and the demo landing.
const mkRooms = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, kind: i % 2 ? 'meeting' : 'plan', title: `Room ${i}`, status: 'done',
  created: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));

test('Home Recent lists at most 5 rooms, newest first, across modes', () => {
  const { app } = boot(quiet);
  setup(app);
  app.S.roomIndex = Object.fromEntries(mkRooms(7).map((r) => [r.id, r]));
  const html = app.recentHtml();
  const ids = [...html.matchAll(/data-recent="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['r6', 'r5', 'r4', 'r3', 'r2']);
  assert.ok(html.includes('Room 6') && html.includes('Done'));
  assert.equal(boot(quiet).app.recentHtml(), '', 'no rooms, no section');
  assert.ok(!hasDash(html));
});

test('Home Recent: clicking a row opens the room', () => {
  const { app, ctx } = boot(quiet);
  setup(app);
  app.S.roomIndex = Object.fromEntries(mkRooms(2).map((r) => [r.id, r]));
  app.S.rooms = { r1: { ...app.S.roomIndex.r1, messages: [] } };
  const btn = { ...el(), dataset: { recent: 'r1' } };
  ctx.document.querySelectorAll = (sel) => (sel === '#main [data-recent]' ? [btn] : []);
  app.S.view = 'home';
  ctx.document.querySelector = () => el();
  // renderHome binds each [data-recent] button to openRoom
  vmRun(ctx, 'renderHome()');
  btn.onclick();
  assert.equal(app.S.active, 'r1');
});

test('demo mode opens the build that needs you on first load, other modes do not', async () => {
  const state = { seats: [], rooms: [], roomIndex: [
    { id: 'c1', kind: 'meeting', title: 'Council', status: 'done', created: '2026-01-01T00:00:00Z' },
    { id: 'b1', kind: 'build', title: 'Build: x', status: 'needs-you', created: '2026-01-03T00:00:00Z' },
    { id: 'p1', kind: 'plan', title: 'Plan', status: 'done', created: '2026-01-02T00:00:00Z' } ] };
  const f = async (url) => (url === '/api/state' ? json(state) : json({ checks: [] }));
  const demo = boot(f);
  demo.ctx.document.getElementById = (id) => (id === 'demo-banner' ? el() : null);
  await demo.app.load();
  assert.equal(demo.app.S.active, 'b1');
  const plain = boot(f);
  plain.ctx.document.getElementById = () => null;
  plain.app.S.roomIndex = Object.fromEntries(state.roomIndex.map((r) => [r.id, r]));
  assert.equal(plain.app.isDemo(), false);
  assert.equal(plain.app.demoLanding(), false);
  assert.equal(plain.app.S.active, null);
});
function vmRun(ctx, code) { return require('node:vm').runInContext(code, ctx); }
