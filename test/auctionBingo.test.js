'use strict';

const test = require('node:test');
const assert = require('node:assert');
const E = require('../public/shared/auction-bingo/engine');
const bot = require('../public/shared/auction-bingo/bot');
const adapter = require('../public/shared/auction-bingo/adapter');
const { Room } = require('../public/shared/room');

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const players = (n) => [...Array(n)].map((_, i) => ({ id: `p${i}`, name: `P${i}` }));
const coins = (o) => ({ ...E.emptyCoins(), ...o });
const T0 = 1_000_000;

function chooseAll(g, picks, now = T0) {
  Object.entries(picks).forEach(([id, shape]) => assert.ok(E.applyAction(g, id, { type: 'choose', shape }, now).ok));
}
function bidAll(g, bids, now = T0) {
  Object.entries(bids).forEach(([id, c]) => assert.ok(E.applyAction(g, id, { type: 'bid', coins: coins(c) }, now).ok, id));
}

test('준비: 코인 10개 30원, 티켓 7장, 7라운드', () => {
  const g = E.createGame(players(5), { timer: 'normal' }, T0);
  const v = E.viewFor(g, 'p0', T0);
  assert.strictEqual(v.me.coinValue, 30);
  assert.strictEqual(E.coinCount(v.me.coins), 10);
  assert.strictEqual(v.me.tickets, 7);
  assert.strictEqual(v.rounds, 7);
  assert.strictEqual(v.phase, 'choose');
});

test('도형 선택은 단계가 끝나야 공개된다', () => {
  const g = E.createGame(players(3), {}, T0);
  E.applyAction(g, 'p0', { type: 'choose', shape: 'star' }, T0);
  assert.strictEqual(E.viewFor(g, 'p1', T0).players[0].choice, null);
  assert.strictEqual(E.viewFor(g, 'p0', T0).players[0].choice, 'star');
  assert.ok(E.viewFor(g, 'p1', T0).players[0].submitted);
  chooseAll(g, { p1: 'star', p2: 'circle' });
  assert.strictEqual(g.phase, 'bid');
  assert.strictEqual(E.viewFor(g, 'p1', T0).players[0].choice, 'star');
});

test('최고 입찰자가 선택 인원 수만큼 획득, 코인은 결과와 상관없이 회수', () => {
  const g = E.createGame(players(4), {}, T0);
  chooseAll(g, { p0: 'star', p1: 'star', p2: 'star', p3: 'circle' });
  bidAll(g, { p0: { 3: 1 }, p1: { 1: 1 }, p2: { 2: 1 }, p3: { 1: 1 } });
  assert.strictEqual(g.phase, 'result');
  assert.deepStrictEqual(g.players.p0.won, { circle: 0, triangle: 0, star: 3 });
  assert.deepStrictEqual(g.players.p3.won, { circle: 1, triangle: 0, star: 0 });
  assert.strictEqual(E.coinValue(g.players.p1.coins), 29); // 져도 회수
  assert.strictEqual(E.coinValue(g.players.p0.coins), 27);
});

test('동률이면 나눠 갖고 나머지는 버린다', () => {
  const g = E.createGame(players(5), {}, T0);
  chooseAll(g, { p0: 'triangle', p1: 'triangle', p2: 'triangle', p3: 'triangle', p4: 'triangle' });
  bidAll(g, { p0: { 2: 1 }, p1: { 1: 2 }, p2: { 1: 1 }, p3: {}, p4: { 2: 1 } });
  // p0, p1, p4 가 2원 동률 → 5 / 3 = 1개씩, 2개 버림
  ['p0', 'p1', 'p4'].forEach((id) => assert.strictEqual(g.players[id].won.triangle, 1));
  assert.strictEqual(g.players.p2.won.triangle, 0);
});

test('아무도 1원 이상 내지 않으면 유찰', () => {
  const g = E.createGame(players(3), {}, T0);
  chooseAll(g, { p0: 'circle', p1: 'circle', p2: 'star' });
  bidAll(g, { p0: {}, p1: {}, p2: { 1: 1 } });
  const h = E.viewFor(g, 'p0', T0).history[0];
  assert.strictEqual(h.shapes.circle.status, 'unsold');
  assert.strictEqual(h.shapes.triangle.status, 'none');
  assert.strictEqual(g.players.p0.won.circle, 0);
});

