// Shared test harness for public/app.js: runs the frontend in a VM with a minimal DOM stub. Layout and focus are
// checked by hand in a browser; these tests reach the pure helpers and the state handlers.
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

// Names reached by the tests. A name app.js does not define reads as undefined, so a later item can add its own
// names here (or pass opts.expose) without breaking an older test.
const EXPOSE = [
  'S', 'normChecks', 'SSE', 'tw', 'dispatch', 'load', 'capabilityText', 'capInner', 'writeHelpText', 'planTableHtml', 'shortHash',
  'roleOptionsHtml', 'writeCheckText', 'itemRowHtml', 'canApply', 'buildResumable', 'buildSummary', 'ITEM_STATUS', 'resumeBuild', 'paintProposal',
  // U1: modes, homes, Ask picker
  'MODES', 'modeOf', 'visibleModes', 'setMode', 'paintModeNav', 'modeNavHtml', 'renderModeHome', 'modeHomeHtml', 'modeCardsHtml',
  'cliState', 'seatChoices', 'askPickerHtml', 'sendAsk', 'sessionListHtml', 'openRoom', 'roomIndexList', 'onKey', 'newInMode', 'recentHtml', 'isDemo', 'demoLanding', 'modeBlock', 'currentPick',
];

// Loads app.js into a fresh VM context. fetchImpl answers /api/state, /api/doctor and the rest.
// opts.storage: a Map used as localStorage (a throwing one tests the try/catch). opts.expose: more names to reach.
function boot(fetchImpl, opts = {}) {
  const eventSources = [];
  const store = opts.storage || null;
  const localStorage = opts.localStorage || (store
    ? { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } }
    : { getItem: () => null, setItem() {} });
  const ctx = {
    console, setTimeout, clearTimeout, setImmediate, Promise, JSON, Date, Math, Object, Array, Map, Set, Number, String, RegExp, Error,
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    URL, Blob: class {}, CSS: { escape: (s) => String(s) },
    navigator: { platform: 'Win32', userAgent: 'Windows NT 10.0' },
    location: { href: 'http://127.0.0.1:4390/', host: '127.0.0.1:4390', pathname: '/', search: '', hash: '' },
    history: { replaceState() {} },
    localStorage,
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
  const names = [...new Set([...EXPOSE, ...(opts.expose || [])])];
  const exportLine = `globalThis.__app = { ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };`;
  vm.runInContext(`${SRC}\n;${exportLine}`, ctx, { filename: 'app.js' });
  return { app: ctx.__app, eventSources, ctx };
}
const json = (body, status = 200) => ({ status, json: async () => body });
const flush = () => new Promise((r) => setImmediate(r));
// Code points 0x2013 (en dash) and 0x2014 (em dash), written as numbers so this file holds no dash character.
const hasDash = (text) => [...String(text)].some((ch) => ch.codePointAt(0) === 0x2013 || ch.codePointAt(0) === 0x2014);

module.exports = { el, boot, json, flush, hasDash };
