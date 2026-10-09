// Tail utility for the run watchers (src/watch/tail.js): partial lines, CRLF, invalid JSON, reset on shrink, a UTF-8
// character split across polls, oversized line heads, the per-poll read budget, and the read-only helpers (statSafe,
// under, readFirstLine, readFirstMatching). Temporary folders only. Links are made when the OS allows them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTail, readFirstLine, readFirstMatching, statSafe, under } = require('../src/watch/tail');

// A fresh folder that is removed after the test. Removal never follows a link.
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-tail-'));
  t.after(() => removeTree(dir));
  return dir;
}

function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  try {
    if (st.isSymbolicLink()) {
      try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
    } else if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  } catch {}
}

// True when the link was made. Windows needs a privilege for file symlinks; folder junctions need none.
function tryLink(target, linkPath, type) {
  try { fs.symlinkSync(target, linkPath, type); return true; } catch { return false; }
}

const bytes = (s) => Buffer.byteLength(s);

test('createTail: a partial line waits for its newline and completes on the next poll', (t) => {
  const file = path.join(tmpDir(t), 'run.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"b":');
  const tail = createTail(file);
  assert.deepEqual(tail.poll(), { lines: [{ a: 1 }], heads: [], gone: false, reset: false });
  assert.deepEqual(tail.poll(), { lines: [], heads: [], gone: false, reset: false }, 'nothing new yet');
  fs.appendFileSync(file, '2}\n');
  assert.deepEqual(tail.poll(), { lines: [{ b: 2 }], heads: [], gone: false, reset: false });
  assert.equal(tail.offset, bytes('{"a":1}\n{"b":2}\n'), 'the offset counts the bytes read');
});

test('createTail: CRLF endings are trimmed, and a CR at the end of a partial line waits for its LF', (t) => {
  const file = path.join(tmpDir(t), 'crlf.jsonl');
  fs.writeFileSync(file, '{"a":1}\r\n{"b":"x"}\r\n');
  const tail = createTail(file);
  assert.deepEqual(tail.poll().lines, [{ a: 1 }, { b: 'x' }]);
  fs.appendFileSync(file, '{"c":3}\r');
  assert.deepEqual(tail.poll().lines, []);
  fs.appendFileSync(file, '\n');
  assert.deepEqual(tail.poll().lines, [{ c: 3 }]);
});

test('createTail: invalid JSON, blank lines and JSON that is not an object are skipped', (t) => {
  const file = path.join(tmpDir(t), 'bad.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{bad\n\n   \n[1,2]\n"text"\nnull\n{"c":3}\n');
  assert.deepEqual(createTail(file).poll().lines, [{ a: 1 }, { c: 3 }]);
});

test('createTail: a file shorter than the offset sets reset and is read again from its start', (t) => {
  const file = path.join(tmpDir(t), 'shrink.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"b":2}\n');
  const tail = createTail(file);
  assert.deepEqual(tail.poll().lines, [{ a: 1 }, { b: 2 }]);
  fs.writeFileSync(file, '{"c":3}\n');
  assert.deepEqual(tail.poll(), { lines: [{ c: 3 }], heads: [], gone: false, reset: true });
  fs.appendFileSync(file, '{"d":4}\n');
  assert.deepEqual(tail.poll(), { lines: [{ d: 4 }], heads: [], gone: false, reset: false });
});

test('createTail: a reset drops the partial line that was open before the shrink', (t) => {
  const file = path.join(tmpDir(t), 'partial.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"b":');
  const tail = createTail(file);
  assert.equal(tail.poll().lines.length, 1);
  fs.writeFileSync(file, '{"z":9}\n');
  assert.deepEqual(tail.poll(), { lines: [{ z: 9 }], heads: [], gone: false, reset: true },
    'the old fragment is not joined to the new line');
});

test('createTail: a UTF-8 character split across two polls decodes once, as one line', (t) => {
  const file = path.join(tmpDir(t), 'utf8.jsonl');
  const line = Buffer.from('{"s":"\u{1F600}"}\n'); // the emoji is 4 bytes
  const cut = line.indexOf(0xf0) + 2;
  fs.writeFileSync(file, line.subarray(0, cut));
  const tail = createTail(file);
  assert.deepEqual(tail.poll().lines, []);
  fs.appendFileSync(file, line.subarray(cut));
  assert.deepEqual(tail.poll().lines, [{ s: '\u{1F600}' }]);
  assert.deepEqual(tail.poll().lines, [], 'no second copy');
});

