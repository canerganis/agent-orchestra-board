#!/usr/bin/env node
// CLI entry. Usage: agent-orchestra-board [projectDir] [--port <n>] [--open]   |   agent-orchestra-board doctor [projectDir] [--json]
//                  |   agent-orchestra-board doctor --containment [--yes] [--json]
// Legacy form still works: agent-orchestra-board [projectDir] [port]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnResolved } = require('../src/platform'); // every child process of the board resolves its binary on PATH first
const { DEFAULT_PORT } = require('../src/config');
const { version: VERSION } = require('../package.json');

const USAGE = `Agent Orchestra Board ${VERSION} - a local board that runs Claude CLI and Codex CLI agents as seats.

Usage: agent-orchestra-board [projectDir] [--port <n>] [--open]
       agent-orchestra-board doctor [projectDir] [--port <n>] [--json]
       agent-orchestra-board doctor --containment [--yes] [--json]
       agent-orchestra-board demo [--port <n>] [--open]
       agent-orchestra-board --version | --help

  projectDir     project to orchestrate (default: current directory); state lives in <projectDir>/.orchestra/
  --port <n>     listen port (default: $PORT or ${DEFAULT_PORT}); the board binds 127.0.0.1 only
  --open         open the board in the default browser once it is listening
  doctor         check the environment (Node, Claude/Codex CLIs and logins, Windows sandbox, port, state dir)
                 prints a table, or JSON with --json; exit code 1 when a check fails
  doctor --containment
                 opt-in: runs the real Claude and Codex CLIs (cheap models, a few cents) in a temporary repository to
                 check that their sandboxes keep writes inside the worktree; prints the plan and runs only with --yes;
                 never runs under CI; your project is not touched and no write check record is written
  demo           zero token demo: the board on a temporary sample project with prerecorded rooms; no agent or model runs
  -V, --version  print the version
  -h, --help     show this help

Legacy form: agent-orchestra-board [projectDir] [port]

Environment: ORCHESTRA_CLAUDE_BIN, ORCHESTRA_CODEX_BIN (CLI executables), ORCHESTRA_LANG (agents' reply language), PORT`;

function parseArgs(argv) {
  const a = { projectDir: null, port: null, open: false, help: false, cmd: null, version: false, json: false, containment: false, yes: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--port') { const v = argv[++i]; a.port = v === undefined ? NaN : Number(v); }
    else if (x.startsWith('--port=')) a.port = Number(x.slice('--port='.length));
    else if (x === '--open') a.open = true;
    else if (x === '--json') a.json = true;
    else if (x === '--containment') a.containment = true;
    else if (x === '--yes') a.yes = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--version' || x === '-V') a.version = true;
    else if (x === '--') { positional.push(...argv.slice(i + 1)); break; }
    else if (x.startsWith('-') && x.length > 1) throw Object.assign(new Error(`unknown option '${x}' (try --help)`), { exitCode: 2 });
    else if (i === 0 && x === 'doctor') a.cmd = 'doctor';
    else if (i === 0 && x === 'demo') a.cmd = 'demo';
    else positional.push(x);
  }
  // [projectDir] [port]: the second positional is the legacy port argument.
  if (positional[0] !== undefined) a.projectDir = positional[0];
  if (positional[1] !== undefined && /^\d+$/.test(positional[1]) && a.port === null) a.port = Number(positional[1]);
  const usage = (msg) => Object.assign(new Error(`${msg} (try --help)`), { exitCode: 2 });
  if ((a.containment || a.yes) && a.cmd !== 'doctor') throw usage(`${a.containment ? '--containment' : '--yes'} works only with doctor`);
  if (a.yes && !a.containment) throw usage('--yes works only with doctor --containment');
  return a;
}

function resolvePort(a) {
  const port = a.port !== null ? a.port : Number(process.env.PORT) || DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const msg = Number.isNaN(a.port) ? '--port needs a number (1-65535)' : `invalid port '${a.port !== null ? a.port : process.env.PORT}' (expected 1-65535)`;
    throw Object.assign(new Error(msg), { exitCode: 2 });
  }
  return port;
}

// Open a URL in the default browser without blocking or inheriting stdio.
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawnResolved(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.error(`Could not open a browser; visit ${url}`));
    child.unref();
  } catch { console.error(`Could not open a browser; visit ${url}`); }
}

function banner(info, projectDir) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
  return [
    '',
    `  ${bold(`Agent Orchestra Board ${VERSION}`)}`,
    `  Board    ${bold(info.url)}  ${dim('(127.0.0.1 only)')}`,
    `  Project  ${projectDir}`,
    `  State    ${path.join(projectDir, '.orchestra')}`,
    `  ${dim('Press Ctrl+C to stop; running agent turns are killed with the board.')}`,
    '',
  ].join('\n');
}

