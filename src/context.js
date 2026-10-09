// Prompt assembly that keeps a long, byte-identical prefix across items (so both CLIs can serve it from their prompt
// cache) and sends reviewers only what changed since the round they already saw.
// buildPacket puts the stable part first in a fixed order (rules, plan summary, shared scout brief) and everything that
// varies per item (id, spec, owner areas, notes) or per round (feedback) after the ITEM_MARK line.
const ITEM_MARK = '=== This item ===';
const STABLE_KEYS = ['rules', 'plan', 'brief'];

const clean = (s) => (typeof s === 'string' ? s.trim() : '');

// stable: { rules, plan, brief } strings (any may be empty); item: string; feedback: string or null.
function buildPacket({ stable = {}, item = '', feedback = null } = {}) {
  const parts = STABLE_KEYS.map((k) => clean(stable[k])).filter(Boolean);
  if (parts.length) parts.push(ITEM_MARK);
  const it = clean(item);
  if (it) parts.push(it);
  const fb = clean(feedback);
  if (fb) parts.push(fb);
  return parts.join('\n\n');
}

// The stable prefix buildPacket would emit for this stable block, including the item marker.
function stablePrefix(stable = {}) {
  const parts = STABLE_KEYS.map((k) => clean(stable[k])).filter(Boolean);
  return parts.length ? parts.join('\n\n') + '\n\n' + ITEM_MARK : '';
}

// Splits a git patch into per-file sections keyed by their header line, each with its hunks.
function sections(patchText) {
  const out = new Map();
  const chunks = String(patchText || '').split(/^(?=diff --git )/m).filter((c) => c.trim());
  for (const c of chunks) {
    const [head, ...hunks] = c.split(/^(?=@@ )/m);
    const key = head.split(/\r?\n/, 1)[0];
    out.set(key, { head, hunks });
  }
  return out;
}

// The part of `cur` that is not already in `prev`: whole new files, and for changed files only the hunks that differ.
// Files that disappeared from the patch are listed so the reviewer knows they are no longer part of the change.
function diffSincePrevious(prev, cur) {
  const before = sections(prev), after = sections(cur);
  const out = [], dropped = [];
  for (const [key, sec] of after) {
    const old = before.get(key);
    if (!old) { out.push(sec.head + sec.hunks.join('')); continue; }
    const seen = new Set(old.hunks);
    const fresh = sec.hunks.filter((h) => !seen.has(h));
    if (fresh.length) out.push(sec.head + fresh.join(''));
  }
  for (const key of before.keys()) if (!after.has(key)) dropped.push(key.replace(/^diff --git /, ''));
  let text = out.join('');
  if (dropped.length) text += `${text && !text.endsWith('\n') ? '\n' : ''}(no longer in the change: ${dropped.join(', ')})\n`;
  return text;
}

// Removes fenced ```diff blocks (the board shows the frozen patch separately, so the builder's copy would be a duplicate).
function stripDiffBlocks(text) {
  return String(text || '').replace(/^```diff[^\n]*\r?\n[\s\S]*?^```[ \t]*$/gm, '(the diff is sent below as the patch)').trim();
}

// Free text version of diffSincePrevious: a position-aware line diff of `cur` against `prev`. Added lines are marked
// "+ ", removed lines "- " (so deletions, reorderings and indentation changes stay visible; lines are compared exactly,
// apart from line endings and trailing spaces), and each run of unchanged lines becomes one "(N unchanged ...)" marker
// in its place. Returns null when that would not be shorter than `cur` (or the texts are too large to diff cheaply),
// so the caller sends the whole text.
const DIFF_CELL_LIMIT = 4_000_000;
const toLines = (t) => String(t || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));

function textSincePrevious(prev, cur) {
  const a = toLines(prev), b = toLines(cur);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - lo, m = eb - lo;
  if (n * m > DIFF_CELL_LIMIT) return null;
  // lcs[i][j]: length of the longest common subsequence of a[lo+i..ea) and b[lo+j..eb)
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[lo + i] === b[lo + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let same = lo, run = lo;
  const flush = () => { if (run) out.push(`(${run} unchanged line(s))`); run = 0; };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[lo + i] === b[lo + j]) { run++; same++; i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { flush(); out.push('+ ' + b[lo + j]); j++; }
    else { flush(); out.push('- ' + a[lo + i]); i++; }
  }
  same += a.length - ea;
  run += a.length - ea;
  flush();
  const text = `(+ added, - removed, compared with the previous round; ${same} unchanged line(s) in total)\n${out.join('\n')}`;
  return text.length < String(cur || '').length ? text : null;
}

module.exports = { buildPacket, stablePrefix, diffSincePrevious, stripDiffBlocks, textSincePrevious, ITEM_MARK };
