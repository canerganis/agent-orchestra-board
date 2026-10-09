// Plan workflow: optional debate, or a finished council (F9) -> manager writes a plan -> the user approves, edits or rejects it.
// Nothing here starts a build; approval only records the plan revision and hash that a build must match.
const { validatePlan, extractJson, planHash, PLAN_FORMAT } = require('./plan-model');
const { httpError, now } = require('../util');

const MAX_PLAN_TURNS = 2;
const REVISIONS_KEPT = 20;
// The manager gets a short handoff, never the transcript: a long handoff rebuilds the context the scout saved.
const DIGEST_MESSAGES = 4;
const DIGEST_CHARS = 800;
const SYNTHESIS_CHARS = 6000;

// Context the manager gets from the debate: the synthesis when there is one (capped), else the last few agent notes.
function debateDigest(room) {
  const result = room.resultId ? room.messages.find((m) => m.id === room.resultId) : null;
  if (result && result.text) {
    const t = result.text.length > SYNTHESIS_CHARS ? result.text.slice(0, SYNTHESIS_CHARS) + '\n…(synthesis truncated)' : result.text;
    return 'Debate synthesis:\n' + t;
  }
  const notes = room.messages
    .filter((m) => m.seatId !== 'system' && m.seatId !== 'user' && !m.error && m.text)
    .slice(-DIGEST_MESSAGES)
    .map((m) => `${m.name}: ${m.text.slice(0, DIGEST_CHARS)}`);
  return notes.length ? 'Debate notes:\n' + notes.join('\n\n') : '';
}

