// Debate workflow: optional scout brief -> parallel round 1 -> discussion rounds (early stop on STANCE: CONVERGED) -> optional synthesis.
const { EFFORTS } = require('../config');
const { today, lastLine } = require('../util');

function createMeeting({ store, seats, rooms }) {
  const { seatById } = seats;
  const { say, sys, pushRoom, roomUsage, buildContext, NOT_DELIVERED } = rooms;

  // Short replies from context do not need deep reasoning; reasoning tokens dominate output cost.
  const capEffort = (seatId, cap) => { const s = seatById(seatId); if (!s) return cap; const l = EFFORTS[s.agent]; return l[Math.min(l.indexOf(s.effort), l.indexOf(cap))] || cap; };

  // Token-lean meeting:
  //  1. optional scout reads the code once and writes a shared brief (the only step with tools),
  //  2. round 1: independent ideas from the brief, no tools (avoids N agents re-reading the same files),
  //  3. later rounds: each seat gets only messages it has not seen (its room thread remembers the rest),
  //  4. stop early when every participant reports STANCE: CONVERGED,
  //  5. synthesis gets only what the facilitator has not seen yet.
  async function runMeeting(room) {
    const { topic, seatIds, rounds, synthId, scoutId } = room;
    const ctx = room.withContext ? buildContext() : '';
    const everyone = [...new Set([...seatIds, synthId, scoutId].filter(Boolean))];
    // Track seen message ids, not indexes: in the parallel round a placeholder exists before its text arrives.
    const seen = Object.fromEntries(everyone.map((id) => [id, new Set(room.messages.map((m) => m.id))]));
    const markOwn = () => everyone.forEach((id) => room.messages.filter((m) => m.seatId === id).forEach((m) => seen[id].add(m.id)));
    // Messages count as seen only after the seat's turn succeeds, so a failed turn does not lose them.
    const unseen = (id) => room.messages.filter((m) => !m.streaming && m.text && m.seatId !== id && m.seatId !== 'system' && !seen[id].has(m.id));
    const fmt = (ms) => ms.map((m) => `${m.seatId === 'user' ? 'User (the human running this meeting)' : m.name}: ${m.text}`).join('\n\n');
    const hasThread = (id) => !!room.threads?.[id];
    const converged = (text) => /^STANCE:\s*CONVERGED$/i.test(lastLine(text));
    const lastStance = {};

    let brief = '';
    if (scoutId) {
      room.round = 'scout'; pushRoom(room);
      const res = await say(room, scoutId, `Scout task for a meeting. Topic:\n${topic}${ctx}\n\nRead only what is relevant inside your target scope. Write a factual brief for the other participants (max 350 words): key facts, relevant files with file:line, constraints, unknowns. No opinions or recommendations.`, { round: 'scout', label: 'scout brief', tools: 'read', threadKey: scoutId + ':scout' }); // own thread: the files it read must not ride along in later rounds
      if (res.ok && res.text) brief = res.text;
      // The brief goes into round 1 prompts; user notes posted meanwhile stay unseen so round 2 delivers them.
      room.messages.filter((m) => m.seatId !== 'user' || m === room.messages[0]).forEach((m) => everyone.forEach((id) => seen[id].add(m.id)));
    }
    if (room.stopped) return finishMeeting(room, seen);

    // Topic + brief: sent in round 1, and again to any seat whose room thread does not exist (failed turn, facilitator).
    const background = () => `Meeting topic:\n${topic}\n\n${brief ? `Shared brief (facts gathered by ${seatById(scoutId)?.name || 'the scout'}; rely on it instead of re-reading files):\n${brief}\n\n` : ctx ? ctx + '\n\n' : ''}`;

    room.round = 1; pushRoom(room);
    const r1 = `${background()}Round 1 of ${rounds}: your independent ideas, 3-6 concrete bullets, max 180 words. Cite file:line for claims about code or mark them "unverified".`;
    await Promise.all(seatIds.map((id) => say(room, id, r1, { round: 1, label: 'independent ideas', tools: brief ? 'none' : 'read', withTarget: !brief })));
    markOwn();

    for (let r = 2; r <= rounds && !room.stopped; r++) {
      room.round = r; pushRoom(room);
      const stances = [];
      for (const id of seatIds) {
        if (room.stopped) break;
        const fresh = unseen(id);
        // Silent agreement: a converged seat skips its turn when everything new is also converged.
        if (lastStance[id] && fresh.length && fresh.every((m) => converged(m.text))) { sys(room, `✓ ${seatById(id)?.name} agreed silently (turn skipped).`, { skip: { seatId: id, round: r } }); stances.push(true); continue; }
        const res = await say(room, id, `${hasThread(id) ? '' : background()}Round ${r} of ${rounds}. New messages since your last turn:\n\n${fmt(fresh) || '(nothing new)'}\n\nRespond as in a live meeting: build on, challenge (name who and why) or merge. Max 120 words. End with exactly one line: "STANCE: CONVERGED" if you would sign the current direction, otherwise "STANCE: OPEN".`,
          { round: r, label: 'discussion', tools: 'none', withTarget: false, effort: capEffort(id, 'medium') });
        if (res.ok) fresh.forEach((m) => seen[id].add(m.id));
        markOwn();
        lastStance[id] = res.ok && converged(res.text);
        stances.push(lastStance[id]);
      }
      if (r < rounds && stances.length === seatIds.length && stances.every(Boolean)) { sys(room, '✓ Everyone converged: remaining rounds skipped.', { earlyStop: r }); break; }
    }

    if (synthId && !room.stopped) {
      room.round = 'synthesis'; pushRoom(room);
      const participated = seatIds.includes(synthId) && hasThread(synthId);
      const fresh = unseen(synthId), t = fmt(fresh);
      const res = await say(room, synthId, `${participated ? '' : background()}You are the facilitator. ${participated ? 'Messages you have not seen yet' : 'Meeting transcript'}:\n\n${t || '(none)'}\n\nSynthesize for the user: consensus, open disagreements (who vs who), top 3 options each with a first step, one recommendation. Max 350 words.${participated ? ' Treat your own earlier messages as one participant among the others; do not privilege them.' : ''}`, { label: 'synthesis', tools: 'none', withTarget: false });
      if (res.ok) {
        fresh.forEach((m) => seen[synthId].add(m.id)); // the facilitator read these notes: not "not delivered"
        room.resultId = res.msg.id;
        const cur = store.read('BRAINSTORM.md') ?? '# Brainstorm\n';
        store.write('BRAINSTORM.md', cur.replace(/\s*$/, '\n') + `\n## Debate (${today()}): ${topic.slice(0, 80)}\nParticipants: ${seatIds.map((id) => seatById(id)?.name).join(', ')} · rounds: ${rounds} · synthesis: ${seatById(synthId).name}\n\n${res.text}\n`);
      }
    }
    finishMeeting(room, seen);
  }

  function finishMeeting(room, seen = {}) {
    const sets = Object.values(seen);
    room.messages.filter((m, i) => i > 0 && m.seatId === 'user' && !sets.some((s) => s.has(m.id))).forEach((m) => sys(room, NOT_DELIVERED(m)));
    // A debate in which no agent turn succeeded (every CLI missing, every seat crashed) is an error, not "done".
    const turns = room.messages.filter((m) => m.seatId !== 'system' && m.seatId !== 'user');
    const allFailed = turns.length > 0 && turns.every((m) => m.error);
    room.status = room.stopped ? 'stopped' : allFailed ? 'error' : 'done';
    if (room.status === 'error') sys(room, 'Every agent turn failed, so there is no discussion. Fix the cause shown above (see the setup check), then use "Run again".');
    room.usage ||= roomUsage(room);
    pushRoom(room);
    store.appendLog('board', `Debate "${room.topic.slice(0, 80)}" ${room.status} (${room.seatIds.join(', ')}; net ${room.usage.tokens} tok, cached ${room.usage.cached}).`);
  }

  return { runMeeting, capEffort };
}

module.exports = { createMeeting };
