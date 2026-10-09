// Plan model: validation, canonical hashing, owner areas, topological order and role fallback.
// Pure functions only: no fs, no git, no CLI. The board never names a model or seat here.
const { sha256 } = require('../util');

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const ROLES = ['manager', 'hard', 'medium', 'easy', 'reviewer'];
const ROLE_FALLBACK = {
  manager: ['hard', 'medium', 'easy', 'reviewer'],
  hard: ['medium', 'manager', 'easy', 'reviewer'],
  medium: ['hard', 'easy', 'manager', 'reviewer'],
  easy: ['medium', 'hard', 'manager', 'reviewer'],
  reviewer: ['manager', 'hard', 'medium', 'easy'],
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SEAT_ID_RE = /^[\w-]{1,64}$/;

// JSON with object keys sorted recursively, no whitespace; undefined object values are dropped.
function canonicalJson(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

const planHash = (plan) => sha256(canonicalJson(plan));
const itemHash = (item) => sha256(canonicalJson(item));

// Returns a normalized repo-relative POSIX path, or throws. Dirs and files both allowed; no globs.
function normalizeArea(p) {
  const fail = (why) => { throw new Error(`invalid owner area "${p}": ${why}`); };
  if (typeof p !== 'string' || p.includes('\0')) fail('NUL byte or not a string');
  let s = p.trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!s) fail('empty');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) fail('absolute paths are not allowed');
  if (s.split('/').some((seg) => seg === '..' || seg === '.')) fail('"." and ".." segments are not allowed');
  if (/[*?[\]]/.test(s)) fail('wildcards are not allowed');
  // NTFS strips trailing dots and spaces and treats ':' as an alternate data stream separator,
  // so these spellings alias other names (".git./x" is ".git/x"; "a.js." is "a.js").
  if (s.includes(':')) fail('colons are not allowed (NTFS alternate data streams)');
  if (s.split('/').some((seg) => /[. ]$/.test(seg))) fail('segments ending in a dot or space are not allowed (NTFS aliases)');
  if (s.length > 200) fail('too long');
  const first = s.split('/')[0].toLowerCase();
  if (first === '.git' || first === '.orchestra') fail('.git and .orchestra cannot be owned');
  return s;
}

// Filesystems that alias paths differing only by case (NTFS and default APFS/HFS+).
const caseInsensitiveFs = (platform) => platform === 'win32' || platform === 'darwin';

const within = (f, x) => f === x || f.startsWith(x + '/');

// Case-sensitive; two areas overlap when equal or one is a directory prefix of the other. On win32 and darwin
// (platform is injectable) areas that differ only by case alias the same path, so they overlap too.
function areasOverlap(a, b, { platform = process.platform } = {}) {
  let x = String(a);
  let y = String(b);
  if (caseInsensitiveFs(platform)) { x = x.toLowerCase(); y = y.toLowerCase(); }
  return within(x, y) || within(y, x);
}

// True when the file (normalized first) equals one of the areas or lies inside one. Always case-sensitive.
function pathInAreas(file, areas) {
  let f;
  try { f = normalizeArea(file); } catch { return false; }
  return areas.some((a) => within(f, String(a)));
}

// True on win32/darwin when the file lies in an area only when case is ignored (so it aliases an owned path but is
// spelled differently). A caller refuses such a patch path. Always false elsewhere and for invalid files.
function pathCaseConflict(file, areas, { platform = process.platform } = {}) {
  if (!caseInsensitiveFs(platform)) return false;
  let f;
  try { f = normalizeArea(file); } catch { return false; }
  const lf = f.toLowerCase();
  return areas.some((a) => !within(f, String(a)) && within(lf, String(a).toLowerCase()));
}

// Returns the cycle as ids, closing with the first id repeated, or null when there is none.
function findCycle(items) {
  const deps = new Map(items.map((it) => [it.id, it.dependsOn || []]));
  const remaining = new Set(items.map((it) => it.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...remaining]) {
      if (deps.get(id).every((d) => !remaining.has(d))) { remaining.delete(id); changed = true; }
    }
  }
  if (!remaining.size) return null;
  let cur = items.map((it) => it.id).find((id) => remaining.has(id));
  const path = [];
  const pos = new Map();
  while (!pos.has(cur)) {
    pos.set(cur, path.length);
    path.push(cur);
    cur = deps.get(cur).find((d) => remaining.has(d));
  }
  return [...path.slice(pos.get(cur)), cur];
}

