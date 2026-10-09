// Engine registry (plan 3.1 and 2.6). Three engines are listed for the UI: the board team, which runs the build workflow
// on the user's agents, and two handoff engines, Claude Code and Codex, which the user runs in their own CLI.
// engineInfo() is the availability rule for all three: a pure function of the doctor's CLI states, the cached write
// status and the two data folders. The registry holds the engines that can start (the board team in this build; the
// handoff engines register with F7), and publish() is the one way an engine saves a run and announces it.
// Nothing here spawns a process or reads a CLI's files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpError } = require('../util');

const ENGINE_IDS = Object.freeze(['board', 'claude-code', 'codex']);
const LABELS = Object.freeze({ board: 'Board team', 'claude-code': 'Claude Code, you run it', codex: 'Codex, you run it' });
const CLI_NAMES = Object.freeze({ claude: 'Claude Code CLI', codex: 'Codex CLI' });
const AGENTS = Object.freeze(['claude', 'codex']);
const CLI_STATES = Object.freeze(['ok', 'warn', 'broken', 'missing']);
// A run room keeps at most this many agents (plan 3.1); the oldest ones drop out first.
const RUN_AGENTS_MAX = 300;
// A run room is saved at most this often while its agents change (plan 3.1).
const SAVE_INTERVAL_MS = 5000;

// The doctor's checks for the two CLIs, by id. Login checks are never read here: they do not change a CLI's state.
function cliChecks(checks) {
  const find = (id) => (Array.isArray(checks) ? checks.find((c) => c && c.id === id) || null : null);
  return { claude: find('claude'), codex: find('codex') };
}

// A CLI's state from env.cli[agent]: a doctor check carrying `state`, or the state string itself. Anything else counts
// as 'missing', so an unknown CLI is never offered as usable.
function stateOf(env, agent) {
  const c = env && env.cli ? env.cli[agent] : null;
  const s = c && typeof c === 'object' ? c.state : c;
  return CLI_STATES.includes(s) ? s : 'missing';
}
// The doctor's detail line for a CLI, when there is one. It is plain text and shown as it is.
function detailOf(env, agent) {
  const c = env && env.cli ? env.cli[agent] : null;
  return c && typeof c === 'object' && typeof c.detail === 'string' && c.detail ? c.detail : null;
}