test('createTail: an oversized line is skipped and its head gives type, key and agentId', (t) => {
  const file = path.join(tmpDir(t), 'huge.jsonl');
  const head = '{"type":"result","key":"build:I1:haiku","agentId":"a1234567890abc"';
  fs.writeFileSync(file, `${head},"result":"${'x'.repeat(300)}"}\n{"type":"ok"}\n`);
  const r = createTail(file, { maxLine: 100, headBytes: 128 }).poll();
  assert.deepEqual(r.lines, [{ type: 'ok' }]);
  assert.deepEqual(r.heads, [{ oversized: true, after: 0, type: 'result', key: 'build:I1:haiku', agentId: 'a1234567890abc' }]);
});

test('createTail: a head records how many lines of the same poll came before it', (t) => {
  const file = path.join(tmpDir(t), 'order.jsonl');
  const big = `{"type":"result","key":"k1","agentId":"a1","data":"${'y'.repeat(200)}"}`;
  fs.writeFileSync(file, `{"n":1}\n${big}\n{"n":2}\n`);
  const r = createTail(file, { maxLine: 100, headBytes: 64 }).poll();
  assert.deepEqual(r.lines, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(r.heads, [{ oversized: true, after: 1, type: 'result', key: 'k1', agentId: 'a1' }]);
});

test('createTail: a line of exactly maxLine bytes is read, and one byte more makes it an oversized head', (t) => {
  const file = path.join(tmpDir(t), 'edge.jsonl');
  const exact = `{"k":"${'z'.repeat(22)}"}`; // 30 bytes
  const over = `{"k":"${'z'.repeat(23)}"}`;   // 31 bytes
  assert.equal(bytes(exact), 30);
  assert.equal(bytes(over), 31);
  fs.writeFileSync(file, `${exact}\n${over}\n`);
  const r = createTail(file, { maxLine: 30, headBytes: 16 }).poll();
  assert.deepEqual(r.lines, [{ k: 'z'.repeat(22) }]);
  assert.deepEqual(r.heads, [{ oversized: true, after: 1 }], 'no key is in the first 16 bytes');
});

test('createTail: an oversized line split over several polls gives one head, and nothing is repeated', (t) => {
  const file = path.join(tmpDir(t), 'split.jsonl');
  const big = `{"type":"result","key":"k1","agentId":"a1","data":"${'y'.repeat(200)}"}`;
  fs.writeFileSync(file, `{"n":1}\n${big}\n{"n":2}\n`);
  const size = fs.statSync(file).size;
  const tail = createTail(file, { maxBytes: 16, maxLine: 100, headBytes: 64 });
  const polls = [];
  for (let i = 0; tail.offset < size; i++) {
    assert.ok(i < 200, 'the tail reaches the end of the file');
    polls.push(tail.poll());
  }
  assert.deepEqual(polls.flatMap((p) => p.lines), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(polls.flatMap((p) => p.heads), [{ oversized: true, after: 0, type: 'result', key: 'k1', agentId: 'a1' }]);
});

test('createTail: a head cut off by headBytes gives no value for that key, and nested keys are ignored', (t) => {
  const file = path.join(tmpDir(t), 'nested.jsonl');
  // The nested "type" comes first. The top-level agentId value is cut off after its opening quote.
  fs.writeFileSync(file, `{"result":{"type":"text","key":"decoy"},"type":"result","key":"k\\"2","agentId":"${'a'.repeat(50)}"}\n`);
  const r = createTail(file, { maxLine: 20, headBytes: 80 }).poll();
  assert.deepEqual(r.heads, [{ oversized: true, after: 0, type: 'result', key: 'k"2' }]);
});

test('createTail: each poll reads at most maxBytes, and a large file arrives in order over several polls', (t) => {
  const file = path.join(tmpDir(t), 'budget.jsonl');
  const text = Array.from({ length: 10 }, (_, i) => `{"n":${i + 1}}\n`).join('');
  fs.writeFileSync(file, text);
  const tail = createTail(file, { maxBytes: 20 });
  const seen = [];
  let before = 0;
  for (let i = 0; tail.offset < text.length; i++) {
    assert.ok(i < 100, 'the tail reaches the end of the file');
    const r = tail.poll();
    assert.ok(tail.offset - before <= 20, 'at most maxBytes per poll');
    before = tail.offset;
    seen.push(...r.lines);
  }
  assert.deepEqual(seen.map((o) => o.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('createTail: a missing file reports gone, and its content is read from the start once it appears', (t) => {
  const file = path.join(tmpDir(t), 'later.jsonl');
  const tail = createTail(file);
  assert.deepEqual(tail.poll(), { lines: [], heads: [], gone: true, reset: false });
  fs.writeFileSync(file, '{"a":1}\n');
  assert.deepEqual(tail.poll(), { lines: [{ a: 1 }], heads: [], gone: false, reset: false });
});

test('createTail: a link or a folder at the path is never read and reports gone', (t) => {
  const dir = tmpDir(t);
  const target = path.join(dir, 'target.jsonl');
  fs.writeFileSync(target, '{"a":1}\n');
  const linked = path.join(dir, 'linked.jsonl');
  if (!tryLink(target, linked, 'file')) {
    const folder = path.join(dir, 'folder');
    fs.mkdirSync(folder);
    if (!tryLink(folder, linked, 'junction')) return t.skip('this machine cannot create links');
  }
  assert.deepEqual(createTail(linked).poll(), { lines: [], heads: [], gone: true, reset: false });
  const folder2 = path.join(dir, 'folder2');
  fs.mkdirSync(folder2);
  assert.equal(createTail(folder2).poll().gone, true, 'a folder is not a file');
});

test('createTail: limits must be integers in range', () => {
  for (const bad of [{ maxBytes: 0 }, { maxLine: -1 }, { headBytes: -1 }, { maxBytes: 1.5 }, { maxLine: '4' }]) {
    assert.throws(() => createTail('unused.jsonl', bad), RangeError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => createTail('unused.jsonl', { headBytes: 0 }));
});

test('statSafe: a file or folder gives its stat; a missing path and a link give null', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, '{}\n');
  assert.equal(statSafe(file).isFile(), true);
  assert.equal(statSafe(dir).isDirectory(), true);
  assert.equal(statSafe(path.join(dir, 'missing')), null);
  const folder = path.join(dir, 'folder');
  fs.mkdirSync(folder);
  const link = path.join(dir, 'folder-link');
  if (!tryLink(folder, link, 'junction')) return t.skip('this machine cannot create links');
  assert.equal(statSafe(link), null, 'a folder link is refused');
  const fileLink = path.join(dir, 'file-link.jsonl');
  if (tryLink(file, fileLink, 'file')) assert.equal(statSafe(fileLink), null, 'a file link is refused');
});

test('readFirstLine: the first line as an object, or null when it is too long, not an object, or missing', (t) => {
  const dir = tmpDir(t);
  const write = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };
  assert.deepEqual(readFirstLine(write('a.jsonl', '{"sid":"x"}\r\n{"second":1}\n')), { sid: 'x' });
  assert.deepEqual(readFirstLine(write('b.jsonl', '{"only":true}')), { only: true }, 'a single line with no newline');
  assert.equal(readFirstLine(write('c.jsonl', `{"k":"${'y'.repeat(40)}"}\n`), 20), null, 'longer than max');
  const exact = `{"k":"${'y'.repeat(12)}"}`;
  assert.equal(bytes(exact), 20);
  assert.deepEqual(readFirstLine(write('d.jsonl', `${exact}\n`), 20), { k: 'y'.repeat(12) }, 'exactly max bytes still counts');
  assert.equal(readFirstLine(write('e.jsonl', 'not json\n{"ok":1}\n')), null);
  assert.equal(readFirstLine(write('g.jsonl', `{"a":1}${' '.repeat(30)}`), 20), null,
    'valid JSON followed by padding is still refused when the line is too long');
  assert.equal(readFirstLine(write('f.jsonl', '[1]\n')), null, 'an array is not an object');
  assert.equal(readFirstLine(path.join(dir, 'missing.jsonl')), null);
  assert.equal(readFirstLine(dir), null, 'a folder is not a file');
});

test('readFirstMatching: skips lines without cwd, respects the window, and a last line counts only when the file fits', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'session.jsonl');
  const l1 = '{"type":"queue-operation","op":"enqueue"}\n';
  const l2 = '{"type":"summary","text":"x"}\n';
  const l3 = '{"type":"user","cwd":"/work/app"}\n';
  fs.writeFileSync(file, `${l1}${l2}${l3}{"cwd":"/work/other"}\n`);
  const hasCwd = (o) => typeof o.cwd === 'string';
  assert.deepEqual(readFirstMatching(file, hasCwd), { type: 'user', cwd: '/work/app' });
  assert.equal(readFirstMatching(file, (o) => o.cwd === '/nope'), null);
  assert.equal(readFirstMatching(file, hasCwd, bytes(l1 + l2) + 5), null, 'a line whose newline is outside the window is not read');
  assert.equal(readFirstMatching(file, hasCwd, bytes(l1 + l2 + l3) - 1), null,
    'a complete object at the window edge still needs its newline inside the window');
  assert.deepEqual(readFirstMatching(file, hasCwd, bytes(l1 + l2 + l3)), { type: 'user', cwd: '/work/app' });
  const short = path.join(dir, 'short.jsonl');
  fs.writeFileSync(short, '{"type":"x"}\n{"cwd":"/tail"}');
  assert.deepEqual(readFirstMatching(short, hasCwd), { cwd: '/tail' }, 'a last line with no newline counts when the file fits');
  assert.equal(readFirstMatching(short, hasCwd, 20), null, 'and does not count when the window cuts it');
  assert.equal(readFirstMatching(path.join(dir, 'missing.jsonl'), hasCwd), null);
});

test('under: a real path strictly inside root is accepted; "..", relative, outside and linked paths are refused', (t) => {
  const dir = tmpDir(t);
  const root = path.join(dir, 'projects');
  const outside = path.join(dir, 'outside');
  const inner = path.join(root, 'sub', 'session.jsonl');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(inner, '{}\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const sep = path.sep;

  assert.equal(under(root, inner), true);
  assert.equal(under(root, root), false, 'the root is not strictly under itself');
  assert.equal(under(root, path.join(root, 'missing.jsonl')), false, 'a missing path is not under the root');
  assert.equal(under(root, path.join(outside, 'secret.txt')), false, 'an outside path');
  assert.equal(under(root, `${root}${sep}..${sep}outside${sep}secret.txt`), false, 'a ".." escape');
  assert.equal(under(root, `${root}${sep}sub${sep}..${sep}sub${sep}session.jsonl`), false,
    'a ".." segment is refused even when it stays inside');
  assert.equal(under(root, 'sub/session.jsonl'), false, 'a relative path');

  const outLink = path.join(root, 'out-link');
  if (tryLink(outside, outLink, 'junction')) {
    assert.equal(under(root, path.join(outLink, 'secret.txt')), false, 'a folder link that leads outside');
  } else {
    t.diagnostic('no folder link on this machine: the outside-link check is skipped');
  }
  const innerLink = path.join(root, 'sub-link');
  if (tryLink(path.join(root, 'sub'), innerLink, 'junction')) {
    assert.equal(under(root, path.join(innerLink, 'session.jsonl')), false, 'a folder link inside root is refused too');
  }
  const fileLink = path.join(root, 'file-link.jsonl');
  if (tryLink(inner, fileLink, 'file')) {
    assert.equal(under(root, fileLink), false, 'a file link is refused, even one that points inside root');
  } else {
    t.diagnostic('no file link on this machine: the file-link check is skipped');
  }
  const rootLink = path.join(dir, 'projects-link');
  if (tryLink(root, rootLink, 'junction')) {
    assert.equal(under(rootLink, path.join(rootLink, 'sub', 'session.jsonl')), true, 'the root itself may be a link');
  }
  assert.equal(under(root, inner), true, 'the real file is still under root');
});