// Validates a raw plan and returns the normalized plan. Throws Error with a user-facing message.
// opts.source: 'owner' (default; a plan the user wrote, edited or approved) or 'manager' (a model-written plan).
// Acceptance checks are shell commands, so they are OFF by default: a manager's checks (and any check of a plan the
// owner marked checksEnabled:false) are kept only as proposedChecks, which nothing runs. Only the owner path keeps
// `checks`, the field a build runs. checksEnabled is true exactly when some item carries live checks, and the plan
// hash covers the checks, the proposals and the flag.
function validatePlan(raw, { source = 'owner' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plan must be an object');
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
  if (!goal || goal.length > 8000) throw new Error('plan.goal is required (max 8000 characters)');
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 30) {
    throw new Error('plan.items must be a list of 1-30 items');
  }

  const items = [];
  const seen = new Set();
  raw.items.forEach((it, i) => {
    const src = it && typeof it === 'object' ? it : {};
    const id = typeof src.id === 'string' ? src.id.trim() : '';
    if (!ID_RE.test(id)) throw new Error(`item ${i + 1}: id must match ^[a-z0-9][a-z0-9-]{0,31}$`);
    if (seen.has(id)) throw new Error(`duplicate item id "${id}"`);
    seen.add(id);

    const title = typeof src.title === 'string' ? src.title.trim() : '';
    if (!title || title.length > 120) throw new Error(`item "${id}": title is required (max 120 characters)`);
    const spec = typeof src.spec === 'string' ? src.spec.trim() : '';
    if (!spec || spec.length > 4000) throw new Error(`item "${id}": spec is required (max 4000 characters)`);

    if (!Array.isArray(src.owns)) throw new Error(`item "${id}": owns must list 1-20 paths`);
    const owns = [...new Set(src.owns.map(normalizeArea))];
    if (owns.length < 1 || owns.length > 20) throw new Error(`item "${id}": owns must list 1-20 paths`);

    const rawDeps = src.dependsOn === undefined || src.dependsOn === null ? [] : src.dependsOn;
    if (!Array.isArray(rawDeps) || rawDeps.some((d) => typeof d !== 'string')) {
      throw new Error(`item "${id}": dependsOn must be a list of item ids`);
    }
    const dependsOn = rawDeps.map((d) => d.trim());

    const difficulty = typeof src.difficulty === 'string' ? src.difficulty.trim() : '';
    if (!DIFFICULTIES.includes(difficulty)) throw new Error(`item "${id}": difficulty must be easy, medium or hard`);

    let seatId = src.seatId === undefined || src.seatId === null ? '' : src.seatId;
    if (typeof seatId !== 'string') throw new Error(`item "${id}": seatId is not a valid id`);
    seatId = seatId.trim();
    if (seatId === '') seatId = null;
    else if (!SEAT_ID_RE.test(seatId)) throw new Error(`item "${id}": seatId is not a valid id`);

    // Optional acceptance checks: commands run in the item worktree after the freeze, before any review. Live only on the
    // owner path (see validatePlan); a manager's checks become proposedChecks, which are listed but never run.
    const parseChecks = (field) => {
      const list = src[field] === undefined || src[field] === null ? [] : src[field];
      if (!Array.isArray(list) || list.length > 5) throw new Error(`item "${id}": ${field} must be a list of at most 5 { name, cmd }`);
      return list.map((c, n) => {
        const name = c && typeof c.name === 'string' ? c.name.trim() : '';
        const cmd = c && typeof c.cmd === 'string' ? c.cmd.trim() : '';
        if (!name || name.length > 60) throw new Error(`item "${id}": check ${n + 1} needs a name (max 60 characters)`);
        if (!cmd || cmd.length > 500 || cmd.includes(String.fromCharCode(0))) throw new Error(`item "${id}": check "${name}" needs a cmd string (max 500 characters)`);
        return { name, cmd };
      });
    };
    const asked = parseChecks('checks');
    const proposed = parseChecks('proposedChecks');
    const live = source === 'owner' && raw.checksEnabled !== false;
    const liveChecks = live ? asked : [];
    const proposedChecks = live ? proposed : [...proposed, ...asked];
    if (proposedChecks.length > 5) throw new Error(`item "${id}": at most 5 checks`);

    const item = { id, title, spec, owns, dependsOn, difficulty, seatId };
    if (liveChecks.length) item.checks = liveChecks;
    if (proposedChecks.length) item.proposedChecks = proposedChecks;
    items.push(item);
  });

  const ids = new Set(items.map((it) => it.id));
  for (const it of items) {
    for (const d of it.dependsOn) {
      if (d === it.id) throw new Error(`item "${it.id}" depends on itself`);
      if (!ids.has(d)) throw new Error(`item "${it.id}" depends on unknown item "${d}"`);
    }
  }

  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      for (const areaA of items[a].owns) {
        for (const areaB of items[b].owns) {
          if (areasOverlap(areaA, areaB)) {
            throw new Error(`items "${items[a].id}" and "${items[b].id}" overlap on "${areaA}"`);
          }
        }
      }
    }
  }

  const cycle = findCycle(items);
  if (cycle) throw new Error(`dependency cycle: ${cycle.join(' -> ')}`);

  const plan = { goal, items };
  if (items.some((it) => it.checks)) plan.checksEnabled = true;
  return plan;
}

