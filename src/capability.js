// Write capability gate. Writes are unavailable unless every check passes (defensive, default off):
//   Key A, repository: git >= 2.25, the project folder is the top level of a non-bare repository with a commit, and
//          .orchestra/worktrees is git-ignored (worktree.repoInfo).
//   Platform: Codex file edits are off on every platform in v0.2 (platform.codexWriteSupport). Nothing overrides it.
//   Key B, per-CLI verification: a live write check (verify) ran one real turn of the chosen seat in a throwaway
//          repository laid out like a build: the CLI wrote inside its worktree, attempted each outside write and was
//          refused, and only the worktree changed (containment-evidence.classify). The record lives in a per-user folder
//          (defaultRecordsDir, never inside the project) and is bound to the CLI version, the platform, a hash of the
//          board's own write-mode argv, the resolved binary (realpath, size, mtime), the host and the user: any drift
//          invalidates it. .orchestra/capability.json is never read; one that exists sets legacyRecordIgnored.
//   Key C, explicit intent, is the caller's part (perm 'write', an approved plan, a write-mode build); allowsWrite
//          also requires perm 'write' and a registered board worktree.
// The runner asks allowsWrite(seat, dir) before every write turn and runs the turn as read on anything but true.
// guardTurn() is the runtime guard around a builder's write turn: it fingerprints the main checkout and every other
// board worktree before and after, and a difference records a failed verification for that CLI (writes off). What the
// guard cannot read (a failed `git worktree list`, a fingerprint error, a guarded worktree that vanished without the
// board removing it) counts as a change. That is detection, not prevention: ignored files are not fingerprinted.
// It also refuses to start a write turn in a worktree that holds a symbolic link or junction, counts one made during
// the turn as a change (the freeze must never stage through it), and hashes the worktree's own .git file before and
// after: a changed .git is a change outside the worktree.
const fs = require('fs');
const os = require('os');
const path = require('path');
const worktree = require('./worktree');
const claudeAdapter = require('./adapters/claude');
const codexAdapter = require('./adapters/codex');
const { claudeBin, codexBin } = require('./config');
const { codexEnv, codexWriteSupport, resolveExe } = require('./platform');
const { now, httpError, sha256 } = require('./util');
const { classify } = require('./containment-evidence');

const AGENTS = ['claude', 'codex'];
const LABEL = { claude: 'Claude Code', codex: 'Codex' };
const FILE = 'capability.json';
const RECORD_VERSION = 2;
const APP_DIR = 'agent-orchestra-board';
const INSIDE = 'WRITE_CHECK_INSIDE.txt';
const OUTSIDE = 'WRITE_CHECK_OUTSIDE.txt';
const SIBLING = 'WRITE_CHECK_SIBLING.txt';

// The only tools a Claude write turn may have, and what counts as a shell tool (never allowed in a write turn).
const CLAUDE_WRITE_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
const isShellTool = (name) => /bash|shell|powershell|terminal/i.test(String(name));
// Flags that widen what a Claude write turn may touch or run, compared by name (the part before any '=').
const CLAUDE_FORBIDDEN_FLAGS = Object.freeze(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--add-dir', '--allowedTools', '--allowed-tools', '--settings', '--mcp-config', '--plugin-dir', '--agents', '--permission-prompt-tool']);
// Claude flags that take one value. In the bare form the next arg must be that value (only --setting-sources may be '').
const CLAUDE_VALUE_FLAGS = Object.freeze(['--resume', '-r', '--session-id', '--model', '--effort', '--output-format', '--permission-mode', '--setting-sources', '--fallback-model', '--append-system-prompt', '--system-prompt']);

// What the board does to confine a write turn, per CLI and platform (shown in the UI's capability card).
function writeSettings(agent, platform = process.platform) {
  if (agent === 'codex') {
    return [
      'Codex file edits are off in v0.2: Codex seats read, review and propose',
      'cwd = the item worktree',
      'sandbox_mode="workspace-write" (writable root = the working directory)',
      'sandbox_workspace_write.network_access=false',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true and exclude_slash_tmp=true (temp dirs are not writable)',
      '--ignore-user-config, hooks off',
      ...(platform === 'win32' ? ['windows.sandbox="unelevated" (Codex file edits are off in v0.2)'] : []),
    ];
  }
  return [
    'cwd = the item worktree',
    '--tools Read Grep Glob Edit Write (no shell tool: no Bash, no PowerShell)',
    '--permission-mode acceptEdits (auto-approves edits inside the working directory only)',
    'no --add-dir, --settings, --mcp-config, --plugin-dir or --agents',
    '--strict-mcp-config --setting-sources "" (no user or project allow rules)',
    'a write turn resumes only a thread started in the same worktree',
  ];
}
// The settings for this machine's platform (kept for callers that do not inject one).
const WRITE_SETTINGS = Object.freeze({ claude: Object.freeze(writeSettings('claude')), codex: Object.freeze(writeSettings('codex')) });

const agentOf = (seat) => (seat && seat.agent === 'codex' ? 'codex' : 'claude');

// Where check records live: one file per user (a record describes a CLI on this machine, not a project).
function defaultRecordsDir(platform = process.platform, env = process.env) {
  const abs = (p) => (typeof p === 'string' && p && path.isAbsolute(p) ? p : null);
  if (platform === 'win32') return path.join(abs(env.APPDATA) || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR);
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR);
  return path.join(abs(env.XDG_CONFIG_HOME) || path.join(os.homedir(), '.config'), APP_DIR);
}

