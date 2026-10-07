// Debate workflow: optional scout brief -> parallel round 1 -> discussion rounds (early stop on STANCE: CONVERGED) -> optional synthesis.
const { EFFORTS, naive, CLAUDE_CHEAP_MODEL } = require('../config');
const { today, lastLine, clip } = require('../util');

function createMeeting({ store, seats, rooms, settings = {} }) {
  const { seatById } = seats;
  const { say, sys, pushRoom, roomUsage, buildContext, NOT_DELIVERED } = rooms;

  // Short replies from context do not need deep reasoning; reasoning tokens dominate output cost.
  // The seat's effort (or its per-session override on the room) capped at `cap`. Setting capEffort off (settings.json,
  // default on) returns the uncapped effort for every discussion turn.
  const capEffort = (seatId, cap, room = null) => {
    const s = seatById(seatId); if (!s) return cap;
    const base = room?.overrides?.[seatId]?.effort || s.effort;
    if (settings.capEffort === false) return base;
    const l = EFFORTS[s.agent]; return l[Math.min(l.indexOf(base), l.indexOf(cap))] || cap;
  };

  // Token-lean meeting:
  //  1. optional scout reads the code once and writes a shared brief (the only step with tools),
  //  2. round 1: independent ideas from the brief, no tools (avoids N agents re-reading the same files),
  //  3. later rounds: each seat gets only messages it has not seen (its room thread remembers the rest),
  //  4. stop early when every participant reports STANCE: CONVERGED,
  //  5. synthesis gets only what the facilitator has not seen yet.
  // ORCHESTRA_NAIVE=1 (benchmark baseline only, see config.js) turns 1, 3 and 4 off: no scout, the full transcript
  // on a fresh thread with read tools and no effort cap every turn, no silent agreement, no early stop.
  // A failed seat never stalls the debate: its message is marked failed, the others continue, and the synthesis
  // prompt says whose turns are missing. A seat that cannot run at all (not logged in, deleted) sits out the rest.
  async function runMeeting(room) {
    const NAIVE = naive();
    const { topic, seatIds, rounds, synthId } = room;
    const scoutId = NAIVE ? null : room.scoutId;
    const ctx = room.withContext ? buildContext() : '';
    const everyone = [...new Set([...seatIds, synthId, scoutId].filter(Boolean))];
    // Track seen message ids, not indexes: in the parallel round a placeholder exists before its text arrives.
    const seen = Object.fromEntries(everyone.map((id) => [id, new Set(room.messages.map((m) => m.id))]));
    const markOwn = () => everyone.forEach((id) => room.messages.filter((m) => m.seatId === id).forEach((m) => seen[id].add(m.id)));
    // Messages count as seen only after the seat's turn succeeds, so a failed turn does not lose them.
    // A failed turn's text (a partial stream) is never forwarded: it is not a contribution.
    const unseen = (id) => room.messages.filter((m) => !m.streaming && m.text && !m.error && m.seatId !== id && m.seatId !== 'system' && !seen[id].has(m.id));
    // Naive baseline: everything said so far (own messages too: the turn runs on a fresh thread).
    const transcript = () => room.messages.filter((m, i) => i > 0 && !m.streaming && m.text && !m.error && m.seatId !== 'system');
    const fmt = (ms) => ms.map((m) => `${m.seatId === 'user' ? 'User (the human running this meeting)' : m.name}: ${m.text}`).join('\n\n');
    const hasThread = (id) => !!room.threads?.[id];
    const converged = (text) => /^STANCE:\s*CONVERGED$/i.test(lastLine(text));
    const lastStance = {};
    const failures = []; // { name, round, error } for the synthesis prompt
    const out = new Set(); // seats that cannot run at all (auth, deleted): skipped for the rest of the debate
    const nameOf = (id) => seatById(id)?.name || id;
    const noteFailure = (id, round, res) => {
      if (res.ok || res.error === 'stopped' || room.stopped) return;
      failures.push({ name: nameOf(id), round, error: clip(res.error || 'failed', 140) });
      // 'unavailable': the CLI could not be launched at all (missing binary, shim); retrying it only bills nothing but
      // failed messages, so it sits out like an auth failure.
      if ((res.failure === 'auth' || res.failure === 'unavailable' || res.error === 'no such agent') && !out.has(id) && seatIds.includes(id)) {
        out.add(id);
        sys(room, `${nameOf(id)} cannot run (${clip(res.error || 'failed', 160)}) and sits out the rest of this debate; the others continue.`, { seatOut: { seatId: id, round } });
      }
    };

    let brief = '';
    if (scoutId) {
      room.round = 'scout'; pushRoom(room);
      const res = await say(room, scoutId, `Scout task for a meeting. Topic:\n${topic}${ctx}\n\nRead only what is relevant inside your target scope. Write a factual brief for the other participants (max 350 words): key facts, relevant files with file:line, constraints, unknowns. No opinions or recommendations.`, { round: 'scout', label: 'scout brief', tools: 'read', threadKey: scoutId + ':scout', effort: capEffort(scoutId, 'medium', room), model: seatById(scoutId)?.agent === 'claude' ? CLAUDE_CHEAP_MODEL : null }); // turn-only default; a session override on the seat wins // own thread: the files it read must not ride along in later rounds
      if (res.ok && res.text) brief = res.text;
      else if (!room.stopped && res.error !== 'stopped') sys(room, `Scout ${nameOf(scoutId)} failed (${clip(res.error || 'no brief', 160)}); round 1 runs without a brief and reads the code itself.`);
      // The brief goes into round 1 prompts; user notes posted meanwhile stay unseen so round 2 delivers them.
      room.messages.filter((m) => m.seatId !== 'user' || m === room.messages[0]).forEach((m) => everyone.forEach((id) => seen[id].add(m.id)));
    }
    if (room.stopped) return finishMeeting(room, seen);

    // Topic + brief: sent in round 1, and again to any seat whose room thread does not exist (failed turn, facilitator).
    const background = () => `Meeting topic:\n${topic}\n\n${brief ? `Shared brief (facts gathered by ${seatById(scoutId)?.name || 'the scout'}; rely on it instead of re-reading files):\n${brief}\n\n` : ctx ? ctx + '\n\n' : ''}`;

    room.round = 1; pushRoom(room);
    const r1 = `${background()}Round 1 of ${rounds}: your independent ideas, 3-6 concrete bullets, max 180 words. Cite file:line for claims about code or mark them "unverified".`;
    const r1res = await Promise.all(seatIds.map((id) => say(room, id, r1, { round: 1, label: 'independent ideas', tools: brief ? 'none' : 'read', withTarget: !brief })));
    r1res.forEach((res, i) => noteFailure(seatIds[i], 1, res));
    markOwn();

    for (let r = 2; r <= rounds && !room.stopped; r++) {
      room.round = r; pushRoom(room);
      const stances = [];
      const active = seatIds.filter((id) => !out.has(id));
      // One seat left has nobody to answer: the debate goes straight to synthesis instead of paying for a monologue.
      if (active.length < 2) break;
      for (const id of active) {
        if (room.stopped) break;
        let res;
        if (NAIVE) {
          res = await say(room, id, `${background()}Round ${r} of ${rounds}. Full meeting transcript so far:\n\n${fmt(transcript()) || '(nothing yet)'}\n\nRespond as in a live meeting: build on, challenge (name who and why) or merge. Max 120 words. End with exactly one line: "STANCE: CONVERGED" if you would sign the current direction, otherwise "STANCE: OPEN".`,
            { round: r, label: 'discussion', tools: 'read', withTarget: true, threadKey: `${id}:r${r}` });
        } else {
          const fresh = unseen(id);
          // Nothing new for this seat (its peers' turns failed or were skipped): no billed turn, the stance carries over.
          if (!fresh.length) { stances.push(!!lastStance[id]); continue; }
          // Silent agreement: a converged seat skips its turn when everything new is also converged.
          if (lastStance[id] && fresh.length && fresh.every((m) => converged(m.text))) { sys(room, `✓ ${seatById(id)?.name} agreed silently (turn skipped).`, { skip: { seatId: id, round: r } }); stances.push(true); continue; }
          res = await say(room, id, `${hasThread(id) ? '' : background()}Round ${r} of ${rounds}. New messages since your last turn:\n\n${fmt(fresh) || '(nothing new)'}\n\nRespond as in a live meeting: build on, challenge (name who and why) or merge. Max 120 words. End with exactly one line: "STANCE: CONVERGED" if you would sign the current direction, otherwise "STANCE: OPEN".`,
            { round: r, label: 'discussion', tools: 'none', withTarget: false, effort: capEffort(id, 'medium', room) });
          // Not marked seen on failure: a failed turn may not have stored the prompt, and a repeated message is cheaper than a lost one.
          if (res.ok) fresh.forEach((m) => seen[id].add(m.id));
        }
        noteFailure(id, r, res);
        markOwn();
        lastStance[id] = res.ok && converged(res.text);
        stances.push(lastStance[id]);
      }
      if (!NAIVE && r < rounds && stances.length === active.length && stances.every(Boolean)) { sys(room, '✓ Everyone converged: remaining rounds skipped.', { earlyStop: r }); break; }
    }

    if (synthId && !room.stopped) {
      room.round = 'synthesis'; pushRoom(room);
      const participated = !NAIVE && seatIds.includes(synthId) && hasThread(synthId);
      const fresh = NAIVE ? transcript() : unseen(synthId), t = fmt(fresh);
      const missing = failures.length
        ? `\n\nSome turns failed and are missing from the transcript: ${failures.map((f) => `${f.name} (${f.round === 1 ? 'round 1' : `round ${f.round}`}: ${f.error})`).join('; ')}. Say in the synthesis whose input is missing, and do not present their views as known.`
        : '';
      const res = await say(room, synthId, `${participated ? '' : background()}You are the facilitator. ${participated ? 'Messages you have not seen yet' : 'Meeting transcript'}:\n\n${t || '(none)'}${missing}\n\nSynthesize for the user: consensus, open disagreements (who vs who), top 3 options each with a first step, one recommendation. Max 350 words.${participated ? ' Treat your own earlier messages as one participant among the others; do not privilege them.' : ''}`,
        { label: 'synthesis', tools: 'none', withTarget: false, ...(NAIVE ? { threadKey: `${synthId}:synth` } : {}) });
      if (res.ok) {
        fresh.forEach((m) => seen[synthId].add(m.id)); // the facilitator read these notes: not "not delivered"
        room.resultId = res.msg.id;
        const cur = store.read('BRAINSTORM.md') ?? '# Brainstorm\n';
        store.write('BRAINSTORM.md', cur.replace(/\s*$/, '\n') + `\n## Debate (${today()}): ${topic.slice(0, 80)}\nParticipants: ${seatIds.map((id) => seatById(id)?.name).join(', ')} · rounds: ${rounds} · synthesis: ${seatById(synthId)?.name || synthId}\n\n${res.text}\n`);
      } else if (!room.stopped && res.error !== 'stopped') sys(room, `The synthesis by ${nameOf(synthId)} failed (${clip(res.error || 'failed', 160)}); the discussion above is the result.`);
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
