// U3: Start build (the engine choice, the board team's options, the handoff form and its paste prompt), the plan card's
// "Before you build" and the patch export of a propose item (public/app.js in the VM harness). Layout and focus are checked
// by hand in a browser. The dialog is driven through a stub page whose selectors answer the same element each time.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { el, boot, json, flush, hasDash } = require('./ui-harness');

// Names the tests reach (opts.expose). app.js defines them; the shared harness list does not carry them.
const EXPOSE = ['engineList', 'defaultEngine', 'seatFor', 'codexOffText', 'codexStateText', 'engineSegHtml', 'boardSummaryInner',
  'boardPanelHtml', 'handoffFormHtml', 'handedHtml', 'boardStartBody', 'handoffStartBody', 'newBuildDraft', 'buildDialogHtml',
  'openBuild', 'refreshBuildEngines', 'preflightHtml', 'loadPreflight', 'renderPlanCard', 'exportHtml', 'itemRowHtml',
  'HANDOFF_TIERS', 'roleOptionsHtml'];

const PLAN_HASH = 'a'.repeat(64);
const PLAN = { id: 'p1', kind: 'plan', title: 'CSV export', status: 'approved', created: '2026-10-08T10:00:00Z', planRevision: 2,
  planHash: PLAN_HASH, managerId: 'sol', messages: [],
  plan: { goal: 'Add CSV export', items: [
    { id: 'i1', title: 'Parser', spec: 'parse', owns: ['src/csv.js'], dependsOn: [], difficulty: 'easy' },
    { id: 'i2', title: 'Route', spec: 'route', owns: ['src/route.js'], dependsOn: ['i1'], difficulty: 'medium' },
  ] } };
const seats = [
  { id: 'claude1', name: 'Claude', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', status: 'idle' },
  { id: 'luna', name: 'Luna', agent: 'codex', model: 'gpt-6-luna', effort: 'medium', status: 'idle' },
  { id: 'sol', name: 'Sol', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', status: 'idle' },
];
const CODEX_OFF = 'off on Windows: the board runs Codex with the unelevated Windows sandbox. Codex seats can still read, review and propose.';
const CAP_OFF = { writes: 'unavailable', reason: 'no repository', agents: {
  claude: { available: false, reason: 'the write check has not been run' },
  codex: { available: false, reason: CODEX_OFF } } };
const PF_OK = { git: { ok: true, reason: null }, clean: true, dirtyCount: 0,
  writes: { claude: { available: true, reason: null }, codex: { available: false, reason: CODEX_OFF } } };

// The visible text of some HTML: tags removed, spaces collapsed.
const visible = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const quiet = async () => json({ checks: [] });
// A plain copy of a value made inside the VM (deepStrictEqual compares realms strictly).
const plain = (v) => JSON.parse(JSON.stringify(v));
// One EngineInfo, as src/engines/index.js sends it, with the parts a test changes.
const LABEL = { board: 'Board team', 'claude-code': 'Claude Code, you run it', codex: 'Codex, you run it' };
const info = (id, over = {}) => ({ id, label: LABEL[id], launch: id === 'board' ? 'board' : 'handoff', available: true, hidden: false,
  reason: null, note: null, modes: id === 'board' ? ['write', 'propose'] : [], ...over });
// The button of one engine in a segmented choice, as a tag (for its disabled attribute).
const engineBtn = (html, id) => (html.match(new RegExp(`<button[^>]*data-engine="${id}"[^>]*>`)) || [''])[0];
function setup(app, seatList = seats) {
  app.S.seats = Object.fromEntries(seatList.map((s) => [s.id, { ...s }]));
  app.S.order = seatList.map((s) => s.id);
}

// A stub page: every selector answers the same element on each call, and lists answer what the test set for them.
function scope() {
  const kids = {}, lists = {};
  const node = el();
  node.querySelector = (sel) => (kids[sel] ||= el());
  node.querySelectorAll = (sel) => lists[sel] || [];
  node.kids = kids; node.lists = lists;
  return node;
}
function page(ctx) {
  const doc = scope();
  ctx.document.querySelector = (sel) => doc.querySelector(sel);
  doc.kids['#overlay .modal'] = scope();
  return { doc, box: doc.kids['#overlay .modal'] };
}
// A button or input of the stub page: a dataset, a value and the handler slots the app binds.
const control = (dataset, value = '') => Object.assign(el(), { dataset, value });

test('engine choice: the board team is the default, and an engine the server hides is not offered', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  app.S.engines = [info('board'), info('claude-code'), info('codex', { hidden: true, available: false, reason: 'Codex is not installed' })];
  const list = app.engineList();
  assert.deepEqual([...list.map((e) => e.id)], ['board', 'claude-code']);
  assert.equal(app.defaultEngine(list), 'board');
  const html = app.engineSegHtml(list, 'board');
  assert.match(html, /aria-checked="true" data-engine="board"/, 'the board team is the checked choice');
  assert.match(visible(html), /Board team Claude Code, you run it/);
  assert.ok(!visible(html).includes('Codex, you run it'), 'a hidden engine is not offered');
});

test('a missing CLI: its engine stays only when its data folder is shown, and its note says what to do', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const note = 'Codex CLI is not on PATH. Run it from wherever it is installed.';
  app.S.engines = [info('board'), info('claude-code'), info('codex', { hidden: false, available: true, note })];
  assert.ok(app.engineList().some((e) => e.id === 'codex'), 'the Codex data folder exists, so the engine is shown');
  assert.match(visible(app.engineSegHtml(app.engineList(), 'board')), /Codex, you run it/);
  assert.match(visible(app.handoffFormHtml(PLAN, 'codex', app.HANDOFF_TIERS.codex)), new RegExp(note.replace(/[.()]/g, '\\$&')));
  app.S.engines = [info('board'), info('claude-code')];
  assert.ok(!app.engineList().some((e) => e.id === 'codex'), 'without a folder the engine is not offered');
});