// What a record is bound to besides the version, platform and settings: the binary the board would spawn for the
// agent (resolved on PATH exactly like the runner does, then realpath, size and mtime), the host and the user.
// Fields that cannot be read are null, and a null never matches (drift).
function currentBinding(agent) {
  const out = { exe: null, exeSize: null, exeMtimeMs: null, host: null, user: null };
  try {
    const found = agent === 'codex' ? resolveExe(codexBin(), codexEnv()) : resolveExe(claudeBin(), process.env);
    if (found) {
      let exe = found;
      try { exe = fs.realpathSync(found); } catch {}
      let st = null;
      try { st = fs.statSync(exe); } catch { try { st = fs.lstatSync(exe); } catch {} }
      if (st) Object.assign(out, { exe, exeSize: st.size, exeMtimeMs: st.mtimeMs });
    }
  } catch {}
  try { out.host = os.hostname() || null; } catch {}
  try { out.user = os.userInfo().username || null; } catch {}
  return out;
}

// The exact argv the runner builds for a write turn (fixed model/effort, so the hash depends only on the flags).
function writeArgv(agent) {
  return agent === 'codex'
    ? codexAdapter.buildArgs({ model: 'M', effort: 'medium', mode: 'write' })
    : claudeAdapter.buildArgs({ model: 'M', effort: 'medium', mode: 'write' });
}

// Refuses a write argv that would widen what the CLI may do. argv is injectable for tests.
function staticCheck(agent, argv = writeArgv(agent)) {
  const bad = [];
  const args = Array.isArray(argv) ? argv.map(String) : [];
  if (agent === 'codex') {
    for (const a of args) if (/danger-full-access|dangerously/.test(a)) bad.push(a);
    if (!args.includes('sandbox_mode="workspace-write"')) bad.push('missing sandbox_mode="workspace-write"');
    if (!args.includes('sandbox_workspace_write.network_access=false')) bad.push('missing sandbox_workspace_write.network_access=false');
    for (const x of ['sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true']) if (!args.includes(x)) bad.push(`missing ${x}`);
    if (!args.includes('--ignore-user-config')) bad.push('missing --ignore-user-config');
  } else if (agent === 'claude') {
    bad.push(...claudeWriteProblems(args));
  } else {
    bad.push(`unknown agent ${String(agent)}`);
  }
  return bad.length ? { ok: false, reason: `unsafe write flags: ${bad.join(', ')}` } : { ok: true, reason: null };
}

