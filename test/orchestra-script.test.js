// scripts/orchestra.mjs (the helper behind the Claude Code plugin skill) and the plugin manifests. No board is started
// and no CLI runs: only the usage text, the "nothing running" path and the manifest shape are checked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir, rmrf } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'orchestra.mjs');
const run = (args, cwd) => cp.spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 30000 });

test('orchestra.mjs prints its usage without a command and exits 0', () => {
  const r = run([], ROOT);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: node scripts\/orchestra\.mjs start\|status\|council/);
});

test('orchestra.mjs status reports no board for a folder without one', () => {
  const dir = tmpDir('ob-orch-');
  try {
    const r = run(['status', '--project', dir], ROOT);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No board running for/);
  } finally { rmrf(dir); }
});

test('council and ask refuse an empty question before starting anything', () => {
  for (const c of ['council', 'ask']) {
    const r = run([c], ROOT);
    assert.equal(r.status, 1, c);
    assert.match(r.stderr, /usage:/, c);
  }
});

test('the plugin manifest, the marketplace entry and the skill agree on the name', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(plugin.name, 'agent-orchestra-board');
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, './');
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'orchestra-board', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: orchestra-board\ndescription: /);
  assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/orchestra\.mjs/);
  assert.equal(plugin.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
});
