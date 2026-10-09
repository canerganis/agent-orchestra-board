const test = require('node:test');
const assert = require('node:assert/strict');
const { PRIOR, LADDERS, GROUPS, DIFFICULTIES, priorQuality, floorFor, ladderFor } = require('../src/router/prior');

const CLAUDE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const CODEX = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'];
const BOTH = { claude: CLAUDE, codex: CODEX };

test('PRIOR has strength, cost and source for every model and group', () => {
  assert.equal(PRIOR.length, 6);
  for (const row of PRIOR) {
    assert.ok(row.source.length > 0);
    assert.ok(row.cost >= 1);
    for (const g of GROUPS) assert.ok(row.strength[g] >= 1 && row.strength[g] <= 5);
  }
});

test('every group and difficulty has a ladder and a reviewer rule', () => {
  for (const g of GROUPS) {
    assert.ok(LADDERS[g].reviewer.claude && LADDERS[g].reviewer.codex);
    for (const d of DIFFICULTIES) assert.ok(LADDERS[g][d].length >= 2);
  }
});

test('both providers: first rung is chosen', () => {
  const r = ladderFor({ group: 'code', difficulty: 'medium', available: BOTH });
  assert.equal(r.rung.model, 'claude-sonnet-5-5');
  assert.equal(r.rung.effort, 'medium');
  assert.match(r.reason, /first choice/);
});

test('Claude only: never returns a Codex model', () => {
  for (const g of GROUPS) {
    for (const d of DIFFICULTIES) {
      const r = ladderFor({ group: g, difficulty: d, available: { claude: CLAUDE } });
      if (!r.held) assert.equal(r.rung.provider, 'claude');
    }
  }
  const r = ladderFor({ group: 'ui', difficulty: 'medium', available: { claude: CLAUDE, codex: [] } });
  assert.equal(r.rung.model, 'claude-sonnet-5-5');
});

test('Codex only: falls to Codex rungs, in patch mode for write builds', () => {
  const r = ladderFor({ group: 'code', difficulty: 'medium', available: { codex: CODEX } });
  assert.equal(r.rung.model, 'gpt-6.1-sol');
  assert.equal(r.rung.patch, true);
  assert.match(r.reason, /patch mode/);
  assert.match(r.reason, /fallback after/);
  for (const g of GROUPS) {
    for (const d of DIFFICULTIES) {
      const x = ladderFor({ group: g, difficulty: d, available: { codex: CODEX } });
      if (!x.held) assert.equal(x.rung.provider, 'codex');
    }
  }
});

test('never returns a model that is not available', () => {
  const available = { claude: ['claude-sonnet-5-5'], codex: ['gpt-6-luna'] };
  for (const g of GROUPS) {
    for (const d of DIFFICULTIES) {
      const r = ladderFor({ group: g, difficulty: d, available });
      if (!r.held) assert.ok(available[r.rung.provider].includes(r.rung.model));
    }
  }
});

test('hard security keeps the floor: only Opus qualifies', () => {
  assert.equal(floorFor('security', 'hard'), 0.55);
  assert.equal(ladderFor({ group: 'security', difficulty: 'hard', available: BOTH }).rung.model, 'claude-opus-5-5');
  const noOpus = { claude: ['claude-sonnet-5-5', 'claude-haiku-5-5'], codex: CODEX };
  const r = ladderFor({ group: 'security', difficulty: 'hard', available: noOpus });
  assert.equal(r.held, true);
  assert.equal(r.rung, null);
  assert.match(r.reason, /^held/);
  assert.equal(ladderFor({ group: 'security', difficulty: 'hard', available: { codex: CODEX } }).held, true);
});

test('floor uses the item type: arch/hard leaves only Opus', () => {
  const noOpus = { claude: ['claude-sonnet-5-5'], codex: CODEX };
  assert.equal(ladderFor({ group: 'code', difficulty: 'hard', type: 'arch', available: noOpus }).held, true);
  assert.equal(ladderFor({ group: 'code', difficulty: 'hard', type: 'arch', available: BOTH }).rung.model, 'claude-opus-5-5');
});

test('Astra xhigh on security/medium runs only in propose builds', () => {
  const only = { codex: ['gpt-6-astra'] };
  assert.equal(ladderFor({ group: 'security', difficulty: 'medium', available: only }).held, true);
  const p = ladderFor({ group: 'security', difficulty: 'medium', available: only, mode: 'propose' });
  assert.equal(p.rung.model, 'gpt-6-astra');
  assert.equal(p.rung.patch, false);
});

test('priorQuality follows plan 4.1 arithmetic', () => {
  const q = (o) => priorQuality({ group: 'code', ...o });
  assert.equal(q({ model: 'claude-opus-5-5', difficulty: 'medium', effort: 'medium' }), 0.72);
  assert.equal(q({ model: 'claude-opus-5-5', difficulty: 'hard', effort: 'high' }), 0.685);
  assert.equal(q({ model: 'claude-haiku-5-5', difficulty: 'easy' }), 0.55);
  assert.equal(q({ model: 'gpt-6.1-sol', difficulty: 'medium', effort: 'medium', patch: true }), 0.55);
  assert.equal(q({ model: 'nope', difficulty: 'easy' }), null);
});

test('effort adjustment is 0.015 per AA point (plan 4.1, 4.2)', () => {
  const sec = (o) => priorQuality({ group: 'security', type: 'security', model: 'gpt-6-astra', difficulty: 'medium', ...o });
  assert.equal(sec({ effort: 'xhigh' }), 0.48);
  assert.equal(sec({ effort: 'xhigh', patch: true }), 0.43);
  assert.equal(sec({ effort: 'medium' }), 0.45);
});

test('low and xhigh effort deltas follow plan 4.1/4.2', () => {
  const q = (o) => priorQuality(o);
  // Astra security/medium xhigh: .48 propose, .43 patch (below the .45 floor, so skipped).
  assert.equal(q({ group: 'security', type: 'security', model: 'gpt-6-astra', difficulty: 'medium', effort: 'xhigh' }), 0.48);
  assert.equal(q({ group: 'security', type: 'security', model: 'gpt-6-astra', difficulty: 'medium', effort: 'xhigh', patch: true }), 0.43);
  assert.ok(0.43 < floorFor('security', 'medium', 'security'));
  // Low effort is negative: Opus security/easy low, strength 4: .60 + .10 - .045.
  assert.equal(q({ group: 'security', model: 'claude-opus-5-5', difficulty: 'easy', effort: 'low' }), 0.655);
  // Sol code/hard xhigh in patch mode: .60 - .08 + .03 - .05, clears the .50 floor.
  assert.equal(q({ group: 'code', model: 'gpt-6.1-sol', difficulty: 'hard', effort: 'xhigh', patch: true }), 0.5);
  assert.ok(0.5 >= floorFor('code', 'hard'));
  // Sonnet ui/easy low: .60 + .10 - .09.
  assert.equal(q({ group: 'ui', model: 'claude-sonnet-5-5', difficulty: 'easy', effort: 'low' }), 0.61);
});

test('unknown group or difficulty is held, not thrown', () => {
  assert.equal(ladderFor({ group: 'x', difficulty: 'easy', available: BOTH }).held, true);
  assert.equal(ladderFor({}).held, true);
});
