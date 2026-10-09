// Read-only file helpers for the run watchers: a byte-level tail of an append-only JSON Lines file, first-line
// readers, a stat that refuses links, and a containment check for folders the watchers walk. Nothing here writes,
// renames or deletes. Reads do not throw: a missing, linked or unreadable file reads as gone (poll) or null (readers).
//
// createTail(file, { maxBytes, maxLine, headBytes }) returns { poll(), offset }. poll() returns:
//   lines  parsed JSON objects of the complete lines read by this poll, in file order. Invalid JSON, blank lines,
//          arrays and scalars are skipped. A trailing CR is dropped and a leading byte order mark is ignored.
//   heads  one entry per line longer than maxLine. That line is skipped and its head is kept:
//          { oversized: true, after, type?, key?, agentId? }. after is how many entries of lines came before it in
//          this poll. type, key and agentId are the top-level string values in the first headBytes of the line; a
//          value cut off by that limit, or nested inside another value, is left out.
//   gone   true when the path is missing, a link or not a regular file. Nothing is read and the offset is kept.
//   reset  true when the file is shorter than the offset (truncated). Reading restarts at byte 0, an open partial
//          line is dropped, and the caller must discard whatever it derived from earlier lines.
// offset is the number of bytes read since the last reset, and at most maxBytes are read per poll.
//
// readFirstLine(file, max) gives the first line as an object, readFirstMatching(file, pred, maxBytes) the first
// object for which pred is true. Both give null when there is no such object. statSafe(file) is lstat with links
// refused. under(root, p) is true only for a real path strictly inside root, reached without links, with no '..'.
const fs = require('fs');
const path = require('path');

const NL = 0x0a;
const CR = 0x0d;
const WIN = process.platform === 'win32';
// Opening never follows a final link where the OS has O_NOFOLLOW. statSafe refuses links on every OS.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
const EMPTY = Buffer.alloc(0);
const HEAD_KEYS = new Set(['type', 'key', 'agentId']);
const DOT_DOT = /(^|[\\/])\.\.([\\/]|$)/;

const realpath = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
const closeQuiet = (fd) => { try { fs.closeSync(fd); } catch {} };

// lstat with links refused: null when the path is missing, unreadable or a symbolic link.
function statSafe(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isSymbolicLink() ? null : st;
  } catch { return null; }
}

// Calls fn(fd, stat) for a regular file that is not a link and returns what fn returns. Null for anything else.
// Errors from open or from fn propagate to the caller.
function withRegularFile(file, fn) {
  const l = statSafe(file);
  if (!l || !l.isFile()) return null;
  let fd = null;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
    const st = fs.fstatSync(fd);
    return st.isFile() ? fn(fd, st) : null;
  } finally {
    if (fd !== null) closeQuiet(fd);
  }
}

// Reads up to len bytes at position start. Fewer bytes come back only when the file ends first.
function readAt(fd, start, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

// One line as a JSON object, or null when it is blank, invalid, or not an object.
function parseLine(bytes) {
  let b = bytes;
  if (b.length && b[b.length - 1] === CR) b = b.subarray(0, b.length - 1);
  if (!b.length) return null;
  let text = b.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// Top-level string values of "type", "key" and "agentId" in the text of an oversized line's first bytes. Only
// depth 1 counts, so nested keys are ignored, and a string that the end of the text cuts off is not reported.
function headFields(text) {
  const out = {};
  const n = text.length;
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  const skipWs = (p) => { while (p < n && isSpace(text[p])) p++; return p; };
  const stringEnd = (p) => { // index of the quote that closes the string opened at p, or -1
    for (let q = p + 1; q < n; q++) {
      if (text[q] === '\\') q++;
      else if (text[q] === '"') return q;
    }
    return -1;
  };
  const decode = (s) => {
    try { const v = JSON.parse(s); return typeof v === 'string' ? v : undefined; } catch { return undefined; }
  };
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '"') {
      const close = stringEnd(i);
      if (close < 0) break;
      const colon = skipWs(close + 1);
      if (depth === 1 && text[colon] === ':') {
        const key = decode(text.slice(i, close + 1));
        if (HEAD_KEYS.has(key) && !Object.prototype.hasOwnProperty.call(out, key)) {
          const v = skipWs(colon + 1);
          const end = text[v] === '"' ? stringEnd(v) : -1;
          const value = end < 0 ? undefined : decode(text.slice(v, end + 1));
          if (value !== undefined) out[key] = value;
        }
      }
      i = close + 1;
      continue;
    }
    i++;
  }
  return out;
}

