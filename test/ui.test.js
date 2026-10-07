// Frontend logic (public/app.js) run in a VM with a minimal DOM stub: setup-check normalisation, streamed-text reset,
// and SSE events held while a snapshot loads. Layout and focus are checked by hand in a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function el() {
  const e = {
    style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    isConnected: true, title: '', id: '', scrollHeight: 0, scrollTop: 0, clientHeight: 0, offsetParent: null,
    lastElementChild: null, firstElementChild: null, nextElementSibling: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, addEventListener() {}, append() {}, prepend() {},
    remove() {}, focus() {}, blur() {}, select() {}, setSelectionRange() {}, insertAdjacentHTML() {}, after() {},
    contains() { return false; }, checkVisibility() { return true; }, scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0 }; },
    querySelector() { return el(); }, querySelectorAll() { return []; }, closest() { return null; },
  };
  return e;
}

// Loads app.js into a fresh VM context. fetchImpl answers /api/state and /api/doctor.
function boot(fetchImpl) {
  const eventSources = [];
  const ctx = {
    console, setTimeout, clearTimeout, setImmediate, Promise, JSON, Date, Math, Object, Array, Map, Set, Number, String, RegExp, Error,
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    URL, Blob: class {}, CSS: { escape: (s) => String(s) },
    navigator: { platform: 'Win32', userAgent: 'Windows NT 10.0' },
    location: { href: 'http://127.0.0.1:4390/', host: '127.0.0.1:4390', pathname: '/', search: '', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    innerWidth: 1200, Notification: undefined,
    fetch: fetchImpl,
    EventSource: class { constructor(u) { this.url = u; eventSources.push(this); } },
  };
  const doc = el();
  Object.assign(doc, { body: el(), documentElement: el(), activeElement: el(), title: '', hidden: false,
    createElement: () => el(), createTextNode: () => el(), addEventListener() {}, querySelector: () => el(), querySelectorAll: () => [] });
  ctx.document = doc; ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${SRC}\n;globalThis.__app = { S, normChecks, SSE, tw, dispatch, load, tickTimers: () => 0 };`, ctx, { filename: 'app.js' });
  return { app: ctx.__app, eventSources };
}
const json = (body) => ({ status: 200, json: async () => body });
const flush = () => new Promise((r) => setImmediate(r));

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
