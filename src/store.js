// .orchestra/ paths and JSON persistence for one project.
const fs = require('fs');
const path = require('path');
const { today } = require('./util');

function createStore(projectDir) {
  const project = path.resolve(projectDir || process.cwd());
  const orch = path.join(project, '.orchestra');
  const roomDir = path.join(orch, 'rooms');

  const read = (f) => { try { return fs.readFileSync(path.join(orch, f), 'utf8'); } catch { return null; } };
  // Atomic write: the content goes to a temp file in the same directory, then renames over the target, so a crash or
  // power loss mid-write never leaves a truncated file. Windows can refuse a rename while a scanner or indexer holds
  // the target (EPERM/EBUSY): retried briefly. A symlink at the target is refused: never write through one.
  const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
  const write = (f, s) => {
    const file = path.join(orch, f);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Every directory on the way must really be inside the project: a symlinked .orchestra/rooms (or .orchestra) that
    // points elsewhere would let the rename land outside the project.
    const realDir = fs.realpathSync(path.dirname(file)), realProject = fs.realpathSync(project);
    if (realDir !== realProject && !realDir.startsWith(realProject + path.sep)) throw Object.assign(new Error(`refusing to write outside the project: ${file}`), { code: 'EOUTSIDE' });
    try { if (fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error(`refusing to write through a symlink: ${file}`), { code: 'ESYMLINK' }); } catch (e) { if (e.code === 'ESYMLINK') throw e; }
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, s);
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); return; }
      catch (e) {
        if (i < 8 && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) { sleepMs(25 * (i + 1)); continue; }
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
    }
  };
  const readJson = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
  const writeJson = (f, obj) => write(f, JSON.stringify(obj, null, 2));

  function appendLog(agent, text) {
    const cur = read('LOG.md') ?? '# Orchestra log\n\n';
    write('LOG.md', cur.replace(/\s*$/, '\n') + `- ${today()} | ${agent} | ${text.replace(/\s+/g, ' ').trim()}\n`);
  }

  // Creates .orchestra/ and, once, a .gitignore inside it that keeps the session token out of version control
  // (users are free to commit the rest of the directory). An existing .gitignore keeps its lines and only gains the
  // required ones. capability.json is ignored too: the board no longer reads one there (write checks are stored per
  // user), and a stale or forged copy must not travel with the repository.
  const GITIGNORE = '# Written by Agent Orchestra Board. The session token must never be committed; the rest is your call.\nsession\nempty/\nworktrees/\ncapability.json\n';
  function ensure() {
    fs.mkdirSync(orch, { recursive: true });
    const gi = path.join(orch, '.gitignore');
    try { fs.writeFileSync(gi, GITIGNORE, { flag: 'wx' }); return; } catch {} // created now (or read-only: nothing to do)
    // An existing .gitignore (the user's own) keeps its lines, but the session token (and the rest) must still be ignored.
    try {
      const cur = fs.readFileSync(gi, 'utf8');
      const lines = cur.split(/\r?\n/).map((l) => l.trim());
      const missing = [];
      if (!lines.some((l) => /^\/?session\s*$/.test(l))) missing.push('session');
      if (!lines.some((l) => /^\/?worktrees\/?\s*$/.test(l))) missing.push('worktrees/');
      if (!lines.some((l) => /^\/?capability\.json\s*$/.test(l))) missing.push('capability.json');
      if (missing.length) fs.appendFileSync(gi, `${cur.endsWith('\n') || !cur ? '' : '\n'}${missing.join('\n')}\n`);
    } catch {}
  }

  return { project, orch, roomDir, read, write, readJson, writeJson, appendLog, ensure };
}

module.exports = { createStore };
