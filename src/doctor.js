// Environment checks for `orchestra-board doctor` (table) and GET /api/doctor (JSON).
// Never makes a model call: the only processes spawned are `<cli> --version` (via cmd.exe for a .cmd shim), always
// from the file resolved on PATH, never from a project directory (platform.spawnResolved). Never
// writes to disk except a probe file it removes again. Never prints secrets: credential files and environment
// variables are inspected for presence and shape only (auth mode, subscription tier, expiry).
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { claudeBin, codexBin } = require('./config');
// Binary resolution lives in platform.js (the runner spawns through the same lookup): PATH only, never the cwd.
const { codexEnv, killTree, resolveBin, resolveShims, isExecutableFile, spawnResolved } = require('./platform');

const WIN = process.platform === 'win32';
const SHIM = /\.(cmd|bat)$/i;
const check = (id, name, status, detail, hint) => ({ id, name, status, detail, ...(hint ? { hint } : {}) });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const day = (ms) => { const d = new Date(ms); return isNaN(d) ? '?' : d.toISOString().slice(0, 10); };

// Run `<exe> --version` with a timeout. `exe` is the resolved file. shim: run a .cmd/.bat through cmd.exe
// (quoted as a whole, so paths with spaces work; no deprecated shell:true). Timeouts kill the whole tree.
function versionOf(exe, env, timeoutMs, { shim = false, spawnFn = spawnResolved } = {}) {
  return new Promise((resolve) => {
    let child; let t; let out = ''; let done = false;
    const finish = (r) => { if (!done) { done = true; if (t) clearTimeout(t); resolve(r); } };
    const [cmd, args, extra] = shim && WIN
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${exe}" --version"`], { windowsVerbatimArguments: true }]
      : [exe, ['--version'], {}];
    try { child = spawnFn(cmd, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'], ...extra }); }
    catch (e) { return finish({ error: e }); }
    t = setTimeout(() => { finish({ timeout: true }); try { killTree(child); } catch {} }, timeoutMs);
    if (typeof t.unref === 'function') t.unref();
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code) => finish({ code, text: out.trim().split(/\r?\n/).find((l) => /\d+\.\d+/.test(l)) || out.trim().split(/\r?\n/)[0] || '' }));
  });
}

function nodeCheck() {
  const major = Number(process.versions.node.split('.')[0]);
  return check('node', 'Node.js', major >= 20 ? 'ok' : 'fail', `v${process.versions.node} (needs >= 20)`,
    major >= 20 ? undefined : 'Install Node.js 20 or newer: https://nodejs.org');
}

// A file named like the CLI at the project root. The board never runs it (every spawn resolves the CLI on PATH
// first, see platform.spawnResolved), but on Windows a plain `claude` typed in cmd.exe inside that directory would,
// and a project that ships such a file deserves a look before any agent is pointed at it.
function cwdShadow(bin, projectDir) {
  if (!WIN || !projectDir || bin.includes('/') || bin.includes('\\')) return null;
  const exts = [...(path.extname(bin) ? [''] : []), '.com', '.exe'];
  return exts.map((e) => path.join(projectDir, bin + e)).find(isExecutableFile) || null;
}

// opts: { spawnFn? (tests), projectDir? (cwd shadow warning) }
async function cliCheck(agent, bin, env, timeoutMs, { spawnFn = spawnResolved, projectDir = null } = {}) {
  const name = agent === 'claude' ? 'Claude CLI' : 'Codex CLI';
  const envVar = agent === 'claude' ? 'ORCHESTRA_CLAUDE_BIN' : 'ORCHESTRA_CODEX_BIN';
  const install = agent === 'claude' ? 'Install Claude Code (https://claude.com/claude-code), or point ORCHESTRA_CLAUDE_BIN at the executable.'
    : 'Install Codex CLI (https://github.com/openai/codex), or point ORCHESTRA_CODEX_BIN at the executable.';
  // Name the override only when it is what we are checking: the variable may be set for the other CLI's sake
  // (CI sets both), and a caller may pass any bin explicitly.
  const via = process.env[envVar] && bin === process.env[envVar] ? ` (${envVar}=${bin})` : '';
  const exes = resolveBin(bin, env);
  const shims = resolveShims(bin, env);
  if (!exes.length && !shims.length) return check(agent, name, 'fail', `'${bin}' not found on PATH${via}`, install);
  const exeHint = agent === 'codex'
    ? 'an npm install keeps the vendored codex.exe inside <npm prefix>\\node_modules\\@openai\\codex\\ (under its platform package), or download the native build from github.com/openai/codex/releases'
    : 'the npm package may ship no .exe at all: use the native installer (https://claude.com/claude-code)';
  const shimHint = `Node cannot spawn .cmd/.bat files without a shell. Set ${envVar} to the full path of the native executable (${exeHint}).`;
  if (!exes.length) {
    // Only a shim exists: spawn() would report ENOENT (bare name) or EINVAL (explicit .cmd). Read its version via cmd.exe.
    const shim = shims[0];
    const r = await versionOf(shim, env, timeoutMs, { shim: true, spawnFn });
    const ver = r.code === 0 && r.text ? r.text.slice(0, 60) : r.timeout ? '--version timed out' : r.error ? `--version failed: ${r.error.code || r.error.message}` : `--version exited ${r.code}`;
    return check(agent, name, 'warn', `${ver} — ${shim} is a ${path.extname(shim)} shim, which the board cannot launch (spawn: ${SHIM.test(bin) ? 'EINVAL' : 'ENOENT'})${via}`, shimHint);
  }
  const exe = exes[0];
  const r = await versionOf(exe, env, timeoutMs, { spawnFn });
  if (r.error) {
    if (shims.length) return check(agent, name, 'warn', `${exe} could not be started (${r.error.code || r.error.message}); ${shims[0]} is a ${path.extname(shims[0])} shim, which the board cannot launch${via}`, shimHint);
    return check(agent, name, 'fail', `'${bin}' could not be started: ${r.error.code || r.error.message} — ${exe}${via}`, install);
  }
  if (r.timeout) return check(agent, name, 'warn', `'${bin} --version' timed out after ${timeoutMs / 1000}s — ${exe}${via}`);
  if (r.code !== 0) return check(agent, name, 'warn', `'${bin} --version' exited ${r.code}${r.text ? `: ${r.text.slice(0, 80)}` : ''} — ${exe}${via}`);
  const ver = r.text.slice(0, 60) || 'version unknown';
  const more = exes.length > 1 ? ` (+${exes.length - 1} more on PATH)` : '';
  const shadow = cwdShadow(bin, projectDir);
  if (shadow) return check(agent, name, 'warn', `${ver} — ${exe}${more}${via}; note that ${shadow} exists in the project. The board ignores it (CLIs are resolved on PATH, never in the project), but a bare \`${bin}\` typed in cmd.exe inside that directory would run it`,
    'Check why the project ships an executable named like the CLI before letting agents loose on it.');
  return check(agent, name, 'ok', `${ver} — ${exe}${more}${via}`);
}

function claudeLoginCheck(env = process.env) {
  if (env.ANTHROPIC_API_KEY) return check('claudeLogin', 'Claude login', 'ok', 'API key from ANTHROPIC_API_KEY (value not shown)');
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return check('claudeLogin', 'Claude login', 'ok', 'OAuth token from CLAUDE_CODE_OAUTH_TOKEN (value not shown)');
  if (env.ANTHROPIC_AUTH_TOKEN) return check('claudeLogin', 'Claude login', 'ok', 'auth token from ANTHROPIC_AUTH_TOKEN (value not shown)');
  if (env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_VERTEX === '1' || env.CLAUDE_CODE_USE_FOUNDRY === '1') {
    return check('claudeLogin', 'Claude login', 'ok', 'cloud provider auth via CLAUDE_CODE_USE_* environment');
  }
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const creds = readJson(path.join(dir, '.credentials.json'));
  const oauth = creds && creds.claudeAiOauth;
  if (oauth && (oauth.accessToken || oauth.refreshToken)) {
    const tier = [oauth.subscriptionType, oauth.rateLimitTier].filter(Boolean).join(', ');
    const refreshExp = Number(oauth.refreshTokenExpiresAt);
    if (refreshExp && refreshExp < Date.now()) {
      return check('claudeLogin', 'Claude login', 'warn', `claude.ai login found${tier ? ` (${tier})` : ''} but its refresh token expired ${day(refreshExp)}`, 'Run `claude login` to sign in again.');
    }
    const exp = Number(oauth.expiresAt);
    const note = exp ? (exp < Date.now() ? '; access token expired (refreshes on next run)' : `; token valid until ${day(exp)}`) : '';
    return check('claudeLogin', 'Claude login', 'ok', `claude.ai login${tier ? ` (${tier})` : ''}${note} — ${path.join(dir, '.credentials.json')}`);
  }
  if (creds && creds.primaryApiKey) return check('claudeLogin', 'Claude login', 'ok', `API key stored in ${path.join(dir, '.credentials.json')} (value not shown)`);
  if (process.platform === 'darwin') return check('claudeLogin', 'Claude login', 'skip', 'credentials live in the macOS Keychain; cannot verify without a paid call');
  const acct = (readJson(path.join(os.homedir(), '.claude.json')) || {}).oauthAccount;
  return check('claudeLogin', 'Claude login', 'warn', acct ? `account configured but no credential file in ${dir}` : `no credentials found in ${dir}`,
    'Run `claude login` (or set ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`).');
}

function codexLoginCheck(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const authFile = path.join(home, 'auth.json');
  const auth = readJson(authFile);
  if (auth) {
    const t = auth.tokens || {};
    const refreshed = auth.last_refresh ? ` (refreshed ${day(auth.last_refresh)})` : '';
    if (t.access_token || t.refresh_token || t.id_token) {
      return check('codexLogin', 'Codex login', 'ok', `ChatGPT login${auth.auth_mode ? ` (auth_mode ${auth.auth_mode})` : ''}${refreshed} — ${authFile}`);
    }
    if (auth.OPENAI_API_KEY) return check('codexLogin', 'Codex login', 'ok', `API key stored in auth.json (value not shown)${refreshed} — ${authFile}`);
  }
  if (env.OPENAI_API_KEY) return check('codexLogin', 'Codex login', 'ok', 'API key from OPENAI_API_KEY (value not shown)');
  return check('codexLogin', 'Codex login', 'warn', auth ? `${authFile} has no tokens` : `no credentials found in ${home}`, 'Run `codex login` (or set OPENAI_API_KEY).');
}

// Minimal TOML scan: value of `sandbox` inside the [windows] table.
function codexSandboxSetting(configFile) {
  let text; try { text = fs.readFileSync(configFile, 'utf8'); } catch { return { exists: false }; }
  let section = ''; let value = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const h = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (h) { section = h[1]; continue; }
    const kv = line.match(/^sandbox\s*=\s*["']([^"']*)["']/);
    if (kv && section === 'windows') value = kv[1];
  }
  return { exists: true, value };
}

