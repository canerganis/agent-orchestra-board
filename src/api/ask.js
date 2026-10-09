// POST /api/ask {roomId?, seatId, text, model?, effort?} -> {roomId} (plan F8): one turn of an Ask conversation. Without
// roomId a new Ask room starts; with it the conversation goes on, and seatId may name another seat (the switch). The
// checks and the turn live in rooms.sendAsk; this route reads the shape of the body and finds the room.
const { v } = require('../security');
const { httpError } = require('../util');

module.exports = (ctx) => [{
  method: 'POST',
  re: /^\/api\/ask$/,
  run: async ({ body }) => {
    const roomId = v.id(body.roomId, 'roomId');
    const seatId = v.id(body.seatId, 'seatId', { required: true });
    const room = roomId === undefined ? null : ctx.rooms.rooms.get(roomId);
    if (roomId !== undefined && !room) throw httpError(404, 'no such room');
    const text = v.str(body.text, 'text', { max: 20000 }) || '';
    const out = ctx.rooms.sendAsk(room, seatId, text, { model: body.model, effort: body.effort });
    return { roomId: out.id };
  },
}];
