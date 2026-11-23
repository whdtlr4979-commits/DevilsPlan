'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../public/shared/room');
const adapter = require('../public/shared/russian-roulette/adapter');

function setup(opts = {}) {
  const inbox = {}; // clientId -> [{type, data}]
  const send = (cid, type, data) => (inbox[cid] = inbox[cid] || []).push({ type, data });
  const room = new Room({ adapter, code: 'TEST', send, botDelay: 5, disconnectDelay: 5, passDelay: 5, ackMs: 5, ...opts });
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
  const restored = Room.restore(saved, { adapter, send, botDelay: 1, disconnectDelay: 1, passDelay: 1, ackMs: 1 });
  assert.ok(restored.join('h2', { token }).ok);
  assert.strictEqual(restored.game.phase, 'playing');
  // 봇 + (내 차례면) 대신 진행되며 결국 종료된다
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (restored.game.phase === 'ended') { clearInterval(iv); resolve(); }
      const me = restored.players.find((p) => !p.isBot);
      if (restored.game && restored.game.phase === 'playing') {
        const cur = restored.game.seats[(restored.game.firstSeat + restored.game.offset) % 6];
        if (cur === me.id && restored.game.pendingManip && restored.game.pendingManip.by === me.id) {
          restored.request('h2', 'action', { type: 'manipSwap', pair: 0 }); // 공용 풀을 채웠으면 조작
        } else if (cur === me.id && restored.game.players[me.id].credits > 0) {
          restored.request('h2', 'action', { type: 'manip', amount: 1 }); // 0이면 자동 패스
        }
      }
    }, 2);
  });
  assert.strictEqual(restored.game.result.eliminated.length, 2);
  restored.close();
});

test('러시안 룰렛: 공개 조사 뒤에는 모두 확인하거나 시간이 지나야 다음 차례', async () => {
  const { room, last } = setup({ ackMs: 60_000 });
  room.createHost('h', { name: 'A' });
  const g2 = room.join('g', { name: 'B' });
  room.request('h', 'start');
  const game = room.game;
  // 사람 차례가 될 때까지 봇 진행 (봇 지연 5ms)
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const cur = game.seats[(game.firstSeat + game.offset) % 6];
      if ((cur === room.hostId || cur === g2.playerId) && !game.pendingAck) { clearInterval(iv); resolve(); }
      else if (game.pendingAck) { // 봇의 공개 조사 → 두 사람이 확인
        room.request('h', 'action', { type: 'ack' });
        room.request('g', 'action', { type: 'ack' });
      }
    }, 2);
  });
  const cur = game.seats[(game.firstSeat + game.offset) % 6];
  const cid = cur === room.hostId ? 'h' : 'g';
  const other = cid === 'h' ? 'g' : 'h';
  assert.ok(room.request(cid, 'action', { type: 'publicCheck', pair: 0 }).ok);
  assert.ok(game.pendingAck, '확인 대기 시작');
  const v = last(other).data.game;
  assert.ok(v.ack && v.ack.remainingMs > 0);
  assert.deepStrictEqual(v.actions, []);
  // 확인 전에는 다음 사람(봇 포함)이 행동할 수 없다
  const nextPid = game.seats[(game.firstSeat + game.offset) % 6];
  const turnBefore = game.turn;
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(game.turn, turnBefore);
  assert.ok(game.pendingAck);
  // 한 명만 확인 → 여전히 대기, 두 명 모두 확인 → 해제
  room.request(cid, 'action', { type: 'ack' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(game.pendingAck);
  room.request(other, 'action', { type: 'ack' });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(game.pendingAck, null);
  assert.ok(nextPid);
  room.close();
});

test('러시안 룰렛: 아무도 확인하지 않아도 시간이 지나면 자동으로 넘어간다', async () => {
  const { room } = setup({ ackMs: 80 });
  room.createHost('h', { name: 'A', practice: true });
  const game = room.game;
  // 확인 대기가 처음 생길 때까지 (봇 또는 내가 공개 조사)
  const seenAt = await new Promise((resolve, reject) => {
    const stop = setTimeout(() => reject(new Error('공개 조사가 나오지 않음')), 5000);
    const iv = setInterval(() => {
      if (game.pendingAck) { clearInterval(iv); clearTimeout(stop); resolve(Date.now()); return; }
      const cur = game.seats[(game.firstSeat + game.offset) % 6];
      if (cur === room.hostId && game.players[cur].credits > 0) room.request('h', 'action', { type: 'publicCheck', pair: 1 });
    }, 1);
  });
  const ack = game.pendingAck;
  // 아무도 확인하지 않음 → 약 80ms 뒤 자동 해제
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (game.pendingAck !== ack) { clearInterval(iv); resolve(); } }, 2);
  });
  assert.ok(Date.now() - seenAt >= 50, '시간이 지나기 전에 해제되면 안 됨');
  room.close();
});
