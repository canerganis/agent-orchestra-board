// Build workflow: runs an approved plan item by item. Each item goes to the agent mapped to its difficulty tier,
// runs one Propose -> Review loop (chain.runItemChain) and, in write mode, works in its own git worktree under
// .orchestra/worktrees/<room>/<item> that starts from the build's base commit plus the frozen patches of the items it
// depends on. Nothing reaches the main checkout until the user applies a reviewed proposal (applyItem), which stages
// it without committing. A build stops at the next item when the plan loses its approval, pauses on request, and can
// be resumed explicitly (also after a board restart), optionally adopting a newly approved plan revision.
// The board never names a model or seat here: agents come from the user's role mapping.
// Codex builders never get file edits (owner decision, Appendix B item 2): in a write build they run read-only and end
// with a ```diff block that the board vets and applies into their worktree (chain patch mode). In propose mode every
// passing item's last ```diff block is exported as a patch file for the user (item.exported); nothing is applied.
const fs = require('fs');
const path = require('path');
const { itemHash, topoOrder, resolveRoles, seatForItem, reviewerFor, ROLES } = require('./plan-model');
const { httpError, now } = require('../util');
const ledger = require('../ledger');

const MAX_ITEM_ATTEMPTS = 2;
const PATCH_VIEW_CHARS = 2000000;
const ROOM_ID_RE = /^[\w-]{1,64}$/;
// Item states that keep a dependent from ever starting until the user acts (isReady decides when one may start).
const DEP_BLOCKS = new Set(['needs-you', 'needs-artifact', 'failed', 'quarantined', 'discarded', 'apply-failed', 'blocked']);
// A resume retries these (attempts reset): the user asked for another try.
// apply-failed is here so the owner can rebuild an item whose apply cannot succeed (a retry apply needs no resume).
const RETRY_ON_RESUME = new Set(['needs-you', 'needs-artifact', 'blocked', 'failed', 'apply-failed']);
// The one readiness predicate, used for dependency admission and for build completion. An item is ready only when its
// review passed (or it was applied) AND it has a usable artifact: in write mode a frozen proposal that the passing
// review covers; in propose mode an exported patch whose `git apply --check` against the dependency tree succeeded.
function isReady(item, mode) {
  if (!item) return false;
  if (item.status === 'applied') return true;
  if (item.status !== 'passed' || !item.review || item.review.verdict !== 'pass') return false;
  if (mode === 'write') return !!(item.proposal && item.proposal.file && item.proposal.hash && item.review.hash === item.proposal.hash);
  const ex = item.exported;
  return !!(ex && ex.file && ex.hash && ex.check && ex.check.ok === true);
}
const RESUMABLE = new Set(['paused', 'stopped', 'needs-approval', 'needs-you']);
// A finished build is resumable only to rebuild an item whose apply failed.
const resumableRoom = (room) => RESUMABLE.has(room.status) || (room.status === 'done' && Object.values(room.items || {}).some((it) => it.status === 'apply-failed'));
const NEEDS_APPROVAL_NOTE = 'The plan changed or lost its approval. Approve the current revision, then resume.';

