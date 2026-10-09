// Prompt packets: a byte-identical stable prefix across items, and delta-only patches for later review rounds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPacket, stablePrefix, diffSincePrevious, ITEM_MARK } = require('../src/context');

const stable = { rules: 'RULES', plan: 'Plan goal: ship it', brief: 'BRIEF text' };

test('two items share a byte-identical prefix covering the whole stable part, in a fixed order', () => {
  const a = buildPacket({ stable, item: 'Build item "a": first' });
  const b = buildPacket({ stable, item: 'Build item "b": second', feedback: 'fix it' });
  const prefix = stablePrefix(stable);
  assert.equal(prefix, 'RULES\n\nPlan goal: ship it\n\nBRIEF text\n\n' + ITEM_MARK);
  assert.ok(a.startsWith(prefix) && b.startsWith(prefix));
  assert.ok(!prefix.includes('"a"') && !prefix.includes('"b"'), 'no item id in the prefix');
  // key order in the input object does not change the output
  assert.equal(buildPacket({ stable: { brief: 'BRIEF text', plan: 'Plan goal: ship it', rules: 'RULES' }, item: 'x' }), buildPacket({ stable, item: 'x' }));
  assert.ok(a.indexOf('Build item "a"') > prefix.length - 1);
  assert.ok(b.endsWith('fix it'));
});

test('an empty stable part adds no marker', () => {
  assert.equal(buildPacket({ item: 'just the item', feedback: 'fb' }), 'just the item\n\nfb');
});

const file = (name, hunks) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${hunks.join('')}`;
const h = (n) => `@@ -${n},1 +${n},1 @@\n-old${n}\n+new${n}\n`;

test('diffSincePrevious keeps new files and changed hunks only, and names dropped files', () => {
  const prev = file('a.js', [h(1), h(10)]) + file('gone.js', [h(1)]);
  const cur = file('a.js', [h(1), h(10), h(20)]) + file('b.js', [h(1)]);
  const d = diffSincePrevious(prev, cur);
  assert.ok(d.includes('@@ -20,1 +20,1 @@') && d.includes('diff --git a/b.js b/b.js'));
  assert.ok(!d.includes('@@ -10,1'), 'an unchanged hunk is not repeated');
  assert.ok(d.includes('no longer in the change: a/gone.js b/gone.js'));
  assert.equal(diffSincePrevious(cur, cur), '');
});

const { stripDiffBlocks, textSincePrevious } = require('../src/context');

test('stripDiffBlocks drops a fenced diff block but keeps the prose around it', () => {
  const diff = file('a.js', [h(1)]);
  const reply = `Changed a.js.\n\n\`\`\`diff\n${diff}\`\`\`\n`;
  const out = stripDiffBlocks(reply);
  assert.ok(out.startsWith('Changed a.js.') && !out.includes('@@') && !out.includes('diff --git'));
  assert.ok(out.length < reply.length);
  assert.equal(stripDiffBlocks('no diff here'), 'no diff here');
});

test('textSincePrevious keeps only new lines, and is null when the delta would not be shorter', () => {
  const prev = 'Plan:\n' + Array.from({ length: 40 }, (_, i) => `step ${i} does a long described thing`).join('\n');
  const cur = prev + '\nstep 40 is new';
  const d = textSincePrevious(prev, cur);
  assert.ok(d.includes('step 40 is new') && !d.includes('step 3 does'));
  assert.ok(d.length < cur.length / 4, 'the delta is a small fraction of the full output');
  assert.equal(textSincePrevious('a', 'completely different text'), null);
});

test('textSincePrevious keeps deleted lines, reordering and indentation changes', () => {
  const pad = Array.from({ length: 30 }, (_, i) => `step ${i} does a long described thing`);
  const prev = ['Plan:', ...pad, 'last step'].join('\n');
  // a removed step is shown, not "(nothing new)"
  const removed = textSincePrevious(prev, prev.replace('step 7 does a long described thing\n', ''));
  assert.ok(removed.includes('- step 7 does a long described thing') && !removed.includes('(nothing new)'));
  // a reordering shows up as a removal plus an addition
  const swapped = pad.slice(); [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  const re = textSincePrevious(prev, ['Plan:', ...swapped, 'last step'].join('\n'));
  assert.ok(re.includes('+ step 4 does') && re.includes('- step 4 does'));
  // an indentation change inside a code block is a change
  const code = ['```js', 'if (x) {', '  a();', '}', '```', ...pad].join('\n');
  const ind = textSincePrevious(code, code.replace('  a();', '    a();'));
  assert.ok(ind.includes('-   a();') && ind.includes('+     a();'));
  // line endings and trailing spaces alone are not changes
  const same = textSincePrevious(prev, prev.replace(/\n/g, '  \r\n'));
  assert.ok(same === null || !/^[+-] /m.test(same));
});
