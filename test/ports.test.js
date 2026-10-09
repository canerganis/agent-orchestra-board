// Two in-process boards started in one process get different OS assigned ports, each with its own session cookie.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, startApp, teardown } = require('./helpers');

test('two startApp calls get different OS assigned ports and port-bound cookies', async () => {
  process.env.ORCHESTRA_CLAUDE_BIN = 'fake-claude-not-installed';
  process.env.ORCHESTRA_CODEX_BIN = 'fake-codex-not-installed';
  const d1 = tmpDir('ob-ports-'), d2 = tmpDir('ob-ports-');
  let a, b;
  try {
    a = await startApp({ projectDir: d1 });
    b = await startApp({ projectDir: d2 });
    assert.ok(a.port > 0 && b.port > 0);
    assert.notEqual(a.port, b.port);
    assert.match(a.cookie, new RegExp(`^ob_session_${a.port}=`));
    assert.match(b.info.url, new RegExp(`^http://localhost:${b.port}/`));
    assert.equal((await a.get('/api/state')).status, 200);
    assert.equal((await b.get('/api/state')).status, 200);
  } finally { await teardown(a, d1); await teardown(b, d2); }
});
