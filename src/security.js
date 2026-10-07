// Security primitives for the local board: session token + cookie, security headers, POST body validation.
//
// THREAT MODEL
// The board listens on 127.0.0.1 only and drives CLIs that can read (and, for 'write' seats, edit) the
// project and spend money. The attacker is therefore not on the network but *in the user's browser*:
//   1. A malicious web page the user has open (any origin) that fires requests at http://localhost:<port>.
//      Fetch/XHR to another origin carry an Origin header -> rejected by the Origin allowlist; simple GETs
//      (img/script tags, top-level navigation) and SSE have no body but must not leak state -> every
//      /api/* request additionally needs the session cookie (per-project token, persisted in
//      .orchestra/session), which such requests cannot have
//      unless the page was opened from the printed URL, and SameSite=Strict keeps the browser from
//      attaching it to anything initiated by a foreign site. The token itself is random per project (kept in
//      <project>/.orchestra/session, mode 0600, so a restart does not log open tabs out), appears in the
//      terminal output and in the HttpOnly cookie, and is stripped from the URL on exchange.
//   2. DNS rebinding (attacker.example resolving to 127.0.0.1): Host must be exactly a local host:port.
//   3. Another local process or user on a multi-user machine: it cannot read the terminal of this user
//      and, lacking the token, gets 401 from the API (it can still see that the port is open).
//   4. Content injection: agent output is rendered by the frontend; CSP limits damage from any rendering
//      bug to the page itself (no external scripts, no connections elsewhere, no framing).
//   5. Hostile request bodies: every POST field is type- and length-checked here, and seat targets are
//      confined to the project directory via realpath (no '..', no absolute escapes, no symlink escapes).
// Out of scope: a compromised browser extension with host permissions, malware running as the user, and
// the CLIs' own behaviour once they run (that is what read-only-by-default and the per-mode tool lists
// are for).
const crypto = require('crypto');

const TOKEN_BYTES = 24; // 192 bits, base64url -> 32 chars
const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

// Constant-time comparison of two strings. Compares UTF-8 *bytes*: timingSafeEqual throws on buffers of
// different byte length, and a string's UTF-16 length says nothing about that (e.g. 32 x 'é' = 64 bytes).
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a) return false;
  const A = Buffer.from(a, 'utf8'), B = Buffer.from(b, 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// Loads the token persisted for this project (so a restart keeps open tabs and the dev preview valid) or
// creates a new one and stores it with mode 0600. Any unreadable/invalid file is replaced by a fresh token.
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
function loadOrCreateToken(file) {
  const fs = require('fs');
  const path = require('path');
  const t = newToken();
  // A symlink at the session path (a cloned repo can carry one) is never followed: neither read nor written. The
  // token then lives in memory for this process only.
  let linked = false;
  try { linked = fs.lstatSync(file).isSymbolicLink() || fs.lstatSync(path.dirname(file)).isSymbolicLink(); } catch {}
  if (linked) return t;
  try { const cur = fs.readFileSync(file, 'utf8').trim(); if (TOKEN_RE.test(cur)) return cur; } catch {}
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, t + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch {} // unwritable state dir: fall back to a token that lives only as long as this process
  return t;
}

// Cookies are shared across ports on localhost, so the name carries the port to keep boards apart.
const cookieName = (port) => `ob_session_${port}`;
const cookieValue = (header, name) => {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};
// Session cookie (no Max-Age): gone when the browser closes.
const setCookie = (name, value) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict`;

// Headers set on every response. The app ships no inline <script>, but uses inline style="" attributes.
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};
function applyHeaders(res) { for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v); }

// ---------- body validation ----------
class BadRequest extends Error { constructor(m) { super(m); this.status = 400; } }
const bad = (m) => { throw new BadRequest(m); };

const ID = /^[\w-]{1,64}$/;
// Each check returns the normalized value or throws BadRequest. `undefined` passes through unless required.
const v = {
  object(b) { if (!b || typeof b !== 'object' || Array.isArray(b)) bad('JSON object required'); return b; },
  str(x, name, { max = 1000, min = 0, required = false, trim = true } = {}) {
    if (x === undefined || x === null) { if (required || min > 0) bad(`${name} is required`); return undefined; }
    if (typeof x !== 'string') bad(`${name} must be a string`);
    if (x.includes('\0')) bad(`${name} contains a NUL byte`);
    const s = trim ? x.trim() : x;
    if (s.length > max) bad(`${name} is too long (max ${max} characters)`);
    if (s.length < min) bad(min === 1 ? `${name} is required` : `${name} is too short (min ${min})`);
    return s;
  },
  id(x, name, { required = false } = {}) {
    if (x === undefined || x === null || x === '') { if (required) bad(`${name} is required`); return undefined; }
    if (typeof x !== 'string' || !ID.test(x)) bad(`${name} is not a valid id`);
    return x;
  },
  idList(x, name, { max = 20 } = {}) {
    if (x === undefined) return [];
    if (!Array.isArray(x)) bad(`${name} must be an array`);
    if (x.length > max) bad(`${name} has too many entries (max ${max})`);
    return x.map((e, i) => v.id(e, `${name}[${i}]`, { required: true }));
  },
  int(x, name, { min, max, def } = {}) {
    if (x === undefined || x === null || x === '') return def;
    const n = typeof x === 'string' && /^-?\d+$/.test(x.trim()) ? Number(x) : x;
    if (typeof n !== 'number' || !Number.isInteger(n)) bad(`${name} must be an integer`);
    if (n < min || n > max) bad(`${name} must be between ${min} and ${max}`);
    return n;
  },
  num(x, name, { min = -Infinity, max = Infinity, def } = {}) {
    if (x === undefined || x === null || x === '') return def;
    const n = typeof x === 'string' ? Number(x) : x;
    if (typeof n !== 'number' || !Number.isFinite(n)) bad(`${name} must be a number`);
    if (n < min || n > max) bad(`${name} is out of range`);
    return n;
  },
  bool(x, name) {
    if (x === undefined || x === null) return false;
    if (typeof x !== 'boolean') bad(`${name} must be true or false`);
    return x;
  },
  oneOf(x, name, list) {
    if (x === undefined || x === null) return undefined;
    if (!list.includes(x)) bad(`${name} must be one of ${list.join(', ')}`);
    return x;
  },
};

module.exports = { newToken, loadOrCreateToken, tokenEquals, cookieName, cookieValue, setCookie, SECURITY_HEADERS, applyHeaders, BadRequest, v };