function createPlan({ store, seats, rooms, meeting }) {
  const { seatById } = seats;
  const { say, sys, pushRoom, buildContext } = rooms;
  const { runMeeting } = meeting;

  // Every plan revision is stored on the room; the newest REVISIONS_KEPT are kept.
  function setRevision(room, plan, by) {
    room.planRevision += 1;
    room.plan = plan;
    room.planHash = planHash(plan);
    room.revisions = room.revisions || [];
    room.revisions.push({ revision: room.planRevision, hash: room.planHash, by, at: now(), plan });
    if (room.revisions.length > REVISIONS_KEPT) room.revisions = room.revisions.slice(-REVISIONS_KEPT);
    room.approval = null;
  }


  // Drops item seats that no longer exist: a plan may name an agent that was deleted since the plan was written.
  function clearMissingSeats(plan) {
    for (const it of plan.items) if (it.seatId && !seatById(it.seatId)) it.seatId = null;
    return plan;
  }

  async function runPlan(room) {
    const managerId = room.managerId;
    const manager = seatById(managerId);
    if (!manager) {
      sys(room, 'The manager agent no longer exists.');
      room.status = 'error';
      pushRoom(room);
      return;
    }

    // A plan made from a council (F9) has no debate of its own: the manager gets the council's digest instead. A council
    // that is gone or not done any more ends the plan with an error, so the plan never runs without its context.
    const council = room.councilId ? rooms.rooms.get(room.councilId) : null;
    if (room.councilId && (!council || council.kind !== 'meeting' || council.status !== 'done')) {
      sys(room, 'The council this plan was made from is no longer available.');
      room.status = 'error';
      pushRoom(room);
      return;
    }
    if (council) sys(room, `Planning from the council "${council.title}". No debate runs for this plan.`);

    if (!room.councilId && room.seatIds.length >= 2) {
      await runMeeting(room);
      if (room.stopped) { room.status = 'stopped'; pushRoom(room); return; }
      if (room.status === 'error') { pushRoom(room); return; }
    }

    room.phase = 'plan';
    room.status = 'running';
    room.round = 'plan';
    pushRoom(room);

    const digest = debateDigest(council || room);
    const prompt = `You are the manager. Turn this goal into a build plan.\n\nGoal:\n${room.goal}${digest ? '\n\n' + digest : ''}${room.withContext ? buildContext() : ''}\n\n${PLAN_FORMAT}\n\nRead the code you need to choose precise owner areas. Reply with one JSON object in a \`\`\`json block and nothing else.`;

    let err = '';
    for (let turn = 1; turn <= MAX_PLAN_TURNS && !room.stopped; turn++) {
      const text = turn === 1
        ? prompt
        : `Your plan could not be used: ${err}. Reply with the corrected plan as one JSON object in a \`\`\`json block, nothing else.`;
      const res = await say(room, managerId, text, { round: 'plan', label: 'plan', tools: 'read', withTarget: true, threadKey: managerId + ':plan' });
      if (room.stopped) break;
      if (!res.ok) {
        sys(room, `${manager.name} could not write the plan: ${res.error}`);
        room.status = 'error';
        break;
      }
      try {
        const plan = clearMissingSeats(validatePlan(extractJson(res.text), { source: 'manager' }));
        setRevision(room, plan, 'manager');
        room.status = 'awaiting-approval';
        sys(room, `Plan revision ${room.planRevision} is ready: ${plan.items.length} item(s). Approve it, edit it or reject it. Nothing is built before you approve.`);
        break;
      } catch (e) {
        err = e.message;
        if (turn === MAX_PLAN_TURNS) {
          sys(room, `The plan is still invalid after ${MAX_PLAN_TURNS} tries: ${err}`);
          room.status = 'error';
        }
      }
    }

    if (room.stopped) room.status = 'stopped';
    pushRoom(room);
    store.appendLog('board', `Plan "${room.goal.slice(0, 80)}": ${room.status}${room.plan ? ` (${room.plan.items.length} items, revision ${room.planRevision})` : ''}.`);
  }

  // Checks shared by approve, edit and reject: the plan exists, is in a state that accepts decisions, and the
  // caller saw the current revision.
  function assertCurrent(room, { revision, hash }) {
    if (!room || room.kind !== 'plan') throw httpError(404, 'no such plan', 'no-plan');
    if (!['awaiting-approval', 'approved', 'rejected'].includes(room.status)) {
      throw httpError(409, 'the plan is not ready for approval', 'not-ready');
    }
    if (revision !== room.planRevision || hash !== room.planHash) {
      throw httpError(409, 'stale plan: reload and review the current revision', 'stale');
    }
  }

  // Validates a plan body sent by the user (edit or edit-then-approve) and returns the normalized plan.
  function validateBody(plan) {
    let v;
    try { v = validatePlan(plan); } catch (e) { throw httpError(400, e.message, 'invalid-plan'); }
    for (const it of v.items) {
      if (it.seatId !== null && !seatById(it.seatId)) throw httpError(400, `item "${it.id}": no such agent`, 'invalid-plan');
    }
    return v;
  }

  function approvePlan(room, { revision, hash, plan } = {}) {
    assertCurrent(room, { revision, hash });
    if (plan !== undefined && plan !== null) {
      const v = validateBody(plan);
      if (planHash(v) !== room.planHash) setRevision(room, v, 'user');
    }
    // Live acceptance checks are shell commands: the approval records how many were approved (the plan hash covers them).
    const nChecks = room.plan.items.reduce((n, it) => n + (it.checks ? it.checks.length : 0), 0);
    room.approval = { decision: 'approved', revision: room.planRevision, hash: room.planHash, at: now(), checks: nChecks };
    room.status = 'approved';
    sys(room, `You approved revision ${room.planRevision} (${room.planHash.slice(0, 12)})${nChecks ? `, including ${nChecks} acceptance check command(s) that run on this machine` : ''}.`);
    pushRoom(room);
    return room.approval;
  }

  function editPlan(room, { revision, hash, plan } = {}) {
    assertCurrent(room, { revision, hash });
    if (plan === undefined || plan === null) throw httpError(400, 'plan is required');
    const v = validateBody(plan);
    if (planHash(v) === room.planHash) throw httpError(400, 'no changes', 'no-changes');
    setRevision(room, v, 'user');
    room.status = 'awaiting-approval';
    sys(room, `Revision ${room.planRevision} saved. Approve it to build; any build of an earlier revision waits for approval.`);
    pushRoom(room);
    return { revision: room.planRevision, hash: room.planHash };
  }

  function rejectPlan(room, { revision, hash, note } = {}) {
    assertCurrent(room, { revision, hash });
    room.approval = { decision: 'rejected', revision: room.planRevision, hash: room.planHash, at: now(), note: note || null };
    room.status = 'rejected';
    sys(room, 'You rejected this plan.' + (note ? ' Note: ' + note : ''));
    pushRoom(room);
    return { ok: true };
  }

  // True only while the plan's current approval matches this hash (an edit clears the approval).
  function isApproved(planRoom, hash) {
    return !!planRoom && planRoom.kind === 'plan' && planRoom.approval?.decision === 'approved'
      && planRoom.approval.hash === hash && planRoom.planHash === hash;
  }

  return { runPlan, approvePlan, editPlan, rejectPlan, isApproved, setRevision, MAX_PLAN_TURNS };
}

module.exports = { createPlan, debateDigest, MAX_PLAN_TURNS, SYNTHESIS_CHARS };
