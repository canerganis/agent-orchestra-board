// Stateless helpers: verdict/stance line extraction, clipping, JSONL splitting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lastLine, clip, shortCmd, jsonlFeeder, newId, today, now } = require('../src/util');

test('lastLine: last non-empty line, markdown emphasis stripped, CRLF and trailing blanks tolerated', () => {
  assert.equal(lastLine('Looks good.\n\n**VERDICT: PASS**\n\n'), 'VERDICT: PASS');
  assert.equal(lastLine('ok\r\n`STANCE: CONVERGED`\r\n'), 'STANCE: CONVERGED');
  assert.equal(lastLine('_VERDICT: FAIL_'), 'VERDICT: FAIL');
  assert.equal(lastLine('VERDICT: PASS\nbut one more thing'), 'but one more thing', 'only the LAST line counts');
  assert.equal(lastLine(''), '');
  assert.equal(lastLine(null), '');
  assert.equal(lastLine(undefined), '');
});

test('strict verdict / stance regexes (as used by chain and meeting) accept only an exact last line', () => {
  const PASS = (t) => /^VERDICT:\s*PASS$/i.test(lastLine(t));
  const CONV = (t) => /^STANCE:\s*CONVERGED$/i.test(lastLine(t));
  assert.ok(PASS('No blockers.\nVERDICT: PASS'));
  assert.ok(PASS('No blockers.\n**verdict:  pass**'));
  assert.ok(!PASS('VERDICT: PASS\nWell, almost.'));
  assert.ok(!PASS('VERDICT: PASS (with nits)'));
  assert.ok(!PASS('VERDICT: PASSED'));
  assert.ok(!PASS('VERDICT: FAIL'));
  assert.ok(CONV('I agree.\nSTANCE: CONVERGED'));
  assert.ok(!CONV('STANCE: CONVERGED\nSTANCE: OPEN'));
  assert.ok(!CONV('STANCE: OPEN'));
});

test('clip: strings collapse whitespace and get an ellipsis; objects are JSON-encoded; unencodable input is empty', () => {
  assert.equal(clip('  a   b\n\tc  '), 'a b c');
  assert.equal(clip('x'.repeat(130)), 'x'.repeat(120) + '…');
  assert.equal(clip('abcdef', 3), 'abc…');
  assert.equal(clip({ file_path: 'src/a.js' }), '{"file_path":"src/a.js"}');
  const cyc = {}; cyc.self = cyc;
  assert.equal(clip(cyc), '');
});

test('shortCmd: unwraps a PowerShell -Command wrapper and caps the length', () => {
  assert.equal(shortCmd("powershell -Command 'Get-ChildItem src'"), 'Get-ChildItem src');
  assert.equal(shortCmd('ls -la'), 'ls -la');
  assert.equal(shortCmd('y'.repeat(200)).length, 160);
});

test('jsonlFeeder: splits on newlines, parses only lines starting with "{", ignores invalid JSON, holds partial lines', () => {
  const seen = [];
  const feed = jsonlFeeder((o) => seen.push(o));
  feed('{"a":1}\nnoise\n{"b":');
  assert.deepEqual(seen, [{ a: 1 }]);
  feed('2}\n{bad json}\n[1]\n  {"c":3}  \n');
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  feed(Buffer.from('{"d":4}\n'));
  assert.deepEqual(seen.at(-1), { d: 4 });
});

test('newId: base36 time prefix plus random suffix (unique for the handful of ids a room creates per millisecond); today/now are ISO based', () => {
  const ids = Array.from({ length: 8 }, newId);
  for (const id of ids) assert.match(id, /^[0-9a-z]{8,}$/);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids[0].slice(0, 8) <= newId().slice(0, 8), 'time prefix never decreases');
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(now().slice(0, 10), today());
});