function codexSandboxCheck() {
  if (!WIN) return check('codexSandbox', 'Codex Windows sandbox', 'skip', 'Windows only');
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const cfg = codexSandboxSetting(path.join(home, 'config.toml'));
  const launch = 'Agent Orchestra Board launches Codex with -c windows.sandbox="unelevated"';
  if (!cfg.exists) return check('codexSandbox', 'Codex Windows sandbox', 'ok', `no config.toml in ${home}; ${launch}`);
  if (cfg.value === null) return check('codexSandbox', 'Codex Windows sandbox', 'ok', `config.toml sets no windows.sandbox; ${launch}`);
  if (cfg.value === 'unelevated') return check('codexSandbox', 'Codex Windows sandbox', 'ok', `config.toml windows.sandbox = "unelevated" (matches the board's launch flag)`);
  return check('codexSandbox', 'Codex Windows sandbox', 'ok', `config.toml windows.sandbox = "${cfg.value}"; overridden per launch (${launch})`,
    cfg.value === 'elevated' ? 'The elevated sandbox needs an admin setup; the board does not rely on it.' : undefined);
}

// The Microsoft Store `pwsh` alias (WindowsApps) cannot be launched from the unelevated sandbox, so Codex children
// get a PATH without WindowsApps (platform.codexEnv) and need another shell to fall back to.
function pwshCheck() {
  if (!WIN) return check('pwsh', 'PowerShell for Codex', 'skip', 'Windows only');
  const all = resolveBin('pwsh.exe');
  const store = (f) => /\\WindowsApps\\/i.test(f);
  const seen = resolveBin('pwsh.exe', codexEnv())[0] || resolveBin('powershell.exe', codexEnv())[0] || null;
  if (all.length && !store(all[0])) return check('pwsh', 'PowerShell for Codex', 'ok', `pwsh at ${all[0]}`);
  if (all.length && store(all[0])) {
    if (seen) return check('pwsh', 'PowerShell for Codex', 'ok', `pwsh on PATH is the Microsoft Store alias (${all[0]}); Codex children get a PATH without WindowsApps and use ${seen}`);
    return check('pwsh', 'PowerShell for Codex', 'fail', `pwsh on PATH is the Microsoft Store alias (${all[0]}) and no other PowerShell is on PATH; the unelevated Codex sandbox cannot launch it`,
      'Install PowerShell 7 with the MSI (`winget install Microsoft.PowerShell`) or put Windows PowerShell (System32\\WindowsPowerShell\\v1.0) on PATH.');
  }
  if (seen) return check('pwsh', 'PowerShell for Codex', 'ok', `no pwsh on PATH; Codex children use ${seen}`);
  return check('pwsh', 'PowerShell for Codex', 'warn', 'no pwsh or powershell found on PATH', 'Install PowerShell 7 with the MSI (`winget install Microsoft.PowerShell`).');
}

