'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../public/shared/russian-roulette/room');

function setup(opts = {}) {
  const inbox = {}; // clientId -> [{type, data}]
  const send = (cid, type, data) => (inbox[cid] = inbox[cid] || []).push({ type, data });
  const room = new Room({ code: 'TEST', send, botDelay: 5, disconnectDelay: 5, ...opts });
  const last = (cid, type = 'room') => [...(inbox[cid] || [])].reverse().find((m) => m.type === type);
  return { room, inbox, last };
}

test('방 생성 / 입장 / 방 상태 전송', () => {
  const { room, last } = setup();
  assert.ok(room.createHost('h', { name: '호스트' }).ok);
  const r = room.join('g', { name: '게스트' });
  assert.ok(r.ok && r.token);
  const v = last('g').data;
  assert.strictEqual(v.players.length, 2);
  assert.strictEqual(v.meId, r.playerId);
  assert.strictEqual(room.join('x', { name: '게스트' }).ok, false, '닉네임 중복');
  // 토큰은 다른 플레이어에게 노출되지 않는다
  assert.ok(!JSON.stringify(last('h').data).includes(r.token));
});

test('토큰으로 재접속', () => {
  const { room, last } = setup();
  room.createHost('h', { name: 'A' });
  const r = room.join('g1', { name: 'B' });
  room.disconnect('g1');
  assert.strictEqual(last('h').data.players.find((p) => p.name === 'B').connected, false);
  const again = room.join('g2', { token: r.token });
  assert.ok(again.ok);
  assert.strictEqual(again.playerId, r.playerId);
  assert.strictEqual(room.join('g3', { token: 'nope' }).ok, false);
});

test('방장 권한: 봇 추가, 강퇴, 시작', () => {
  const { room, last } = setup();
  room.createHost('h', { name: 'A' });
  room.join('g', { name: 'B' });
  assert.strictEqual(room.request('g', 'addBot').ok, false);
  assert.ok(room.request('h', 'addBot').ok);
  const gid = last('g').data.meId;
  assert.ok(room.request('h', 'kick', { playerId: gid }).ok);
  assert.ok(last('g', 'kicked'));
  assert.strictEqual(room.request('g', 'chat', { text: 'hi' }).ok, false);
  assert.ok(room.request('h', 'start').ok);
  const v = last('h').data;
  assert.strictEqual(v.phase, 'playing');
  assert.strictEqual(v.players.length, 6);
  room.close();
});

test('P2P 모드: 방장이 나가면 방이 닫힌다', () => {
  let closed = false;
  const { room, last } = setup({ hostIsServer: true, onClose: () => (closed = true) });
  room.createHost('h', { name: 'A' });
  room.join('g', { name: 'B' });
  room.request('h', 'leave');
  assert.ok(closed);
  assert.ok(last('g', 'closed'));
});

test('서버 모드: 방장이 나가면 방장 위임', () => {
  const { room, last } = setup();
  room.createHost('h', { name: 'A' });
  const g = room.join('g', { name: 'B' });
  room.request('h', 'leave');
  assert.strictEqual(last('g').data.hostId, g.playerId);
});

test('저장 / 복원 후 이어서 진행', async () => {
  const { room, inbox } = setup();
  room.createHost('h', { name: 'A', practice: true });
  const token = room.players[0].token;
  const saved = JSON.parse(JSON.stringify(room.serialize()));
  room.close();

  const send = (cid, type, data) => (inbox[cid] = inbox[cid] || []).push({ type, data });
  const restored = Room.restore(saved, { send, botDelay: 1, disconnectDelay: 1 });
  assert.ok(restored.join('h2', { token }).ok);
  assert.strictEqual(restored.game.phase, 'playing');
  // 봇 + (내 차례면) 대신 진행되며 결국 종료된다
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (restored.game.phase === 'ended') { clearInterval(iv); resolve(); }
      const me = restored.players.find((p) => !p.isBot);
      if (restored.game && restored.game.phase === 'playing') {
        const cur = restored.game.seats[(restored.game.firstSeat + restored.game.offset) % 6];
        if (cur === me.id) restored.request('h2', 'action', { type: 'manip', amount: 1, pair: 0 });
      }
    }, 2);
  });
  assert.strictEqual(restored.game.result.eliminated.length, 2);
  restored.close();
});
