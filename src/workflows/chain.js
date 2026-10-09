// Propose -> Review workflow. A builder proposes (read-only, the v0.1 behaviour) or, in write mode, edits its item
// worktree; a reviewer answers VERDICT: PASS/FAIL; the loop repeats with optional effort escalation.
// runItemChain is the per-item engine. In write mode every round's worktree changes are frozen into a hash-bound
// proposal (patch.freezeProposal) and the review covers exactly that hash; a worktree that changes after the freeze
// voids the review. runChain is the room workflow: it always proposes and never touches files.
// Patch mode (a Codex builder in a write build, owner decision Appendix B item 2): the builder runs read-only in its
// worktree and ends with a ```diff block; the board vets it and applies it into the worktree (patch.applyProposedPatch),
// then freezes the worktree like any write turn. Codex itself never gets file edits.
const { EFFORTS } = require('../config');
const { lastLine, sha256, now } = require('../util');
const { runChecks, formatChecks } = require('../checks');
const { buildPacket, diffSincePrevious, stripDiffBlocks, textSincePrevious } = require('../context');

const PATCH_SHOW_CHARS = 30000;
const DIFF_RULE = 'End with exactly one unified diff in a ```diff block, git format, paths relative to the repository root.';
const DIFF_RULE_AGAIN = 'End with exactly one unified diff of the complete change in a ```diff block, git format, paths relative to the repository root.';
const DIFF_RULE_PATCH = 'End with exactly one unified diff in a ```diff block, git format, paths relative to the repository root, against the files as they are now in your working directory. The board checks it and applies it there.';
const VERDICT_RULE = 'List at most 3 BLOCKER and 3 SHOULD-FIX findings; add at most 3 NIT only when the verdict is PASS. FAIL only if a BLOCKER exists. The last line must be exactly "VERDICT: PASS" or "VERDICT: FAIL".';
// Notes the user posted that no agent turn has consumed yet. The first message is the room's topic or task.
const pendingNotes = (room) => room.messages.filter((m) => m.seatId === 'user' && !m.consumed && m !== room.messages[0]);
const noteBlock = (notes) => (notes.length ? `\n\nNotes from the user:\n${notes.map((m) => '- ' + m.text).join('\n')}` : '');

