// Security gate on a live server: Host allowlist, Origin allowlist, JSON-only POST, the per-project
// session token (persisted in .orchestra/session) and its cookie, static file confinement, body limits, security
// headers, API validation. No CLI runs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { tmpDir, startApp, request, sse, teardown } = require('./helpers');

let PORT = 0; // the real port comes from startApp (OS assigned), set in before()
let dir, ctx;

before(async () => {
  // Nothing here needs a CLI; names that cannot resolve guarantee no real binary is ever started.
  process.env.ORCHESTRA_CLAUDE_BIN = 'fake-claude-not-installed';
  process.env.ORCHESTRA_CODEX_BIN = 'fake-codex-not-installed';
  dir = tmpDir('ob-security-');
  ctx = await startApp({ projectDir: dir });
  PORT = ctx.port;
});
after(() => teardown(ctx, dir));

const raw = (method, p, o) => request(PORT, method, p, o); // no cookie

test('session token: start URL carries ?t=<token>; the exchange sets an HttpOnly SameSite=Strict cookie (303 to /); a wrong token is 403', async () => {
  assert.ok(ctx.token, 'createServer exposes the per-project token / start URL');
  assert.equal(require('fs').readFileSync(require('path').join(dir, '.orchestra', 'session'), 'utf8').trim(), ctx.token, 'the token is persisted in .orchestra/session');
  assert.match(ctx.info.url, new RegExp(`^http://localhost:${PORT}/\\?t=`));
  const ok = await raw('GET', `/?t=${ctx.token}`);
  assert.equal(ok.status, 303); assert.equal(ok.headers.location, '/');
  const sc = String(ok.headers['set-cookie']);
  assert.match(sc, new RegExp(`^ob_session_${PORT}=${ctx.token}; Path=/; HttpOnly; SameSite=Strict`));
  const bad = await raw('GET', '/?t=not-the-token');
  assert.equal(bad.status, 403); assert.match(bad.text, /out of date/); assert.equal(bad.json, null); // a page with the way out, not raw JSON
  // Same length, one char off: constant-time compare must still reject.
  const flipped = ctx.token.slice(0, -1) + (ctx.token.endsWith('a') ? 'b' : 'a');
  assert.equal((await raw('GET', `/?t=${flipped}`)).status, 403);
});

test('without the cookie: / and /index.html are 401 HTML, every /api/* is 401 JSON, other static assets are public', async () => {
  const home = await raw('GET', '/');
  assert.equal(home.status, 401); assert.match(home.headers['content-type'], /text\/html/); assert.match(home.text, /Session required/);
  assert.equal((await raw('GET', '/index.html')).status, 401);
  for (const p of ['/api/state', '/api/doctor', '/api/events']) {
    const r = await raw('GET', p);
    assert.equal(r.status, 401, p); assert.deepEqual(r.json, { error: 'unauthorized: open the URL printed at startup' });
  }
  const post = await raw('POST', '/api/settings', { body: { lang: 'English' } });
  assert.equal(post.status, 401);
  assert.equal((await raw('GET', '/app.css')).status, 200);
  assert.equal((await raw('GET', '/app.js')).status, 200);
});

test('with the cookie: / is the app, /api/state has the documented shape, /api/doctor returns checks', async () => {
  const home = await ctx.get('/');
  assert.equal(home.status, 200); assert.match(home.headers['content-type'], /text\/html/); assert.match(home.text, /<!doctype html>/i);
  const st = await ctx.get('/api/state');
  assert.equal(st.status, 200);
  assert.deepEqual(Object.keys(st.json).sort(), ['apiVersion', 'capability', 'efforts', 'engines', 'limits', 'models', 'naive', 'project', 'roomIndex', 'rooms', 'seats', 'settings', 'watch']);
  assert.equal(st.json.settings.lang, 'English');
  assert.ok(Array.isArray(st.json.seats) && st.json.seats.length >= 1);
  for (const s of st.json.seats) assert.ok(['idle', 'working', 'error'].includes(s.status) && 'activity' in s && 'roomId' in s);
  const doc = await ctx.get('/api/doctor');
  assert.equal(doc.status, 200);
  assert.ok(Array.isArray(doc.json.checks));
  for (const c of doc.json.checks) assert.ok(c.id && c.name && ['ok', 'warn', 'fail', 'skip'].includes(c.status), JSON.stringify(c));
});