test('a broken CLI disables its engine and gives the reason as visible text, and the next engine becomes the default', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const reason = 'Claude Code CLI cannot be started by the board: only a claude.cmd shim was found';
  app.S.engines = [info('board', { available: false, reason, modes: [] }),
    info('claude-code', { note: 'Claude Code CLI cannot be started by the board. You can still run it yourself.' }),
    info('codex', { hidden: true, available: false })];
  const list = app.engineList();
  const html = app.engineSegHtml(list, app.defaultEngine(list));
  assert.match(engineBtn(html, 'board'), / disabled>/, 'the board team button is disabled');
  assert.ok(!/ disabled/.test(engineBtn(html, 'claude-code')), 'the handoff engine stays usable');
  assert.ok(visible(html).includes(`Board team is unavailable: ${reason}`), 'the reason is visible text, not only a tooltip');
  assert.equal(app.defaultEngine(list), 'claude-code', 'the first engine that can run is the default');
  assert.equal(app.defaultEngine([info('board', { available: false })]), 'board', 'with nothing usable the board team stays selected and disabled');
});

test('no build engine at all: the reason is shown and no choice is offered', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  app.S.engines = [info('board', { hidden: true, available: false, reason: 'Neither Claude Code nor Codex is installed: no CLI was found on PATH.' }),
    info('claude-code', { hidden: true, available: false }), info('codex', { hidden: true, available: false })];
  const html = app.engineSegHtml(app.engineList(), 'board');
  assert.ok(!html.includes('data-engine'), 'no choice');
  assert.match(visible(html), /Neither Claude Code nor Codex is installed/);
});