function createChain({ store, seats, rooms, broadcast, capability = null, patch = null }) {
  const { seatById } = seats;
  const { say, sys, pushRoom, saveRoom, live, buildContext, NOT_DELIVERED } = rooms;

  const bump = (agent, e) => { const l = EFFORTS[agent]; return l[Math.min(l.indexOf(e) + 1, l.length - 1)]; };

  // One item's Propose -> Review loop. opts: { task, reviewTask, builderId, reviewerId, maxRounds, escalate, worktree
  // ({ dir, startTree }), owns, patchMode, onUpdate }. Returns { status: 'passed'|'failed'|'stopped'|'error'|'quarantined',
  // rounds, error?, failedSeat?, text? } where text is the builder's reply of the passing round.
  async function runItemChain(room, item, opts) {
    const { task, reviewTask = task, builderId, reviewerId, maxRounds = 3, escalate = false, worktree = null, owns = null, onUpdate = () => {} } = opts;
    // Acceptance checks (write mode only): commands run in the worktree after the freeze and before any review.
    const checks = worktree ? (opts.checks ?? item.checks ?? []) : [];
    const patchMode = !!(opts.patchMode && worktree);
    if (worktree && (!capability || !patch)) throw new Error('write mode needs capability and patch');
    const builder = seatById(builderId), reviewer = seatById(reviewerId);
    const builderKey = `${builderId}:${item.id}`, reviewerKey = `${reviewerId}:${item.id}:review`;
    const kind = worktree ? 'work' : 'proposal';
    const scope = owns ? owns.join(', ') : 'this directory';
    // Mode rules are identical for every item of a build, so they belong to the stable prefix; the owner areas vary per
    // item and go after it.
    const doIt = patchMode
      ? `You cannot modify files: your current working directory is a git worktree made for this item, and you may only read it. Summarize the change briefly. ${DIFF_RULE_PATCH}`
      : worktree
        ? 'Work only inside your current working directory (a git worktree made for this item). Do not commit or switch branches. End with a short summary of what you changed.'
        : `You cannot modify files: propose the change concretely. Summarize it briefly. ${DIFF_RULE}`;
    const scopeLine = `Change only files under: ${scope}.`;
    // Shared, item independent context (opts.stable: { rules, plan, brief }) leads every first-turn prompt.
    const shared = opts.stable || {};
    const stableOf = (rules) => ({ rules: [shared.rules, rules].filter(Boolean).join('\n\n'), plan: shared.plan, brief: shared.brief });
    let prevPatch = null, prevOutput = null, lastFindings = null; // what the reviewer saw last round, and the findings it raised then
    const againRule = patchMode ? ` ${DIFF_RULE_PATCH}` : worktree ? '' : ` ${DIFF_RULE_AGAIN}`;
    let effort = room.overrides?.[builderId]?.effort || builder.effort;
    let feedback = null, feedbackHead = null; // feedbackHead is set when the feedback comes from failed checks, not the reviewer

    // Marks the item failed, posts the reason when given, and returns the error result.
    const failed = (error, failedSeat, note = null) => {
      if (note) sys(room, note);
      item.status = 'failed'; item.error = error; onUpdate(item);
      return { status: 'error', rounds: room.round, error, failedSeat };
    };
    const escalateNow = (r) => {
      if (!escalate || r >= maxRounds) return;
      const next = bump(builder.agent, effort);
      if (next !== effort) { effort = next; sys(room, `⚡ ${builder.name} effort raised → ${effort}`); }
    };

    for (let r = 1; r <= maxRounds && !room.stopped; r++) {
      room.round = r; pushRoom(room);
      item.status = 'building'; item.rounds = r; onUpdate(item);
      // Notes from the user are consumed only once the builder's turn has succeeded (see below).
      const notes = pendingNotes(room);
      const noteText = noteBlock(notes);
      // The header belongs to this round's feedback only: it is cleared once used, so a later round that sets other
      // feedback (empty freeze, out-of-area, diff not applied) never inherits it.
      const head = feedbackHead; feedbackHead = null;
      const prompt = r === 1
        ? buildPacket({ stable: stableOf(doIt), item: `${task}${noteText}\n\n${scopeLine}` })
        : buildPacket({ item: `${head || `Review feedback from ${reviewer.name} (round ${r - 1}):`}\n${feedback}${noteText}\n\n${head ? 'Fix the failing checks' : 'Address the BLOCKER and SHOULD-FIX items only'}, then summarize.${againRule}` });

      // Write mode: the guard fingerprints the main checkout and the other worktrees around the turn.
      // Patch mode: the turn is read-only, so the worktree must not change during it either.
      let guard = null, wtBefore = null;
      if (worktree) {
        try { guard = await capability.guardTurn({ agent: builder.agent, worktreeDir: worktree.dir }); }
        catch (e) { return failed(`write guard failed: ${e.message}`, 'builder', `${builder.name} failed: write guard failed: ${e.message}`); }
        if (patchMode) {
          try { wtBefore = patch.hashWorktree({ worktreeDir: worktree.dir, startTree: worktree.startTree }); }
          catch (e) { await guard.finish(); return failed(`worktree unreadable: ${e.message}`, null, `Could not read the worktree before ${builder.name}'s turn: ${e.message}`); }
        }
      }
      let b, g = null;
      try {
        b = await say(room, builderId, prompt, {
          round: r, effort, label: `${worktree ? (patchMode ? 'implementation (diff)' : 'implementation') : 'proposal'} · ${effort}`,
          tools: worktree && !patchMode ? 'write' : 'read', worktree: worktree ? worktree.dir : null, withTarget: !worktree, threadKey: builderKey,
        });
      } finally {
        if (guard) g = await guard.finish(); // after the turn, even when it failed
      }
      if (patchMode && (!g || g.ok)) {
        let wtAfter = null;
        try { wtAfter = patch.hashWorktree({ worktreeDir: worktree.dir, startTree: worktree.startTree }); } catch {}
        if (wtAfter !== wtBefore) {
          // A read-only turn that changed files: the sandbox did not hold. Nothing from it is applied or reviewed.
          item.status = 'quarantined';
          item.error = 'the worktree changed during a read-only turn';
          sys(room, `⛔ ${builder.name} changed files in its worktree during a read-only turn. The item is quarantined; nothing from this turn is applied.`);
          onUpdate(item);
          return { status: 'quarantined', rounds: r, error: item.error };
        }
      }
      if (g && !g.ok) {
        item.status = 'quarantined';
        item.error = 'changes outside the worktree: ' + g.changed.join(', ');
        sys(room, `⛔ ${builder.name} changed files outside its worktree (${g.changed.join(', ')}). The item is quarantined and file edits are disabled until the write check passes again.`);
        onUpdate(item);
        return { status: 'quarantined', rounds: r, error: item.error };
      }
      if (room.stopped) break;
      // A builder that cannot run (missing CLI, crash) is an error, not a review that ran out of rounds.
      if (!b.ok) return failed(b.error, 'builder', `${builder.name} failed: ${b.error}`);
      notes.forEach((m) => { m.consumed = true; }); // the builder read them
      if (worktree && !patchMode && b.mode !== 'write') {
        return failed('file edits are not available', 'builder', `${builder.name} could not get file edits for this turn (write check or permission missing).`);
      }

      // Freeze what the builder produced: a hash-bound proposal in write mode, the reply text otherwise.
      if (patchMode) {
        // The board applies the builder's diff into the worktree; the freeze below then covers exactly that change.
        let ap;
        try { ap = patch.applyProposedPatch({ store, worktreeDir: worktree.dir, text: b.text || '', owns }); }
        catch (e) { ap = { ok: false, code: 'error', reason: e.message, files: [] }; }
        if (!ap.ok) {
          const list = ap.files && ap.files.length ? ` (${ap.files.join(', ')})` : '';
          feedback = `BLOCKER: the board could not apply your diff: ${ap.reason}${list}. Change only files under: ${scope}.`;
          sys(room, `${builder.name}'s diff was not applied in round ${r}: ${ap.reason}${list}. Sent back without a review.`);
          escalateNow(r);
          continue;
        }
      }
      if (worktree) {
        let fr;
        try {
          fr = patch.freezeProposal({ store, worktreeDir: worktree.dir, startTree: worktree.startTree, roomId: room.id, itemId: item.id, round: r, owns });
        } catch (e) {
          return failed(`freeze failed: ${e.message}`, null, `Could not freeze ${builder.name}'s change in round ${r}: ${e.message}`);
        }
        if (fr.empty) {
          feedback = 'No changes were found in your worktree. Make the change in the files themselves.';
          sys(room, `${builder.name} made no changes in round ${r}.`);
          escalateNow(r);
          continue;
        }
        const bad = [...fr.outOfArea, ...fr.unsafe];
        if (bad.length) {
          feedback = `BLOCKER: these changes are outside your owner areas or not allowed (symlinks, submodules): ${bad.join(', ')}. Revert them and change only files under: ${scope}.`;
          sys(room, `${builder.name} changed files outside its areas in round ${r}; sent back without a review.`);
          continue;
        }
        item.proposal = { round: r, hash: fr.hash, file: fr.rel, files: fr.files, bytes: fr.bytes, frozenAt: now() };
        if (patchMode) Object.assign(item.proposal, { via: 'diff', untested: true, note: patch.UNTESTED_NOTE });
      } else {
        const text = b.text || '';
        item.proposal = { round: r, hash: sha256(text), file: null, files: [], bytes: Buffer.byteLength(text), frozenAt: now(), msgId: b.msg?.id || null };
      }
      // Gate: the acceptance checks run on exactly the frozen change. A failure goes back to the builder; no review is bought.
      let checkText = '';
      if (worktree && checks.length) {
        item.status = 'checking'; onUpdate(item);
        // Checks run code the builder wrote, outside any sandbox and with the owner's rights (the owner turned them on and
        // saw every command on the approval screen). They run only on a worktree that still equals the frozen patch, with
        // a minimal environment, a timeout and a tree kill, under the same write guard as a builder turn.
        let pre;
        try { pre = patch.hashWorktree({ worktreeDir: worktree.dir, startTree: worktree.startTree }); }
        catch (e) { return failed(`worktree unreadable: ${e.message}`, null, `Could not re-check the worktree before the acceptance checks: ${e.message}`); }
        if (pre !== item.proposal.hash) {
          item.checkResults = null;
          feedback = 'Your files changed after your change was frozen for review. Re-check the change and finish it.';
          sys(room, 'The worktree no longer matches the frozen patch, so the acceptance checks were not run. Sent back without a review.');
          onUpdate(item); escalateNow(r); continue;
        }
        let cguard;
        try { cguard = await capability.guardTurn({ agent: builder.agent, worktreeDir: worktree.dir }); }
        catch (e) { return failed(`write guard failed: ${e.message}`, 'builder', `Write guard failed before the acceptance checks: ${e.message}`); }
        let results, cg;
        const checksAt = now();
        try { results = await runChecks(worktree.dir, checks, { timeoutMs: opts.checkTimeoutMs, maxOutput: opts.checkMaxOutput, stopped: () => room.stopped }); }
        finally { cg = await cguard.finish(); }
        if (!cg.ok) {
          item.checkResults = null;
          item.status = 'quarantined';
          item.error = 'changes outside the worktree during the acceptance checks: ' + cg.changed.join(', ');
          sys(room, `⛔ The acceptance checks changed files outside the worktree (${cg.changed.join(', ')}). The item is quarantined and file edits are disabled until the write check passes again.`);
          onUpdate(item);
          return { status: 'quarantined', rounds: r, error: item.error };
        }
        if (room.stopped) break;
        let after;
        try { after = patch.hashWorktree({ worktreeDir: worktree.dir, startTree: worktree.startTree }); }
        catch (e) { return failed(`worktree unreadable: ${e.message}`, null, `Could not re-check the worktree after the checks: ${e.message}`); }
        if (after !== item.proposal.hash) {
          item.checkResults = null;
          feedbackHead = `Acceptance checks changed your files (round ${r}):`;
          feedback = 'Running the checks modified the worktree, so their results do not count. Make the checks leave no files behind, then finish the change.';
          sys(room, `The acceptance checks changed the worktree in round ${r}; their results do not count. Sent back without a review.`);
          onUpdate(item); escalateNow(r); continue;
        }
        // ran: the receipt and the ledger read this to show that commands ran on this machine, unsandboxed, with a scrubbed environment.
        item.checkResults = { hash: item.proposal.hash, results, at: now(), ran: { count: checks.length, commands: checks.map((x) => x.cmd), env: 'minimal', sandboxed: false, startedAt: checksAt } };
        const bad = results.filter((x) => !x.ok);
        if (bad.length) {
          feedbackHead = `Acceptance checks failed (round ${r}). The board ran them in your worktree after your change:`;
          feedback = formatChecks(results);
          sys(room, `Acceptance checks failed in round ${r} (${bad.map((x) => x.name).join(', ')}); sent back to ${builder.name} without a review.`);
          onUpdate(item); escalateNow(r); continue;
        }
        checkText = `\n\n--- acceptance checks (patch ${item.proposal.hash.slice(0, 12)}) ---\n${formatChecks(results)}\n---`;
      } else if (worktree) item.checkResults = null;
      item.review = null; item.status = 'reviewing'; onUpdate(item);

      // The reviewer's thread already holds the task after its first turn: later rounds do not send it again.
      const rNotes = pendingNotes(room);
      const rNoteText = noteBlock(rNotes);
      const reviewerHasTask = !!room.threads?.[reviewerKey];
      const intro = reviewerHasTask
        ? `Review the revised ${kind} from ${builder.name} for the same task (round ${r}).`
        : `Review ${builder.name}'s latest ${kind} on this task:\n${reviewTask}`;
      // From the second round on the reviewer's thread holds the earlier patch: it gets the unresolved findings and only
      // the diff since that round, not the whole patch again.
      const carried = reviewerHasTask && lastFindings ? `\n\n--- unresolved findings from your round ${r - 1} review ---\n${lastFindings}\n---` : '';
      let body, fullPatch = null;
      if (worktree) {
        let patchText;
        try { patchText = patch.readProposal({ store, rel: item.proposal.file, hash: item.proposal.hash }).toString('utf8'); }
        catch (e) { return failed(`proposal unreadable: ${e.message}`, null, `Could not read the frozen proposal in round ${r}: ${e.message}`); }
        fullPatch = patchText;
        const delta = reviewerHasTask && prevPatch !== null;
        if (delta) patchText = diffSincePrevious(prevPatch, patchText).trim() || '(the patch is unchanged since the previous round)';
        if (patchText.length > PATCH_SHOW_CHARS) patchText = patchText.slice(0, PATCH_SHOW_CHARS) + '\n…(patch truncated; the full change is in your working directory)';
        const label = delta ? `changes since round ${r - 1}, patch ${item.proposal.hash.slice(0, 12)} (${item.proposal.files.length} file(s) in total)` : `patch ${item.proposal.hash.slice(0, 12)} (${item.proposal.files.length} file(s))`;
        // In patch mode the builder's reply ends with the same diff that follows as the patch: send it once.
        const summary = patchMode ? stripDiffBlocks(b.text) : b.text;
        body = `\n\n--- ${builder.name} summary ---\n${summary}\n---${carried}\n\n--- ${label} ---\n${patchText}\n---`;
      } else {
        // Later rounds: the reviewer's thread holds the earlier output, so it gets only what changed.
        const cur = b.text || '';
        const part = reviewerHasTask && prevOutput !== null ? textSincePrevious(prevOutput, cur) : null;
        body = part !== null
          ? `${carried}\n\n--- changes in ${builder.name}'s output since round ${r - 1} ---\n${part}\n---`
          : `${carried}\n\n--- ${builder.name} output ---\n${cur}\n---`;
      }
      const reviewPrompt = reviewerHasTask
        ? `${intro}${body}${checkText}${rNoteText}\n\n${VERDICT_RULE}`
        : buildPacket({ stable: { rules: VERDICT_RULE, plan: shared.plan, brief: shared.brief }, item: `${intro}${body}${checkText}${rNoteText}` });
      const rv = await say(room, reviewerId, reviewPrompt, {
        round: r, label: 'review', tools: 'read', worktree: worktree ? worktree.dir : null, withTarget: !worktree, threadKey: reviewerKey,
      });
      if (room.stopped) break;
      // A review that could not run is not a FAIL verdict: stop with an error instead of looping on empty feedback.
      if (!rv.ok) return failed(rv.error, 'reviewer', `${reviewer.name} failed: ${rv.error}`);
      rNotes.forEach((m) => { m.consumed = true; }); // the reviewer read them
      if (fullPatch !== null) prevPatch = fullPatch; // the reviewer has now seen this patch
      else prevOutput = b.text || ''; // ... or this output

      if (worktree) {
        // The review counts only if the worktree still holds exactly the frozen change.
        let current;
        try { current = patch.hashWorktree({ worktreeDir: worktree.dir, startTree: worktree.startTree }); }
        catch (e) { return failed(`worktree unreadable: ${e.message}`, null, `Could not re-check the worktree after the review: ${e.message}`); }
        if (current !== item.proposal.hash) {
          sys(room, 'The worktree changed after the proposal was frozen, so this review does not count.');
          feedback = 'Your files changed after your change was frozen for review. Re-check the change and finish it.';
          item.review = null; onUpdate(item);
          continue;
        }
      }

      // Only a successful review whose last non-empty line is exactly the verdict counts as PASS.
      const passed = /^VERDICT:\s*PASS$/i.test(lastLine(rv.text));
      if (rv.msg) { // absent only when the reviewer was deleted mid-chain
        rv.msg.verdict = passed ? 'pass' : 'fail';
        room.resultId = rv.msg.id; // the latest review is the result
        if (live(room)) broadcast({ t: 'msg', roomId: room.id, msg: rv.msg }); saveRoom(room);
      }
      item.review = { hash: item.proposal.hash, verdict: passed ? 'pass' : 'fail', msgId: rv.msg?.id || null, seatId: reviewerId, at: now() };
      if (passed) { item.status = 'passed'; onUpdate(item); return { status: 'passed', rounds: r, text: b.text || '' }; }
      // NITs are not acted on by the builder (it addresses BLOCKER and SHOULD-FIX only): they are not forwarded.
      feedback = rv.text.split(/\r?\n/).filter((l) => !/^\s*(?:[-*]\s*)?\**\s*NIT\b/i.test(l)).join('\n').trim() || rv.text;
      lastFindings = feedback;
      onUpdate(item);
      escalateNow(r);
    }
    if (room.stopped) { item.status = 'pending'; onUpdate(item); return { status: 'stopped', rounds: room.round }; }
    item.status = 'needs-you'; onUpdate(item);
    return { status: 'failed', rounds: room.round };
  }

  // The room workflow (v0.1 contract): the builder always proposes; a write seat is told that edits happen only in
  // Build sessions. The item is the room's own 'main' item, with no worktree.
  async function runChain(room) {
    const { task, builderId, reviewerId, maxRounds, escalate } = room;
    const builder = seatById(builderId), reviewer = seatById(reviewerId);
    const ctx = room.withContext ? buildContext() : '';
    if (builder.perm === 'write') sys(room, 'File edits happen only in Build sessions (Plan → Approve → Build); this builder proposes.');
    const item = (room.item ||= { id: 'main' });
    const res = await runItemChain(room, item, { task: `Task:\n${task}${ctx}`, reviewTask: task, builderId, reviewerId, maxRounds, escalate, worktree: null });
    const reviewerFailed = res.failedSeat === 'reviewer';
    // quarantined cannot happen without a worktree; it is mapped to error defensively.
    room.status = res.status === 'stopped' ? 'stopped' : res.status === 'passed' ? 'passed' : res.status === 'failed' ? 'needs-you' : 'error';
    if (room.status === 'needs-you') sys(room, 'Round limit reached without a PASS. Use "Run again" to retry, or "Continue in Direct chat" to settle it with one agent.');
    if (room.status === 'error' && reviewerFailed) sys(room, `${reviewer.name} could not complete the review, so the latest ${builder.perm !== 'write' ? 'proposal' : 'change'} above is unreviewed. Fix the cause shown above (see the setup check), then use "Run again".`);
    else if (room.status === 'error') sys(room, `${builder.name} could not complete a turn, so there was nothing to review. Fix the cause shown above (see the setup check), then use "Run again".`);
    room.messages.filter((m) => m.seatId === 'user' && !m.consumed && m !== room.messages[0]).forEach((m) => sys(room, NOT_DELIVERED(m)));
    pushRoom(room);
    store.appendLog('board', `Propose→Review ${builder.name}→${reviewer.name} "${task.slice(0, 80)}": ${room.status} after ${room.round} round(s).`);
  }

  return { runChain, runItemChain, bump };
}

module.exports = { createChain };