// Tail of an append-only file. The header describes what poll() returns.
function createTail(file, { maxBytes = 1 << 20, maxLine = 4 << 20, headBytes = 512 } = {}) {
  for (const [name, value, min] of [['maxBytes', maxBytes, 1], ['maxLine', maxLine, 1], ['headBytes', headBytes, 0]]) {
    if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be an integer of at least ${min}`);
  }
  const freshLine = () => ({ parts: [], len: 0, over: false, head: EMPTY });
  let offset = 0;         // bytes read from the file since the last reset
  let line = freshLine(); // the line still open at the end of the bytes read so far

  // Adds bytes of the open line. Until it passes maxLine its bytes are kept whole; after that only its head is kept.
  const addBytes = (piece) => {
    line.len += piece.length;
    if (!line.over) {
      if (line.len <= maxLine) {
        if (piece.length) line.parts.push(Buffer.from(piece));
        return;
      }
      line.over = true;
      line.head = Buffer.concat(line.parts).subarray(0, headBytes);
      line.parts = [];
    }
    if (line.head.length < headBytes) line.head = Buffer.concat([line.head, piece.subarray(0, headBytes - line.head.length)]);
  };
  const finishLine = (lines, heads) => {
    if (line.over) heads.push({ oversized: true, after: lines.length, ...headFields(line.head.toString('utf8')) });
    else {
      const obj = parseLine(Buffer.concat(line.parts));
      if (obj) lines.push(obj);
    }
    line = freshLine();
  };
  const feed = (chunk, lines, heads) => {
    for (let start = 0; ;) {
      const nl = chunk.indexOf(NL, start);
      addBytes(chunk.subarray(start, nl < 0 ? chunk.length : nl));
      if (nl < 0) return;
      finishLine(lines, heads);
      start = nl + 1;
    }
  };
  const poll = () => {
    let got = null;
    try {
      got = withRegularFile(file, (fd, st) => {
        const reset = st.size < offset;
        const start = reset ? 0 : offset;
        const want = Math.min(maxBytes, st.size - start);
        return { reset, start, chunk: want > 0 ? readAt(fd, start, want) : EMPTY };
      });
    } catch { got = null; }
    if (!got) return { lines: [], heads: [], gone: true, reset: false };
    if (got.reset) { offset = 0; line = freshLine(); }
    const lines = [], heads = [];
    feed(got.chunk, lines, heads);
    offset = got.start + got.chunk.length;
    return { lines, heads, gone: false, reset: got.reset };
  };
  return { poll, get offset() { return offset; } };
}

// First line of a file as a JSON object. Null when that line is longer than max bytes, is not an object, or the path
// is missing, a link or not a regular file.
function readFirstLine(file, max = 1 << 20) {
  try {
    return withRegularFile(file, (fd, st) => {
      const buf = readAt(fd, 0, Math.min(max + 1, st.size));
      const nl = buf.indexOf(NL);
      if (nl >= 0) return nl > max ? null : parseLine(buf.subarray(0, nl));
      return st.size > max ? null : parseLine(buf);
    });
  } catch { return null; }
}

// First JSON object in the first maxBytes of a file for which pred(object) is true, or null. A line counts only when
// its newline lies inside that window, or when the whole file fits in it.
function readFirstMatching(file, pred, maxBytes = 256 << 10) {
  try {
    return withRegularFile(file, (fd, st) => {
      const buf = readAt(fd, 0, Math.min(maxBytes, st.size));
      const whole = st.size <= maxBytes;
      for (let start = 0; start < buf.length;) {
        const nl = buf.indexOf(NL, start);
        if (nl < 0 && !whole) return null;
        const obj = parseLine(buf.subarray(start, nl < 0 ? buf.length : nl));
        if (obj && pred(obj)) return obj;
        if (nl < 0) return null;
        start = nl + 1;
      }
      return null;
    });
  } catch { return null; }
}

// Strict containment of real paths. Case-insensitive on Windows.
function inside(child, root) {
  const low = (s) => (WIN ? s.toLowerCase() : s);
  const c = low(child), r = low(root);
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.length > prefix.length && c.startsWith(prefix);
}

// True when p is a real path strictly inside root. Refused: relative paths, any '..' segment (checked before anything
// is normalised), a symbolic link on the way from root down to p (root itself may be a link), and a p whose real path
// leaves root. A missing path is not under anything.
function under(root, p) {
  try {
    if (typeof root !== 'string' || typeof p !== 'string') return false;
    if (!path.isAbsolute(root) || !path.isAbsolute(p) || DOT_DOT.test(root) || DOT_DOT.test(p)) return false;
    const base = path.resolve(root);
    const abs = path.resolve(p);
    const rel = path.relative(base, abs);
    if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) return false;
    let cur = base;
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part);
      if (fs.lstatSync(cur).isSymbolicLink()) return false;
    }
    return inside(realpath(abs), realpath(base));
  } catch { return false; }
}

module.exports = { createTail, readFirstLine, readFirstMatching, statSafe, under };