test('결과: 낙찰가만 공개, 최고 낙찰가 도형은 시크릿, 낙찰자는 본인에게도 비공개', () => {
  const g = E.createGame(players(3), {}, T0);
  chooseAll(g, { p0: 'circle', p1: 'triangle', p2: 'star' });
  bidAll(g, { p0: { 5: 1 }, p1: { 2: 1 }, p2: { 1: 1 } });
  const v = E.viewFor(g, 'p0', T0);
  const h = v.history[0];
  assert.strictEqual(h.shapes.circle.secret, true);
  assert.strictEqual(h.shapes.circle.price, null);
  assert.strictEqual(h.shapes.triangle.price, 2);
  assert.strictEqual(h.shapes.star.price, 1);
  assert.strictEqual(h.shapes.circle.winners, undefined);
  assert.strictEqual(h.amounts, undefined);
  assert.strictEqual(v.me.won, null);
  assert.strictEqual(h.myBid, 5);
  // 다른 사람의 입찰 금액은 안 보인다
  assert.ok(!JSON.stringify(E.viewFor(g, 'p1', T0)).includes('"myBid":5'));
});

test('가진 코인보다 많이 낼 수 없고, 코인은 쪼갤 수 없다', () => {
  const g = E.createGame(players(3), {}, T0);
  chooseAll(g, { p0: 'circle', p1: 'circle', p2: 'circle' });
  assert.strictEqual(E.applyAction(g, 'p0', { type: 'bid', coins: coins({ 10: 2 }) }, T0).ok, false);
  assert.strictEqual(E.applyAction(g, 'p0', { type: 'bid', coins: coins({ 1: 1.5 }) }, T0).ok, false);
  assert.strictEqual(E.applyAction(g, 'p0', { type: 'bid', coins: coins({ 4: 1 }) }, T0).ok, true); // 없는 단위는 무시 → 0원
});

test('제한 시간: 선택 안 하면 무작위 상자, 입찰 안 하면 0원', () => {
  const g = E.createGame(players(3), { timer: 'fast' }, T0);
  E.applyAction(g, 'p0', { type: 'choose', shape: 'star' }, T0);
  assert.strictEqual(E.tick(g, T0 + 1000), false);
  assert.ok(E.tick(g, T0 + 30_000));
  assert.strictEqual(g.phase, 'bid');
  assert.ok(g.choices.p1 && g.choices.p2);
  assert.ok(E.tick(g, T0 + 30_000 + 45_000));
  assert.strictEqual(g.phase, 'result');
  assert.deepStrictEqual(g.history[0].autoBid.sort(), ['p0', 'p1', 'p2']);
  assert.ok(E.tick(g, T0 + 75_000 + 6_000));
  assert.strictEqual(g.phase, 'choose');
  assert.strictEqual(g.round, 2);
});

test('빙고판 배치: 빙고 줄 수 최대화, 넘치는 도형은 버림', () => {
  assert.strictEqual(E.bestPlacement({ circle: 3, triangle: 3, star: 3 }).lineCount, 8);
  const p = E.bestPlacement({ circle: 2, triangle: 5, star: 2 });
  assert.strictEqual(p.filled, 7);
  assert.strictEqual(p.discarded.triangle, 2);
  assert.strictEqual(p.lineCount, 4);
  assert.strictEqual(E.bestPlacement({ circle: 0, triangle: 0, star: 0 }).lineCount, 0);
});

test('순위: 빙고 줄 수 → 채운 칸 → 남은 코인', () => {
  const g = E.createGame(players(3), {}, T0);
  g.round = 7;
  g.players.p0.won = { circle: 3, triangle: 0, star: 0 }; // 0줄 3칸
  g.players.p1.won = { circle: 0, triangle: 0, star: 3 }; // 1줄 (대각선)
  g.players.p2.won = { circle: 3, triangle: 0, star: 0 }; // 0줄 3칸, 코인 더 많음
  g.players.p0.coins = coins({ 1: 1 });
  g.players.p2.coins = coins({ 5: 1 });
  chooseAll(g, { p0: 'circle', p1: 'triangle', p2: 'star' });
  bidAll(g, { p0: {}, p1: {}, p2: {} });
  assert.ok(E.tick(g, T0 + 999_999));
  assert.strictEqual(g.phase, 'ended');
  const ranks = Object.fromEntries(g.result.standings.map((r) => [r.id, r.rank]));
  assert.deepStrictEqual(ranks, { p1: 1, p2: 2, p0: 3 });
  // 끝나면 모두 공개
  const v = E.viewFor(g, 'p0', T0);
  assert.ok(v.history[0].amounts);
  assert.deepStrictEqual(v.me.won, g.players.p0.won);
});