test('the Recommended summary names the team and gives the Codex reason as text when a Codex seat builds', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  setup(app); app.S.capability = CAP_OFF;
  const draft = app.newBuildDraft(PLAN);
  const text = visible(app.boardSummaryInner(draft));
  assert.match(text, /Board team \(recommended\)/);
  assert.ok(text.includes('Manager: Sol. Builders by difficulty: easy Sol, medium Sol, hard Sol. Reviewer: Sol.'), text);
  assert.match(text, /Codex builders read only and return a diff\. Codex file edits are off on Windows: the board runs Codex with the unelevated Windows sandbox/);
  assert.match(text, /Edits happen in per-item worktrees, and you apply each item\. If file edits are unavailable, the build only proposes\./);
  draft.roles.manager = 'claude1'; draft.roles.reviewer = 'claude1';
  assert.ok(!visible(app.boardSummaryInner(draft)).includes('Codex'), 'a Claude-only team has no Codex line');
});

test('the Recommended summary states the mode, and the Codex reason is checked until the capability has a result', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  setup(app); app.S.capability = null;
  const draft = app.newBuildDraft(PLAN);
  assert.match(visible(app.boardSummaryInner(draft)), /Checking whether Codex file edits are available\./);
  draft.mode = 'propose';
  assert.match(visible(app.boardSummaryInner(draft)), /This build only proposes: each passing item exports a patch file, and no file is edited\./);
  draft.mode = 'write';
  assert.match(visible(app.boardSummaryInner(draft)), /Edits happen in per-item worktrees, and you apply each item\./);
  app.S.capability = { writes: 'available', reason: null, agents: { codex: { available: true, reason: null } } };
  assert.equal(app.codexStateText(), 'Codex file edits are available.');
  assert.equal(app.codexOffText(''), 'Codex file edits are off.');
  assert.equal(app.codexOffText('the write check failed'), 'Codex file edits are off: the write check failed');
});

