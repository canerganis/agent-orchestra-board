// Shared part of the two handoff engines (plan 3.3, F7): Claude Code and Codex, both run by the user in their own CLI.
// The board writes a handoff file and a paste prompt, finds the run by its code, links it after one click, mirrors its
// agents live and, once the run ends, shows what changed with read-only git. The board never starts or stops the run,
// and the run is outside the write gate: the handoff rules are guidance only.
//
// createHandoffEngine() holds everything both engines share: the approval check, the run room, candidates, link,
// unlink, stop, dispose, recover, the planChanged check and the publish rate limit. An adapter (claude-code.js,
// codex.js) brings the engine's own parts: how candidates are found, how a linked run is followed and how its status
// reads. Prompt and result text never reach a run room: adapters pass labels, models, statuses and counts only.
const crypto = require('crypto');
const path = require('path');
const worktree = require('../worktree');
const { httpError } = require('../util');
const { MODEL_RE } = require('../seats');
const { engineInfo, mergeAgents } = require('./index');

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TOKEN_RE = /^ob[a-z2-7]{6}$/;
// Candidates are runs that started at most this long before the handoff (clocks and slow saves differ a little).
const WINDOW_MS = 60 * 1000;
// At most this many engine events per room per second (plan F7.5: 2 per second).
const EVENT_GAP_MS = 500;
const CANDIDATES_MAX = 20;
const STAT_LINES = 40;
const TIERS = Object.freeze(['easy', 'medium', 'hard']);
const DEFAULT_TIERS = Object.freeze({
  'claude-code': Object.freeze({ easy: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', hard: 'claude-opus-5-5' }),
  codex: Object.freeze({ easy: 'gpt-6-luna', medium: 'gpt-6-luna', hard: 'gpt-6.1-sol' }),
});
const ENGINE_NAMES = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex' });
// Run statuses after which the run is over: the changes are computed once at the first of them.
const ENDED = new Set(['done', 'stopped', 'unknown']);
// A linked run is not followed for ever. 'done' releases its follower at once. 'stopped' and 'unknown' can still turn
// back into running (a Codex turn that went silent and resumes), so they release after this long without a change.
// The room stays linked; a released run is read again on demand (candidates) and at board start.
const RELEASE_MS = 10 * 60 * 1000;
const HEAD_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ITEM_FIELDS = Object.freeze(['id', 'title', 'spec', 'owns', 'dependsOn', 'difficulty']);

// A run code: 'ob' plus 6 characters from [a-z2-7] (plan 3.3, step 2).
function newToken() {
  let s = 'ob';
  for (let i = 0; i < 6; i++) s += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)];
  return s;
}
const isToken = (s) => typeof s === 'string' && TOKEN_RE.test(s);

// The plan items as the handoff shows them: only id, title, spec, owns, dependsOn and difficulty. No seat ids, no
// usage, nothing else the plan room holds.
function handoffItems(plan) {
  const items = plan && Array.isArray(plan.items) ? plan.items : [];
  return items.map((it) => Object.fromEntries(ITEM_FIELDS.map((k) => [k, it[k]])));
}

// An item id as a Codex task name carries it: lowercased, '-' turned into '_', anything outside [a-z0-9_] dropped.
const taskKey = (id) => String(id).toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '');
// Map from the sanitized task name part to the item id, for every item (items or plain ids). Plan ids hold no '_', so
// two ids never share a key; a key that is still taken (or empty) gets a numbered suffix so the map stays one to one.
function sanitizeItemIds(items) {
  const map = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const id = typeof it === 'string' ? it : it && typeof it.id === 'string' ? it.id : null;
    if (id === null) continue;
    const base = taskKey(id) || 'item';
    let key = base;
    for (let n = 2; map.has(key); n++) key = `${base}_${n}`;
    map.set(key, id);
  }
  return map;
}

