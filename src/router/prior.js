'use strict';
// Router prior and ladders (ROUTER-PLAN.md 3.1, 3.3, 4.1, 4.2, 4.4). Pure: no I/O.
// Every strength is an UNVERIFIED mapping from public evidence (plan 3.2).

const GROUPS = ['security', 'code', 'ui', 'tests-docs'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

// Per-type strengths from plan 3.1, in the order below.
const TYPES = ['plan', 'arch', 'security', 'backend', 'ui', 'tests', 'refactor', 'docs', 'research'];
function types(...v) {
  return Object.fromEntries(TYPES.map((t, i) => [t, v[i]]));
}

// strength: per group (1 to 5). code uses the backend column and tests-docs the lower of
// tests and docs, so a group value is never optimistic. types: the full per-type row.
// cost: relative list cost (Haiku and Luna are 1).
const PRIOR = Object.freeze([
  { model: 'claude-opus-5-5', provider: 'claude', cost: 40,
    strength: { security: 4, code: 5, ui: 5, 'tests-docs': 5 },
    types: types(5, 5, 4, 5, 5, 5, 5, 5, 5),
    source: 'plan 3.1/3.3: CodeRabbit known-bug set 10/13, Terminal-Bench, Code Arena WebDev, list $4/$20' },
  { model: 'claude-sonnet-5-5', provider: 'claude', cost: 20,
    strength: { security: 3, code: 4, ui: 4, 'tests-docs': 3 },
    types: types(4, 3, 3, 4, 4, 3, 4, 5, 4),
    source: 'plan 3.1/3.3: Terminal-Bench 70.6, GDPval-AA, CodeRabbit 6/13, list $2/$10' },
  { model: 'claude-haiku-5-5', provider: 'claude', cost: 1,
    strength: { security: 2, code: 3, ui: 2, 'tests-docs': 2 },
    types: types(2, 2, 2, 3, 2, 2, 2, 3, 3),
    source: 'plan 3.1/3.3: cheap, built for triage; Terminal-Bench 39.2, list $0.10/$0.50' },
  { model: 'gpt-6-astra', provider: 'codex', cost: 100,
    strength: { security: 3, code: 4, ui: 4, 'tests-docs': 3 },
    types: types(4, 4, 3, 4, 4, 3, 4, 3, 4),
    source: 'plan 3.1/3.3: Coding Agent Index 62, Code Arena WebDev 2nd, list $10/$50' },
  { model: 'gpt-6.1-sol', provider: 'codex', cost: 20,
    strength: { security: 2, code: 4, ui: 2, 'tests-docs': 3 },
    types: types(3, 3, 2, 4, 2, 3, 3, 3, 4),
    source: 'plan 3.1/3.3: DeepSWE 75.2, weak on UI and security (refusals), list $2/$10' },
  { model: 'gpt-6-luna', provider: 'codex', cost: 1,
    strength: { security: 2, code: 2, ui: 2, 'tests-docs': 2 },
    types: types(2, 2, 2, 2, 2, 2, 2, 2, 2),
    source: 'plan 3.1/3.3: triage and trivial edits only; Terminal-Bench 16.4, list $0.10/$0.50' },
].map((r) => Object.freeze(r)));

// Rung: { provider, model, effort (null = model default), patch?, proposeOnly? }.
// patch: a Codex builder in a write build returns a diff that the board applies.
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';
const ASTRA = 'gpt-6-astra';
const SOL = 'gpt-6.1-sol';
const LUNA = 'gpt-6-luna';
const cl = (model, effort) => Object.freeze({ provider: 'claude', model, effort });
const cx = (model, effort, extra) => Object.freeze({ provider: 'codex', model, effort, patch: true, ...extra });

// Reviewer rules (plan 4.4): the other provider first, defaults per group and provider.
const REVIEWERS = {
  security: { claude: { model: OPUS, effort: 'high' }, codex: { model: ASTRA, effort: 'xhigh' }, doubleReview: true },
  code: { claude: { model: SONNET, effort: 'high', hardModel: OPUS, hardEffort: 'high' }, codex: { model: SOL, effort: 'high' } },
  ui: { claude: { model: SONNET, effort: 'high', hardModel: OPUS, hardEffort: 'high' }, codex: { model: ASTRA, effort: 'high' } },
  'tests-docs': { claude: { model: SONNET, effort: 'high' }, codex: { model: SOL, effort: 'high' } },
};
const REVIEWER_RULE = 'other provider when not stopped; same provider, different model otherwise (weight 0.5); same model only as last resort (weight 0.25)';

const LADDERS_RAW = {
  security: {
    easy: [cl(OPUS, 'low'), cl(SONNET, 'medium'), cx(ASTRA, 'medium')],
    medium: [cl(OPUS, 'high'), cl(OPUS, 'medium'), cl(SONNET, 'high'), cx(ASTRA, 'xhigh', { proposeOnly: true })],
    hard: [cl(OPUS, 'xhigh'), cl(OPUS, 'high')],
  },
  code: {
    easy: [cl(HAIKU, null), cx(SOL, 'low'), cx(LUNA, 'medium')],
    medium: [cl(SONNET, 'medium'), cx(SOL, 'medium'), cl(HAIKU, null)],
    hard: [cl(OPUS, 'medium'), cl(SONNET, 'high'), cx(SOL, 'xhigh')],
  },
  ui: {
    easy: [cl(HAIKU, null), cl(SONNET, 'low'), cx(SOL, 'medium')],
    medium: [cl(SONNET, 'medium'), cx(ASTRA, 'medium'), cl(OPUS, 'low')],
    hard: [cl(OPUS, 'medium'), cl(SONNET, 'high'), cx(ASTRA, 'xhigh')],
  },
  'tests-docs': {
    easy: [cl(HAIKU, null), cx(SOL, 'low'), cx(LUNA, 'medium')],
    medium: [cl(SONNET, 'medium'), cx(SOL, 'medium'), cl(HAIKU, null)],
    hard: [cl(OPUS, 'medium'), cl(SONNET, 'high')],
  },
};

const LADDERS = {};
for (const g of GROUPS) {
  const entry = { reviewer: Object.freeze({ ...REVIEWERS[g], rule: REVIEWER_RULE }) };
  for (const d of DIFFICULTIES) entry[d] = Object.freeze(LADDERS_RAW[g][d]);
  LADDERS[g] = Object.freeze(entry);
}
Object.freeze(LADDERS);

// Plan 4.1: strength to base value, difficulty and effort adjustments, patch penalty.
const BASE = { 1: 0.15, 2: 0.30, 3: 0.45, 4: 0.60, 5: 0.72 };
const FLOOR = { easy: 0.30, medium: 0.40, hard: 0.50 };
// Plan 4.1 step 3: 0.015 per AA index point above or below the model's medium score.
// AA_DELTA is (AA score at that effort) minus (AA score at medium), in index points.
// Anchors (documented): Opus high +3 (.045), Sonnet high +6 (.09), Astra xhigh +2 (plan 4.2
// check 3: .45 -> .48). Every other entry is UNVERIFIED, set by the conductor: Sol xhigh +2
// (needed for code/hard xhigh in patch mode to reach the .50 floor), low = mirror of the
// upward anchor, Claude xhigh = high (no extra credit). Haiku runs at its default effort and
// Luna only at medium, so they have no entries.
const AA_POINT = 0.015;
const AA_DELTA = {
  'claude-opus-5-5': { low: -3, high: 3, xhigh: 3 },
  'claude-sonnet-5-5': { low: -6, high: 6, xhigh: 6 },
  'gpt-6-astra': { low: -2, xhigh: 2 },
  'gpt-6.1-sol': { low: -2, xhigh: 2 },
};
const PATCH_PENALTY = 0.05;

function priorRow(model) {
  return PRIOR.find((r) => r.model === model) || null;
}

function floorFor(group, difficulty, type) {
  const base = FLOOR[difficulty];
  if (base === undefined) return null;
  return Math.round((base + (group === 'security' || type === 'arch' || type === 'security' ? 0.05 : 0)) * 1000) / 1000;
}

// Prior quality of one rung, or null for an unknown model.
function priorQuality({ model, group, type, difficulty, effort, patch }) {
  const row = priorRow(model);
  if (!row) return null;
  const s = (type && row.types[type]) || row.strength[group];
  if (!s) return null;
  let q = BASE[s];
  if (difficulty === 'easy') q += 0.10;
  else if (difficulty === 'hard') q -= s >= 4 ? 0.08 : 0.18;
  const delta = (AA_DELTA[model] || {})[effort];
  if (typeof delta === 'number') q += AA_POINT * delta;
  if (patch) q -= PATCH_PENALTY;
  return Math.round(q * 1000) / 1000;
}

function has(list, model) {
  return Array.isArray(list) && list.includes(model);
}

/**
 * First available rung of the ladder that clears the quality floor.
 * available: { claude: [models], codex: [models] } (either side may be missing or empty).
 * Optional: type (one of the 9 types; tightens strength and floor), mode ('write' by default
 * or 'propose'; Codex rungs keep the patch penalty only in write mode, and propose-only
 * rungs are skipped in write mode).
 * Returns { held: false, rung, quality, floor, reason, skipped } or
 * { held: true, rung: null, reason, skipped }. Never returns an unavailable model.
 */
function ladderFor({ group, difficulty, available, type, mode } = {}) {
  const ladder = LADDERS[group] && LADDERS[group][difficulty];
  if (!ladder) {
    return { held: true, rung: null, quality: null, floor: null, skipped: [],
      reason: `held: no ladder for group "${group}" difficulty "${difficulty}"` };
  }
  const write = mode !== 'propose';
  const floor = floorFor(group, difficulty, type);
  const skipped = [];
  for (const rung of ladder) {
    const label = `${rung.model} ${rung.effort || 'default'}`;
    if (!has(available && available[rung.provider], rung.model)) {
      skipped.push({ rung: label, cause: 'not available' });
      continue;
    }
    if (rung.proposeOnly && write) {
      skipped.push({ rung: label, cause: 'propose builds only' });
      continue;
    }
    const patch = Boolean(rung.patch && write);
    const quality = priorQuality({ model: rung.model, group, type, difficulty, effort: rung.effort, patch });
    if (quality === null || quality < floor) {
      skipped.push({ rung: label, cause: `below floor (${quality} < ${floor})` });
      continue;
    }
    const via = skipped.length === 0
      ? 'first choice'
      : `fallback after ${skipped.map((x) => x.rung).join(', ')}`;
    return {
      held: false,
      rung: { ...rung, patch },
      quality,
      floor,
      skipped,
      reason: `${label} for ${group}/${difficulty}: quality ${quality} >= floor ${floor}, ${via}${patch ? ', patch mode' : ''}`,
    };
  }
  return {
    held: true,
    rung: null,
    quality: null,
    floor,
    skipped,
    reason: `held: no rung for ${group}/${difficulty} clears floor ${floor}; ${skipped.map((x) => `${x.rung} (${x.cause})`).join('; ')}`,
  };
}

module.exports = { PRIOR, LADDERS, GROUPS, DIFFICULTIES, priorQuality, floorFor, ladderFor };