function portCheck(port, running) {
  if (port == null) return Promise.resolve(check('port', 'Port', 'skip', 'no port given (pass --port <n> to test one)'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(check('port', 'Port', 'fail', `${port} is not a valid port (1-65535)`));
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        resolve(running ? check('port', 'Port', 'ok', `${port} in use by this board (127.0.0.1)`)
          : check('port', 'Port', 'warn', `${port} is already in use on 127.0.0.1`, `Another board may be running at http://localhost:${port}; otherwise start with --port <other>.`));
      } else resolve(check('port', 'Port', 'fail', `cannot bind 127.0.0.1:${port}: ${e.code || e.message}`));
    });
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(check('port', 'Port', 'ok', `${port} is free on 127.0.0.1`))));
  });
}

function projectCheck(projectDir) {
  let st; try { st = fs.statSync(projectDir); } catch { return check('project', 'Project', 'fail', `${projectDir} does not exist`, 'Pass an existing directory: agent-orchestra-board <projectDir>'); }
  if (!st.isDirectory()) return check('project', 'Project', 'fail', `${projectDir} is not a directory`);
  const git = fs.existsSync(path.join(projectDir, '.git'));
  return check('project', 'Project', 'ok', `${projectDir}${git ? ' (git repository)' : ' (not a git repository)'}`);
}

