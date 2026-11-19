'use strict';

const crypto = require('crypto');
const engine = require('./engine');
const bot = require('./bot');

const MAX_PLAYERS = engine.SEATS;
const BOT_DELAY_MS = 1500;
const DISCONNECTED_DELAY_MS = 8000; // 접속이 끊긴 플레이어는 이 시간 후 봇이 대신 진행
const ROOM_IDLE_MS = 1000 * 60 * 60; // 1시간 동안 사람이 없으면 방 삭제
const CHAT_LIMIT = 60;
const BOT_NAMES = ['봇 알파', '봇 브라보', '봇 찰리', '봇 델타', '봇 에코', '봇 폭스'];

const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(18).toString('base64url');

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 12);
  return n || null;
}

function newCode(rooms) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

module.exports = function attach(nsp) {
  const rooms = new Map();

  /* ---------------- 공통 헬퍼 ---------------- */

  const humans = (room) => room.players.filter((p) => !p.isBot);
  const findPlayer = (room, id) => room.players.find((p) => p.id === id);

  function roomView(room, viewerId) {
    return {
      code: room.code,
      hostId: room.hostId,
      meId: viewerId,
      gameNo: room.gameNo || 0,
      phase: room.game ? room.game.phase : 'lobby',
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        connected: p.isBot ? true : p.connected,
      })),
      game: room.game ? engine.viewFor(room.game, viewerId) : null,
      chat: room.chat,
    };
  }

  function broadcast(room) {
    for (const p of room.players) {
      if (!p.isBot && p.connected && p.socketId) {
        nsp.to(p.socketId).emit('room', roomView(room, p.id));
      }
    }
  }

  function systemChat(room, text) {
    room.chat.push({ system: true, text, at: Date.now() });
    if (room.chat.length > CHAT_LIMIT) room.chat.shift();
  }

  function schedule(room) {
    clearTimeout(room.timer);
    room.timer = null;
    const g = room.game;
    if (!g || g.phase !== 'playing') return;
    const pid = engine.currentPlayerId(g);
    const p = findPlayer(room, pid);
    if (!p) return;
    if (p.isBot || !p.connected) {
      room.timer = setTimeout(() => autoPlay(room, pid), p.isBot ? BOT_DELAY_MS : DISCONNECTED_DELAY_MS);
    }
  }

  function autoPlay(room, pid) {
    const g = room.game;
    if (!g || g.phase !== 'playing' || engine.currentPlayerId(g) !== pid) return;
    const p = findPlayer(room, pid);
    if (p && !p.isBot && p.connected) return; // 그 사이에 재접속
    const action = bot.decide(g, pid);
    let res = engine.applyAction(g, pid, action);
    if (!res.ok) res = engine.applyAction(g, pid, { type: 'publicCheck', pair: 0 }); // 안전장치
    if (!res.ok) res = engine.applyAction(g, pid, { type: 'manip', amount: 1, pair: 0 });
    afterChange(room);
  }

  function afterChange(room) {
    room.lastActive = Date.now();
    if (room.game && room.game.phase === 'ended' && !room.endAnnounced) {
      room.endAnnounced = true;
      const names = room.game.result.eliminated.map((id) => room.game.players[id].name);
      systemChat(room, `게임 종료! 탈락: ${names.join(', ')}`);
    }
    broadcast(room);
    schedule(room);
  }

  function bind(socket, room, player) {
    player.socketId = socket.id;
    player.connected = true;
    socket.data.code = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
  }

  function ctx(socket) {
    const room = rooms.get(socket.data.code);
    if (!room) return {};
    return { room, player: findPlayer(room, socket.data.playerId) };
  }

  function removePlayer(room, playerId) {
    room.players = room.players.filter((p) => p.id !== playerId);
    if (room.hostId === playerId) {
      const next = humans(room)[0];
      room.hostId = next ? next.id : null;
    }
    if (!humans(room).length) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
    }
  }

  function startGame(room) {
    let n = 0;
    while (room.players.length < MAX_PLAYERS) {
      const used = new Set(room.players.map((p) => p.name));
      const name = BOT_NAMES.find((b) => !used.has(b)) || `봇 ${++n}`;
      room.players.push({ id: newId(), name, isBot: true, connected: true });
    }
    room.gameNo = (room.gameNo || 0) + 1;
    room.game = engine.createGame(room.players.map((p) => ({ id: p.id, name: p.name })));
    room.endAnnounced = false;
    systemChat(room, '게임이 시작되었습니다. 자리 추첨 완료!');
  }

  const reply = (ack, payload) => typeof ack === 'function' && ack(payload);

  /* ---------------- 소켓 이벤트 ---------------- */

  nsp.on('connection', (socket) => {
    socket.on('create', ({ name, practice } = {}, ack) => {
      const n = cleanName(name);
      if (!n) return reply(ack, { ok: false, error: '닉네임을 입력하세요.' });
      const code = newCode(rooms);
      const player = { id: newId(), name: n, token: newToken(), isBot: false, connected: true };
      const room = { code, hostId: player.id, players: [player], game: null, chat: [], timer: null, lastActive: Date.now() };
      rooms.set(code, room);
      bind(socket, room, player);
      systemChat(room, `${n} 님이 방을 만들었습니다.`);
      if (practice) startGame(room);
      reply(ack, { ok: true, code, playerId: player.id, token: player.token });
      afterChange(room);
    });

    socket.on('join', ({ code, name, token } = {}, ack) => {
      const room = rooms.get(String(code || '').toUpperCase().trim());
      if (!room) return reply(ack, { ok: false, error: '존재하지 않는 방 코드입니다.' });

      // 재접속
      if (token) {
        const existing = room.players.find((p) => !p.isBot && p.token === token);
        if (existing) {
          bind(socket, room, existing);
          reply(ack, { ok: true, code: room.code, playerId: existing.id, token: existing.token });
          afterChange(room);
          return;
        }
      }
      const n = cleanName(name);
      if (!n) return reply(ack, { ok: false, error: '닉네임을 입력하세요.' });
      if (room.game && room.game.phase === 'playing') return reply(ack, { ok: false, error: '이미 게임이 진행 중입니다.' });
      if (room.players.some((p) => p.name === n)) return reply(ack, { ok: false, error: '이미 사용 중인 닉네임입니다.' });

      // 자리가 없으면 봇 한 명을 내보낸다
      if (room.players.length >= MAX_PLAYERS) {
        const botIdx = room.players.findIndex((p) => p.isBot);
        if (botIdx < 0) return reply(ack, { ok: false, error: '방이 가득 찼습니다. (최대 6명)' });
        room.players.splice(botIdx, 1);
      }
      const player = { id: newId(), name: n, token: newToken(), isBot: false, connected: true };
      room.players.push(player);
      bind(socket, room, player);
      systemChat(room, `${n} 님이 입장했습니다.`);
      reply(ack, { ok: true, code: room.code, playerId: player.id, token: player.token });
      afterChange(room);
    });

    socket.on('addBot', (_, ack) => {
      const { room, player } = ctx(socket);
      if (!room || room.hostId !== player?.id) return reply(ack, { ok: false, error: '방장만 할 수 있습니다.' });
      if (room.game && room.game.phase === 'playing') return reply(ack, { ok: false, error: '게임 중에는 할 수 없습니다.' });
      if (room.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: '자리가 없습니다.' });
      const used = new Set(room.players.map((p) => p.name));
      const name = BOT_NAMES.find((b) => !used.has(b)) || `봇 ${room.players.length + 1}`;
      room.players.push({ id: newId(), name, isBot: true, connected: true });
      reply(ack, { ok: true });
      afterChange(room);
    });

    socket.on('kick', ({ playerId } = {}, ack) => {
      const { room, player } = ctx(socket);
      if (!room || room.hostId !== player?.id) return reply(ack, { ok: false, error: '방장만 할 수 있습니다.' });
      if (room.game && room.game.phase === 'playing') return reply(ack, { ok: false, error: '게임 중에는 할 수 없습니다.' });
      const target = findPlayer(room, playerId);
      if (!target || target.id === player.id) return reply(ack, { ok: false, error: '대상을 찾을 수 없습니다.' });
      if (!target.isBot && target.socketId) {
        nsp.to(target.socketId).emit('kicked');
        nsp.sockets.get(target.socketId)?.leave(room.code);
      }
      removePlayer(room, target.id);
      if (!target.isBot) systemChat(room, `${target.name} 님이 강퇴되었습니다.`);
      reply(ack, { ok: true });
      afterChange(room);
    });

    socket.on('start', (_, ack) => {
      const { room, player } = ctx(socket);
      if (!room || room.hostId !== player?.id) return reply(ack, { ok: false, error: '방장만 시작할 수 있습니다.' });
      if (room.game && room.game.phase === 'playing') return reply(ack, { ok: false, error: '이미 진행 중입니다.' });
      startGame(room);
      reply(ack, { ok: true });
      afterChange(room);
    });

    socket.on('action', (action, ack) => {
      const { room, player } = ctx(socket);
      if (!room || !player || !room.game) return reply(ack, { ok: false, error: '게임을 찾을 수 없습니다.' });
      const res = engine.applyAction(room.game, player.id, action);
      reply(ack, res);
      if (res.ok) afterChange(room);
    });

    socket.on('backToLobby', (_, ack) => {
      const { room, player } = ctx(socket);
      if (!room || room.hostId !== player?.id) return reply(ack, { ok: false, error: '방장만 할 수 있습니다.' });
      if (!room.game || room.game.phase !== 'ended') return reply(ack, { ok: false, error: '게임이 끝난 뒤에만 가능합니다.' });
      room.game = null;
      // 나간 사람은 정리
      room.players.filter((p) => !p.isBot && !p.connected).forEach((p) => removePlayer(room, p.id));
      if (!rooms.has(room.code)) return;
      systemChat(room, '대기실로 돌아왔습니다.');
      reply(ack, { ok: true });
      afterChange(room);
    });

    socket.on('chat', ({ text } = {}) => {
      const { room, player } = ctx(socket);
      const t = String(text || '').trim().slice(0, 200);
      if (!room || !player || !t) return;
      room.chat.push({ from: player.name, playerId: player.id, text: t, at: Date.now() });
      if (room.chat.length > CHAT_LIMIT) room.chat.shift();
      broadcast(room);
    });

    socket.on('leave', (_, ack) => {
      const { room, player } = ctx(socket);
      reply(ack, { ok: true });
      if (!room || !player) return;
      socket.leave(room.code);
      socket.data.code = null;
      if (room.game && room.game.phase === 'playing') {
        // 게임 중 이탈: 자리는 유지하고 봇이 대신 플레이
        player.connected = false;
        player.socketId = null;
        player.token = null;
        systemChat(room, `${player.name} 님이 나갔습니다. 남은 차례는 봇이 대신합니다.`);
        if (room.hostId === player.id) {
          const next = humans(room).find((p) => p.connected);
          if (next) room.hostId = next.id;
        }
        if (!humans(room).some((p) => p.connected)) {
          clearTimeout(room.timer);
          rooms.delete(room.code);
          return;
        }
      } else {
        systemChat(room, `${player.name} 님이 나갔습니다.`);
        removePlayer(room, player.id);
        if (!rooms.has(room.code)) return;
      }
      afterChange(room);
    });

    socket.on('disconnect', () => {
      const { room, player } = ctx(socket);
      if (!room || !player || player.socketId !== socket.id) return;
      player.connected = false;
      player.socketId = null;
      afterChange(room);
    });
  });

  // 비활성 방 정리
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (!humans(room).some((p) => p.connected) && now - room.lastActive > ROOM_IDLE_MS) {
        clearTimeout(room.timer);
        rooms.delete(code);
      }
    }
  }, 60 * 1000).unref();

  return { rooms };
};
