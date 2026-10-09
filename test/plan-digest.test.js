// The handoff from a debate or a Council to the plan manager stays short: the synthesis (capped) when there is one,
// otherwise only the last few agent notes. A long handoff would rebuild the context the scout brief saved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { debateDigest, SYNTHESIS_CHARS } = require('../src/workflows/plan');

const msg = (id, name, text, seatId = name.toLowerCase()) => ({ id, name, seatId, text });

test('the synthesis is the whole handoff, and a long one is capped', () => {
  const room = { resultId: 's', messages: [msg('a', 'Claude', 'x'.repeat(5000)), msg('s', 'Sol', 'y'.repeat(SYNTHESIS_CHARS + 2000))] };
  const d = debateDigest(room);
  assert.ok(d.startsWith('Debate synthesis:\n'));
  assert.ok(!d.includes('x'), 'no agent message rides along with the synthesis');
  assert.ok(d.length < SYNTHESIS_CHARS + 100);
  assert.match(d, /synthesis truncated/);
});

test('without a synthesis only the last four notes go, each clipped to 800 characters', () => {
  const messages = [msg('u', 'You', 'question', 'user')];
  for (let i = 0; i < 10; i++) messages.push(msg(`m${i}`, `Agent${i}`, `${i}`.repeat(2000)));
  const d = debateDigest({ messages });
  assert.ok(d.startsWith('Debate notes:\n'));
  assert.equal((d.match(/^Agent\d: /gm) || []).length, 4);
  assert.ok(!d.includes('Agent5:'), 'older notes are left out');
  assert.ok(d.length < 4 * 820 + 40);
});