// Kahn's algorithm; among ready items the earliest in the original list goes first.
function topoOrder(items) {
  const done = new Set();
  const out = [];
  while (out.length < items.length) {
    const next = items.find((it) => !done.has(it.id) && (it.dependsOn || []).every((d) => done.has(d)));
    if (!next) throw new Error('dependency cycle among items');
    done.add(next.id);
    out.push(next.id);
  }
  return out;
}

// Assigns an agent to every role. Unassigned roles take the first assigned role in ROLE_FALLBACK.
function resolveRoles(roles, seatExists) {
  if (roles === undefined || roles === null) roles = {};
  if (typeof roles !== 'object' || Array.isArray(roles)) throw new Error('roles must be an object');
  const assigned = {};
  for (const k of Object.keys(roles)) {
    if (!ROLES.includes(k)) throw new Error(`unknown role "${k}"`);
    const v = roles[k];
    if (v === '' || v === null || v === undefined) continue;
    if (typeof v !== 'string' || !SEAT_ID_RE.test(v) || !seatExists(v)) throw new Error(`role "${k}": no such agent`);
    assigned[k] = v;
  }
  if (!Object.keys(assigned).length) throw new Error('assign an agent to at least one role');

  const resolved = {};
  const notes = [];
  for (const r of ROLES) {
    if (assigned[r]) { resolved[r] = assigned[r]; continue; }
    const src = ROLE_FALLBACK[r].find((s) => assigned[s]);
    resolved[r] = assigned[src];
    notes.push(`${r} uses the ${src} agent`);
  }
  return { resolved, notes };
}

// The item's own seat wins when it exists; otherwise the agent for its difficulty.
function seatForItem(item, resolved, seatExists) {
  return item.seatId && seatExists(item.seatId) ? item.seatId : resolved[item.difficulty];
}

// Reviewer: first of reviewer, manager, hard, medium, easy that differs from the builder; else self-review.
function reviewerFor(builderId, resolved) {
  for (const r of ['reviewer', 'manager', 'hard', 'medium', 'easy']) {
    const id = resolved[r];
    if (id && id !== builderId) return { reviewerId: id, self: false };
  }
  return { reviewerId: builderId, self: true };
}

// Pulls a JSON object out of a model reply: a fenced block first, else the outermost braces.
function extractJson(text) {
  const s = String(text ?? '');
  const fence = s.match(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/i);
  let candidate;
  if (fence) {
    candidate = fence[1].trim();
  } else {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('no JSON object found in the reply');
    candidate = s.slice(start, end + 1);
  }
  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new Error('the reply is not valid JSON: ' + e.message);
  }
}

const PLAN_FORMAT = `Reply with ONE JSON object and nothing else, in this shape:
{
  "goal": "one paragraph restating the goal",
  "items": [
    {
      "id": "parse-config",
      "title": "Parse the config file (max 120 characters)",
      "spec": "What to build, precise enough to implement without questions (max 4000 characters)",
      "owns": ["src/config.js", "test/config.test.js"],
      "dependsOn": [],
      "difficulty": "easy",
      "seatId": null,
      "checks": [{ "name": "unit tests", "cmd": "node --test test/config.test.js" }]
    }
  ]
}

Rules:
- Use 1 to 30 items. Item ids are lowercase, match ^[a-z0-9][a-z0-9-]{0,31}$ and are unique.
- owns: 1 to 20 repo-relative POSIX paths (directories or files). No globs, no "..", never .git or .orchestra. Owner areas of different items must not overlap.
- dependsOn: list another item only when this item needs that item's code. Never create cycles.
- difficulty: easy = mechanical, one or two files, a clear spec. medium = several files or some judgement. hard = cross-cutting, security, concurrency or tricky algorithms.
- seatId: leave null.
- checks: optional proposals, at most 5 { name, cmd } per item. cmd is one shell command that must pass offline and exit 0. They are OFF: nothing runs unless the owner reads every command and turns checks on for this plan.
- Do not name agents or models anywhere in the plan. The board assigns agents by difficulty.
`;

module.exports = {
  DIFFICULTIES,
  ROLES,
  ROLE_FALLBACK,
  canonicalJson,
  planHash,
  itemHash,
  normalizeArea,
  areasOverlap,
  pathInAreas,
  pathCaseConflict,
  validatePlan,
  topoOrder,
  resolveRoles,
  seatForItem,
  reviewerFor,
  extractJson,
  PLAN_FORMAT,
};
