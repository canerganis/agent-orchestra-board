// Propose -> Review workflow: builder proposes (or edits, if a write seat), reviewer answers VERDICT: PASS/FAIL, loop with optional effort escalation.
const { EFFORTS } = require('../config');
const { lastLine } = require('../util');
const { resolveTarget, gitDiff } = require('../target');

function createChain({ store, seats, rooms, broadcast }) {
  const { seatById } = seats;
  const { say, sys, pushRoom, saveRoom, live, buildContext, NOT_DELIVERED } = rooms;

  const bump = (agent, e) => { const l = EFFORTS[agent]; return l[Math.min(l.indexOf(e) + 1, l.length - 1)]; };

  async function runChain(room) {
    const { task, builderId, reviewerId, maxRounds, escalate } = room;
    const builder = seatById(builderId), reviewer = seatById(reviewerId);
    const ctx = room.withContext ? buildContext() : '';
    let effort = builder.effort, feedback = null, passed = false, builderFailed = false, reviewerFailed = false;
    for (let r = 1; r <= maxRounds && !room.stopped; r++) {
      room.round = r; pushRoom(room);
      // A read-only builder proposes (v0.1 default); only a write seat edits files.
      const propose = builder.perm !== 'write';
      const doIt = propose ? 'You cannot modify files: propose the change concretely (files, exact edits or a patch). End with a short summary.' : 'Do the task. End with a short summary of what you changed.';
      // Notes the user posted into the room since the builder's last turn.
      const notes = room.messages.filter((m) => m.seatId === 'user' && !m.consumed && m !== room.messages[0]);
      notes.forEach((m) => { m.consumed = true; });
      const noteText = notes.length ? `\n\nNotes from the user:\n${notes.map((m) => '- ' + m.text).join('\n')}` : '';
      const b = await say(room, builderId, r === 1
        ? `Task:\n${task}${ctx}${noteText}\n\n${doIt}`
        : `Review feedback from ${reviewer.name} (round ${r - 1}):\n${feedback}${noteText}\n\nAddress the BLOCKER and SHOULD-FIX items only, then summarize.`, { round: r, effort, label: `${propose ? 'proposal' : 'implementation'} · ${effort}` });
      if (room.stopped) break;
      // A builder that cannot run (missing CLI, crash) is an error, not a review that ran out of rounds.
      if (!b.ok) { builderFailed = true; sys(room, `${builder.name} failed: ${b.error}`); break; }
      const diff = propose ? '' : gitDiff(resolveTarget(builder, store.project).cwd);
      // Notes posted while the builder worked go to the reviewer.
      const rNotes = room.messages.filter((m) => m.seatId === 'user' && !m.consumed && m !== room.messages[0]);
      rNotes.forEach((m) => { m.consumed = true; });
      const rNoteText = rNotes.length ? `\n\nNotes from the user:\n${rNotes.map((m) => '- ' + m.text).join('\n')}` : '';
      const rv = await say(room, reviewerId, `Review ${builder.name}'s latest ${propose ? 'proposal' : 'work'} on this task:\n${task}\n\n--- ${builder.name} output ---\n${b.text}\n---${diff ? `\n\n--- changes ---\n${diff}\n---` : ''}${rNoteText}\n\nList at most 3 BLOCKER, 3 SHOULD-FIX and 3 NIT findings. FAIL only if a BLOCKER exists. The last line must be exactly "VERDICT: PASS" or "VERDICT: FAIL".`,
        { round: r, label: 'review', withTarget: !diff });
      if (room.stopped) break;
      // A review that could not run is not a FAIL verdict: stop with an error instead of looping on empty feedback.
      if (!rv.ok) { reviewerFailed = true; sys(room, `${reviewer.name} failed: ${rv.error}`); break; }
      // Only a successful review whose last non-empty line is exactly the verdict counts as PASS.
      passed = rv.ok && /^VERDICT:\s*PASS$/i.test(lastLine(rv.text));
      if (rv.msg) { // absent only when the reviewer was deleted mid-chain
        rv.msg.verdict = passed ? 'pass' : 'fail';
        room.resultId = rv.msg.id; // the latest review is the result
        if (live(room)) broadcast({ t: 'msg', roomId: room.id, msg: rv.msg }); saveRoom(room);
      }
      if (passed) break;
      feedback = rv.text;
      if (escalate && r < maxRounds) { const next = bump(builder.agent, effort); if (next !== effort) { effort = next; sys(room, `⚡ ${builder.name} effort raised → ${effort}`); } }
    }
    room.status = room.stopped ? 'stopped' : passed ? 'passed' : builderFailed || reviewerFailed ? 'error' : 'needs-you';
    if (room.status === 'needs-you') sys(room, 'Round limit reached without a PASS. Use "Run again" to retry, or "Continue in Direct chat" to settle it with one agent.');
    if (room.status === 'error' && reviewerFailed) sys(room, `${reviewer.name} could not complete the review, so the latest ${builder.perm !== 'write' ? 'proposal' : 'change'} above is unreviewed. Fix the cause shown above (see the setup check), then use "Run again".`);
    else if (room.status === 'error') sys(room, `${builder.name} could not complete a turn, so there was nothing to review. Fix the cause shown above (see the setup check), then use "Run again".`);
    room.messages.filter((m) => m.seatId === 'user' && !m.consumed && m !== room.messages[0]).forEach((m) => sys(room, NOT_DELIVERED(m)));
    pushRoom(room);
    store.appendLog('board', `Propose→Review ${builder.name}→${reviewer.name} "${task.slice(0, 80)}": ${room.status} after ${room.round} round(s).`);
  }

  return { runChain, bump };
}

module.exports = { createChain };
