// Builds launchable fake `claude`/`codex` CLIs for one test file and exposes the scenario/calls protocol
// of test/fake-cli/fake-cli.js. The runner finds them through ORCHESTRA_CLAUDE_BIN / ORCHESTRA_CODEX_BIN.
//
//   POSIX:   fake-claude / fake-codex are `sh` scripts that exec `node fake-cli.js "$@"`.
//   Windows: a plain spawn() cannot run .cmd wrappers (EINVAL on Node >= 20.12) and node.exe rejects claude's
//            argv, so shim.cs is compiled with the .NET Framework csc.exe (part of Windows) into
//            fake-claude.exe / fake-codex.exe. Without csc the caller gets `skipReason` and skips its tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'fake-cli.js');
// Upper bound for one csc.exe build (a stalled antivirus scan must fail setup, not hang it).
const CSC_TIMEOUT_MS = 120000;

function findCsc() {
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function buildWrappers(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform !== 'win32') {
    const out = {};
    for (const name of ['fake-claude', 'fake-codex']) {
      const f = path.join(binDir, name);
      fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT}" "$@"\n`, { mode: 0o755 });
      out[name] = f;
    }
    return { claudeBin: out['fake-claude'], codexBin: out['fake-codex'], skipReason: null };
  }
  const csc = findCsc();
  if (!csc) return { claudeBin: null, codexBin: null, skipReason: 'csc.exe (.NET Framework) not found: cannot build the native fake CLI shim on Windows' };
  const src = fs.readFileSync(path.join(__dirname, 'shim.cs'), 'utf8').replace(/__NODE__/g, process.execPath).replace(/__SCRIPT__/g, SCRIPT);
  const cs = path.join(binDir, 'shim.cs');
  // UTF-8 BOM: the .NET Framework csc reads a BOM-less source in the ANSI code page, which garbles non-ASCII
  // characters in the embedded node/script paths (e.g. a user folder with Turkish letters).
  fs.writeFileSync(cs, '﻿' + src);
  const claudeBin = path.join(binDir, 'fake-claude.exe'), codexBin = path.join(binDir, 'fake-codex.exe');
  const r = spawnSync(csc, ['/nologo', '/optimize', '/target:exe', '/nowarn:1701,1702', `/out:${claudeBin}`, cs], { encoding: 'utf8', windowsHide: true, timeout: CSC_TIMEOUT_MS });
  // spawnSync blocks the event loop, so test timeouts cannot fire: an expired build must fail loudly right here.
  if (r.error) throw new Error(`building the fake CLI shim with csc.exe did not finish within ${CSC_TIMEOUT_MS}ms: ${r.error.message}`);
  if (r.status !== 0) return { claudeBin: null, codexBin: null, skipReason: `csc failed (${r.status}): ${(r.stdout || '') + (r.stderr || '')}`.trim() };
  fs.copyFileSync(claudeBin, codexBin);
  return { claudeBin, codexBin, skipReason: null };
}

// dir: a per-test scratch directory (the fake's state lives in <dir>/fake, the isolated home in <dir>/home).
// Sets the env the runner reads and redirects HOME/USERPROFILE so no module ever reads the real ~/.codex or ~/.claude.
function setupFakeCli(dir) {
  require('../helpers').isolateHome(dir);
  const fakeDir = path.join(dir, 'fake');
  for (const d of ['gates', 'threads']) fs.mkdirSync(path.join(fakeDir, d), { recursive: true });
  const built = buildWrappers(path.join(fakeDir, 'bin'));
  const env = { ORCHESTRA_CLAUDE_BIN: built.claudeBin || 'fake-claude-unavailable', ORCHESTRA_CODEX_BIN: built.codexBin || 'fake-codex-unavailable', OB_FAKE_DIR: fakeDir };
  Object.assign(process.env, env);

  const callsFile = path.join(fakeDir, 'calls.jsonl');
  const readJsonl = (file) => { let s; try { s = fs.readFileSync(file, 'utf8'); } catch { return []; } return s.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); };
  const calls = () => readJsonl(callsFile);
  const writesFile = path.join(fakeDir, 'writes.jsonl');

  return {
    ...built, dir: fakeDir, env,
    // scenario(rules[]) or scenario({rules, default})
    scenario(s) { fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify(Array.isArray(s) ? { rules: s } : s, null, 2)); },
    calls,
    // File operations the fake performed (writeFiles / deleteFiles), one entry per operation: {n, op, path, ok, error}.
    writes: () => readJsonl(writesFile),
    resetCalls() { try { fs.unlinkSync(callsFile); } catch {} try { fs.unlinkSync(writesFile); } catch {} for (const g of fs.readdirSync(path.join(fakeDir, 'gates'))) fs.unlinkSync(path.join(fakeDir, 'gates', g)); },
    openGate(name) { fs.writeFileSync(path.join(fakeDir, 'gates', name), '1'); },
    // Resolves with the matching calls once at least `count` of them were logged.
    waitCalls(pred, count = 1, timeout = 15000) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const hit = calls().filter(pred);
          if (hit.length >= count) return resolve(hit);
          if (Date.now() - t0 > timeout) return reject(new Error(`timed out waiting for ${count} fake CLI call(s); have ${hit.length} of ${calls().length}`));
          setTimeout(tick, 25);
        };
        tick();
      });
    },
  };
}

module.exports = { setupFakeCli, findCsc, SCRIPT, tmpRoot: () => os.tmpdir() };
