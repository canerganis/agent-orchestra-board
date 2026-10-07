// .orchestra/ paths and JSON persistence for one project.
const fs = require('fs');
const path = require('path');
const { today } = require('./util');

function createStore(projectDir) {
  const project = path.resolve(projectDir || process.cwd());
  const orch = path.join(project, '.orchestra');
  const roomDir = path.join(orch, 'rooms');

  const read = (f) => { try { return fs.readFileSync(path.join(orch, f), 'utf8'); } catch { return null; } };
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(orch, f)), { recursive: true }); fs.writeFileSync(path.join(orch, f), s); };
  const readJson = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
  const writeJson = (f, obj) => write(f, JSON.stringify(obj, null, 2));

  function appendLog(agent, text) {
    const cur = read('LOG.md') ?? '# Orchestra log\n\n';
    write('LOG.md', cur.replace(/\s*$/, '\n') + `- ${today()} | ${agent} | ${text.replace(/\s+/g, ' ').trim()}\n`);
  }

  // Creates .orchestra/ and, once, a .gitignore inside it that keeps the session token out of version control
  // (users are free to commit the rest of the directory). An existing .gitignore is left alone.
  const GITIGNORE = '# Written by Orchestra Board. The session token must never be committed; the rest is your call.\nsession\nempty/\n';
  function ensure() {
    fs.mkdirSync(orch, { recursive: true });
    const gi = path.join(orch, '.gitignore');
    try { fs.writeFileSync(gi, GITIGNORE, { flag: 'wx' }); } catch {} // exists (EEXIST) or read-only: fine
  }

  return { project, orch, roomDir, read, write, readJson, writeJson, appendLog, ensure };
}

module.exports = { createStore };