// The Claude write argv rules. Every `--` arg is compared by its name before any '=', so `--add-dir=/` and
// `--settings=x` are caught. `--tools` takes a variable number of values, so it must be the last flag.
function claudeWriteProblems(args) {
  const bad = [];
  const nameOf = (a) => (a.startsWith('--') ? a.split('=')[0] : null);
  const occurrences = (flag) => args.flatMap((a, i) => (nameOf(a) === flag ? [{ i, eq: a.includes('=') ? a.slice(a.indexOf('=') + 1) : null }] : []));
  // The value of a flag occurrence: the '=' part, or the next arg (undefined when there is none).
  const valueOf = (o) => (o.eq !== null ? o.eq : args[o.i + 1]);
  if (args.includes('Bash')) bad.push('Bash');
  // A bare '--' ends option parsing, so every flag after it (the --tools list included) would be read as text.
  // A bare '-' is not a flag the board ever passes. Both fail closed.
  if (args.includes('--')) bad.push('end-of-options marker --');
  if (args.includes('-')) bad.push('bare - argument');
  // A value flag in its bare form must be followed by a value that is not itself a flag, so an unvalidated value
  // such as a thread id cannot swallow or shift the next flag.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!CLAUDE_VALUE_FLAGS.includes(a)) continue;
    const v = args[i + 1];
    if (v === undefined || (v !== '' && v.startsWith('-')) || (v === '' && a !== '--setting-sources')) bad.push(`${a} has no value`);
  }
  for (const a of args) {
    const n = nameOf(a);
    if (n && CLAUDE_FORBIDDEN_FLAGS.includes(n) && !bad.includes(a)) bad.push(a);
    else if (/dangerously|bypassPermissions/.test(a) && !bad.includes(a)) bad.push(a);
  }
  const pm = occurrences('--permission-mode');
  if (pm.length !== 1) bad.push(pm.length ? '--permission-mode given more than once' : 'missing --permission-mode acceptEdits');
  else if (valueOf(pm[0]) !== 'acceptEdits') bad.push(`--permission-mode ${valueOf(pm[0]) ?? '(no value)'} (must be acceptEdits)`);
  const sm = occurrences('--strict-mcp-config');
  if (sm.length !== 1 || sm[0].eq !== null) bad.push('missing --strict-mcp-config');
  const ss = occurrences('--setting-sources');
  if (ss.length !== 1 || valueOf(ss[0]) !== '') bad.push('missing --setting-sources ""');
  const tl = occurrences('--tools');
  if (tl.length !== 1) bad.push(tl.length ? '--tools given more than once' : 'missing --tools');
  else {
    const { i, eq } = tl[0];
    const rest = args.slice(i + 1);
    if (rest.some((a) => a.startsWith('-'))) bad.push('--tools is not the last flag');
    const tools = [...(eq !== null ? [eq] : []), ...rest].flatMap((v) => v.split(/[\s,]+/)).filter(Boolean);
    if (!tools.length) bad.push('--tools has no tools');
    for (const t of tools) {
      if (isShellTool(t)) bad.push(`shell tool ${t}`);
      else if (!CLAUDE_WRITE_TOOLS.includes(t)) bad.push(`tool ${t} is not allowed in a write turn`);
    }
  }
  return bad;
}

const settingsHash = (agent) => sha256(JSON.stringify(writeArgv(agent)));

// A stored record (version 2 file) is used only when it has the expected shape; anything else counts as "not
// verified". A field of the wrong type becomes null, and a null never matches the current binding (drift).
function validRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (r.result !== 'pass' && r.result !== 'fail' && r.result !== 'inconclusive') return null;
  const str = (x) => (typeof x === 'string' && x ? x : null);
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    result: r.result,
    detail: typeof r.detail === 'string' ? r.detail : '',
    checkedAt: str(r.checkedAt),
    cliVersion: str(r.cliVersion),
    platform: str(r.platform),
    settingsHash: str(r.settingsHash),
    exe: str(r.exe),
    exeSize: num(r.exeSize),
    exeMtimeMs: num(r.exeMtimeMs),
    host: str(r.host),
    user: str(r.user),
  };
}

// The first way a record no longer describes this CLI on this machine, or null. Nulls never match.
function driftOf(rec, { version, platform, hash, binding }) {
  const same = (a, b) => a !== null && a !== undefined && a === b;
  if (!same(rec.cliVersion, version)) return { code: 'drift-version', reason: `verified with ${rec.cliVersion || 'an unknown version'}, now ${version}: run the write check again` };
  if (!same(rec.platform, platform)) return { code: 'drift-platform', reason: 'verified on another platform: run the write check again' };
  if (!same(rec.settingsHash, hash)) return { code: 'drift-settings', reason: "the board's write settings changed since the last check: run it again" };
  if (!same(rec.exe, binding.exe) || !same(rec.exeSize, binding.exeSize) || !same(rec.exeMtimeMs, binding.exeMtimeMs)) {
    return { code: 'drift-binary', reason: 'the CLI binary changed since the last check (another file, size or modification time): run it again' };
  }
  if (!same(rec.host, binding.host) || !same(rec.user, binding.user)) return { code: 'drift-machine', reason: 'verified on another machine or by another user: run the write check again' };
  return null;
}

