'use strict';
// Router profiles and shadow score (ROUTER-PLAN.md 3.5, 4.6). Pure: no I/O.
// Every constant here is UNVERIFIED until real ledger data confirms it.

const { GROUPS } = require('./classify');

const MIN_SAMPLE = 3; // UNVERIFIED: below this a cell is still just the prior (3.5 rule 6)
const PRIOR_WEIGHT = 4; // UNVERIFIED: prior counts as this many pseudo observations (3.5 rule 5)
const CONFIDENT_N = 8; // UNVERIFIED: observations needed before a score is called confident

function groupOf(obs) {
  if (obs && obs.group) return obs.group;
  return (obs && GROUPS[obs.taskType]) || 'code';
}

// A failure on the board's side says nothing about the model (3.5 rule 3).
function isBoardFailure(obs) {
  return !!obs && obs.outcome === 'error' && obs.reason === 'board';
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function updateProfile(profile, obs) {
  const base = profile || {};
  if (!obs || !obs.model || isBoardFailure(obs)) return base;
  const group = groupOf(obs);
  const old = (base[obs.model] && base[obs.model][group]) || { n: 0, firstPass: 0, fixes: 0, tokens: 0, ms: 0 };
  const attempt = Number.isFinite(obs.attempt) && obs.attempt >= 1 ? obs.attempt : 1;
  const cell = {
    n: old.n + 1,
    firstPass: old.firstPass + (obs.outcome === 'pass' && attempt === 1 ? 1 : 0),
    fixes: old.fixes + Math.max(0, attempt - 1),
    tokens: old.tokens + num(obs.tokens),
    ms: old.ms + num(obs.ms),
  };
  return { ...base, [obs.model]: { ...base[obs.model], [group]: cell } };
}

function shadowScore(profile, model, group, prior) {
  const cell = profile && profile[model] && profile[model][group];
  const n = cell ? cell.n : 0;
  if (n < MIN_SAMPLE) return { score: prior, n, confident: false };
  const score = Math.round(((PRIOR_WEIGHT * prior + cell.firstPass) / (PRIOR_WEIGHT + n)) * 1000) / 1000;
  return { score, n, confident: n >= CONFIDENT_N };
}

module.exports = { updateProfile, shadowScore, MIN_SAMPLE, PRIOR_WEIGHT, CONFIDENT_N };
