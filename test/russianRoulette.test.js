'use strict';

const test = require('node:test');
const assert = require('node:assert');
const E = require('../public/shared/russian-roulette/engine');
const bot = require('../public/shared/russian-roulette/bot');

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const players = () => [...Array(6)].map((_, i) => ({ id: `p${i}`, name: `P${i}` }));

function fixedGame(chambers, aim = 0) {
  const g = E.createGame(players(), seeded(1));
  g.chambers = chambers.slice();
  g.aim = aim;
  return g;
}

test('게임 생성: 총알 2발, 크레딧 16, 좌석 6', () => {
  const g = E.createGame(players(), seeded(42));
  assert.strictEqual(g.chambers.filter(Boolean).length, 2);
  assert.strictEqual(g.seats.length, 6);
  Object.values(g.players).forEach((p) => assert.strictEqual(p.credits, 16));
  assert.strictEqual(E.currentSeat(g), 0);
});

test('차례가 아닌 플레이어는 행동할 수 없다', () => {
  const g = fixedGame([true, true, false, false, false, false]);
  const other = g.seats[1];
  assert.strictEqual(E.applyAction(g, other, { type: 'publicCheck', pair: 0 }).ok, false);
});

test('공개 조사는 1크레딧, 결과가 모두에게 보인다', () => {
  const g = fixedGame([true, false, false, false, false, true]);
  const p = g.seats[0];
  assert.ok(E.applyAction(g, p, { type: 'publicCheck', pair: 5 }).ok); // 약실 6,1
  assert.strictEqual(g.players[p].credits, 15);
  const other = g.seats[3];
  const v = E.viewFor(g, other);
  const ev = v.events.find((e) => e.type === 'publicCheck');
  assert.deepStrictEqual(ev.results, [true, true]);
  assert.strictEqual(v.knowledge[5].loaded, true);
  assert.strictEqual(v.knowledge[0].loaded, true);
});

test('비공개 조사는 2크레딧, 본인만 결과를 보고 다른 사람에겐 약실조차 숨겨진다', () => {
  const g = fixedGame([false, true, false, false, true, false]);
  const p = g.seats[0];
  assert.ok(E.applyAction(g, p, { type: 'privateCheck', pair: 1 }).ok);
  assert.strictEqual(g.players[p].credits, 14);
  const mine = E.viewFor(g, p).events.find((e) => e.type === 'privateCheck');
  assert.deepStrictEqual(mine.results, [true, false]);
  const v = E.viewFor(g, g.seats[1]);
  assert.strictEqual(v.events.find((e) => e.type === 'privateCheck'), undefined);
  const theirs = v.events.find((e) => e.type === 'private');
  assert.deepStrictEqual(Object.keys(theirs).sort(), ['by', 'mine', 'round', 'turn', 'type']);
  assert.strictEqual(v.knowledge[1], null);
});

test('비공개 조사 / 조작 제출 / 조작 실행 / 패스는 다른 사람에게 구별되지 않는다', () => {
  const g = fixedGame([true, false, false, false, false, true]);
  g.players[g.seats[0]].manip = 5;
  g.players[g.seats[2]].credits = 0;
  E.applyAction(g, g.seats[0], { type: 'manip', amount: 1, pair: 2 }); // 조작 실행
  E.applyAction(g, g.seats[1], { type: 'privateCheck', pair: 0 });
  assert.deepStrictEqual(E.availableActions(g, g.seats[2]), ['pass']);
  assert.strictEqual(E.applyAction(g, g.seats[3], { type: 'pass' }).ok, false);
  assert.ok(E.applyAction(g, g.seats[2], { type: 'pass' }).ok);
  const v = E.viewFor(g, g.seats[4]);
  const acts = v.events.filter((e) => !['start', 'roundStart'].includes(e.type));
  assert.deepStrictEqual(acts.map((e) => e.type), ['private', 'private', 'private']);
  acts.forEach((e) => assert.deepStrictEqual(Object.keys(e).sort(), ['by', 'mine', 'round', 'turn', 'type']));
  // 크레딧 소진 여부도 숨김
  assert.strictEqual(v.seats[2].out, null);
  assert.strictEqual(v.emptyCount, null);
  // 패스는 크레딧이 0이어도 차례를 소모한다
  assert.strictEqual(E.currentSeat(g), 3);
});

