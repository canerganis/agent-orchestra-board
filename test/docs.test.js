// R1: the docs follow the code. docs/api.md names every v2 route, every SSE event the server sends and every error code
// the v2 routes and engines return; the ADR index lists every record; the docs and the UI use no em or en dash as
// punctuation. No server, no CLI: these tests read files only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApiV2 } = require('../src/api');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const API = read('docs', 'api.md');
// Code points 0x2013 (en dash) and 0x2014 (em dash), written as numbers so this file holds no dash character.
const DASHES = new Set([0x2013, 0x2014]);
const dashLines = (text) => text.split('\n').map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => [...line].some((ch) => DASHES.has(ch.codePointAt(0))));
const srcFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
  const rel = path.join(dir, d.name);
  return d.isDirectory() ? srcFiles(rel) : rel.endsWith('.js') ? [rel] : [];
});

test('docs: README, CHANGELOG, SECURITY, CONTRIBUTING and docs/ use no em or en dash', () => {
  const docs = ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md',
    ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => path.join('docs', f)),
    ...fs.readdirSync(path.join(ROOT, 'docs', 'decisions')).filter((f) => f.endsWith('.md')).map((f) => path.join('docs', 'decisions', f))];
  for (const f of docs) assert.deepEqual(dashLines(read(f)).map((x) => `${f}:${x.n}`), [], `${f} has an em or en dash`);
});

test('public/: an em or en dash appears only as an empty-cell placeholder, never as punctuation', () => {
  for (const f of ['app.js', 'app.css', 'index.html']) {
    const text = read('public', f);
    // The only allowed form is a quoted single dash, the placeholder for an empty table cell or a missing figure.
    const stripped = text.replace(/'[–—]'/g, "''");
    assert.deepEqual(dashLines(stripped).map((x) => `${f}:${x.n}`), [], `public/${f} uses a dash as punctuation`);
  }
});

test('docs/api.md documents every API v2 route', () => {
  const documented = new Set();
  for (const m of API.matchAll(/`(GET|POST) (\/api\/[^`?\s]*)/g)) documented.add(`${m[1]} ${m[2].replace(/:\w+/g, '*')}`);
  const routes = createApiV2({}).routes.map((r) => {
    const p = r.re.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\([^)]*\)/g, '*');
    return `${r.method} ${p}`;
  });
  assert.ok(routes.length >= 9, `found ${routes.length} routes`);
  for (const r of routes) assert.ok(documented.has(r), `docs/api.md does not document ${r}`);
  for (const r of ['GET /api/rooms/*', 'GET /api/preflight']) assert.ok(documented.has(r), `docs/api.md does not document ${r}`);
});

test('docs/api.md lists every SSE event the server sends', () => {
  const events = new Set(['hello']);
  for (const f of [...srcFiles('src')]) {
    for (const m of read(f).matchAll(/(?:broadcast|safeSend)\(\{ ?t: '([A-Za-z]+)'/g)) events.add(m[1]);
  }
  assert.ok(events.has('engine') && events.has('wfRun'), 'the scan finds the v2 events');
  const section = API.slice(API.indexOf('## SSE events'), API.indexOf('## Persistence'));
  for (const t of events) assert.ok(section.includes(`| \`${t}\` |`), `SSE event ${t} is not in docs/api.md`);
});

test('docs/api.md names every error code the v2 routes, the engines and the server return', () => {
  const codes = new Set();
  const files = ['src/server.js', ...srcFiles('src/api'), ...srcFiles('src/engines'), 'src/workflows/build.js', 'src/capability.js'];
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/httpError\(\d{3},[^;]*?'([a-z][a-z0-9-]+)'\)/g)) codes.add(m[1]);
    for (const m of text.matchAll(/code: '([a-z][a-z0-9-]+)'/g)) codes.add(m[1]);
  }
  // build.js names its own lookups no-build and no-item, but server.js answers those 404s first, without a code (as the
  // docs say), so a client never sees them.
  codes.delete('no-build'); codes.delete('no-item');
  assert.ok(codes.has('unknown-engine') && codes.has('unsupported-platform') && codes.has('not-a-candidate'), 'the scan finds the v2 codes');
  for (const c of codes) assert.ok(API.includes(`\`${c}\``), `error code ${c} is not in docs/api.md`);
});

test('the ADR index lists every decision record, and README links ADR 0007', () => {
  const index = read('docs', 'decisions', 'README.md');
  const adrs = fs.readdirSync(path.join(ROOT, 'docs', 'decisions')).filter((f) => /^\d{4}-.*\.md$/.test(f));
  assert.ok(adrs.includes('0007-engines.md'));
  for (const f of adrs) assert.ok(index.includes(`(${f})`), `docs/decisions/README.md does not link ${f}`);
  assert.ok(read('README.md').includes('docs/decisions/0007-engines.md'));
});
