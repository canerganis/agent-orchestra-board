// Demo banner text: "Recorded from a real run on <date>. No agents run now." when the rooms carry recordedAt, today's
// banner otherwise. Also the refusal and the sanitizing of bench/record-demo.mjs (it is never run here).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { pathToFileURL } = require('url');
const { tmpDir, rmrf } = require('./helpers');
const { bannerText, recordedAtOf, MESSAGE } = require('../src/demo');

const SCRIPT = path.join(__dirname, '..', 'bench', 'record-demo.mjs');

test('banner: recordedAt gives the recorded text with the date', () => {
  assert.equal(bannerText('2026-10-09T12:30:00.000Z'), 'Recorded from a real run on 2026-10-09. No agents run now.');
});

test('banner: missing or invalid recordedAt keeps today\'s banner', () => {
  for (const v of [undefined, null, '', 'not a date', 42, {}]) assert.equal(bannerText(v), MESSAGE, String(v));
  assert.equal(MESSAGE, 'Demo, no agents run');
});

test('recordedAtOf reads the first valid recordedAt from the room files, null when there is none', () => {
  const dir = tmpDir('ob-banner-');
  try {
    assert.equal(recordedAtOf(path.join(dir, 'missing')), null);
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'a' }));
    fs.writeFileSync(path.join(dir, 'b.json'), '{broken');
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ recordedAt: 'nope' }));
    assert.equal(recordedAtOf(dir), null);
    fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify({ recordedAt: '2026-11-02T08:00:00.000Z' }));
    assert.equal(recordedAtOf(dir), '2026-11-02T08:00:00.000Z');
  } finally { rmrf(dir); }
});

test('record-demo refuses without OB_REAL=1 and starts nothing', () => {
  for (const v of [undefined, '', '0', 'true']) {
    const env = { ...process.env };
    delete env.OB_REAL; delete env.CI; delete env.GITHUB_ACTIONS; // the CI refusal comes first and is covered elsewhere
    if (v !== undefined) env.OB_REAL = v;
    const r = cp.spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 2, `OB_REAL=${v}`);
    assert.match(r.stderr, /refusing to run/);
    assert.match(r.stderr, /OB_REAL=1/);
    assert.equal(r.stdout, '');
  }
});

test('record-demo sanitizes paths, the user name and room ids, and checks the result', async () => {
  const m = await import(pathToFileURL(SCRIPT).href);
  assert.notEqual(m.refusal({}), null);
  assert.equal(m.refusal({ OB_REAL: '1' }), null);
  const proj = 'C:\\Users\\jdoe\\AppData\\Local\\Temp\\orchestra-record-abc';
  const room = {
    id: 'rid1',
    messages: [{ text: `read ${proj}\\src\\list.js and C:/Users/jdoe/AppData/Local/Temp/orchestra-record-abc/README.md, home C:\\Users\\jdoe\\.claude, rid1` }],
    [`${proj}\\k`]: 1,
  };
  const ctx = { paths: [proj], home: 'C:\\Users\\jdoe', user: 'jdoe', idMap: { rid1: 'demo-council' } };
  const out = m.sanitizeRoom(room, ctx);
  assert.equal(out.id, 'demo-council');
  assert.equal(out.messages[0].text, 'read C:\\work\\taskly\\src\\list.js and C:/work/taskly/README.md, home C:\\Users\\dev\\.claude, demo-council');
  assert.ok('C:\\work\\taskly\\k' in out);
  assert.equal(room.id, 'rid1');
  m.assertClean(out, ctx);
  assert.throws(() => m.assertClean({ t: 'C:\\Users\\jdoe\\x' }, ctx), /local value/);
  assert.throws(() => m.assertClean({ t: 'by JDoe' }, ctx), /local value/);
  assert.equal(m.MAX_ITEMS, 2);
  assert.equal(m.TOPIC, 'Should taskly add a --json flag to list, and what should it print?');
});