test('게임이 끝나면 모든 기록이 공개된다', () => {
  const g = fixedGame([false, false, true, false, true, false], 3);
  g.players[g.seats[1]].credits = 0;
  g.players[g.seats[2]].credits = 0;
  g.players[g.seats[0]].credits = 2;
  E.applyAction(g, g.seats[0], { type: 'privateCheck', pair: 4 });
  const v = E.viewFor(g, g.seats[5]);
  assert.strictEqual(v.phase, 'ended');
  assert.deepStrictEqual(v.events.find((e) => e.type === 'privateCheck').results, [true, false]);
  assert.strictEqual(v.emptyCount, 3);
});

test('회전은 3/4 크레딧, 총구가 시계방향으로 이동', () => {
  const g = fixedGame([true, true, false, false, false, false], 4);
  assert.ok(E.applyAction(g, g.seats[0], { type: 'rotate', steps: 1 }).ok);
  assert.strictEqual(g.aim, 5);
  assert.strictEqual(g.players[g.seats[0]].credits, 13);
  assert.ok(E.applyAction(g, g.seats[1], { type: 'rotate', steps: 2 }).ok);
  assert.strictEqual(g.aim, 1);
  assert.strictEqual(g.players[g.seats[1]].credits, 12);
});

test('다른 플레이어의 크레딧은 보이지 않는다', () => {
  const g = fixedGame([true, true, false, false, false, false]);
  const v = E.viewFor(g, g.seats[0]);
  assert.strictEqual(v.seats[0].credits, 16);
  assert.strictEqual(v.seats[1].credits, null);
});

test('조작: 1~3씩 비공개 제출, 6 이상이면 조작권, 초과분 소멸', () => {
  const g = fixedGame([true, false, false, false, false, true]);
  const p = g.seats[0];
  // 6명이 한 번씩 돌도록 나머지는 공개조사
  const others = () => g.seats.slice(1).forEach((id) => E.applyAction(g, id, { type: 'publicCheck', pair: 2 }));
  assert.strictEqual(E.applyAction(g, p, { type: 'manip', amount: 4 }).ok, false);
  assert.ok(E.applyAction(g, p, { type: 'manip', amount: 3 }).ok);
  others();
  // 라운드 2 → 선 플레이어는 좌석 1. 좌석 0은 맨 마지막
  g.seats.slice(1).forEach((id) => E.applyAction(g, id, { type: 'publicCheck', pair: 2 }));
  // 누적 3 + 3 = 6 → pair 필요
  assert.strictEqual(E.applyAction(g, p, { type: 'manip', amount: 3 }).ok, false);
  assert.ok(E.applyAction(g, p, { type: 'manip', amount: 3, pair: 0 }).ok);
  assert.deepStrictEqual(g.chambers, [false, true, false, false, false, true]);
  assert.strictEqual(g.players[p].manip, 0);
  assert.strictEqual(g.players[p].credits, 10);
  // 다른 사람에게는 조작 자체가 보이지 않는다
  const v = E.viewFor(g, g.seats[2]);
  assert.strictEqual(v.events.filter((e) => e.type === 'manipSubmit' || e.type === 'manip').length, 0);
  // 본인 지식은 스왑 반영
  const mine = E.viewFor(g, p);
  assert.strictEqual(mine.events.find((e) => e.type === 'manip').pair, 0);
});

test('초과 크레딧 소멸', () => {
  const g = fixedGame([true, false, false, false, false, true]);
  const p = g.seats[0];
  g.players[p].manip = 5;
  assert.ok(E.applyAction(g, p, { type: 'manip', amount: 3, pair: 2 }).ok);
  assert.strictEqual(g.players[p].manip, 0);
  assert.strictEqual(g.players[p].credits, 13);
  assert.strictEqual(g.events.find((e) => e.type === 'manip').wasted, 2);
});

