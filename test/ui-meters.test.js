// P1: the header meters repaint on their own when a reading goes stale (public/app.js in the VM harness).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, json } = require('./ui-harness');

const quiet = async () => json({ checks: [] });

test('tickTimers repaints the meters when a window passes its reset', async () => {
  const { app, ctx } = boot(quiet, { expose: ['paintMeters', 'tickTimers'] });
  const meters = ctx.document.querySelector('#meters');
  ctx.document.querySelector = (sel) => (sel === '#meters' ? meters : ctx.document.body);
  const now = Date.now();
  app.S.limits = { claude: { updated: now, observed: { five_hour: now }, windows: { five_hour: { pct: 92, resetsAt: now + 150 } } } };
  app.paintMeters();
  assert.match(meters.innerHTML, /92%/);
  assert.doesNotMatch(meters.innerHTML, /old/);
  app.tickTimers();
  assert.doesNotMatch(meters.innerHTML, /old/);
  await new Promise((r) => setTimeout(r, 200));
  app.tickTimers();
  assert.match(meters.innerHTML, /92%, 0 min old/);
  assert.match(meters.innerHTML, /stale/);
});

test('tickTimers repaints once a reading is older than 30 minutes', () => {
  const { app, ctx } = boot(quiet, { expose: ['paintMeters', 'tickTimers'] });
  const meters = ctx.document.querySelector('#meters');
  ctx.document.querySelector = (sel) => (sel === '#meters' ? meters : ctx.document.body);
  const l = { updated: Date.now(), observed: { five_hour: Date.now() - 29 * 60e3 }, windows: { five_hour: { pct: 40, resetsAt: Date.now() + 3600e3 } } };
  app.S.limits = { claude: l };
  app.paintMeters();
  assert.doesNotMatch(meters.innerHTML, /min old/);
  l.observed.five_hour = Date.now() - 31 * 60e3;
  app.tickTimers();
  assert.match(meters.innerHTML, /40%, 31 min old/);
});
