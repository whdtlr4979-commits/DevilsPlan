'use strict';

/**
 * Socket.IO 어댑터 — 실제 로직은 public/shared/russian-roulette/room.js (브라우저 P2P 호스트와 공용)
 */
const { Room, randomCode } = require('../../../public/shared/russian-roulette/room');

const ROOM_IDLE_MS = 1000 * 60 * 60; // 1시간 동안 사람이 없으면 방 삭제
const ROOM_EVENTS = ['addBot', 'kick', 'start', 'action', 'backToLobby', 'chat', 'leave'];

module.exports = function attach(nsp) {
  const rooms = new Map(); // code -> Room
  const clientRoom = new Map(); // socket.id -> code
  const send = (clientId, type, data) => nsp.to(clientId).emit(type, data);
  const reply = (ack, payload) => typeof ack === 'function' && ack(payload);

  nsp.on('connection', (socket) => {
    const current = () => rooms.get(clientRoom.get(socket.id));

    const leaveCurrent = () => {
      const room = current();
      if (room) room.disconnect(socket.id);
      clientRoom.delete(socket.id);
    };

    socket.on('create', (payload, ack) => {
      leaveCurrent();
      let code;
      do code = randomCode();
      while (rooms.has(code));
      const room = new Room({ code, send, onClose: () => rooms.delete(code) });
      rooms.set(code, room);
      clientRoom.set(socket.id, code);
      const res = room.createHost(socket.id, payload || {});
      if (!res.ok) {
        rooms.delete(code);
        clientRoom.delete(socket.id);
      }
      reply(ack, res);
    });

    socket.on('join', (payload, ack) => {
      const code = String((payload && payload.code) || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return reply(ack, { ok: false, error: '존재하지 않는 방 코드입니다.' });
      if (clientRoom.get(socket.id) !== code) leaveCurrent();
      clientRoom.set(socket.id, code);
      const res = room.join(socket.id, payload || {});
      if (!res.ok) clientRoom.delete(socket.id);
      reply(ack, res);
    });

    for (const ev of ROOM_EVENTS) {
      socket.on(ev, (payload, ack) => {
        const room = current();
        if (!room) return reply(ack, { ok: false, error: '방을 찾을 수 없습니다.' });
        reply(ack, room.request(socket.id, ev, payload));
        if (ev === 'leave') clientRoom.delete(socket.id);
      });
    }

    socket.on('disconnect', leaveCurrent);
  });

  // 비활성 방 정리
  setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (!room.hasConnectedHumans() && now - room.lastActive > ROOM_IDLE_MS) room.close();
    }
  }, 60 * 1000).unref();

  return { rooms };
};