test('봇: 가진 코인 안에서 입찰, 혼자면 1원', () => {
  const g = E.createGame(players(3), {}, T0);
  chooseAll(g, { p0: 'circle', p1: 'star', p2: 'star' });
  const a = bot.decideBid(g, 'p0', seeded(1));
  assert.strictEqual(E.coinValue(a.coins), 1);
  const b = bot.decideBid(g, 'p1', seeded(2));
  assert.ok(E.hasCoins(g.players.p1.coins, b.coins) && E.coinValue(b.coins) >= 1);
  assert.strictEqual(E.coinValue(bot.coinsFor(E.START_COINS, 4)), 4);
  assert.strictEqual(E.coinValue(bot.coinsFor(coins({ 5: 1 }), 2)), 5);
});

test('봇끼리 300판 시뮬레이션: 항상 끝나고 규칙 위반 없음', () => {
  const rng = seeded(11);
  for (let n = 0; n < 300; n++) {
    const count = 3 + (n % 6);
    const g = E.createGame(players(count), {}, T0, rng);
    let steps = 0;
    while (g.phase !== 'ended') {
      if (g.phase === 'choose') g.order.forEach((id) => E.applyAction(g, id, bot.decideChoice(g, id, rng), T0, rng));
      else if (g.phase === 'bid') g.order.forEach((id) => assert.ok(E.applyAction(g, id, bot.decideBid(g, id, rng), T0, rng).ok));
      else E.tick(g, g.deadline, rng);
      Object.values(g.players).forEach((p) => E.COIN_VALUES.forEach((v) => assert.ok(p.coins[v] >= 0)));
      assert.ok(++steps < 100);
    }
    assert.strictEqual(g.history.length, 7);
    assert.strictEqual(g.result.standings.length, count);
    assert.strictEqual(g.result.standings[0].rank, 1);
  }
});

test('방: 연습 모드는 봇과 함께 끝까지 진행된다', async () => {
  const sent = [];
  const room = new Room({ adapter, code: 'AB01', send: (c, t, d) => sent.push({ c, t, d }), botDelay: 1, disconnectDelay: 1 });
  room.settings = { timer: 'fast' };
  room.createHost('h', { name: '나', practice: true });
  assert.strictEqual(room.players.length, 5);
  const g = room.game;
  // 사람은 바로바로 제출, 결과 단계는 시간을 앞당겨 진행
  await new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      try {
        if (g.phase === 'ended') { clearInterval(iv); return resolve(); }
        if (g.phase === 'choose' && !g.choices[room.hostId]) room.request('h', 'action', { type: 'choose', shape: 'star' });
        if (g.phase === 'bid' && !g.bids[room.hostId]) room.request('h', 'action', { type: 'bid', coins: coins({ 1: g.players[room.hostId].coins[1] ? 1 : 0 }) });
        if (g.phase === 'result') { g.deadline = Date.now(); room.schedule(); }
        else g.botDelays = Object.fromEntries(g.order.map((id) => [id, 0]));
      } catch (e) { clearInterval(iv); reject(e); }
    }, 3);
  });
  assert.strictEqual(room.phase(), 'ended');
  const last = sent.filter((m) => m.t === 'room').pop().d;
  assert.strictEqual(last.game.result.standings.length, 5);
  room.close();
});

test('방 설정: 방장만, 올바른 프리셋만', () => {
  const room = new Room({ adapter, code: 'AB02', send: () => {} });
  room.createHost('h', { name: 'A' });
  room.join('g', { name: 'B' });
  assert.strictEqual(room.request('g', 'settings', { timer: 'fast' }).ok, false);
  assert.strictEqual(room.request('h', 'settings', { timer: 'nope' }).ok, false);
  assert.ok(room.request('h', 'settings', { timer: 'relaxed' }).ok);
  assert.strictEqual(room.view('g').settings.timer, 'relaxed');
  room.close();
});