test('Advanced holds the roles, rounds, escalation and mode; Write is disabled when the board cannot edit files', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  setup(app); app.S.capability = CAP_OFF;
  app.S.engines = [info('board', { modes: ['propose'] }), info('claude-code')];
  const draft = app.newBuildDraft(PLAN);
  const html = app.boardPanelHtml(draft, app.engineList());
  assert.match(html, /<details class="adv build-adv" id="buildAdv"><summary>Advanced: roles, rounds, escalate, mode<\/summary>/);
  assert.equal((html.match(/data-role="/g) || []).length, 5, 'one select per role');
  assert.match(html, /<option value="write" disabled>/, 'Write is off while the board cannot edit');
  assert.match(html, /<option value="propose">/);
  assert.match(html, /id="bMax"/);
  assert.match(html, /id="bEsc"/);
  assert.match(html, /<option value="auto" selected>/, 'Automatic is the default');
  assert.match(visible(html), /This build will propose changes only: no repository/, 'the capability note stays as text');
});

test('the handoff form says the run is outside the board write gate, and it shows the suggested models', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const html = app.handoffFormHtml(PLAN, 'claude-code', app.HANDOFF_TIERS['claude-code']);
  assert.ok(visible(html).includes("It is outside the board's write gate and can edit your checkout."), 'the outside-the-gate text');
  assert.match(visible(html), /You run this plan in your own Claude Code, with your own settings\./);
  assert.match(visible(html), /for the 2 items of revision 2/);
  assert.match(visible(html), /Suggested models \(written into the handoff, not enforced\)/);
  assert.match(html, /data-tier="easy" value="claude-haiku-5-5"/);
  assert.match(html, /data-tier="medium" value="claude-sonnet-5-5"/);
  assert.match(html, /data-tier="hard" value="claude-opus-5-5"/);
  const codex = app.handoffFormHtml(PLAN, 'codex', app.HANDOFF_TIERS.codex);
  assert.match(visible(codex), /You run this plan in your own Codex/);
  assert.match(codex, /data-tier="hard" value="gpt-6.1-sol"/);
});

test('the start bodies: the board team sends roles, rounds, escalation and a mode only when chosen; a handoff sends its tiers', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  setup(app);
  const draft = app.newBuildDraft(PLAN);
  assert.deepEqual(plain(app.boardStartBody(PLAN, draft)), { planRoomId: 'p1', revision: 2, hash: PLAN_HASH,
    roles: { manager: 'sol', hard: null, medium: null, easy: null, reviewer: null }, maxRounds: 3, escalate: false },
  'an empty role is sent as null (the fallback), and no mode is sent for Automatic');
  draft.roles.reviewer = 'luna'; draft.maxRounds = 2; draft.escalate = true; draft.mode = 'propose';
  const body = plain(app.boardStartBody(PLAN, draft));
  assert.equal(body.roles.reviewer, 'luna'); assert.equal(body.maxRounds, 2); assert.equal(body.escalate, true); assert.equal(body.mode, 'propose');
  draft.engine = 'claude-code'; draft.tiers['claude-code'].hard = 'claude-sonnet-5-5';
  assert.deepEqual(plain(app.handoffStartBody(PLAN, draft)), { engine: 'claude-code', planRoomId: 'p1', revision: 2, hash: PLAN_HASH,
    options: { tiers: { easy: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', hard: 'claude-sonnet-5-5' } } });
});

test('the paste prompt replaces the form once the handoff is written: its steps, a copy button, and no shell command', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const prompt = 'Read .orchestra/handoff/p1-r2-obabcdef.md and run it with a Workflow, following its rules.';
  const html = app.handedHtml({ engine: 'claude-code', prompt });
  assert.match(visible(html), /The handoff is written\. The board does not start the run: run it yourself in Claude Code\./);
  assert.match(visible(html), /Open Claude Code in your project folder\. Paste this prompt\./);
  assert.ok(html.includes(`data-copy="${prompt}"`), 'the prompt is copied as it is');
  assert.match(html, /aria-label="Copy prompt"/);
  assert.ok(!html.includes('<img'), 'a prompt is escaped');
  assert.ok(!app.handedHtml({ engine: 'codex', prompt: '<img src=x onerror=1>' }).includes('<img'));
});

test('a dialog for the board team: the start button is disabled when the engine cannot run, and the dialog says the plan revision', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  setup(app);
  app.S.engines = [info('board', { available: false, reason: 'CLI broken', modes: [] }), info('claude-code', { hidden: true, available: false })];
  const draft = app.newBuildDraft(PLAN);
  const html = app.buildDialogHtml(PLAN, draft);
  assert.match(html, /<button class="btn primary" id="bGo" disabled>Start build<\/button>/);
  assert.match(visible(html), /Plan revision 2 · aaaaaaaaaaaa\./);
  assert.match(html, /id="engineSlot"/);
});

test('preflight: a dirty checkout and a folder that is not a git repository both warn, in words', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  setup(app); // the Codex and Claude lines show for the seats the plan uses
  const dirty = visible(app.preflightHtml({ ...PF_OK, clean: false, dirtyCount: 3 }));
  assert.match(dirty, /Warning: 3 uncommitted changes: commit or stash before a build that edits files\./);
  const one = visible(app.preflightHtml({ ...PF_OK, clean: false, dirtyCount: 1 }));
  assert.match(one, /1 uncommitted change: commit or stash/, 'a single change is named in the singular');
  const nonGit = visible(app.preflightHtml({ git: { ok: false, reason: 'the project folder is not a git repository' }, clean: false, dirtyCount: 0, writes: PF_OK.writes }));
  assert.match(nonGit, /Warning: No usable git repository: the project folder is not a git repository\. A build that edits files needs one\./);
  assert.ok(!nonGit.includes('uncommitted'), 'no dirty line for a folder that is not a repository');
  const clean = visible(app.preflightHtml(PF_OK));
  assert.match(clean, /Done: Git repository with a commit\./);
  assert.ok(!clean.includes('Warning:'), 'a clean repository with file edits available has no warning');
  assert.match(clean, /Note: Codex builders read only and return a diff, which the board applies in the item worktree or exports as a patch\. Codex file edits are off on Windows/);
});

test('preflight: a reason from the server is escaped, a read that failed says so, and a read in progress says it is checking', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const hostile = app.preflightHtml({ git: { ok: false, reason: '<img src=x onerror=1>' }, clean: false, dirtyCount: 0, writes: PF_OK.writes });
  assert.ok(!hostile.includes('<img'));
  assert.ok(hostile.includes('&lt;img'));
  assert.match(visible(app.preflightHtml({ error: 'git is not installed' })), /The checkout could not be checked: git is not installed\./);
  assert.match(visible(app.preflightHtml(null)), /Checking the checkout/);
});