test('Host allowlist: localhost / 127.0.0.1 / [::1] with this port pass; other hosts or ports are 403 even with the cookie', async () => {
  for (const host of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]) assert.equal((await ctx.get('/api/state', { host })).status, 200, host);
  for (const host of ['evil.example', `evil.example:${PORT}`, 'localhost', `localhost:${PORT + 1}`, `127.0.0.1:4317`, `localhost.evil.example:${PORT}`, `LOCALHOST:${PORT}`]) {
    const r = await ctx.get('/api/state', { host });
    assert.equal(r.status, 403, `host ${JSON.stringify(host)}`); assert.deepEqual(r.json, { error: 'forbidden host' });
  }
  assert.equal((await ctx.get('/app.css', { host: 'evil.example' })).status, 403, 'static files are gated too');
  // An HTTP/1.0 request without any Host header (Node's client always adds one, so use a raw socket).
  const rawResponse = await new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1', () => sock.write(`GET /api/state HTTP/1.0\r\nCookie: ${ctx.cookie}\r\n\r\n`));
    let s = ''; sock.setEncoding('utf8'); sock.on('data', (c) => { s += c; }); sock.on('end', () => resolve(s)); sock.on('error', reject);
  });
  assert.match(rawResponse, /^HTTP\/1\.[01] 403/); assert.match(rawResponse, /forbidden host/);
});