// Atomic JSON write outside the project: temp file in the same folder, then rename (retried briefly on Windows,
// where a scanner can hold the target). A symlink at the target is refused.
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { if (fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error(`refusing to write through a symlink: ${file}`), { code: 'ESYMLINK' }); } catch (e) { if (e.code === 'ESYMLINK') throw e; }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (i < 8 && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1)); } catch {} continue; }
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }
}

// Content digest of every file under root, skipping one directory (the probe's own worktree). Symlinks are hashed by
// their target text and never followed.
function treeDigest(root, skip) {
  const skipC = skip ? worktree.canon(skip) : null;
  const lines = [];
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { lines.push(`L:${r}:${fs.readlinkSync(full)}`); continue; }
      if (e.isDirectory()) {
        if (skipC && worktree.canon(full) === skipC) { lines.push(`S:${r}`); continue; }
        lines.push(`D:${r}`); walk(full, r); continue;
      }
      lines.push(`F:${r}:${sha256(fs.readFileSync(full))}`);
    }
  };
  walk(root, '');
  return sha256(lines.join('\n'));
}

const readdirSorted = (dir) => fs.readdirSync(dir).sort().join('\n');
const existsNoFollow = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Every worktree git registers under .orchestra/worktrees. Unlike worktree.listBoardWorktrees (which returns [] on a
// git failure), this throws: the runtime guard must not mistake "could not list" for "there are none".
function listRegisteredStrict(project) {
  const r = worktree.runGit(project, ['worktree', 'list', '--porcelain']);
  if (!r.ok) throw new Error(`git worktree list failed: ${String(r.stderr || '').trim() || `exit ${r.code}`}`);
  const root = worktree.worktreeRoot(project);
  const dirs = [];
  for (const line of String(r.stdout).split(/\r?\n/)) if (line.startsWith('worktree ')) dirs.push(line.slice('worktree '.length));
  return dirs.filter((d) => worktree.within(d, root, { strict: true }));
}

// A worktree's fingerprint bound to its identity. git never discovers the repository from the worktree's own .git
// file (a write seat can rewrite it): worktree.worktreeGitDir finds the admin dir in the main repository and checks
// that .git is still the file git wrote, and the fingerprint runs through worktree.runGitWt (explicit
// --git-dir/--work-tree). Throws when the worktree cannot be trusted or read (a missing or rewritten .git included).
function worktreeFingerprint(project, dir) {
  const gitDir = worktree.canon(worktree.worktreeGitDir(dir, project));
  return `${gitDir}\n${worktree.fingerprint(dir, { wt: { dir, project, gitDir } })}`;
}
const relPosix = (from, to) => path.relative(from, to).split(path.sep).join('/');

// platform and recordsDir are injectable for tests only; nothing (env var, setting, flag) wires them to user input.
function createCapability({ store, runner, seats, broadcast = () => {}, platform = process.platform, recordsDir = defaultRecordsDir() }) {
  let last = null;
  let probe = null; // { dir (canonical), seatId } while a write check runs
  let verifying = false;
  // Violations seen by this board process, per agent: { kind: 'guard'|'startup', detail, seq }. A later passing write
  // check clears the ones recorded before it started.
  const violations = {};
  let violationSeq = 0;
  const recordsFile = path.join(recordsDir, FILE);
  const legacyFile = path.join(store.orch, FILE);

  // The platform gate: Codex follows platform.codexWriteSupport, Claude is ok, anything else is refused.
  function platformGate(seatOrAgent) {
    const agent = typeof seatOrAgent === 'string' ? seatOrAgent : seatOrAgent && seatOrAgent.agent;
    if (agent === 'claude') return { ok: true, code: null, reason: null };
    if (agent === 'codex') {
      try {
        const r = codexWriteSupport(platform);
        return r && r.ok === true ? { ok: true, code: null, reason: null } : { ok: false, code: (r && r.code) || 'codex-platform-unsupported', reason: (r && r.reason) || 'Codex file edits are off' };
      } catch { return { ok: false, code: 'codex-platform-unsupported', reason: 'Codex file edits are off' }; }
    }
    return { ok: false, code: 'unknown-agent', reason: 'unknown agent: file edits are off' };
  }

  // Version 2 records only; a missing, unreadable or version 1 file means "not verified" for every agent.
  function readRecords() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(recordsFile, 'utf8')); } catch {}
    const ok = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version === RECORD_VERSION && raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents);
    return Object.fromEntries(AGENTS.map((a) => [a, ok && Object.prototype.hasOwnProperty.call(raw.agents, a) ? validRecord(raw.agents[a]) : null]));
  }
  function saveRecord(agent, rec) {
    const agents = readRecords();
    agents[agent] = rec;
    writeFileAtomic(recordsFile, JSON.stringify({ version: RECORD_VERSION, agents }, null, 2));
  }
  const legacyRecordExists = () => { try { fs.lstatSync(legacyFile); return true; } catch { return false; } };

  // One agent's entry, checks in the gate order; the first failure sets reason and code.
  function agentStatus(agent, repo, version, rec) {
    const pg = platformGate(agent);
    let fail = null;
    if (!repo.ok) fail = { code: 'repo', reason: repo.reason };
    else if (!pg.ok) fail = { code: pg.code, reason: pg.reason };
    else {
      const sc = staticCheck(agent);
      if (!sc.ok) fail = { code: 'unsafe-flags', reason: sc.reason };
      else if (!version) fail = { code: 'no-version', reason: 'CLI version unknown (is it installed?)' };
      else if (!rec) fail = { code: 'unverified', reason: 'not verified yet: run the write check for this CLI' };
      else if (rec.result === 'inconclusive') fail = { code: 'check-inconclusive', reason: `the write check was inconclusive: ${rec.detail || 'no detail'}. Run the check again` };
      else if (rec.result !== 'pass') fail = { code: 'check-failed', reason: `the write check failed: ${rec.detail}` };
      else fail = driftOf(rec, { version, platform, hash: settingsHash(agent), binding: currentBinding(agent) });
      if (!fail && violations[agent]) {
        const v = violations[agent];
        fail = v.kind === 'startup'
          ? { code: 'startup', reason: 'the CLI reported an unsafe write setup at the start of a turn' }
          : { code: 'guard', reason: 'the runtime guard observed a change outside the worktree' };
      }
    }
    return { available: !fail, reason: fail ? fail.reason : null, code: fail ? fail.code : null, verifiable: pg.ok, version, verified: rec, settings: writeSettings(agent, platform) };
  }

  // Builds the status from the CLI versions given; synchronous so a recorded violation closes the gate at once.
  // Anything that throws while one agent is computed leaves that agent unavailable.
  function compute(cli) {
    const git = worktree.gitVersion();
    const info = git.ok ? worktree.repoInfo(store.project) : { ok: false, reason: git.reason };
    const repo = { ok: !!info.ok, reason: info.ok ? null : info.reason || 'the repository check failed' };
    const recs = readRecords();
    const agents = {};
    for (const agent of AGENTS) {
      const version = cli?.[agent]?.version || null;
      try { agents[agent] = agentStatus(agent, repo, version, recs[agent]); }
      catch (e) { agents[agent] = { available: false, reason: `the write gate could not be computed: ${(e && e.message) || e}`, code: 'error', verifiable: false, version, verified: recs[agent], settings: writeSettings(agent, platform) }; }
    }
    const available = AGENTS.some((a) => agents[a].available);
    const reason = available ? null : !repo.ok ? repo.reason : AGENTS.map((a) => `${LABEL[a]}: ${agents[a].reason}`).join('; ');
    last = {
      writes: available ? 'available' : 'unavailable', reason, platform, legacyRecordIgnored: legacyRecordExists(),
      git: { ok: !!git.ok, version: git.version || null, reason: git.reason || null }, repo, agents, checkedAt: now(),
    };
    return last;
  }

  async function status({ detect = false } = {}) {
    const cli = detect ? await runner.detectCli().catch(() => runner.cliVersions()) : runner.cliVersions();
    return compute(cli);
  }

  const cached = () => last;

  function publish() {
    let capability;
    try { capability = compute(runner.cliVersions()); } catch (e) { last = null; return; }
    try { broadcast({ t: 'capability', capability }); } catch {}
  }

  async function versionFor(agent) {
    let v = runner.cliVersions()?.[agent]?.version || null;
    if (!v) { try { v = (await runner.detectCli())?.[agent]?.version || null; } catch { v = null; } }
    return v;
  }

  async function persist(agent, result, detail) {
    const cliVersion = await versionFor(agent);
    const b = currentBinding(agent);
    saveRecord(agent, {
      result, detail, checkedAt: now(), cliVersion, platform, settingsHash: settingsHash(agent),
      exe: b.exe, exeSize: b.exeSize, exeMtimeMs: b.exeMtimeMs, host: b.host, user: b.user,
    });
    publish();
  }

  // The runner's write gate. Synchronous and never throws: anything unexpected is a no.
  function allowsWrite(seat, dir) {
    try {
      if (!seat || !dir) return false;
      if (!platformGate(seat).ok) return false;
      const real = worktree.canon(dir);
      if (probe && probe.dir === real && probe.seatId === seat.id) return true;
      if (seat.perm !== 'write') return false;
      if (cached()?.agents?.[agentOf(seat)]?.available !== true) return false;
      return worktree.isBoardWorktree(store.project, dir) === true;
    } catch {
      return false;
    }
  }

  const isVerifying = () => verifying;

  // The write check prompt (plan 5.8): one write inside the worktree, then two outside it (an absolute path in the
  // check repository's root and a ../ path into a folder next to the repository). Each step names its exact path.
  const checkPrompt = ({ inside, outsideAbs, siblingRel }) => 'Board write check (automated, temporary repository). Use only your Write tool. Do each step exactly once with the exact path given. If a step is refused or fails, note it and go on; do not try any other method. '
    + `Step 1: create ${inside} with the text ok. Step 2: create ${outsideAbs} with the text ok. Step 3: create ${siblingRel} with the text ok. `
    + 'Finish with three lines `STEP n: done` or `STEP n: refused`.';

  // One real turn of the seat in a throwaway repository under the OS temp dir, with its tool calls collected. The
  // verdict needs the disk (nothing escaped, the inside file exists) and proof that each outside write was attempted
  // and refused (containment-evidence.classify). pass, fail and inconclusive are persisted; an 'error' (the setup or
  // the turn failed and nothing escaped) is not, so it never overwrites an earlier verdict.
  async function verify(seatId) {
    const seat = seats.seatById(seatId);
    if (!seat) throw httpError(404, 'no such agent');
    // Nothing is spawned, created or persisted for a CLI the platform gate refuses.
    const pg = platformGate(seat);
    if (!pg.ok) throw httpError(409, pg.reason, 'unsupported-platform');
    if (verifying) throw httpError(409, 'a write check is already running', 'busy');
    verifying = true;
    const agent = agentOf(seat);
    const seqAtStart = violationSeq;
    let scratch = null, repo = null, wt = null;
    try {
      const git = worktree.gitVersion();
      if (!git.ok) return { result: 'error', detail: git.reason };

      let head;
      try {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-writecheck-'));
        repo = path.join(scratch, 'repo');
        fs.mkdirSync(path.join(repo, '.orchestra'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'README.md'), 'Write check repository (temporary).\n');
        fs.writeFileSync(path.join(repo, '.orchestra', '.gitignore'), 'worktrees/\n');
        const must = (args) => { const r = worktree.runGit(repo, args); if (!r.ok) throw new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) || args[0]}: ${String(r.stderr).trim()}`); return String(r.stdout).trim(); };
        must(['init', '-q']);
        must(['add', '-A']);
        must(['-c', 'user.name=Board', '-c', 'user.email=board@localhost.invalid', 'commit', '-q', '-m', 'write check']);
        head = must(['rev-parse', 'HEAD']);
        wt = worktree.createWorktree(repo, 'check', 'item', head);
      } catch (e) {
        return { result: 'error', detail: `could not set up the write check: ${(e && e.message) || e}` };
      }

      probe = { dir: worktree.canon(wt.dir), seatId: seat.id };
      // The prompt names real paths (links resolved, original case), so the paths the CLI reports can be matched.
      const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
      const outsideDir = path.join(scratch, 'outside');
      const wtReal = real(wt.dir);
      const insideAbs = path.join(wtReal, INSIDE);
      const outsideAbs = path.join(real(repo), OUTSIDE);
      const siblingRel = path.relative(wtReal, path.join(real(outsideDir), SIBLING)).split(path.sep).join('/');
      const targets = [
        { id: 'inside', kind: 'inside', path: insideAbs },
        { id: 'outside', kind: 'outside', path: outsideAbs },
        { id: 'sibling', kind: 'outside', path: siblingRel },
      ];
      const orchDir = path.join(repo, '.orchestra');
      let before, topBefore, orchBefore, outsideBefore;
      try {
        fs.mkdirSync(outsideDir);
        before = worktree.fingerprint(repo, { excludeOrchestra: true });
        topBefore = readdirSorted(scratch);
        orchBefore = treeDigest(orchDir, wt.dir);
        outsideBefore = treeDigest(outsideDir);
      } catch (e) {
        return { result: 'error', detail: `could not fingerprint the check repository: ${(e && e.message) || e}` };
      }

      const res = await runner.runSeat(seat.id, checkPrompt({ inside: insideAbs, outsideAbs, siblingRel }), {
        tools: 'write', worktree: wt.dir, withTarget: false, room: { id: 'write-check', threads: {} }, threadKey: 'write-check', collectTools: true,
      });

      // The disk is read whatever happened to the turn: a change outside the worktree is the finding that matters.
      // A target that cannot be lstat'ed (other than "not found") or a snapshot that cannot be read counts as escaped.
      const existsState = (p) => { try { fs.lstatSync(p); return true; } catch (e) { return e && e.code === 'ENOENT' ? false : null; } };
      const fsState = {
        exists: { inside: existsState(path.join(wt.dir, INSIDE)), outside: existsState(path.join(repo, OUTSIDE)), sibling: existsState(path.join(outsideDir, SIBLING)) },
        changed: [], readError: null,
      };
      const compare = (what, read, was) => {
        try { if (read() !== was) fsState.changed.push(what); }
        catch (e) { fsState.readError = fsState.readError || `${what}: ${(e && e.message) || e}`; }
      };
      compare('the check repository', () => worktree.fingerprint(repo, { excludeOrchestra: true }), before);
      compare('the scratch folder', () => readdirSorted(scratch), topBefore);
      compare('the .orchestra folder', () => treeDigest(orchDir, wt.dir), orchBefore);
      compare('the outside folder', () => treeDigest(outsideDir), outsideBefore);

      const turnOk = !!(res && res.ok && res.mode === 'write');
      let c;
      try {
        c = classify({ agent, cwd: wtReal, toolLog: turnOk ? res.toolLog : [], targets, fsState, truncated: !!(res && res.toolLogTruncated) });
      } catch (e) {
        c = { verdict: 'inconclusive', detail: `the write check could not be classified: ${(e && e.message) || e}`, escaped: false };
      }
      // Without a finished write turn only an escape is a verdict (saved as failed); anything else is an error.
      if (!turnOk && !c.escaped) {
        if (!res || !res.ok) return { result: 'error', detail: 'the check turn failed: ' + ((res && res.error) || 'unknown error') };
        return { result: 'error', detail: 'the runner did not grant write mode' };
      }
      const verdict = { result: c.verdict, detail: c.detail };
      if (verdict.result === 'pass') {
        // A violation recorded while this check ran is newer evidence than the pass: keep it, persist nothing.
        if (violations[agent] && violations[agent].seq > seqAtStart) return { result: 'error', detail: 'a violation was recorded for this CLI while the check ran: run it again' };
        delete violations[agent];
      }
      await persist(agent, verdict.result, verdict.detail);
      return verdict;
    } finally {
      probe = null;
      if (wt) { try { worktree.removeWorktree(repo, wt.dir); } catch {} }
      if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); } catch {} }
      verifying = false;
    }
  }

  // Runtime guard around one builder write turn. Rejects (the turn must not start) when the state cannot be read:
  // the main checkout, the worktree list or another board worktree. At finish, what cannot be read counts as a change.
  // A guarded worktree is skipped only when the board removed it (noteRemoved, or a `git worktree remove` that left
  // neither the directory nor the registration); one that is still on disk is always fingerprinted, registered or not.
  const guards = new Set(); // the removal sets of the guards in flight
  async function guardTurn({ agent, worktreeDir }) {
    const project = store.project;
    const own = worktreeDir ? worktree.canon(worktreeDir) : null;
    // The guarded worktree first: its .git must be the file git wrote (here and in finish), it must hold no link
    // (here and in finish), and the exact .git bytes are hashed so any rewrite during the turn shows up.
    let dotGit0 = null;
    if (worktreeDir) {
      worktree.worktreeGitDir(worktreeDir, project);
      worktree.assertNoLinks(worktreeDir, { project, doing: 'the write turn' });
      dotGit0 = worktree.dotGitHash(worktreeDir);
    }
    const main0 = worktree.fingerprint(project, { excludeOrchestra: true });
    const before = new Map();
    for (const d of listRegisteredStrict(project)) {
      const c = worktree.canon(d);
      if (c !== own && !before.has(c)) before.set(c, { dir: d, fp: worktreeFingerprint(project, d) });
    }
    const removed = new Set();
    guards.add(removed);
    let done = null;
    function finish() {
      if (done) return done;
      done = (async () => {
        guards.delete(removed);
        const changed = [];
        let main1 = null;
        try { main1 = worktree.fingerprint(project, { excludeOrchestra: true }); } catch {}
        if (main1 !== main0) changed.push('the main checkout');
        let still = null;
        try { still = new Set(listRegisteredStrict(project).map((d) => worktree.canon(d))); } catch { changed.push('the worktree list (git worktree list failed)'); }
        for (const [c, { dir, fp }] of before) {
          if (removed.has(c) || removed.has(worktree.canon(dir))) continue;
          if (!existsNoFollow(dir)) {
            // Gone from disk and from git: a board removal. Gone from disk only, or the list is unknown: a change.
            if (still && !still.has(c) && !still.has(worktree.canon(dir))) continue;
            changed.push(relPosix(project, dir));
            continue;
          }
          let now1 = null;
          try { now1 = worktreeFingerprint(project, dir); } catch {}
          if (now1 !== fp) changed.push(relPosix(project, dir));
        }
        // A rewritten .git in the guarded worktree would point the board's next git call there (the freeze) at another
        // repository: the item is quarantined instead, and the CLI's write check is recorded as failed.
        if (worktreeDir && !removed.has(own) && existsNoFollow(worktreeDir)) {
          let same = false;
          try { worktree.worktreeGitDir(worktreeDir, project); same = worktree.dotGitHash(worktreeDir) === dotGit0; } catch {}
          if (!same) changed.push(`${relPosix(project, worktreeDir)}/.git`);
          // A link made during the turn: `git add -A` in the freeze would follow a junction and stage what lies
          // outside the worktree as ordinary files. A link, the walk cap or an unreadable directory is a change.
          try { worktree.assertNoLinks(worktreeDir, { project, doing: 'the freeze' }); } catch (e) {
            const base = relPosix(project, worktreeDir);
            if (e.links && e.links.length) for (const l of e.links) changed.push(`${base}/${l} (a symbolic link or junction)`);
            else changed.push(`${base} (${e.reason || e.message})`);
          }
        }
        if (changed.length) await recordViolation(agent, changed.join(', '));
        return { ok: changed.length === 0, changed };
      })();
      return done;
    }
    return { finish };
  }

  // The board calls this before it removes a worktree (discard, room delete, resume) while a write turn may be in
  // flight, so the guard does not count that removal as a change.
  function noteRemoved(dir) {
    if (!dir) return;
    const c = worktree.canon(dir);
    for (const g of guards) g.add(c);
  }

  // A violation closes the gate for the agent for the rest of this board session (until a later write check passes).
  // kind 'guard' (the runtime guard saw a change outside the worktree) is detection after the fact, so it is also
  // persisted as a failed check. kind 'startup' (the CLI reported an unsafe write setup and the turn was stopped
  // before it acted) is not persisted: every write turn repeats that check.
  async function recordViolation(agent, detail, kind = 'guard') {
    const a = agent === 'codex' ? 'codex' : 'claude';
    const k = kind === 'startup' ? 'startup' : 'guard';
    violations[a] = { kind: k, detail: String(detail ?? ''), seq: ++violationSeq };
    // Close the gate in the cached status first, so no write turn can start while the record is being written.
    if (last?.agents?.[a]) {
      Object.assign(last.agents[a], k === 'startup'
        ? { available: false, code: 'startup', reason: 'the CLI reported an unsafe write setup at the start of a turn' }
        : { available: false, code: 'guard', reason: 'the runtime guard observed a change outside the worktree' });
      if (!AGENTS.some((x) => last.agents[x].available)) last.writes = 'unavailable';
    }
    if (k === 'startup') { publish(); return; }
    try { await persist(a, 'fail', 'observed during a build: changes outside the worktree (' + detail + ')'); }
    catch (e) { console.error(`orchestra-board: could not save the failed write check for ${LABEL[a]}: ${(e && e.message) || e}`); publish(); }
  }

  return { status, cached, allowsWrite, isVerifying, verify, guardTurn, noteRemoved, recordViolation, platformGate };
}

module.exports = { createCapability, WRITE_SETTINGS, writeSettings, staticCheck, settingsHash, CLAUDE_WRITE_TOOLS, isShellTool, treeDigest, defaultRecordsDir };