function createBuild({ store, seats, rooms, chain, capability, patch, worktree, plan, broadcast }) {
  const project = store.project;
  const { sys, pushRoom } = rooms;
  const active = new Map(); // roomId -> Promise of the running loop
  const inProgress = new Map(); // roomId -> itemId being built right now
  const seatExists = (id) => !!seats.seatById(id);
  const seatName = (id) => seats.seatById(id)?.name || id || 'nobody';
  const agentOf = (seat) => (seat && seat.agent === 'codex' ? 'codex' : 'claude');
  const errMsg = (e) => String((e && e.message) || e);

  // Ledger: one metadata record per build, review, fix, check, apply and discard (never prompt or reply text; the
  // ledger drops unknown fields anyway). Written under .orchestra/records. A failure to write never affects a build.
  const recordsDir = path.join(store.orch, 'records');
  function record(room, item, role, outcome, extra = {}) {
    try {
      const seat = seats.seatById(extra.seatId !== undefined ? extra.seatId : item.builderId);
      ledger.appendRecord(recordsDir, {
        room: room.id, item: item.id, attempt: (item.attempts || 0) + 1, role, outcome,
        model: seat?.model, effort: seat?.effort, cli: seat ? agentOf(seat) : undefined, taskType: item.difficulty,
        tokens: extra.tokens, ms: extra.ms,
      });
    } catch {}
  }
  // Tokens of the turns this room took in the given seats since message index `from`: every turn's own result is stored
  // on its message by rooms.say, so other rooms' turns on the same seat never count (seat counters are seat wide).
  function turnTokens(room, from, seatId) {
    let sum = 0;
    for (const m of room.messages.slice(from)) if (m.seatId === seatId && Number.isFinite(m.tokens)) sum += m.tokens;
    return sum;
  }

  const planRoomOf = (room) => {
    const pr = room && room.planRoomId ? rooms.rooms.get(room.planRoomId) : null;
    return pr && pr.kind === 'plan' ? pr : null;
  };
  const planItemOf = (room, id) => planRoomOf(room)?.plan?.items?.find((it) => it.id === id) || null;
  // Checks run shell commands on this machine, so a build runs them only when the revision it was approved at was written
  // by the owner and the plan has checks switched on. Anything stored before that rule (a manager revision with live
  // checks) is not run, whatever the build room copied.
  function liveChecksFor(room, planItem, item) {
    const pr = planRoomOf(room);
    if (!pr || pr.plan?.checksEnabled !== true) return [];
    const rev = (pr.revisions || []).find((r) => r && r.revision === room.planRevision && r.hash === room.planHash);
    if (!rev || rev.by !== 'user' || rev.plan?.checksEnabled !== true) return [];
    return planItem?.checks || item.checks || [];
  }
  // The scout brief of the plan room (a successful, non-system 'scout' message), computed once per build room so every
  // item reuses the same byte-identical text in the stable prefix.
  const briefCache = new WeakMap();
  const briefOf = (room) => {
    if (briefCache.has(room)) return briefCache.get(room);
    const m = (planRoomOf(room)?.messages || []).find((x) => x.round === 'scout' && x.text && !x.error && x.seatId !== 'system');
    const text = m ? m.text.trim() : (room.brief || '');
    briefCache.set(room, text);
    return text;
  };
  const goalOf = (room) => planRoomOf(room)?.plan?.goal || room.title || '';

  function buildRoomOf(room) {
    if (!room || room.kind !== 'build') throw httpError(404, 'no such build', 'no-build');
    return room;
  }
  function itemOf(room, itemId) {
    const item = room.items && Object.prototype.hasOwnProperty.call(room.items, itemId) ? room.items[itemId] : null;
    if (!item) throw httpError(404, 'no such item', 'no-item');
    return item;
  }

  function emit(room, item) {
    if (rooms.live(room)) broadcast({ t: 'build', roomId: room.id, itemId: item.id, item });
    pushRoom(room);
  }

  // Absolute path of a stored worktree reference. removeWorktree only ever touches board worktrees (registered with
  // git under .orchestra/worktrees, or an orphan there that still has git's .git file), whatever the stored text says.
  const absOf = (rel) => path.resolve(project, String(rel));

  function removeTree(abs) {
    try { capability?.noteRemoved?.(abs); } catch {}
    try { worktree.removeWorktree(project, abs, { allowOrphan: true }); return true; } catch { return false; }
  }
  // Removes the item's worktree (when the board manages it) and forgets it. Patch files are kept.
  function dropWorktree(item) {
    if (item.worktree && item.worktree.rel) removeTree(absOf(item.worktree.rel));
    item.worktree = null;
  }
  // Forgets the agent threads of an item (chain.runItemChain keys them `${builderId}:${id}` and
  // `${reviewerId}:${id}:review`; seat ids have no colon). A rebuilt item then starts fresh threads that carry the full,
  // current task: a resumed reviewer thread would only get "review the revised work" and still hold an older spec,
  // and a resumed builder thread would remember edits in a worktree that no longer exists.
  // Their thread homes (runner: the worktree each thread was born in) go with them.
  function forgetThreads(room, id) {
    const matches = (key) => {
      const parts = key.split(':');
      return parts[1] === id && (parts.length === 2 || (parts.length === 3 && parts[2] === 'review'));
    };
    for (const map of [room.threads, room.threadHomes]) {
      if (!map) continue;
      for (const key of Object.keys(map)) if (matches(key)) delete map[key];
    }
  }
  // Back to a fresh pending item: no worktree, no proposal, no review, no agent threads.
  function resetItem(room, item, { attempts = false } = {}) {
    forgetThreads(room, item.id);
    dropWorktree(item);
    item.status = 'pending';
    item.proposal = null;
    item.review = null;
    item.exported = null;
    item.checkResults = null;
    item.error = null;
    if (attempts) item.attempts = 0;
  }

  // All dependencies of an item (transitively), in build order.
  function transitiveDeps(room, id) {
    const seen = new Set();
    const visit = (x) => {
      for (const d of room.items[x]?.dependsOn || []) if (!seen.has(d)) { seen.add(d); visit(d); }
    };
    visit(id);
    return room.order.filter((x) => seen.has(x));
  }

  function newItem(planItem, resolved) {
    const builderId = seatForItem(planItem, resolved, seatExists);
    const { reviewerId, self } = reviewerFor(builderId, resolved);
    return {
      id: planItem.id, title: planItem.title, difficulty: planItem.difficulty, owns: [...planItem.owns], dependsOn: [...planItem.dependsOn],
      itemHash: itemHash(planItem), status: 'pending', builderId, reviewerId, selfReview: self, rounds: 0, attempts: 0,
      worktree: null, proposal: null, review: null, exported: null, error: null,
      checks: (planItem.checks || []).map((c) => ({ name: c.name, cmd: c.cmd })),
    };
  }

  // Why the given builders cannot edit files, or null when every one of them can. cap: a CapabilityStatus.
  // A Codex write seat builds in patch mode (read-only turn, the board applies its diff), so the Codex write gate,
  // which stays closed, is not asked. Patch mode still needs item worktrees, so it needs the repository check (Key A):
  // without it an automatic build proposes instead of failing to start.
  function writeBlocker(builderIds, cap) {
    for (const id of [...new Set(builderIds)]) {
      const seat = seats.seatById(id);
      if (!seat) return `agent "${id}" no longer exists`;
      if (seat.perm !== 'write') return `${seat.name} is read-only`;
      if (agentOf(seat) === 'codex') {
        if (cap?.repo?.ok !== true) return cap?.repo?.reason || 'the repository check failed';
        continue;
      }
      const a = cap?.agents?.[agentOf(seat)];
      if (!a || a.available !== true) return (a && a.reason) || cap?.reason || 'file edits are unavailable';
    }
    return null;
  }
  const isPatchBuilder = (id) => agentOf(seats.seatById(id)) === 'codex';
  const writeBuildActive = (exceptId) => [...active.keys()].some((id) => id !== exceptId && rooms.rooms.get(id)?.mode === 'write');

  // ---------- start ----------

  async function startBuild(planRoom, { revision, hash, roles, maxRounds = 3, escalate = false, mode } = {}) {
    if (!planRoom || planRoom.kind !== 'plan') throw httpError(404, 'no such plan', 'no-plan');
    if (revision !== planRoom.planRevision || !plan.isApproved(planRoom, hash)) {
      throw httpError(409, 'the plan is not approved at this revision', 'not-approved');
    }
    if (mode !== undefined && mode !== null && mode !== 'write' && mode !== 'propose') throw httpError(400, 'mode must be write or propose', 'invalid-mode');
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 6) throw httpError(400, 'maxRounds must be 1-6', 'invalid-rounds');
    let resolved, notes;
    try { ({ resolved, notes } = resolveRoles(roles, seatExists)); } catch (e) { throw httpError(400, e.message, 'invalid-roles'); }

    const planItems = planRoom.plan.items;
    const items = {};
    for (const pi of planItems) items[pi.id] = newItem(pi, resolved);
    const builders = planItems.map((pi) => items[pi.id].builderId);

    // Write mode needs every builder to be a write seat whose CLI passed the write check (Key B + C).
    const cap = await capability.status({ detect: true });
    const blocker = writeBlocker(builders, cap);
    if (mode === 'write' && blocker) throw httpError(409, `file edits are unavailable: ${blocker}`, 'writes-unavailable');
    const useMode = mode || (blocker ? 'propose' : 'write');
    let modeReason = useMode === 'propose' ? (mode === 'propose' ? 'propose mode was requested' : blocker) : null;

    // The approval may have changed while the capability status was computed.
    if (revision !== planRoom.planRevision || !plan.isApproved(planRoom, hash)) {
      throw httpError(409, 'the plan is not approved at this revision', 'not-approved');
    }

    let baseCommit = null, expectedTree = null;
    if (useMode === 'write') {
      const info = worktree.repoInfo(project);
      if (!info.ok) throw httpError(409, `file edits are unavailable: ${info.reason}`, 'writes-unavailable');
      const st = worktree.mainState(project);
      if (!st.clean) throw httpError(409, 'the project has uncommitted changes: commit or stash them first', 'checkout-dirty');
      if (writeBuildActive(null)) throw httpError(409, 'another build that edits files is running', 'busy');
      if (patch.applyBusy?.()) throw httpError(409, 'an approved change is being applied: try again in a moment', 'busy');
      baseCommit = st.head;
      expectedTree = st.headTree;
      modeReason = null;
    }

    const room = rooms.newRoom('build', `Build: ${planRoom.plan.goal.slice(0, 50)}`, {
      planRoomId: planRoom.id, planRevision: planRoom.planRevision, planHash: hash, mode: useMode, modeReason,
      roles: { ...(roles || {}) }, resolved, roleNotes: notes, baseCommit, expectedTree, maxRounds, escalate: !!escalate,
      order: topoOrder(planItems), items, applied: [], baseApplied: [], resumeNeeded: false,
    });
    planRoom.buildIds = planRoom.buildIds || [];
    planRoom.buildIds.push(room.id);
    pushRoom(planRoom);

    sys(room, `Roles: ${ROLES.map((r) => `${r} → ${seatName(resolved[r])}`).join(', ')}.${notes.length ? ` (${notes.join('; ')})` : ''}`);
    sys(room, useMode === 'write'
      ? 'Mode: write. Builders edit files only in their own worktrees; nothing reaches your checkout until you apply a reviewed item.'
      : `Mode: propose (${modeReason}). Builders propose changes; no files are edited.`);
    for (const id of room.order) {
      const it = items[id];
      if (it.selfReview) sys(room, `${id}: ${seatName(it.builderId)} reviews its own work (only one agent available).`);
    }
    if (useMode === 'write') {
      const viaDiff = room.order.filter((id) => isPatchBuilder(items[id].builderId));
      if (viaDiff.length) sys(room, `Codex builds ${viaDiff.join(', ')} read only: it returns a diff that the board checks and applies in the item's worktree. Codex never edits files itself.`);
    } else {
      sys(room, 'Each passing item exports its diff as a patch file under .orchestra/proposals. It is untested: read it before you apply it.');
    }
    start(room);
    return room;
  }

  // Runs the loop in the background, tracked in `active` from this moment on.
  function start(room) {
    const p = Promise.resolve()
      .then(() => runBuild(room))
      .catch((e) => {
        try { sys(room, `⚠ ${errMsg(e)}`); room.status = 'error'; pushRoom(room); } catch {}
      })
      .finally(() => { if (active.get(room.id) === p) active.delete(room.id); });
    active.set(room.id, p);
    return p;
  }

  // ---------- the loop ----------

  function markBlocked(room) {
    for (const id of room.order) {
      const it = room.items[id];
      if (!it || it.status !== 'pending') continue;
      const bad = it.dependsOn.find((d) => !room.items[d] || DEP_BLOCKS.has(room.items[d].status));
      if (bad) {
        it.status = 'blocked';
        it.error = `waiting for ${bad} (${room.items[bad]?.status || 'missing'})`;
        emit(room, it);
      }
    }
  }

  // saveRoom only logs a failed write, so the loop would keep spending model calls on state that never reaches the disk.
  // Before each new item the room is saved strictly: on failure the room carries a persistence warning and no new turn
  // starts until a later save succeeds (resume retries it).
  function persistOk(room) {
    try {
      rooms.saveRoomStrict(room);
      if (room.persistWarning) { delete room.persistWarning; sys(room, 'Saving the build state works again.'); }
      return true;
    } catch (e) {
      const first = !room.persistWarning;
      room.persistWarning = `could not save the build state: ${errMsg(e)}`;
      console.error(`orchestra-board: build ${room.id}: ${room.persistWarning}`);
      if (first) { try { sys(room, `⚠ ${room.persistWarning}. No new turns start until saving works; resume once it does.`); } catch {} }
      return false;
    }
  }

  // The chain reports every status change here, and a builder, fix or reviewer turn follows a 'building' or 'reviewing'
  // update. rooms.say only logs a failed save, so those turns are gated on a strict save: when it fails the warning is set
  // and the chain is halted before the turn (the item goes back to pending; resume retries once saving works).
  function turnGate(room, item) {
    if ((item.status === 'building' || item.status === 'reviewing') && !persistOk(room)) {
      const e = new Error(room.persistWarning);
      e.persistHalt = true;
      throw e;
    }
    emit(room, item);
  }

  // The state a build ends in (done, paused, stopped, needs-you, error) must reach the disk too. On failure the warning
  // is set; a build that would show done is paused instead, so resume saves it again and finishes.
  function finalSave(room) {
    if (persistOk(room)) return;
    if (room.status === 'done') {
      room.status = 'paused';
      try { sys(room, 'The build finished but its final state could not be saved. Resume once saving works.'); } catch {}
    }
  }

  async function runBuild(room) {
    try {
      for (;;) {
        if (room.stopped) { room.status = 'stopped'; sys(room, 'Build stopped. Resume it to continue.'); break; }
        if (room.pauseRequested) { room.pauseRequested = false; room.status = 'paused'; sys(room, 'Build paused. Resume it to continue.'); break; }
        if (!plan.isApproved(planRoomOf(room), room.planHash)) { room.status = 'needs-approval'; sys(room, NEEDS_APPROVAL_NOTE); break; }
        markBlocked(room);
        const next = room.order.map((id) => room.items[id])
          .find((it) => it && it.status === 'pending' && it.dependsOn.every((d) => isReady(room.items[d], room.mode)));
        if (!next) break;
        if (!persistOk(room)) { room.status = 'paused'; break; }
        await runItem(room, next);
        if (Object.values(room.items).some((it) => it.status === 'quarantined')) {
          room.status = 'error';
          sys(room, 'The build stopped: an item was quarantined because files outside its worktree changed.');
          break;
        }
      }
      if (room.status === 'running') {
        const list = room.order.map((id) => room.items[id]);
        if (list.every((it) => isReady(it, room.mode))) {
          room.status = 'done';
          sys(room, room.mode === 'write'
            ? 'All items passed review. Apply them one at a time from the build view.'
            : 'All items passed review.');
        } else {
          room.status = 'needs-you';
          const open = list.filter((it) => !isReady(it, room.mode)).map((it) => `${it.id} (${it.status})`);
          sys(room, `These items need you: ${open.join(', ')}. Resume to retry them, or discard them.`);
        }
      }
    } catch (e) {
      room.status = 'error';
      sys(room, `⚠ Build error: ${errMsg(e)}`);
    } finally {
      try { finalSave(room); } catch {}
      pushRoom(room);
      const list = Object.values(room.items);
      const passed = list.filter((it) => isReady(it, room.mode)).length;
      const applied = list.filter((it) => it.status === 'applied').length;
      try { store.appendLog('board', `Build "${goalOf(room).slice(0, 80)}" ${room.status}: ${passed}/${room.order.length} passed, ${applied} applied.`); } catch {}
      active.delete(room.id);
    }
  }

  // Builder and reviewer tokens are summed from this room's own turn results since the chain started (msgs0 is the
  // message count then); a seat that reviews its own work is counted once, under build.
  function recordChain(room, item, res, { ms, msgs0 }) {
    const self = item.builderId === item.reviewerId;
    const builderTokens = turnTokens(room, msgs0, item.builderId);
    const reviewerTokens = self ? 0 : turnTokens(room, msgs0, item.reviewerId);
    const verdict = item.review && item.review.verdict;
    const rounds = Number.isFinite(res.rounds) ? res.rounds : 0;
    const buildOk = res.status === 'passed' ? 'pass' : res.status;
    record(room, item, 'build', buildOk, { tokens: builderTokens, ms, seatId: item.builderId });
    if (rounds > 1) record(room, item, 'fix', res.status === 'passed' ? 'pass' : res.status, { seatId: item.builderId });
    if (verdict) record(room, item, 'review', verdict, { tokens: reviewerTokens, seatId: item.reviewerId });
    const results = item.checkResults && Array.isArray(item.checkResults.results) ? item.checkResults.results : null;
    if (results) {
      record(room, item, 'check', results.every((x) => x.ok) ? 'pass' : 'fail', { seatId: item.builderId });
    }
  }

  async function runItem(room, item) {
    inProgress.set(room.id, item.id);
    try {
      const write = room.mode === 'write';
      const deps = transitiveDeps(room, item.id);
      item.error = null;
      // A seat deleted since the item was created must never reach the chain (it reads builder.effort).
      const gone = [item.builderId, item.reviewerId].find((id) => !seatExists(id));
      if (gone !== undefined || !item.builderId || !item.reviewerId) {
        item.status = 'failed';
        item.error = `agent "${gone ?? ''}" no longer exists: resume the build to pick another agent`;
        sys(room, `${item.id}: ${item.error}.`);
        emit(room, item);
        return;
      }
      let wtDir = null, startTree = null;
      if (write) {
        try {
          // A worktree left from an earlier run (stopped item, crash between create and save) is replaced.
          dropWorktree(item);
          const leftover = worktree.worktreePath(project, room.id, item.id);
          if (fs.existsSync(leftover)) removeTree(leftover);
          const wt = worktree.createWorktree(project, room.id, item.id, room.baseCommit);
          wtDir = wt.dir;
          item.worktree = { rel: wt.rel, baseCommit: room.baseCommit, startTree: null };
          // Dependencies already contained in the base commit (applied, then committed by the user) are not re-applied.
          const inBase = new Set(room.baseApplied || []);
          const depPatches = deps.filter((d) => !inBase.has(d)).map((d) => {
            const p = room.items[d].proposal;
            if (!p || !p.file) throw new Error(`dependency ${d} has no frozen proposal`);
            return { rel: p.file, hash: p.hash };
          });
          startTree = await patch.prepareWorktree({ store, worktreeDir: wt.dir, depPatches });
          item.worktree.startTree = startTree;
        } catch (e) {
          item.status = 'failed';
          item.error = `could not prepare the worktree: ${errMsg(e)}`;
          sys(room, `${item.id}: ${item.error}`);
          emit(room, item);
          return;
        }
      }

      const pi = planItemOf(room, item.id);
      // The plan goal is shared by every item: it leads the prompt (context.buildPacket) so items share a cacheable prefix.
      const stable = { plan: `Plan goal: ${goalOf(room)}`, brief: briefOf(room) };
      const task = `Build item "${item.id}": ${item.title}\n\nSpec:\n${pi ? pi.spec : item.title}\n\nOwner areas (the only paths you may change): ${item.owns.join(', ')}\n${write ? `Already done and present in your files: ${deps.join(', ') || 'nothing'}` : `Earlier items (their patches are only exported, not applied: they are NOT in your files): ${deps.join(', ') || 'none'}`}`;
      emit(room, item);
      let res;
      const t0 = Date.now();
      const msgs0 = room.messages.length;
      try {
        res = await chain.runItemChain(room, item, {
          task, stable, builderId: item.builderId, reviewerId: item.reviewerId, maxRounds: room.maxRounds, escalate: room.escalate,
          worktree: write ? { dir: wtDir, startTree } : null, owns: write ? item.owns : null, onUpdate: (it) => turnGate(room, it),
          patchMode: write && isPatchBuilder(item.builderId), checks: write ? liveChecksFor(room, pi, item) : [],
        });
      } catch (e) {
        res = e && e.persistHalt ? { status: 'stopped', rounds: item.rounds || 0 } : { status: 'error', error: errMsg(e) };
      }
      recordChain(room, item, res, { ms: Date.now() - t0, msgs0 });

      switch (res.status) {
        case 'passed':
          item.status = 'passed';
          if (!write) exportItem(room, item, res.text, deps);
          if (!isReady(item, room.mode)) {
            item.status = 'needs-artifact';
            item.error = write
              ? 'the review passed but the item has no frozen patch'
              : `the review passed but there is no usable patch: ${item.exported?.check?.reason || 'no export'}`;
            sys(room, `${item.id}: ${item.error}. Dependents wait; resume to build it again.`);
          }
          break;
        case 'failed': item.status = 'needs-you'; break;
        case 'quarantined': item.status = 'quarantined'; break;
        case 'stopped': item.status = 'pending'; break; // the worktree stays; resume resets it
        default: {
          item.attempts = (item.attempts || 0) + 1;
          const error = res.error || item.error || 'the item failed';
          if (item.attempts < MAX_ITEM_ATTEMPTS) {
            resetItem(room, item);
            sys(room, `${item.id} failed (${error}); retrying (attempt ${item.attempts + 1} of ${MAX_ITEM_ATTEMPTS}).`);
          } else {
            item.status = 'failed';
            item.error = error;
          }
        }
      }
      emit(room, item);
    } finally {
      inProgress.delete(room.id);
    }
  }

  // Propose mode, after a review PASS: exports the builder's last ```diff block (plan F10). Never throws and never
  // applies anything; a refused diff or a failing `git apply --check` is recorded in item.exported.
  function exportItem(room, item, text, deps = []) {
    const round = item.proposal?.round || item.rounds || 1;
    let r;
    const depPatches = [];
    for (const d of deps) {
      const ex = room.items[d]?.exported;
      if (ex && ex.rel && ex.hash && ex.check && ex.check.ok) depPatches.push({ rel: ex.rel, hash: ex.hash });
    }
    try { r = patch.saveProposedPatch({ store, project, room, item, round, text: text || '', depPatches }); }
    catch (e) { r = { ok: false, code: e.code || 'error', reason: errMsg(e), files: [] }; }
    item.exported = r.ok
      ? { file: r.file, rel: r.rel, hash: r.hash, files: r.files, bytes: r.bytes, check: r.check, untested: true, note: r.note, round, at: now() }
      : { file: null, rel: null, hash: null, files: r.files || [], bytes: 0, check: { ok: false, reason: r.reason }, refused: r.code || 'refused', untested: true, round, at: now() };
    sys(room, r.ok
      ? `${item.id}: patch exported to ${r.file} (${r.files.length} file(s), sha256 ${r.hash.slice(0, 12)}), git apply --check ${r.check.ok ? 'ok' : `failed: ${r.check.reason}`}. Untested.`
      : `${item.id}: no patch exported: ${r.reason}.`);
  }

  // ---------- pause / resume ----------

  function pauseBuild(room) {
    buildRoomOf(room);
    if (!active.has(room.id)) throw httpError(409, 'the build is not running', 'not-running');
    room.pauseRequested = true;
    sys(room, 'Pause requested: the build pauses after the current item.');
    pushRoom(room);
    return { ok: true };
  }

  // Adopts a newly approved plan revision: unchanged items keep their state, changed or new ones start over, items
  // no longer in the plan are discarded. Applied items are never undone (their change is already staged).
  function adoptPlan(room, pr) {
    const fresh = {};
    for (const pi of pr.plan.items) {
      const old = room.items[pi.id];
      if (old && (old.itemHash === itemHash(pi) || old.status === 'applied')) {
        if (old.itemHash !== itemHash(pi)) sys(room, `${pi.id} changed in the plan but is already applied; it is kept as applied.`);
        fresh[pi.id] = old;
        continue;
      }
      if (old) dropWorktree(old);
      forgetThreads(room, pi.id); // the item starts over: its agents must get the new spec in full
      fresh[pi.id] = newItem(pi, room.resolved);
    }
    for (const [id, old] of Object.entries(room.items)) {
      if (fresh[id]) continue;
      if (old.status !== 'applied') { dropWorktree(old); forgetThreads(room, id); old.status = 'discarded'; }
      fresh[id] = old; // kept for the record, outside the build order
    }
    room.items = fresh;
    room.order = topoOrder(pr.plan.items);
    room.planHash = pr.planHash;
    room.planRevision = pr.planRevision;
    sys(room, `Adopted plan revision ${pr.planRevision}.`);
  }

  // Seats a resume binds again: the room's role mapping is re-resolved over the agents that still exist, and every item
  // that is not applied or discarded and lost its builder or reviewer gets a seat through the same fallback as at start.
  // Returns { resolved, notes, rebound: Map itemId -> { builderId, reviewerId, selfReview } }; changes nothing.
  function reseat(room, pr) {
    const live = {};
    for (const [r, id] of Object.entries(room.roles || {})) if (id && seatExists(id)) live[r] = id;
    if (!Object.keys(live).length) {
      throw httpError(409, 'none of the agents assigned to this build exist any more: a new build needs agents', 'writes-unavailable');
    }
    const { resolved, notes } = resolveRoles(live, seatExists);
    const rebound = new Map();
    for (const id of room.order) {
      const it = room.items[id];
      if (!it || ['applied', 'discarded'].includes(it.status)) continue;
      if (seatExists(it.builderId) && seatExists(it.reviewerId)) continue;
      const pi = pr.plan.items.find((x) => x.id === id) || planItemOf(room, id) || { difficulty: it.difficulty };
      const builderId = seatExists(it.builderId) ? it.builderId : seatForItem(pi, resolved, seatExists);
      const { reviewerId, self } = reviewerFor(builderId, resolved);
      rebound.set(id, { builderId, reviewerId, selfReview: self });
    }
    return { resolved, notes, rebound };
  }

  // Builders of the items a resume would run (not yet passed, applied or discarded), with the plan to be used.
  function buildersToRun(room, pr, adopting, { resolved, rebound }) {
    const builderOf = (it) => (rebound.get(it.id) || it).builderId;
    if (!adopting) {
      return room.order.map((id) => room.items[id]).filter((it) => it && !['passed', 'applied', 'discarded'].includes(it.status)).map(builderOf);
    }
    return pr.plan.items.map((pi) => {
      const old = room.items[pi.id];
      if (old && old.itemHash === itemHash(pi)) return ['passed', 'applied', 'discarded'].includes(old.status) ? null : builderOf(old);
      return old && old.status === 'applied' ? null : seatForItem(pi, resolved, seatExists);
    }).filter(Boolean);
  }

  async function resumeBuild(room, { revision, hash } = {}) {
    buildRoomOf(room);
    if (!resumableRoom(room)) throw httpError(409, `a build that is ${room.status} cannot be resumed`, 'not-resumable');
    if (active.has(room.id)) throw httpError(409, 'the build is still running', 'busy');
    const pr = planRoomOf(room);
    if (!pr) throw httpError(409, 'the plan of this build no longer exists', 'no-plan');
    const adopting = !!hash && hash !== room.planHash;
    if (adopting) {
      if (revision !== pr.planRevision || !plan.isApproved(pr, hash)) throw httpError(409, 'the plan is not approved at this revision', 'not-approved');
    } else if (!plan.isApproved(pr, room.planHash)) {
      throw httpError(409, 'needs re-approval: approve the current plan revision, then resume with it', 'not-approved');
    }
    const seating = reseat(room, pr);
    if (room.mode === 'write') {
      const info = worktree.repoInfo(project);
      if (!info.ok) throw httpError(409, `file edits are unavailable: ${info.reason}`, 'writes-unavailable');
      const cap = await capability.status({ detect: true });
      const blocker = writeBlocker(buildersToRun(room, pr, adopting, seating), cap);
      if (blocker) throw httpError(409, `file edits are unavailable: ${blocker}`, 'writes-unavailable');
      if (writeBuildActive(room.id)) throw httpError(409, 'another build that edits files is running', 'busy');
      if (patch.applyBusy?.()) throw httpError(409, 'an approved change is being applied: try again in a moment', 'busy');
    }
    // Every check above may await: re-check what another request could have changed meanwhile.
    if (active.has(room.id) || !resumableRoom(room)) throw httpError(409, 'the build is still running', 'busy');
    if (adopting ? !plan.isApproved(pr, hash) : !plan.isApproved(pr, room.planHash)) {
      throw httpError(409, 'the plan is not approved at this revision', 'not-approved');
    }

    // Re-seat before adoptPlan, which builds new items from room.resolved.
    if (seating.rebound.size) {
      room.resolved = seating.resolved;
      room.roleNotes = seating.notes;
      for (const [id, b] of seating.rebound) {
        const it = room.items[id];
        sys(room, `${id}: ${seatName(it.builderId)} / ${seatName(it.reviewerId)} are gone; now ${seatName(b.builderId)} builds and ${seatName(b.reviewerId)} reviews.`);
        Object.assign(it, b);
      }
    } else if (Object.values(room.resolved || {}).some((id) => !seatExists(id))) {
      room.resolved = seating.resolved;
      room.roleNotes = seating.notes;
    }
    if (adopting) adoptPlan(room, pr);
    for (const id of room.order) {
      const it = room.items[id];
      if (it.status === 'building' || it.status === 'checking' || it.status === 'reviewing' || it.status === 'pending') resetItem(room, it);
      else if (RETRY_ON_RESUME.has(it.status)) resetItem(room, it, { attempts: true });
      else if (it.status === 'passed' && room.mode === 'write') {
        let ok = true;
        try { patch.readProposal({ store, rel: it.proposal?.file, hash: it.proposal?.hash }); } catch { ok = false; }
        if (!ok || !it.review || it.review.hash !== it.proposal?.hash) {
          sys(room, `${id}: its frozen proposal no longer verifies; it is built again.`);
          resetItem(room, it);
        }
      }
    }
    // A passed item was built on top of its dependencies' proposals: when one of them starts over, so does it.
    for (const id of room.order) {
      const it = room.items[id];
      if (it.status !== 'passed') continue;
      if (it.dependsOn.some((d) => !isReady(room.items[d], room.mode))) resetItem(room, it);
    }
    for (const id of room.order) emit(room, room.items[id]);

    room.stopped = false;
    room.pauseRequested = false;
    room.resumeNeeded = false;
    room.status = 'running';
    sys(room, 'Build resumed.');
    pushRoom(room);
    start(room);
    return { ok: true };
  }

  // ---------- apply / discard / view ----------

  async function applyItem(room, itemId, hash) {
    buildRoomOf(room);
    const item = itemOf(room, itemId);
    if (room.mode !== 'write') throw httpError(400, 'this build only proposes changes', 'propose-mode');
    if (!item.proposal || hash !== item.proposal.hash) throw httpError(409, 'stale proposal: reload it', 'stale-proposal');
    if (inProgress.get(room.id) === itemId) throw httpError(409, 'this item is being built', 'build-running');
    // Applying changes the main checkout, which the runtime guard fingerprints around every write turn: during another
    // write build's turn that would quarantine its item and blame its CLI for the board's own change. Checked
    // synchronously right before applyProposal registers itself (applyBusy), so no write build can start in between.
    if (writeBuildActive(room.id)) throw httpError(409, 'another build that edits files is running: wait for it or pause it', 'busy');
    if (item.status === 'applied' || (room.applied || []).includes(itemId)) throw httpError(409, 'already applied', 'applied');
    // One transaction per project: git apply, the room's applied list and its persistence run in one serialized slot,
    // so a concurrent apply reads the list this one wrote. The snapshot is taken inside the slot, never before it.
    let res;
    let saveError = null;
    await patch.applyProposal({ project, store, room, item, approvalOk: plan.isApproved(planRoomOf(room), room.planHash) }, (r) => {
      res = r;
      if (r.ok) {
        const appliedBefore = [...(room.applied || [])];
        // The user committed what the board had applied, so the base commit now contains those items.
        if (r.baseMoved) room.baseApplied = appliedBefore;
        if (!appliedBefore.includes(itemId)) room.applied = [...appliedBefore, itemId];
        dropWorktree(item);
        sys(room, `Applied ${itemId} to the main checkout (staged, not committed).`);
      } else if (item.status === 'apply-failed') {
        sys(room, `Applying ${itemId} failed: ${r.reason}. The proposal is kept.`);
      }
      if (r.ok) {
        try { rooms.saveRoomStrict(room); } catch (e) { saveError = e; }
      }
    });
    if (saveError) {
      const reason = `the change was staged but the build state could not be saved: ${saveError.message}`;
      sys(room, `Applied ${itemId}, but ${reason}.`);
      if (rooms.live(room)) broadcast({ t: 'apply', roomId: room.id, itemId, ok: false, code: 'state-not-saved', error: reason, tree: res.tree || null });
      emit(room, item);
      throw httpError(500, reason, 'state-not-saved');
    }
    record(room, item, 'apply', res.ok ? 'applied' : (res.code || 'failed'));
    if (rooms.live(room)) broadcast({ t: 'apply', roomId: room.id, itemId, ok: !!res.ok, code: res.code || null, error: res.reason || null, tree: res.tree || null });
    emit(room, item);
    if (!res.ok) throw httpError(409, res.reason || 'the proposal could not be applied', res.code || 'apply-failed');
    return { ok: true, tree: res.tree };
  }

  function discardItem(room, itemId) {
    buildRoomOf(room);
    const item = itemOf(room, itemId);
    if (active.has(room.id) && inProgress.get(room.id) === itemId) {
      throw httpError(409, 'this item is being built: pause or stop the build first', 'busy');
    }
    if (item.status === 'applied') throw httpError(409, 'already applied', 'applied');
    if (item.worktree && item.worktree.rel) {
      const abs = absOf(item.worktree.rel);
      if (worktree.isBoardWorktree(project, abs)) {
        try { capability?.noteRemoved?.(abs); } catch {}
        worktree.removeWorktree(project, abs);
      }
    }
    item.worktree = null;
    item.status = 'discarded';
    record(room, item, 'discard', 'discarded');
    sys(room, `Discarded ${itemId}. Items that depend on it are blocked.`);
    emit(room, item);
    return { ok: true };
  }

  function proposalOf(room, itemId) {
    buildRoomOf(room);
    const item = itemOf(room, itemId);
    let text = null, truncated = false, fileErr = null;
    if (room.mode === 'write' && item.proposal && item.proposal.file) {
      try {
        text = patch.readProposal({ store, rel: item.proposal.file, hash: item.proposal.hash }).toString('utf8');
        if (text.length > PATCH_VIEW_CHARS) { text = text.slice(0, PATCH_VIEW_CHARS); truncated = true; }
      } catch (e) { fileErr = e; text = null; }
    }
    let applicable;
    if (room.mode !== 'write') applicable = { ok: false, code: 'propose-mode', reason: 'this build only proposes changes' };
    else if (fileErr) applicable = { ok: false, code: fileErr.code || 'proposal-missing', reason: errMsg(fileErr) };
    else if (!item.proposal || !item.review || item.review.verdict !== 'pass' || item.review.hash !== item.proposal.hash) {
      applicable = { ok: false, code: 'not-reviewed', reason: item.status === 'applied' ? 'already applied' : 'this item has no passing review of its current proposal' };
    } else {
      applicable = patch.applyPreconditions({ project, store, room, item, approvalOk: plan.isApproved(planRoomOf(room), room.planHash) });
    }
    return { itemId, status: item.status, proposal: item.proposal, review: item.review, exported: item.exported || null, patch: text, truncated, applicable };
  }

  // Removes everything a build room owns on disk: its worktrees and its frozen proposals.
  function cleanupRoom(room) {
    if (!room || !ROOM_ID_RE.test(String(room.id))) return;
    for (const it of Object.values(room.items || {})) {
      if (it && it.worktree && it.worktree.rel) { try { capability?.noteRemoved?.(absOf(it.worktree.rel)); } catch {} }
    }
    try { worktree.removeRoomWorktrees(project, room.id); } catch {}
    try { fs.rmSync(path.join(store.orch, 'proposals', room.id), { recursive: true, force: true }); } catch {}
  }

  // Resolves true when the room's loop is not running, or false after ms.
  function whenIdle(room, ms = 30000) {
    const p = room ? active.get(room.id) : null;
    if (!p) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      p.then(() => { clearTimeout(t); resolve(true); }, () => { clearTimeout(t); resolve(true); });
    });
  }

  // After a board restart: builds that were running (now 'stopped' by rooms.load) and still have work wait for an
  // explicit resume. Nothing runs automatically.
  function recover() {
    for (const room of rooms.rooms.values()) {
      if (room.kind !== 'build' || room.status !== 'stopped' || active.has(room.id)) continue;
      const items = Object.values(room.items || {});
      if (!items.some((it) => !['passed', 'applied', 'discarded'].includes(it.status))) continue;
      room.resumeNeeded = true;
      pushRoom(room);
    }
  }

  // The first unfinished build item (not passed, applied or discarded) that names this seat as builder or reviewer.
  function seatInUse(seatId) {
    for (const room of rooms.rooms.values()) {
      if (room.kind !== 'build') continue;
      for (const it of Object.values(room.items || {})) {
        if (!it || ['passed', 'applied', 'discarded'].includes(it.status)) continue;
        if (it.builderId === seatId || it.reviewerId === seatId) return { roomId: room.id, itemId: it.id, title: room.title };
      }
    }
    return null;
  }

  const isActive = (id) => active.has(id);

  return { startBuild, runBuild, pauseBuild, resumeBuild, applyItem, discardItem, proposalOf, cleanupRoom, whenIdle, recover, isActive, seatInUse, MAX_ITEM_ATTEMPTS };
}

module.exports = { createBuild, isReady, MAX_ITEM_ATTEMPTS };