test('Origin allowlist: only http://<local host:port>; foreign, https, null and wrong-port origins are 403', async () => {
  for (const origin of [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`]) {
    assert.equal((await ctx.post('/api/settings', { lang: 'English' }, { headers: { origin } })).status, 200, origin);
  }
  for (const origin of ['http://evil.example', `https://localhost:${PORT}`, 'null', `http://localhost:${PORT + 1}`, `http://localhost:${PORT}.evil.example`]) {
    const r = await ctx.post('/api/settings', { lang: 'English' }, { headers: { origin } });
    assert.equal(r.status, 403, origin); assert.deepEqual(r.json, { error: 'forbidden origin' });
  }
  assert.equal((await ctx.get('/api/state', { headers: { origin: 'http://evil.example' } })).status, 403, 'GET with a foreign Origin too');
});

test('POST must be application/json (415); malformed / non-object JSON is 400; an oversized body is 413', async () => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '']) {
    const r = await ctx.post('/api/settings', '{}', { headers: { 'content-type': ct } });
    assert.equal(r.status, 415, `content-type ${JSON.stringify(ct)}`); assert.deepEqual(r.json, { error: 'json required' });
  }
  const r0 = await ctx.request('POST', '/api/settings', { body: undefined, headers: {} });
  assert.equal(r0.status, 415, 'no content-type at all');
  assert.equal((await ctx.post('/api/settings', '{}', { headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 200);
  assert.equal((await ctx.post('/api/settings', '{"lang": ', {})).status, 400);
  assert.equal((await ctx.post('/api/settings', '[1,2]', {})).status, 400);
  assert.equal((await ctx.post('/api/settings', '"str"', {})).status, 400);
  const big = await ctx.post('/api/settings', JSON.stringify({ lang: 'x'.repeat(1_100_000) }), {});
  assert.equal(big.status, 413); assert.match(big.json.error, /too large/);
});

test('static files: only regular files under public/; traversal (plain and encoded), directories, src/ and unknown paths are 404', async () => {
  const css = await ctx.get('/app.css');
  assert.equal(css.status, 200); assert.match(css.headers['content-type'], /^text\/css/);
  assert.match((await ctx.get('/app.js')).headers['content-type'], /^text\/javascript/);
  assert.match((await ctx.get('/index.html')).headers['content-type'], /^text\/html/);
  for (const p of ['/%2e%2e/package.json', '/../package.json', '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fpackage.json', '/src/server.js', '/../src/server.js', '/nope.css', '/%ZZ', '/api/nothing', '/public/app.css', '/./../package.json', '//app.css/../../package.json']) {
    const r = await ctx.get(p);
    assert.equal(r.status, 404, p); assert.deepEqual(r.json, { error: 'not found' });
  }
  // URL normalization folds "/." into "/": that is the index page, not an escape.
  assert.equal((await ctx.get('/.')).status, 200);
  const r = await ctx.request('PUT', '/api/state');
  assert.equal(r.status, 404, 'non-GET/POST methods fall through to 404');
  assert.equal((await ctx.request('DELETE', '/api/seats/claude/delete')).status, 404);
});

test('gate order: Host and content-type checks answer before the session check (403/415 without a cookie), cookie check before routing (401 for unknown /api paths)', async () => {
  assert.equal((await raw('GET', '/api/state', { host: 'evil.example' })).status, 403);
  assert.equal((await raw('POST', '/api/settings', { body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await raw('POST', '/api/settings', { body: {}, headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await raw('GET', '/api/does-not-exist')).status, 401);
});

test('security headers on every response: CSP without inline scripts, nosniff, frame denial, no-store, no-referrer', async () => {
  for (const r of [await ctx.get('/'), await ctx.get('/api/state'), await raw('GET', '/api/state'), await ctx.get('/nope'), await raw('GET', '/app.css')]) {
    const csp = r.headers['content-security-policy'];
    assert.ok(csp, 'csp present');
    assert.match(csp, /default-src 'self'/); assert.match(csp, /script-src 'self'/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline scripts allowed');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'no-store');
  }
});

test('SSE: text/event-stream with a hello event first (cookie required); settings changes are broadcast', async () => {
  const s = await ctx.sse();
  assert.equal(s.status, 200); assert.match(s.headers['content-type'], /text\/event-stream/);
  assert.deepEqual(s.events[0], { t: 'hello' });
  const r = await ctx.post('/api/settings', { lang: 'Turkish' });
  assert.equal(r.status, 200); assert.equal(r.json.lang, 'Turkish');
  const ev = await s.waitFor((e) => e.t === 'settings');
  assert.deepEqual(ev.settings, { lang: 'Turkish' });
  assert.equal((await ctx.state()).settings.lang, 'Turkish');
  assert.equal(ctx.app.store.readJson('settings.json').lang, 'Turkish');
  s.close();
  const denied = await sse(PORT);
  assert.equal(denied.status, 401);
});

test('API validation: bad seat model 400, meeting needs 2 seats + topic, chain needs two different seats + task, lang is validated, unknown seat 404, errors are {error}', async () => {
  const bad = await ctx.post('/api/seats', { name: 'X', agent: 'claude', model: 'not a model!' });
  assert.equal(bad.status, 400); assert.equal(typeof bad.json.error, 'string');
  const good = await ctx.post('/api/seats', { name: 'Zed', role: 'Tester', agent: 'codex', model: 'gpt-6-luna', effort: 'low', perm: 'read' });
  assert.equal(good.status, 200); assert.equal(good.json.id, 'zed'); assert.equal(good.json.status, 'idle'); assert.equal(good.json.perm, 'read');
  const again = await ctx.post('/api/seats', { name: 'Zed', agent: 'codex', model: 'gpt-6-luna' });
  assert.equal(again.json.id, 'zed-2', 'a second seat with the same name gets a suffixed id');
  assert.equal((await ctx.post('/api/seats', { name: 'W', agent: 'claude', model: 'claude-sonnet-5-5', perm: 'write', target: '../outside' })).status, 400, 'target outside the project');
  assert.equal((await ctx.post('/api/meeting', { topic: 'T', seatIds: ['zed'] })).status, 400);
  assert.equal((await ctx.post('/api/meeting', { topic: '', seatIds: ['zed', 'zed-2'] })).status, 400);
  assert.equal((await ctx.post('/api/meeting', { topic: 'T', seatIds: ['zed', 'zed-2'], rounds: 99 })).status, 400, 'rounds out of range');
  assert.equal((await ctx.post('/api/chain', { task: 'T', builderId: 'zed', reviewerId: 'zed' })).status, 400);
  assert.equal((await ctx.post('/api/chain', { task: '', builderId: 'zed', reviewerId: 'zed-2' })).status, 400);
  assert.equal((await ctx.post('/api/chain', { task: 'T', builderId: 'zed', reviewerId: 'ghost' })).status, 400);
  assert.equal((await ctx.post('/api/settings', { lang: 'x' })).status, 400, 'lang too short');
  assert.equal((await ctx.post('/api/settings', { lang: 'Türkçe' })).json.lang, 'Türkçe');
  assert.equal((await ctx.post('/api/settings', { lang: 'English' })).status, 200);
  for (const act of ['send', 'stop', 'reset', 'delete']) assert.equal((await ctx.post(`/api/seats/ghost/${act}`, { text: 'x' })).status, 404, act);
  assert.equal((await ctx.post('/api/seats/zed/send', { text: '   ' })).status, 400, 'empty message');
  assert.equal((await ctx.post('/api/rooms/ghost/say', { text: 'hi' })).status, 400);
  assert.deepEqual((await ctx.post('/api/rooms/ghost/stop')).json, { ok: false });
  assert.equal((await ctx.post('/api/seats/zed-2/delete')).status, 200);
  assert.equal((await ctx.post('/api/seats/zed/reset')).status, 200);
  assert.ok(!(await ctx.state()).seats.some((s) => s.id === 'zed-2'));
});
