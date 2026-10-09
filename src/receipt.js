// Change receipts: a small, verifiable record of one reviewed patch.
//
// A receipt names the plan and item it belongs to, the sha256 of the exact patch bytes, the reviews that were
// bound to that patch hash, the check results and (optionally) the containment evidence. receiptHash is the sha256
// of the canonical JSON (keys sorted at every depth) of everything else, so key order never changes it. Prompt
// text is never stored: only whitelisted fields are copied in.
const crypto = require('crypto');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Canonical JSON: object keys sorted recursively, array order kept, undefined fields dropped.
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}
const canonicalJson = (v) => JSON.stringify(canonicalize(v));

const toBuf = (b) => (Buffer.isBuffer(b) ? b : b instanceof Uint8Array ? Buffer.from(b) : Buffer.from(String(b ?? ''), 'utf8'));
const str = (v) => (v == null ? null : String(v));

function buildFacts(r) {
  const facts = [`patch ${r.patchHash} (${r.patchBytes} bytes) on base ${r.baseCommit}`];
  for (const rv of r.reviews) facts.push(`review by ${rv.reviewer}: ${rv.verdict} on ${rv.hash}`);
  for (const c of r.checks) facts.push(`check ${c.name}: ${c.ok ? 'ok' : 'failed'}${c.code != null ? ` (code ${c.code})` : ''}`);
  if (r.containment) facts.push(`containment: ${r.containment.result}${r.containment.cliVersion ? ` (cli ${r.containment.cliVersion})` : ''}`);
  return facts;
}

const hashOf = (receipt) => {
  const rest = { ...receipt };
  delete rest.receiptHash;
  return sha(canonicalJson(rest));
};

function makeReceipt({ planHash, itemId, itemHash, baseCommit, patchBytes, reviews = [], checks = [], containment } = {}) {
  const buf = toBuf(patchBytes);
  const r = {
    version: 1,
    planHash: str(planHash),
    itemId: str(itemId),
    itemHash: str(itemHash),
    baseCommit: str(baseCommit),
    patchHash: sha(buf),
    patchBytes: buf.length,
    reviews: reviews.map((x) => ({ reviewer: str(x.reviewer), verdict: str(x.verdict), hash: str(x.hash) })),
    checks: checks.map((x) => ({ name: str(x.name), ok: !!x.ok, code: x.code == null ? null : x.code })),
    containment: containment ? { result: str(containment.result), cliVersion: str(containment.cliVersion) } : null,
  };
  r.facts = buildFacts(r);
  r.receiptHash = hashOf(r);
  return r;
}

// Recomputes the patch hash and the receipt hash and checks that every PASS review is bound to this patch.
function verifyReceipt(receipt, patchBytes) {
  const problems = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { ok: false, problems: ['receipt is not an object'] };
  const buf = toBuf(patchBytes);
  if (sha(buf) !== receipt.patchHash) problems.push('patch bytes do not match patchHash');
  if (buf.length !== receipt.patchBytes) problems.push('patch size does not match patchBytes');
  if (hashOf(receipt) !== receipt.receiptHash) problems.push('receiptHash does not match the receipt content');
  if (!Array.isArray(receipt.reviews)) problems.push('reviews is not a list');
  for (const rv of Array.isArray(receipt.reviews) ? receipt.reviews : []) {
    if (String(rv && rv.verdict).toUpperCase() === 'PASS' && rv.hash !== receipt.patchHash) {
      problems.push(`PASS review by ${rv.reviewer} is bound to another patch hash`);
    }
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { makeReceipt, verifyReceipt, canonicalJson };