test('the patch export renders both commands, the file, its sha256, the check and the untested line', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const room = { id: 'b1', kind: 'build', mode: 'propose', status: 'done', order: ['i2'], items: {} };
  const hash = '3f2a91c0' + 'b'.repeat(56);
  const item = { id: 'i2', title: 'Route', difficulty: 'medium', status: 'passed', builderId: 'luna', reviewerId: 'sol', rounds: 1,
    proposal: { hash: 'c'.repeat(64) }, exported: { file: '.orchestra/proposals/b1/i2-r1.patch', rel: 'proposals/b1/i2-r1.patch', hash,
      files: ['src/route.js', 'src/csv.js', 'test/csv.test.js'], bytes: 900, check: { ok: true, reason: null }, untested: true, round: 1 } };
  const html = app.itemRowHtml(room, item);
  assert.ok(html.includes('data-copy="git apply --check .orchestra/proposals/b1/i2-r1.patch"'), 'the check command');
  assert.ok(html.includes('data-copy="git apply --index .orchestra/proposals/b1/i2-r1.patch"'), 'the apply command');
  assert.equal((html.match(/data-copy="git apply/g) || []).length, 2, 'two copy buttons');
  assert.match(visible(html), /Patch: 3 files, git apply --check ok/);
  assert.ok(html.includes(hash), 'the sha256 is shown in full');
  assert.match(visible(html), /File \.orchestra\/proposals\/b1\/i2-r1\.patch/);
  assert.match(visible(html), /Untested proposal: read the diff before you apply it\./);
});

test('the patch export: a failing check is shown as a failure with its reason; a refused export says why and offers no command', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  const room = { id: 'b1', kind: 'build', mode: 'propose', status: 'done', order: ['i2'], items: {} };
  const failed = { id: 'i2', title: 'Route', status: 'passed', rounds: 1, proposal: null, exported: {
    file: '.orchestra/proposals/b1/i2-r1.patch', hash: 'd'.repeat(64), files: ['src/route.js'], check: { ok: false, reason: 'patch does not apply' }, untested: true } };
  const failText = visible(app.itemRowHtml(room, failed));
  assert.match(failText, /git apply --check failed: patch does not apply/);
  assert.equal((app.itemRowHtml(room, failed).match(/data-copy="git apply/g) || []).length, 2, 'the commands stay: the user can read the diff');
  const refused = { id: 'i2', title: 'Route', status: 'passed', rounds: 1, proposal: null, exported: { file: null, rel: null, hash: null, files: [],
    bytes: 0, check: { ok: false, reason: 'the diff touches .git' }, refused: 'unsafe-path', untested: true } };
  const html = app.itemRowHtml(room, refused);
  assert.match(visible(html), /No patch was exported: the diff touches \.git/);
  assert.ok(!html.includes('data-copy="git apply'), 'no command for a refused export');
  assert.equal(app.exportHtml({ id: 'i3' }), '', 'an item without an export shows nothing');
});

test('new strings: no em or en dash in the Start build, preflight and export text', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  setup(app); app.S.capability = CAP_OFF;
  app.S.engines = [info('board', { available: false, reason: 'CLI broken', modes: [] }), info('claude-code', { note: 'a note' }),
    info('codex', { hidden: true })];
  const draft = app.newBuildDraft(PLAN);
  draft.mode = 'propose';
  const item = { id: 'i2', title: 'Route', status: 'passed', rounds: 1, proposal: null, exported: { file: '.orchestra/proposals/b1/i2-r1.patch',
    hash: 'e'.repeat(64), files: ['a.js'], check: { ok: false, reason: 'does not apply' }, untested: true } };
  const texts = [app.engineSegHtml(app.engineList(), 'claude-code'), app.boardSummaryInner(draft), app.boardPanelHtml(draft, app.engineList()),
    app.handoffFormHtml(PLAN, 'claude-code', app.HANDOFF_TIERS['claude-code']), app.handedHtml({ engine: 'codex', prompt: 'Read a.md' }),
    app.buildDialogHtml(PLAN, draft), app.preflightHtml(null), app.preflightHtml({ error: 'x' }), app.preflightHtml(PF_OK),
    app.preflightHtml({ git: { ok: false, reason: 'not a repository' }, clean: false, dirtyCount: 2, writes: PF_OK.writes }),
    app.exportHtml(item), app.codexOffText('off on Windows: x')];
  for (const t of texts) assert.equal(hasDash(t), false, visible(t).slice(0, 120));
});

// ---------- the dialog, driven through the stub page ----------

test('openBuild: a handoff is chosen, its tiers are edited, and Create handoff posts them and shows the paste prompt', async () => {
  const PROMPT = 'Read .orchestra/handoff/p1-r2-obabcdef.md and run it with a Workflow, following its rules.';
  const posted = [];
  const { app, ctx } = boot(async (url, opts = {}) => {
    if (url === '/api/run') { posted.push({ url, body: JSON.parse(opts.body) }); return json({ roomId: 'run1', pastePrompt: PROMPT }); }
    return json({ checks: [] });
  }, { expose: EXPOSE });
  const { doc, box } = page(ctx);
  setup(app);
  app.S.engines = [info('board'), info('claude-code')];
  const btnBoard = control({ engine: 'board' }), btnHandoff = control({ engine: 'claude-code' });
  box.lists['[data-engine]'] = [btnBoard, btnHandoff];
  app.S.rooms = { p1: PLAN };
  app.openBuild(PLAN);
  assert.match(doc.kids['#overlay'].innerHTML, /Who builds it\?/, 'the dialog is shown');

  const tiers = { easy: control({ tier: 'easy' }, 'claude-haiku-5-5'), medium: control({ tier: 'medium' }, 'claude-sonnet-5-5'), hard: control({ tier: 'hard' }, 'claude-opus-5-5') };
  box.lists['input[data-tier]'] = [tiers.easy, tiers.medium, tiers.hard];
  btnHandoff.onclick();
  assert.match(box.kids['#buildPanel'].innerHTML, /outside the board's write gate/, 'the handoff form is shown');
  assert.match(box.kids['#buildFoot'].innerHTML, /Create handoff/);
  tiers.hard.value = 'claude-sonnet-5-5'; tiers.hard.oninput();

  await box.kids['#bGo'].onclick();
  assert.equal(posted.length, 1, 'one start is sent');
  assert.deepEqual(plain(posted[0].body), { engine: 'claude-code', planRoomId: 'p1', revision: 2, hash: PLAN_HASH,
    options: { tiers: { easy: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', hard: 'claude-sonnet-5-5' } } });
  assert.ok(box.kids['#buildPanel'].innerHTML.includes(PROMPT), 'the paste prompt is shown');
  assert.match(box.kids['#buildFoot'].innerHTML, /Done/);
  assert.ok(!box.kids['#buildFoot'].innerHTML.includes('Create handoff'));
  btnBoard.onclick();
  assert.ok(box.kids['#buildPanel'].innerHTML.includes(PROMPT), 'a written handoff cannot be switched to another engine');
});

test('openBuild: the board team starts a build with the mode that was chosen under Advanced', async () => {
  const posted = [];
  const { app, ctx } = boot(async (url, opts = {}) => {
    if (url === '/api/build') { posted.push({ url, body: JSON.parse(opts.body) }); return json({ roomId: 'b9' }); }
    return json({ checks: [] });
  }, { expose: EXPOSE });
  const { box } = page(ctx);
  setup(app);
  app.S.engines = [info('board'), info('claude-code')];
  app.S.rooms = { p1: PLAN };
  app.openBuild(PLAN);
  const mode = box.querySelector('#bMode'); mode.value = 'propose'; mode.onchange();
  const max = box.querySelector('#bMax'); max.value = '2'; max.onchange();
  await box.kids['#bGo'].onclick();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.mode, 'propose', 'the chosen mode is sent');
  assert.equal(posted[0].body.maxRounds, 2, 'the chosen rounds are sent');
  assert.deepEqual(posted[0].body.roles, { manager: 'sol', hard: null, medium: null, easy: null, reviewer: null });
});

test('openBuild: a change of the engine list repaints the open dialog and moves a choice that is gone to the default', async () => {
  const { app, ctx } = boot(quiet, { expose: EXPOSE });
  const { box } = page(ctx);
  setup(app);
  app.S.engines = [info('board'), info('claude-code')];
  app.S.rooms = { p1: PLAN };
  app.openBuild(PLAN);
  app.SSE.engines({ t: 'engines', engines: [info('board', { available: false, reason: 'the CLI went away', modes: [] }), info('claude-code')] });
  assert.match(engineBtn(box.kids['#engineSlot'].innerHTML, 'board'), / disabled>/, 'the board team is now disabled');
  assert.match(visible(box.kids['#engineSlot'].innerHTML), /Board team is unavailable: the CLI went away/);
  assert.match(box.kids['#buildPanel'].innerHTML, /outside the board's write gate/, 'the dialog moved to the handoff');
  assert.match(box.kids['#buildFoot'].innerHTML, /Create handoff/);
});

test('the plan card reads the checkout while the plan awaits approval and after approval, and never for other states', async () => {
  const urls = [];
  const { app, ctx } = boot(async (url) => { urls.push(url); return url.startsWith('/api/preflight') ? json(PF_OK) : json({ checks: [] }); }, { expose: EXPOSE });
  const { doc } = page(ctx);
  setup(app); app.S.capability = CAP_OFF;
  app.S.active = 'p1';
  app.S.rooms = { p1: { ...PLAN, status: 'awaiting-approval' } };
  app.renderPlanCard();
  const pf = () => urls.filter((u) => u.startsWith('/api/preflight'));
  assert.deepEqual(pf(), ['/api/preflight?planRoomId=p1'], 'read once, for this room');
  assert.match(doc.kids['#planCard'].innerHTML, /Checking the checkout/, 'the card says it is reading');
  await flush(); await flush();
  assert.match(doc.kids['#planCard'].innerHTML, /Before you build/);
  assert.match(visible(doc.kids['#planCard'].innerHTML), /Done: Git repository with a commit\./);
  assert.equal(pf().length, 1, 'the answer is kept: the card does not read it again at once');
  app.S.rooms.p1 = { ...PLAN, status: 'done' };
  app.renderPlanCard();
  assert.equal(pf().length, 1, 'a finished plan is not read');
  assert.ok(!doc.kids['#planCard'].innerHTML.includes('Before you build'));
});

test('the plan card shows a failed read as text', async () => {
  const { app, ctx } = boot(async (url) => (url.startsWith('/api/preflight') ? json({ error: 'git is not installed' }, 500) : json({ checks: [] })), { expose: EXPOSE });
  const { doc } = page(ctx);
  setup(app);
  app.S.active = 'p1';
  app.S.rooms = { p1: { ...PLAN, status: 'approved' } };
  app.renderPlanCard();
  await flush(); await flush();
  assert.match(visible(doc.kids['#planCard'].innerHTML), /The checkout could not be checked: git is not installed\./);
});

test('role options: the empty choice reads as the fallback, and a role resolves down its chain to the next seat', () => {
  const { app } = boot(quiet, { expose: EXPOSE });
  setup(app);
  assert.ok(app.roleOptionsHtml('hard', '').startsWith('<option value="">Uses the fallback</option>'));
  assert.ok(app.seatFor({ manager: 'sol', easy: '' }, 'easy') === 'sol', 'an empty role resolves to the next seat of its chain');
  assert.equal(app.seatFor({ manager: '', hard: '' }, 'hard'), null, 'no seat at all resolves to nothing');
});