// Where Claude Code and Codex keep their data (plan 2.6): CLAUDE_CONFIG_DIR or ~/.claude, CODEX_HOME or ~/.codex.
function homesOf(env = process.env) {
  return {
    claudeHome: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codexHome: env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  };
}
// The homes an env names (claudeHome, codexHome), with the defaults for any it leaves out.
function homesIn(env = {}) {
  const d = homesOf(process.env);
  return { claudeHome: env.claudeHome || d.claudeHome, codexHome: env.codexHome || d.codexHome };
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// The Runs view needs no CLI: it shows when <claudeHome>/projects exists (plan 2.5 and 2.6).
function watchOf(env = {}) {
  return { claude: isDir(path.join(homesIn(env).claudeHome, 'projects')) };
}

// The board team runs on the CLIs the board can start: 'ok' and 'warn' are usable, 'broken' turns that CLI's seats off
// (plan 2.6), and 'missing' hides the engine when no CLI is installed at all.
function boardInfo(env) {
  const states = { claude: stateOf(env, 'claude'), codex: stateOf(env, 'codex') };
  const present = AGENTS.some((a) => states[a] !== 'missing');
  const usable = AGENTS.some((a) => states[a] === 'ok' || states[a] === 'warn');
  let reason = null, note = null;
  if (!usable) {
    reason = present
      ? AGENTS.filter((a) => states[a] === 'broken').map((a) => `${CLI_NAMES[a]} cannot be started by the board${detailOf(env, a) ? `: ${detailOf(env, a)}` : ''}`).join('; ')
      : 'Neither Claude Code nor Codex is installed: no CLI was found on PATH.';
  } else {
    note = AGENTS.flatMap((a) => {
      if (states[a] === 'warn') return [`${CLI_NAMES[a]}: ${detailOf(env, a) || 'check the setup'}`];
      if (states[a] === 'broken') return [`${CLI_NAMES[a]} cannot be started, so its seats are off`];
      return [];
    }).join('; ') || null;
  }
  // The build modes the board can run now: propose always; write once Claude has passed its write check, or when a
  // usable Codex CLI can build in patch mode (read only, the board applies its diff: Appendix B item 2), which needs
  // only a usable repository.
  const cap = env.capability;
  const codexPatch = !!cap && cap.repo?.ok === true && (states.codex === 'ok' || states.codex === 'warn');
  const writes = !!cap && (AGENTS.some((a) => cap.agents?.[a]?.available === true) || codexPatch);
  const modes = usable ? [...(writes ? ['write'] : []), 'propose'] : [];
  return { id: 'board', label: LABELS.board, launch: 'board', available: usable, hidden: !present, reason, note, modes };
}

// A handoff engine (plan 3.2): the user runs the CLI, and the board only writes the handoff and watches the run. It
// shows when its CLI is not missing or its data folder exists (plan 2.6). It stays available while shown: the board
// never launches the CLI, so a broken or missing one does not stop the handoff.
function handoffInfo(id, agent, env) {
  const state = stateOf(env, agent);
  const homes = homesIn(env);
  const folder = agent === 'claude' ? path.join(homes.claudeHome, 'projects') : path.join(homes.codexHome, 'sessions');
  const hidden = state === 'missing' && !isDir(folder);
  const name = agent === 'claude' ? 'Claude Code' : 'Codex';
  let note = null;
  if (state === 'warn') note = `${CLI_NAMES[agent]}: ${detailOf(env, agent) || 'check the setup'}`;
  else if (state === 'broken') note = `${CLI_NAMES[agent]} cannot be started by the board. You can still run it yourself.`;
  else if (state === 'missing') note = `${CLI_NAMES[agent]} is not on PATH. Run it from wherever it is installed.`;
  // No build modes: the board runs no build for a handoff, and the run is outside the write gate.
  return {
    id, label: LABELS[id], launch: 'handoff', available: !hidden, hidden,
    reason: hidden ? `${name} is not installed and no data folder was found at ${folder}.` : null,
    note: hidden ? null : note, modes: [],
  };
}

// EngineInfo (plan 3.1) for one engine id. env: { cli: { claude, codex } (doctor checks or state strings), capability
// (the cached write status, or null), claudeHome, codexHome }.
function engineInfo(id, env = {}) {
  const e = env || {};
  if (id === 'board') return boardInfo(e);
  if (id === 'claude-code') return handoffInfo(id, 'claude', e);
  if (id === 'codex') return handoffInfo(id, 'codex', e);
  throw new Error(`unknown engine: ${String(id)}`);
}

// Agents keyed by id: a changed agent keeps its place, a new one goes last, and only the last RUN_AGENTS_MAX stay.
function mergeAgents(current, changed) {
  const byId = new Map();
  for (const a of Array.isArray(current) ? current : []) if (a && a.id !== undefined) byId.set(a.id, a);
  for (const a of changed) byId.set(a.id, a);
  const all = [...byId.values()];
  return all.length > RUN_AGENTS_MAX ? all.slice(all.length - RUN_AGENTS_MAX) : all;
}

// The registry. Options: rooms (createRooms: live, saveRoom, rooms), broadcast (the SSE sender), env (returns the
// current engineInfo env). now, setTimer, clearTimer and saveIntervalMs exist for tests.
function createEngines({ rooms, broadcast = () => {}, env = () => ({}), now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, saveIntervalMs = SAVE_INTERVAL_MS } = {}) {
  const registry = new Map();
  const saveStates = new WeakMap(); // room -> { last, timer }
  const pending = new Set(); // rooms with a trailing save scheduled
  const logError = (msg) => console.error(`orchestra-board: ${msg}`);

  // The engine a room belongs to: a run room names its engine, and a build room belongs to the board team.
  const engineIdOf = (room) => (room && room.kind === 'run' ? room.engine : room && room.kind === 'build' ? 'board' : null);

  function register(engine) {
    if (!engine || !ENGINE_IDS.includes(engine.id)) throw new Error(`not an engine id: ${engine && engine.id}`);
    registry.set(engine.id, engine);
  }
  const get = (id) => registry.get(id) || null;
  const list = (e = env()) => ENGINE_IDS.map((id) => engineInfo(id, e));

  function saveNow(room, st) {
    pending.delete(room);
    if (st.timer) { clearTimer(st.timer); st.timer = null; }
    st.last = now();
    rooms.saveRoom(room);
  }
  // At most one save per saveIntervalMs. A call inside the window schedules one trailing save, so the last state always
  // reaches disk. The timer is unref'd, so it never keeps the process alive; close() writes it now.
  function scheduleSave(room) {
    let st = saveStates.get(room);
    if (!st) { st = { last: -Infinity, timer: null }; saveStates.set(room, st); }
    if (st.timer) return;
    const wait = st.last + saveIntervalMs - now();
    if (wait <= 0) { saveNow(room, st); return; }
    pending.add(room);
    st.timer = setTimer(() => { st.timer = null; saveNow(room, st); }, wait);
    if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
  }

  // The one way an engine changes a run room: the run summary and the agents that changed are stored, the room is saved
  // (throttled), and one { t: 'engine', roomId, run, agents } event goes out. Nothing is sent for a deleted room.
  function publish(room, run, changed = []) {
    if (!room || !rooms.live(room)) return false;
    const agents = (Array.isArray(changed) ? changed : []).filter((a) => a && typeof a === 'object' && a.id !== undefined);
    room.run = run === undefined ? (room.run ?? null) : run;
    if (agents.length) room.agents = mergeAgents(room.agents, agents);
    broadcast({ t: 'engine', roomId: room.id, run: room.run, agents });
    scheduleSave(room);
    return true;
  }

  // POST /api/run: the named engine starts a run for a plan. A name that is not registered is 400 unknown-engine.
  async function start(id, planRoom, { revision, hash, options } = {}) {
    const eng = get(id);
    if (!eng) throw httpError(400, `unknown engine: ${String(id)}`, 'unknown-engine');
    return eng.start(planRoom, { revision, hash, options });
  }
  // A room is deleted: its engine releases its followers and timers, and a pending save is dropped (the file goes too).
  function dispose(room) {
    if (!room) return;
    const eng = get(engineIdOf(room));
    if (eng && typeof eng.dispose === 'function') { try { eng.dispose(room); } catch (e) { logError(`could not dispose room ${room.id}: ${e.message}`); } }
    const st = saveStates.get(room);
    if (st && st.timer) { clearTimer(st.timer); st.timer = null; }
    pending.delete(room);
  }
  // Board start: every room of a registered engine gets recover() once, so it can re-follow what it was watching.
  function recover() {
    for (const room of rooms.rooms.values()) {
      const eng = get(engineIdOf(room));
      if (!eng || typeof eng.recover !== 'function') continue;
      try { eng.recover(room); } catch (e) { logError(`could not recover room ${room.id}: ${e.message}`); }
    }
  }
  // Board shutdown: pending saves are written now, so the last state of every run reaches disk.
  function close() {
    for (const room of [...pending]) {
      const st = saveStates.get(room);
      if (st) saveNow(room, st); else pending.delete(room);
    }
  }

  return { register, get, list, publish, start, dispose, recover, close };
}

module.exports = { ENGINE_IDS, LABELS, RUN_AGENTS_MAX, SAVE_INTERVAL_MS, engineInfo, createEngines, cliChecks, homesOf, watchOf, mergeAgents };
