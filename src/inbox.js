// Decision inbox: a pure function from board state to the cards that need the user. No I/O, no clock, no mutation.
// state = { rooms: [room] | { id: room } }. Rooms and items use the shapes of plan.js and build.js.
// Card: { id, kind, roomId, itemId?, title, why, evidence: [string], actions: [{ id, label }], priority }.
// A lower priority number is more urgent. Ties keep a stable order: roomId, then itemId, then kind.

const PRIORITY = {
  quarantined: 10,
  'quota-stop': 20,
  'failed-check': 30,
  'item-failed': 35,
  'needs-artifact': 40,
  apply: 50,
  'plan-approval': 60,
  paused: 70,
};

// Item states where the agent has stopped and the user must decide. building, checking, reviewing and pending are auto-fix states.
const USER_STATES = new Set(['passed', 'needs-you', 'failed', 'apply-failed']);

const str = (v, max = 300) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const roomsOf = (state) => {
  const r = state && state.rooms;
  if (Array.isArray(r)) return r.filter(Boolean);
  if (r && typeof r === 'object') return Object.values(r).filter(Boolean);
  return [];
};
const itemsOf = (room) => {
  const items = room.items;
  const list = Array.isArray(items) ? items : items && typeof items === 'object' ? Object.values(items) : [];
  const order = Array.isArray(room.order) ? room.order : null;
  const out = list.filter((it) => it && typeof it === 'object');
  if (order) out.sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9));
  return out;
};
const label = (room) => str(room.title || (room.plan && room.plan.goal) || room.goal || room.id, 80);

function card(kind, room, item, fields) {
  return {
    id: item ? `${kind}:${room.id}:${item.id}` : `${kind}:${room.id}`,
    kind, roomId: room.id, ...(item ? { itemId: item.id } : {}),
    title: fields.title, why: fields.why, evidence: fields.evidence.filter(Boolean),
    actions: fields.actions, priority: PRIORITY[kind],
  };
}

function failedChecks(item) {
  const results = item.checkResults && Array.isArray(item.checkResults.results) ? item.checkResults.results : [];
  return results.filter((x) => x && x.ok === false);
}

function planCards(room) {
  if (room.status !== 'awaiting-approval') return [];
  const n = room.plan && Array.isArray(room.plan.items) ? room.plan.items.length : 0;
  return [card('plan-approval', room, null, {
    title: `Approve plan: ${label(room)}`,
    why: 'Nothing is built before you approve the plan.',
    evidence: [`revision ${room.planRevision ?? '?'}`, `${n} item(s)`],
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'edit', label: 'Edit' }, { id: 'reject', label: 'Reject' }],
  })];
}

// Same conditions as checkApply in patch.js that can be derived from state (the git state checks need I/O).
function canApply(room, item) {
  if (room.mode !== 'write' || room.status === 'running' || room.status === 'needs-approval') return false;
  if (item.status !== 'passed' || !item.proposal || !item.proposal.file || !item.proposal.hash) return false;
  if (!item.review || item.review.verdict !== 'pass' || item.review.hash !== item.proposal.hash) return false;
  const items = room.items && typeof room.items === 'object' ? room.items : {};
  const byId = Array.isArray(items) ? Object.fromEntries(items.filter(Boolean).map((i) => [i.id, i])) : items;
  return (item.dependsOn || []).every((d) => byId[d] && byId[d].status === 'applied');
}

function applyCard(room, item, name) {
  const files = item.proposal.files || [];
  return card('apply', room, item, {
    title: `Apply: ${name}`,
    why: 'The review passed. The change is waiting for your approval to apply.',
    evidence: [`${files.length} file(s)`, ...files.slice(0, 5).map((f) => str(f, 120))],
    actions: [{ id: 'apply', label: 'Apply' }, { id: 'view', label: 'View patch' }, { id: 'discard', label: 'Discard' }],
  });
}

function buildCards(room) {
  const out = [];
  for (const item of itemsOf(room)) {
    const name = `${item.id}${item.title ? `: ${str(item.title, 80)}` : ''}`;
    const bad = failedChecks(item);
    if (item.status === 'quarantined') {
      out.push(card('quarantined', room, item, {
        title: `Quarantined: ${name}`,
        why: 'Files outside the item worktree changed. Nothing from this item is applied.',
        evidence: [str(item.error)],
        actions: [{ id: 'inspect', label: 'Inspect' }, { id: 'discard', label: 'Discard' }],
      }));
    } else if (bad.length && USER_STATES.has(item.status)) {
      out.push(card('failed-check', room, item, {
        title: `Checks failed: ${name}`,
        why: `${bad.length} acceptance check(s) failed.`,
        evidence: bad.map((x) => `${str(x.name || x.cmd, 80)}${x.code != null ? ` (exit ${x.code})` : ''}${x.output ? `: ${str(x.output, 160)}` : ''}`),
        actions: [{ id: 'retry', label: 'Run again' }, { id: 'inspect', label: 'Inspect' }, { id: 'discard', label: 'Discard' }],
      }));
    } else if (item.status === 'needs-you' || item.status === 'failed' || item.status === 'apply-failed') {
      out.push(card('item-failed', room, item, {
        title: `Needs you: ${name}`,
        why: item.status === 'needs-you' ? 'The round limit was reached without a PASS.' : `The item is ${item.status}.`,
        evidence: [str(item.error)],
        actions: [{ id: 'retry', label: 'Run again' }, { id: 'direct', label: 'Continue in direct chat' }, { id: 'discard', label: 'Discard' }],
      }));
    } else if (item.status === 'needs-artifact') {
      out.push(card('needs-artifact', room, item, {
        title: `No usable patch: ${name}`,
        why: 'The review passed but the item has no usable patch. Dependents wait.',
        evidence: [str(item.error)],
        actions: [{ id: 'retry', label: 'Build again' }, { id: 'discard', label: 'Discard' }],
      }));
    } else if (canApply(room, item)) {
      out.push(applyCard(room, item, name));
    }
  }
  const quota = room.stopReason === 'quota' || room.status === 'quota' || !!room.quotaStop;
  if (quota) {
    const q = room.quotaStop && typeof room.quotaStop === 'object' ? room.quotaStop : {};
    out.push(card('quota-stop', room, null, {
      title: `Quota reached: ${label(room)}`,
      why: 'An agent hit its usage limit, so the build stopped.',
      evidence: [str(q.seat || q.agent), q.resetsAt ? `resets at ${str(q.resetsAt)}` : '', str(room.error)],
      actions: [{ id: 'resume', label: 'Resume' }, { id: 'swap', label: 'Use another agent' }],
    }));
  } else if (room.status === 'paused') {
    out.push(card('paused', room, null, {
      title: `Paused: ${label(room)}`,
      why: 'The build is paused until you resume it.',
      evidence: [],
      actions: [{ id: 'resume', label: 'Resume' }, { id: 'stop', label: 'Stop' }],
    }));
  }
  return out;
}

function cardsFor(state) {
  const cards = [];
  for (const room of roomsOf(state)) {
    if (!room || room.id == null) continue;
    if (room.kind === 'plan') cards.push(...planCards(room));
    else if (room.kind === 'build') cards.push(...buildCards(room));
  }
  const key = (c) => `${c.roomId}|${c.itemId || ''}|${c.kind}`;
  return cards.sort((a, b) => a.priority - b.priority || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

module.exports = { cardsFor, PRIORITY };