// doctor --containment: refuses under CI, prints the plan, runs only with --yes. Exit 0 when no case failed, 1 when one
// did, 2 when refused, 130 when interrupted. containment-check is loaded here only, never by the server.
async function containment(a) {
  const check = require('../src/containment-check');
  const refused = check.refusal({ confirmed: a.yes, env: process.env });
  if (refused && refused.code === 'ci') {
    if (a.json) console.log(JSON.stringify({ ok: false, refused: refused.code, reason: refused.reason }, null, 2));
    else console.error(`agent-orchestra-board: ${refused.reason}`);
    process.exitCode = 2;
    return;
  }
  const plan = check.plan();
  const planText = `\n${plan.map((l) => `  ${l}`).join('\n')}\n`;
  if (refused) {
    if (a.json) console.log(JSON.stringify({ ok: false, refused: refused.code, reason: refused.reason, plan }, null, 2));
    else console.log(`${planText}\n  ${refused.reason}\n`);
    process.exitCode = 2;
    return;
  }
  if (!a.json) console.log(planText);
  const result = await check.runContainment({ confirmed: true, env: process.env, log: (line) => { if (!a.json) console.error(`  ${line}`); } });
  if (a.json) console.log(JSON.stringify({ ...result, plan }, null, 2));
  else console.log(`\n  Agent Orchestra Board ${VERSION} doctor --containment  (${process.platform} ${os.arch()}, node ${process.versions.node})\n\n${check.format(result, { color: process.stdout.isTTY && !process.env.NO_COLOR })}\n`);
  process.exitCode = result.aborted ? 130 : result.ok ? 0 : 1;
}

// Ctrl+C / SIGTERM: kill every running CLI child (process tree), close the server, then exit. A second signal forces exit.
function installShutdown(app) {
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) { console.error('\nForced exit.'); process.exit(130); }
    stopping = true;
    console.error(`\n${signal}: stopping the board (Ctrl+C again to force)...`);
    // stopWork first: no new CLI turn starts (queued and retrying turns end as stopped), rooms stop, running children die.
    let killed = 0;
    try { killed = app.stopWork(); } catch {}
    if (killed) console.error(`  stopped ${killed} running agent turn${killed === 1 ? '' : 's'}`);
    const bye = () => process.exit(0);
    const t = setTimeout(bye, 3000); t.unref();
    Promise.resolve().then(() => app.close()).then(bye, bye);
  };
  for (const sig of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(sig, () => shutdown(sig));
  return shutdown;
}

// demo: temporary sample project with prerecorded rooms; never spawns a CLI (see src/demo.js).
async function demo(a) {
  const port = a.port === null && !process.env.PORT ? undefined : resolvePort(a);
  const d = await require('../src/demo').startDemo({ port });
  console.log(banner({ url: d.url }, d.projectDir).replace(/\n  State .*/, "\n  Demo, no agents run. The project is a temporary copy and is deleted on exit."));
  const stop = () => { d.close().then(() => process.exit(0), () => process.exit(0)); };
  for (const sig of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(sig, stop);
  if (a.open) openBrowser(d.url);
  return d.app;
}

async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) { console.log(USAGE); return; }
  if (a.version) { console.log(`agent-orchestra-board ${VERSION}`); return; }
  if (a.cmd === 'doctor' && a.containment) return containment(a);
  if (a.cmd === 'demo') return demo(a);
  const projectDir = path.resolve(a.projectDir || process.cwd());
  const port = resolvePort(a);
  if (a.cmd === 'doctor') {
    const doctor = require('../src/doctor');
    const result = await doctor.run({ projectDir, port });
    if (a.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`\n  Agent Orchestra Board ${VERSION} doctor  (${process.platform} ${os.arch()}, node ${process.versions.node})\n\n${doctor.format(result, { color: process.stdout.isTTY && !process.env.NO_COLOR })}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  // `start` must never create a mistyped project path: createServer() runs `mkdir -p` for .orchestra/ and would
  // silently serve an empty project (doctor has its own projectCheck and reports instead of exiting).
  let st; try { st = fs.statSync(projectDir); } catch { throw Object.assign(new Error(`project directory does not exist: ${projectDir}\n  Pass an existing directory (agent-orchestra-board <projectDir>), or run from inside your project.`), { exitCode: 2 }); }
  if (!st.isDirectory()) throw Object.assign(new Error(`not a directory: ${projectDir}`), { exitCode: 2 });
  const { createServer } = require('../src/server');
  const app = createServer({ projectDir, port });
  let info;
  try { info = await app.start(); } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      throw Object.assign(new Error(`port ${port} is already in use. Is another Agent Orchestra Board running at http://localhost:${port}? Otherwise pass --port <other>.`), { exitCode: 1 });
    }
    if (e && e.code === 'EACCES') throw Object.assign(new Error(`no permission to listen on port ${port}; pass --port <other> (1024-65535).`), { exitCode: 1 });
    throw e;
  }
  // info.url is the only valid entry point (it carries the per-project token persisted in .orchestra/session), so
  // never rebuild it from the port.
  const url = (info && info.url) || `http://localhost:${port}`;
  console.log(banner({ url }, projectDir));
  installShutdown(app);
  if (a.open) openBrowser(url);
  return app;
}

if (require.main === module) main().catch((e) => { console.error(`agent-orchestra-board: ${e.message || e}`); process.exit(e.exitCode || 1); });

module.exports = { main, parseArgs, openBrowser };