// Write access for <project>/.orchestra without changing the filesystem: a probe file (removed again) goes into
// .orchestra when it exists, otherwise into the project directory itself (where `start` would create .orchestra).
// Skipped when the project check failed, so a typo in the project path never creates directories.
function orchestraWriteCheck(projectDir, projectOk = true) {
  const orch = path.join(projectDir, '.orchestra');
  if (!projectOk) return check('orchestra', 'State directory', 'skip', `${orch} (project directory check failed)`);
  let exists = false;
  try { exists = fs.statSync(orch).isDirectory(); } catch {}
  const dir = exists ? orch : projectDir;
  const probe = path.join(dir, `.orchestra-doctor-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'ok', { flag: 'wx' });
    fs.unlinkSync(probe);
    return check('orchestra', 'State directory', 'ok', exists ? `writable: ${orch}` : `${projectDir} is writable; ${orch} will be created on first start`);
  } catch (e) {
    try { fs.unlinkSync(probe); } catch {}
    return check('orchestra', 'State directory', 'fail', `cannot write ${dir}: ${e.code || e.message}`, 'The board stores seats, rooms and logs in .orchestra/; fix permissions or pick another project directory.');
  }
}

// run({ projectDir, port?, running?, timeoutMs? }) -> { ok, checks: [{id, name, status: ok|warn|fail|skip, detail, hint?}] }
// `running: true` means the caller is the live server on `port` (so "in use" is expected). `ok` is false when any check failed.
async function run(opts = {}) {
  const projectDir = path.resolve(opts.projectDir || process.cwd());
  const port = opts.port == null ? null : Number(opts.port);
  const timeoutMs = opts.timeoutMs || 10000;
  const project = projectCheck(projectDir);
  const cliOpts = { projectDir: project.status === 'ok' ? projectDir : null };
  const checks = await Promise.all([
    nodeCheck(),
    cliCheck('claude', claudeBin(), process.env, timeoutMs, cliOpts),
    cliCheck('codex', codexBin(), codexEnv(), timeoutMs, cliOpts),
    claudeLoginCheck(),
    codexLoginCheck(),
    codexSandboxCheck(),
    pwshCheck(),
    portCheck(port, !!opts.running),
    project,
    orchestraWriteCheck(projectDir, project.status === 'ok'),
  ]);
  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

// Terminal table for `orchestra-board doctor`.
function format(result, { color = false } = {}) {
  const paint = color ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_, s) => s;
  const label = { ok: paint(32, 'OK  '), warn: paint(33, 'WARN'), fail: paint(31, 'FAIL'), skip: paint(2, 'SKIP') };
  const w = Math.max(...result.checks.map((c) => c.name.length));
  const lines = [];
  for (const c of result.checks) {
    lines.push(`  ${label[c.status] || c.status}  ${c.name.padEnd(w)}  ${c.detail}`);
    if (c.hint) lines.push(`${' '.repeat(w + 8)}${paint(2, '-> ' + c.hint)}`);
  }
  const n = (s) => result.checks.filter((c) => c.status === s).length;
  const summary = `${n('ok')} ok, ${n('warn')} warning${n('warn') === 1 ? '' : 's'}, ${n('fail')} failed${n('skip') ? `, ${n('skip')} skipped` : ''}`;
  lines.push('', `  ${result.ok ? paint(32, summary) : paint(31, summary)}`);
  return lines.join('\n');
}

module.exports = { run, format, resolveBin, resolveShims, versionOf, cliCheck, claudeLoginCheck, orchestraWriteCheck, projectCheck };