// The suggested model per difficulty, written into the handoff and never enforced. options: { tiers: { easy, medium,
// hard } }; a missing tier takes the engine's default. Anything else is 400 invalid-options.
function tiersOf(engine, options) {
  const invalid = (m) => httpError(400, m, 'invalid-options');
  const out = { ...(DEFAULT_TIERS[engine] || {}) };
  if (options === undefined || options === null) return out;
  if (typeof options !== 'object' || Array.isArray(options)) throw invalid('options must be an object');
  for (const k of Object.keys(options)) if (k !== 'tiers') throw invalid(`unknown option "${k}"`);
  const t = options.tiers;
  if (t === undefined || t === null) return out;
  if (typeof t !== 'object' || Array.isArray(t)) throw invalid('tiers must be an object of model names');
  for (const [k, val] of Object.entries(t)) {
    if (!TIERS.includes(k)) throw invalid(`unknown tier "${k}"`);
    if (val === null || val === '') continue;
    if (typeof val !== 'string' || !MODEL_RE.test(val)) throw invalid(`tier ${k}: not a model name`);
    out[k] = val;
  }
  return out;
}

// A code fence longer than any backtick run in text, so plan text can never close it.
function fenceFor(text) {
  const runs = String(text).match(/`+/g) || [];
  return '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}
const oneLine = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// The handoff file (plan 3.3): goal, revision, hash, run code, the rules, the suggested tiers and the plan items as
// JSON. engine: 'claude-code' or 'codex'. The plan revision is planRoom.planRevision and its hash planRoom.planHash.
function handoffMarkdown(planRoom, { engine, token, tiers } = {}) {
  if (!ENGINE_NAMES[engine]) throw new Error(`not a handoff engine: ${engine}`);
  const plan = planRoom.plan || { goal: '', items: [] };
  const items = handoffItems(plan);
  const t = { ...(DEFAULT_TIERS[engine] || {}), ...(tiers || {}) };
  const json = JSON.stringify(items, null, 2);
  const fence = fenceFor(json);
  const goalFence = fenceFor(plan.goal || '');
  const L = [];
  L.push(`# Handoff: ${oneLine(plan.goal || planRoom.title, 100)}`);
  L.push('');
  L.push(`Written by Agent Orchestra Board for ${ENGINE_NAMES[engine]}. Run it yourself; the board watches the run and never starts or stops it.`);
  L.push('');
  L.push(`* Plan: ${planRoom.id}, revision ${planRoom.planRevision}`);
  L.push(`* Plan hash: ${planRoom.planHash}`);
  L.push(`* Run code: ${token}`);
  L.push('');
  L.push('## Goal');
  L.push('');
  L.push(goalFence + 'text', plan.goal || '', goalFence);
  L.push('');
  L.push('## How to run it');
  L.push('');
  if (engine === 'claude-code') {
    L.push('1. Run this plan with a Workflow: one agent per plan item. An item starts only after every item in its `dependsOn` list is done.');
    L.push(`2. Label every agent \`${token}:<itemId>:<tier>\`, where tier is the item's difficulty (for example \`${token}:${items[0] ? items[0].id : 'item'}:${items[0] ? items[0].difficulty : 'easy'}\`). The board finds and follows the run by these labels.`);
  } else {
    const keys = [...sanitizeItemIds(items).entries()];
    L.push('1. Run this plan with sub-agents: call `spawn_agent` once per plan item. An item starts only after every item in its `dependsOn` list is done.');
    L.push(`2. Give each sub-agent the \`task_name\` from this table, exactly as written. The board finds and follows the run by these names.`);
    L.push('');
    L.push('| Item | task_name |');
    L.push('|---|---|');
    for (const [key, id] of keys) L.push(`| ${id} | ${token}_${key} |`);
  }
  L.push('');
  L.push('3. Suggested models by difficulty (a suggestion, not enforced):');
  for (const k of TIERS) L.push(`   * ${k}: ${t[k] || 'your choice'}`);
  L.push('');
  L.push('## Rules');
  L.push('');
  L.push('1. Do not edit the main checkout. Make the changes in a git worktree, or on a new branch named `ob/' + token + '`.');
  L.push('2. Leave the changes uncommitted for review: no commit, no push, no merge.');
  L.push("3. Each item changes only the paths in its `owns` list.");
  L.push('4. This run is outside the board\'s write gate. These rules are the only guard, so follow them.');
  L.push('');
  L.push('## Plan items');
  L.push('');
  L.push(fence + 'json', json, fence);
  L.push('');
  return L.join('\n');
}

// The text the user pastes into the CLI (plan 2.4). A prompt, not a shell command, so no shell quoting applies.
function pastePrompt(engine, file) {
  const f = String(file).replace(/\\/g, '/');
  if (engine === 'codex') return `Read ${f} and run it with sub-agents (spawn_agent), giving each the task_name it lists and following its rules.`;
  return `Read ${f} and run it with a Workflow, following its rules.`;
}

// ---------- read-only git ----------

const PATHSPEC = ['--', '.', ':(exclude).orchestra'];
function git(project, args) {
  try { return worktree.runGit(project, args); } catch { return { ok: false, stdout: '', stderr: 'git was not found' }; }
}
const lines0 = (s) => String(s || '').split('\0').filter(Boolean);
// The commit HEAD points at, or null (not a repository, no commit yet, no git).
function headOf(project) {
  const r = git(project, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const h = r.ok ? String(r.stdout).trim() : '';
  return HEAD_RE.test(h) ? h : null;
}
// Every worktree of the repository as git lists it, or [] when there is none to list.
function worktreeList(project) {
  const r = git(project, ['worktree', 'list', '--porcelain', '-z']);
  if (!r.ok) return [];
  return lines0(r.stdout).filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
}
const isRepo = (project) => {
  const r = git(project, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && String(r.stdout).trim() === 'true';
};

// What changed since the handoff (plan 3.3, step 6), with read-only git only: the number of changed files (tracked
// changes against baseHead plus untracked files, .orchestra left out), the first 40 lines of `git diff --stat
// <baseHead>`, and the worktrees that did not exist at the handoff (the board's own build worktrees left out).
// A folder that is not a git repository gives { git: false }.
function changesSince(project, baseHead, worktreesAtHandoff = []) {
  if (!isRepo(project)) return { git: false };
  const base = typeof baseHead === 'string' && HEAD_RE.test(baseHead) ? baseHead : null;
  const files = new Set();
  let stat = '';
  if (base) {
    const d = git(project, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', base, ...PATHSPEC]);
    if (d.ok) for (const f of lines0(d.stdout)) files.add(f);
    const s = git(project, ['diff', '--stat', '--no-ext-diff', '--no-textconv', '--no-color', base, ...PATHSPEC]);
    if (s.ok) stat = String(s.stdout).split(/\r?\n/).filter((l) => l !== '').slice(0, STAT_LINES).join('\n');
  } else {
    const d = git(project, ['diff', '--name-only', '-z', '--cached', '--no-renames', ...PATHSPEC]);
    if (d.ok) for (const f of lines0(d.stdout)) files.add(f);
  }
  const u = git(project, ['ls-files', '--others', '--exclude-standard', '-z', ...PATHSPEC]);
  if (u.ok) for (const f of lines0(u.stdout)) files.add(f);
  const before = new Set((Array.isArray(worktreesAtHandoff) ? worktreesAtHandoff : []).map((p) => worktree.canon(p)));
  const boardRoot = path.join(project, '.orchestra', 'worktrees');
  const newWorktrees = worktreeList(project).filter((p) => !before.has(worktree.canon(p)) && !worktree.within(p, boardRoot));
  return { git: true, files: files.size, stat, newWorktrees };
}

// ---------- plan checks ----------

// The same rule as plan.isApproved: the current approval names this hash, and the plan still has it.
function isApprovedAt(planRoom, hash) {
  return !!planRoom && planRoom.kind === 'plan' && !!planRoom.approval && planRoom.approval.decision === 'approved'
    && planRoom.approval.hash === hash && planRoom.planHash === hash;
}
// True when the plan was edited, rejected or deleted after the handoff (plan 3.3, step 7).
const planChangedFor = (room, planRoom) => !isApprovedAt(planRoom, room.planHash);
// The plan as it was handed off: that revision when the plan room still keeps it, else the current plan.
function handedPlan(room, planRoom) {
  if (!planRoom) return null;
  const rev = Array.isArray(planRoom.revisions) ? planRoom.revisions.find((r) => r && r.revision === room.planRevision && r.hash === room.planHash) : null;
  return (rev && rev.plan) || planRoom.plan || null;
}
// Item ids the handoff named.
const itemIdsOf = (plan) => (plan && Array.isArray(plan.items) ? plan.items.map((it) => it.id).filter((id) => typeof id === 'string') : []);

// How many of the item ids appear in the text as whole ids (case-insensitive).
function mentions(text, ids) {
  const s = String(text || '').toLowerCase();
  let n = 0;
  for (const id of ids) {
    const esc = String(id).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(s)) n += 1;
  }
  return n;
}
// Token matches first, then the higher score, then the newer run; at most CANDIDATES_MAX.
function rankCandidates(list) {
  return list
    .sort((a, b) => (Number(b.tokenMatch) - Number(a.tokenMatch)) || (b.score - a.score) || ((b.startedAt || 0) - (a.startedAt || 0)))
    .slice(0, CANDIDATES_MAX);
}

// ---------- the engine ----------

// A handoff engine. adapter: {
//   candidates(room, plan, sinceMs) -> Candidate[]   { ref, title, status, startedAt, agentCount, tokens, tokenMatch, score }
//   linkOf(ref) -> { runId } | { parentThreadId }
//   follow(room, plan, update) -> stop()             update({ run, agents, status }) with changed agents only
//   derive(room, plan) -> { run, agents, status } | null   the run as it reads now (recover)
//   refOf(linked) -> string
// }
// rooms: createRooms(); engines: createEngines() (publish); store: createStore() (write); project: the project folder;
// info: () => EngineInfo now. now, setTimer, clearTimer, eventGapMs and releaseMs exist for tests.
function createHandoffEngine({ id, adapter, rooms, engines, store, project, info, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, eventGapMs = EVENT_GAP_MS, releaseMs = RELEASE_MS }) {
  if (!ENGINE_NAMES[id]) throw new Error(`not a handoff engine: ${id}`);
  const follows = new Map(); // room id -> { room, stop }
  const outbox = new Map();  // room id -> { last, timer, run, agents: Map }
  const releases = new Map(); // room id -> timer that releases a run which stayed stopped or unknown
  const reading = new Set();  // room ids inside readLinked: the follower stays until the reading is done
  const logError = (msg) => console.error(`orchestra-board: ${msg}`);

  const own = (room) => !!room && room.kind === 'run' && room.engine === id;
  function mustOwn(room) {
    if (!own(room)) throw httpError(404, 'no such run room', 'no-run');
    return room;
  }
  const planRoomOf = (room) => rooms.rooms.get(room.planRoomId) || null;
  const planOf = (room) => handedPlan(room, planRoomOf(room));
  const sinceOf = (room) => (Number.isFinite(room.handoffMs) ? room.handoffMs : 0) - WINDOW_MS;

  // Sets planChanged from the plan room as it is now. Returns true when the flag flipped.
  function checkPlan(room) {
    const changed = planChangedFor(room, planRoomOf(room));
    if (changed === !!room.planChanged) return false;
    room.planChanged = changed;
    return true;
  }

  // ---- publish: one engine event per change, at most one per eventGapMs per room; saves through engines.publish
  // (at most one per 5 s) except on a status change, which saves now.
  function flush(roomId) {
    const box = outbox.get(roomId);
    if (!box) return;
    if (box.timer) { clearTimer(box.timer); box.timer = null; }
    if (!box.dirty) return;
    const f = follows.get(roomId);
    const room = f ? f.room : null;
    box.dirty = false;
    box.last = now();
    const agents = [...box.agents.values()];
    box.agents.clear();
    if (room && rooms.live(room)) engines.publish(room, box.run, agents);
  }
  function queue(room, run, agents) {
    let box = outbox.get(room.id);
    if (!box) { box = { last: -Infinity, timer: null, run: null, agents: new Map(), dirty: false }; outbox.set(room.id, box); }
    if (run !== undefined) box.run = run;
    for (const a of agents) box.agents.set(a.id, a);
    box.dirty = true;
    if (box.timer) return;
    const wait = box.last + eventGapMs - now();
    if (wait <= 0) { flush(room.id); return; }
    box.timer = setTimer(() => { box.timer = null; flush(room.id); }, wait);
    if (box.timer && typeof box.timer.unref === 'function') box.timer.unref();
  }
  function dropOutbox(roomId) {
    const box = outbox.get(roomId);
    if (box && box.timer) clearTimer(box.timer);
    outbox.delete(roomId);
  }

  // A run ended: the changes are computed once (read-only git) and kept on the room.
  function noteEnd(room) {
    if (!ENDED.has(room.status) || room.changes) return;
    try { room.changes = changesSince(project, room.baseHead, room.worktreesAtHandoff); }
    catch (e) { logError(`could not compute the changes of run room ${room.id}: ${e.message}`); }
  }

  // One update from the adapter: the run summary, the agents that changed and the run status.
  function onUpdate(room, upd) {
    if (!rooms.live(room) || !follows.has(room.id) || !upd) return;
    let urgent = checkPlan(room);
    if (typeof upd.status === 'string' && upd.status !== room.status) {
      room.status = upd.status;
      noteEnd(room);
      urgent = true;
    }
    const agents = (Array.isArray(upd.agents) ? upd.agents : []).filter((a) => a && typeof a === 'object' && typeof a.id === 'string' && a.id);
    if (urgent && upd.run !== undefined) room.run = upd.run;
    queue(room, upd.run, agents);
    if (urgent) rooms.pushRoom(room); // a status or plan change is saved now and announced as a room change
    settle(room);
  }

  // An ended run lets its follower go: the last agents are published first, then the follower stops. room.linked stays.
  function release(room) {
    if (!follows.has(room.id)) return;
    flush(room.id);
    stopFollow(room);
  }
  function dropRelease(roomId) {
    const h = releases.get(roomId);
    if (h) clearTimer(h);
    releases.delete(roomId);
  }
  // After an update: 'done' releases now, 'stopped' and 'unknown' after releaseMs unless the run comes back first.
  function settle(room) {
    if (!follows.has(room.id) || reading.has(room.id)) return;
    if (!ENDED.has(room.status)) { dropRelease(room.id); return; }
    if (room.status === 'done') { release(room); return; }
    if (releases.has(room.id)) return;
    const h = setTimer(() => {
      releases.delete(room.id);
      if (ENDED.has(room.status)) release(room);
    }, releaseMs);
    if (h && typeof h.unref === 'function') h.unref();
    releases.set(room.id, h);
  }

  function stopFollow(room) {
    const f = follows.get(room.id);
    follows.delete(room.id);
    dropRelease(room.id);
    if (f && typeof f.stop === 'function') { try { f.stop(); } catch {} }
    dropOutbox(room.id);
  }

  // Follows a linked run for one reading: the room takes the status, run and agents it has now. A run that is still
  // going stays followed; an ended one is released again at once.
  function readLinked(room) {
    let d = null;
    reading.add(room.id);
    try {
      startFollow(room);
      d = adapter.derive(room, planOf(room));
    } catch (e) { logError(`could not read the run of room ${room.id}: ${e.message}`); }
    finally { reading.delete(room.id); }
    if (d) {
      room.status = d.status || 'unknown';
      if (d.run !== undefined) room.run = d.run;
      if (Array.isArray(d.agents)) room.agents = mergeAgents(room.agents || [], d.agents.filter((a) => a && typeof a.id === 'string' && a.id));
    } else room.status = 'unknown';
    noteEnd(room);
    if (ENDED.has(room.status)) release(room);
  }
  function startFollow(room) {
    stopFollow(room);
    const entry = { room, stop: null };
    follows.set(room.id, entry);
    // The adapter may report before follow() returns; onUpdate only needs the entry to exist.
    const stop = adapter.follow(room, planOf(room), (upd) => onUpdate(room, upd));
    if (follows.get(room.id) === entry) entry.stop = stop; else if (typeof stop === 'function') { try { stop(); } catch {} }
  }

  const api = {
    id,
    info: (e) => (e ? engineInfo(id, e) : info()),

    // Plan 3.3 steps 1 and 2: approval at this revision and hash (409 not-approved), the options (400 invalid-options),
    // the engine shown (409 engine-unavailable); then the handoff file, then the run room in 'waiting'.
    async start(planRoom, { revision, hash, options } = {}) {
      if (!planRoom || planRoom.kind !== 'plan') throw httpError(404, 'no such plan', 'no-plan');
      if (revision !== planRoom.planRevision || !isApprovedAt(planRoom, hash)) {
        throw httpError(409, 'the plan is not approved at this revision', 'not-approved');
      }
      const tiers = tiersOf(id, options);
      const inf = info();
      if (!inf || !inf.available) throw httpError(409, (inf && inf.reason) || `${ENGINE_NAMES[id]} is not available`, 'engine-unavailable');
      const token = newToken();
      const rel = `handoff/${planRoom.id}-r${revision}-${token}.md`;
      const handoffMs = now();
      store.write(rel, handoffMarkdown(planRoom, { engine: id, token, tiers }));
      const room = rooms.newRoom('run', `${ENGINE_NAMES[id]} run: ${oneLine(planRoom.title, 60)}`, {
        status: 'waiting', engine: id,
        planRoomId: planRoom.id, planRevision: revision, planHash: hash, planChanged: false,
        token, handoffFile: `.orchestra/${rel}`, handoffMs,
        baseHead: headOf(project), worktreesAtHandoff: worktreeList(project),
        linked: null, run: null, agents: [], changes: null,
      });
      return { room, pastePrompt: pastePrompt(id, room.handoffFile) };
    },

    // Plan 3.3 step 5: runs that carry the code first, then runs started since the handoff, scored by item ids.
    candidates(room) {
      mustOwn(room);
      if (checkPlan(room)) rooms.pushRoom(room);
      if (room.linked && !follows.has(room.id)) api.refresh(room);
      if (!isToken(room.token)) return [];
      let list = [];
      try { list = adapter.candidates(room, planOf(room), sinceOf(room)) || []; }
      catch (e) { logError(`could not list run candidates for room ${room.id}: ${e.message}`); }
      return rankCandidates(list);
    },

    // Links one listed candidate (400 not-a-candidate otherwise) and starts following it.
    link(room, ref) {
      mustOwn(room);
      if (typeof ref !== 'string' || !ref || ref.length > 200) throw httpError(400, 'ref must name a listed run', 'invalid-ref');
      if (room.linked) throw httpError(409, 'this room is already linked to a run: unlink it first', 'already-linked');
      const hit = api.candidates(room).find((c) => c.ref === ref);
      if (!hit) throw httpError(400, 'that run is not one of the candidates: use Find my run again', 'not-a-candidate');
      Object.assign(room, { linked: adapter.linkOf(ref), run: null, agents: [], changes: null, status: 'running' });
      startFollow(room);
      const d = adapter.derive(room, planOf(room));
      if (d) onUpdate(room, d);
      rooms.pushRoom(room);
      return { linked: room.linked, status: room.status };
    },

    // Stops following the linked run and waits for another link. The user's run goes on.
    unlink(room) {
      mustOwn(room);
      stopFollow(room);
      Object.assign(room, { linked: null, run: null, agents: [], changes: null, status: 'waiting' });
      checkPlan(room);
      rooms.pushRoom(room);
      engines.publish(room, null, []);
      return true;
    },

    // The board stops watching (= unlink) and the room ends as stopped. The user's run is never killed.
    stop(room) {
      if (!own(room)) return false;
      api.unlink(room);
      room.status = 'stopped';
      rooms.pushRoom(room);
      return true;
    },

    // On demand: a linked run that was released (it had ended) is read once more. If it runs again it is followed
    // again; otherwise the room takes what it reads now and nothing keeps polling. A followed room is left alone.
    refresh(room) {
      if (!own(room) || !room.linked || follows.has(room.id)) return false;
      const before = room.status;
      readLinked(room);
      if (room.status !== before) rooms.pushRoom(room);
      return true;
    },

    // The room is deleted: its follower and timers go.
    dispose(room) {
      if (!room) return;
      stopFollow(room);
    },

    // Board start: a linked room reads its run once and takes the status the run has now (rooms.load turned a
    // running room into stopped). Only a run that is still going stays followed; an ended one is read on demand
    // (candidates) from then on. The plan check runs too, and the room is saved.
    recover(room) {
      if (!own(room)) return;
      checkPlan(room);
      if (room.linked) { room.agents = []; readLinked(room); }
      rooms.saveRoom(room);
    },

    // For tests and shutdown: rooms followed now.
    followed: () => [...follows.keys()],
    flushAll: () => { for (const roomId of [...outbox.keys()]) flush(roomId); },
  };
  return api;
}

module.exports = {
  TOKEN_RE, WINDOW_MS, EVENT_GAP_MS, RELEASE_MS, DEFAULT_TIERS, ENDED,
  newToken, isToken, handoffItems, handoffMarkdown, pastePrompt, sanitizeItemIds, taskKey, tiersOf,
  changesSince, headOf, worktreeList, isApprovedAt, planChangedFor, handedPlan, itemIdsOf, mentions, rankCandidates,
  createHandoffEngine,
};