test('3명 소진 시 즉시 종료 및 격발', () => {
  const g = fixedGame([false, false, true, false, true, false], 3);
  g.players[g.seats[1]].credits = 0;
  g.players[g.seats[2]].credits = 0;
  g.players[g.seats[0]].credits = 1;
  assert.ok(E.applyAction(g, g.seats[0], { type: 'publicCheck', pair: 0 }).ok);
  assert.strictEqual(g.phase, 'ended');
  // aim=3 → 약실 0:좌석3, 1:좌석4, 2:좌석5(피탄), 3:좌석0, 4:좌석1(피탄)
  assert.deepStrictEqual(g.result.eliminated, [g.seats[5], g.seats[1]]);
  assert.strictEqual(g.result.shots.length, 5);
});

test('크레딧 0인 플레이어도 차례를 받아 패스한다', () => {
  const g = fixedGame([true, true, false, false, false, false]);
  g.players[g.seats[1]].credits = 0;
  assert.ok(E.applyAction(g, g.seats[0], { type: 'publicCheck', pair: 0 }).ok);
  assert.strictEqual(E.currentSeat(g), 1);
  assert.ok(E.applyAction(g, g.seats[1], { type: 'pass' }).ok);
  assert.strictEqual(E.currentSeat(g), 2);
});

test('라운드마다 선 플레이어가 시계방향으로 이동', () => {
  const g = fixedGame([true, true, false, false, false, false]);
  for (let i = 0; i < 6; i++) E.applyAction(g, E.currentPlayerId(g), { type: 'publicCheck', pair: 3 });
  assert.strictEqual(g.round, 2);
  assert.strictEqual(E.currentSeat(g), 1);
});

test('다른 사람의 비공개 행동 이후 내 정보는 stale 처리', () => {
  const g = fixedGame([true, true, false, false, false, false]);
  E.applyAction(g, g.seats[0], { type: 'publicCheck', pair: 0 });
  g.players[g.seats[1]].manip = 3;
  E.applyAction(g, g.seats[1], { type: 'manip', amount: 3, pair: 3 });
  const k = E.viewFor(g, g.seats[0]).knowledge;
  assert.strictEqual(k[0].stale, true);
  assert.strictEqual(E.viewFor(g, g.seats[1]).knowledge[0].stale, false);
});

test('봇은 숨겨진 정보를 보지 않는다', () => {
  const g = fixedGame([true, false, false, false, false, true]);
  E.applyAction(g, g.seats[0], { type: 'privateCheck', pair: 5 });
  const prob = bot.belief(g, g.seats[3]);
  prob.forEach((p) => assert.ok(Math.abs(p - 1 / 3) < 1e-9)); // 아무것도 모름
  const own = bot.belief(g, g.seats[0]);
  assert.ok(Math.abs(own[0] - 1) < 1e-9 && Math.abs(own[5] - 1) < 1e-9);
});

test('봇 믿음: 공개 정보와 일치', () => {
  const g = fixedGame([true, true, false, false, false, false]);
  E.applyAction(g, g.seats[0], { type: 'publicCheck', pair: 0 });
  const prob = bot.belief(g, g.seats[3]);
  assert.ok(Math.abs(prob[0] - 1) < 1e-9 && Math.abs(prob[1] - 1) < 1e-9);
  [2, 3, 4, 5].forEach((c) => assert.ok(prob[c] < 1e-9));
});

test('봇끼리 1000판 시뮬레이션: 항상 종료, 규칙 위반 없음', () => {
  const rng = seeded(7);
  const elimCount = {};
  for (let n = 0; n < 1000; n++) {
    const g = E.createGame(players(), rng);
    let steps = 0;
    while (g.phase === 'playing') {
      const pid = E.currentPlayerId(g);
      const action = bot.decide(g, pid, rng);
      const res = E.applyAction(g, pid, action);
      assert.ok(res.ok, `봇 행동 실패: ${JSON.stringify(action)} → ${res.error}`);
      assert.strictEqual(g.chambers.filter(Boolean).length, 2);
      Object.values(g.players).forEach((p) => assert.ok(p.credits >= 0));
      assert.ok(++steps < 500);
    }
    assert.strictEqual(g.result.eliminated.length, 2);
    g.result.eliminated.forEach((id) => (elimCount[g.players[id].seat] = (elimCount[g.players[id].seat] || 0) + 1));
  }
});
