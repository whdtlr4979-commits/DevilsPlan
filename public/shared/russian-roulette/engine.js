/**
 * 러시안 룰렛 게임 엔진 (순수 로직, 네트워크와 무관)
 *
 * 좌표계
 *  - 좌석(seat) 0~5 : 시계 방향. 좌석 0이 1번 플레이어(선 플레이어).
 *  - 약실(chamber) 0~5 : 격발 순서. 약실 k는 "총구가 향한 좌석 + k" 의 플레이어에게 격발된다.
 *    → 좌석 s 의 플레이어에게 걸리는 약실 = (s - aim) mod 6
 *  - 인접 약실 쌍(pair) i : 약실 i 와 약실 (i+1) mod 6
 *  - 총구 회전: aim 이 시계 방향(좌석 번호 증가 방향)으로 이동
 *
 * 정보 공개 규칙
 *  - 공개 조사 / 회전 : 누가 무엇을 했는지 전체 공개
 *  - 조작 크레딧은 모두가 함께 채우는 '공용 풀'(합계 비공개)에 1~3개씩 쌓인다.
 *    내 제출로 풀이 6 이상이 되면 내가 인접 약실 2개를 골라 탄약을 교환하고, 초과분은 소멸, 풀은 0으로 초기화
 *  - 비공개 조사 / 조작 / 패스 : 다른 사람에게는 모두 똑같이 '비공개 행동'으로만 발표
 *    (어느 약실을 봤는지, 얼마를 냈는지, 조작이 일어났는지, 크레딧이 바닥났는지 알 수 없다)
 *  - 게임이 끝나면 모든 기록이 공개된다
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RREngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

const SEATS = 6;
const CHAMBERS = 6;
const BULLETS = 2;
const START_CREDITS = 16;
const MANIP_TARGET = 6;
const MANIP_MIN = 1;
const MANIP_MAX = 3;
const EMPTY_PLAYERS_TO_END = 3;

const COST = {
  publicCheck: 1,
  privateCheck: 2,
  rotate1: 3,
  rotate2: 4,
};

const mod = (n, m) => ((n % m) + m) % m;
const pairChambers = (i) => [mod(i, CHAMBERS), mod(i + 1, CHAMBERS)];
const chamberForSeat = (seat, aim) => mod(seat - aim, CHAMBERS);
const seatForChamber = (chamber, aim) => mod(aim + chamber, SEATS);

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * @param {{id:string,name:string}[]} players 정확히 6명
 * @param {() => number} rng
 */
function createGame(players, rng = Math.random) {
  if (!Array.isArray(players) || players.length !== SEATS) {
    throw new Error(`플레이어는 정확히 ${SEATS}명이어야 합니다.`);
  }
  const order = shuffle(players.slice(), rng); // 추첨으로 자리 결정
  const chambers = Array(CHAMBERS).fill(false);
  const slots = shuffle([...Array(CHAMBERS).keys()], rng).slice(0, BULLETS);
  slots.forEach((c) => (chambers[c] = true));

  const state = {
    phase: 'playing',
    seats: order.map((p) => p.id),
    players: {},
    chambers,
    aim: Math.floor(rng() * SEATS),
    round: 1,
    firstSeat: 0,
    offset: 0,
    turn: 1,
    events: [],
    result: null,
    manipPool: 0, // 공용 조작 풀 (비공개)
    pendingManip: null, // { by, wasted } — 풀을 채운 플레이어가 약실을 고르는 중
  };
  order.forEach((p, seat) => {
    state.players[p.id] = {
      id: p.id,
      name: p.name,
      seat,
      credits: START_CREDITS,
    };
  });
  pushEvent(state, { type: 'start', aim: state.aim });
  pushEvent(state, { type: 'roundStart', round: 1, firstSeat: 0, by: state.seats[0] });
  return state;
}

function pushEvent(state, ev) {
  state.events.push({ ...ev, turn: state.turn, round: state.round });
}

function currentSeat(state) {
  return mod(state.firstSeat + state.offset, SEATS);
}

function currentPlayerId(state) {
  return state.phase === 'playing' ? state.seats[currentSeat(state)] : null;
}

function emptyCount(state) {
  return Object.values(state.players).filter((p) => p.credits === 0).length;
}

function swapPair(chambers, pair) {
  const [a, b] = pairChambers(pair);
  [chambers[a], chambers[b]] = [chambers[b], chambers[a]];
}

function isValidPair(pair) {
  return Number.isInteger(pair) && pair >= 0 && pair < CHAMBERS;
}

/**
 * 가능한 행동 목록 (UI/봇에서 사용)
 */
function availableActions(state, playerId) {
  const p = state.players[playerId];
  if (!p || state.phase !== 'playing' || currentPlayerId(state) !== playerId) return [];
  if (state.pendingManip) return state.pendingManip.by === playerId ? ['manipSwap'] : [];
  const c = p.credits;
  if (c === 0) return ['pass'];
  const list = [];
  if (c >= COST.publicCheck) list.push('publicCheck');
  if (c >= COST.privateCheck) list.push('privateCheck');
  if (c >= COST.rotate1) list.push('rotate1');
  if (c >= COST.rotate2) list.push('rotate2');
  if (c >= MANIP_MIN) list.push('manip');
  return list;
}

/**
 * 행동 적용.
 * action 형식
 *  { type:'publicCheck', pair }
 *  { type:'privateCheck', pair }
 *  { type:'rotate', steps: 1|2 }
 *  { type:'manip', amount: 1~3 }        // 공용 풀에 제출. 풀이 6 이상이 되면 같은 차례에 manipSwap 을 해야 한다
 *  { type:'manipSwap', pair }            // 조작권을 얻은 플레이어가 교환할 인접 약실 선택
 *  { type:'pass' }                       // 크레딧이 0일 때만 (자동)
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function applyAction(state, playerId, action) {
  if (state.phase !== 'playing') return fail('게임이 진행 중이 아닙니다.');
  if (currentPlayerId(state) !== playerId) return fail('당신의 차례가 아닙니다.');
  const p = state.players[playerId];
  if (!action || typeof action !== 'object') return fail('잘못된 행동입니다.');
  if (state.pendingManip && action.type !== 'manipSwap') return fail('조작할 약실 2개를 먼저 고르세요.');

  switch (action.type) {
    case 'publicCheck':
    case 'privateCheck': {
      const cost = COST[action.type];
      if (p.credits < cost) return fail('크레딧이 부족합니다.');
      if (!isValidPair(action.pair)) return fail('인접한 약실 2개를 선택하세요.');
      const chs = pairChambers(action.pair);
      const results = chs.map((c) => state.chambers[c]);
      p.credits -= cost;
      pushEvent(state, { type: action.type, by: playerId, pair: action.pair, results });
      break;
    }
    case 'rotate': {
      const steps = action.steps;
      if (steps !== 1 && steps !== 2) return fail('회전 칸 수가 올바르지 않습니다.');
      const cost = steps === 1 ? COST.rotate1 : COST.rotate2;
      if (p.credits < cost) return fail('크레딧이 부족합니다.');
      p.credits -= cost;
      state.aim = mod(state.aim + steps, SEATS);
      pushEvent(state, { type: 'rotate', by: playerId, steps, aim: state.aim });
      break;
    }
    case 'manip': {
      const amount = action.amount;
      if (!Number.isInteger(amount) || amount < MANIP_MIN || amount > MANIP_MAX) {
        return fail(`조작 크레딧은 ${MANIP_MIN}~${MANIP_MAX}개만 제출할 수 있습니다.`);
      }
      if (p.credits < amount) return fail('크레딧이 부족합니다.');
      p.credits -= amount;
      state.manipPool += amount;
      const reached = state.manipPool >= MANIP_TARGET;
      pushEvent(state, { type: 'manipSubmit', by: playerId, amount, reached });
      if (reached) {
        // 조작권 획득: 초과분 소멸, 풀 초기화. 같은 차례에 약실을 고른다 (차례는 아직 넘어가지 않음)
        state.pendingManip = { by: playerId, wasted: state.manipPool - MANIP_TARGET };
        state.manipPool = 0;
        return { ok: true, manip: true };
      }
      break;
    }
    case 'manipSwap': {
      if (!state.pendingManip || state.pendingManip.by !== playerId) return fail('조작권이 없습니다.');
      if (!isValidPair(action.pair)) return fail('인접한 약실 2개를 선택하세요.');
      swapPair(state.chambers, action.pair);
      pushEvent(state, { type: 'manip', by: playerId, pair: action.pair, wasted: state.pendingManip.wasted });
      state.pendingManip = null;
      break;
    }
    case 'pass': {
      if (p.credits !== 0) return fail('크레딧이 남아 있으면 패스할 수 없습니다.');
      pushEvent(state, { type: 'pass', by: playerId });
      break;
    }
    default:
      return fail('알 수 없는 행동입니다.');
  }
  state.turn += 1;
  if (emptyCount(state) >= EMPTY_PLAYERS_TO_END) {
    finish(state);
  } else {
    advance(state);
  }
  return { ok: true };
}

function fail(error) {
  return { ok: false, error };
}

// 크레딧이 0인 플레이어도 차례를 받는다. (패스가 '비공개 행동'으로 발표되어야 크레딧 소진 여부가 숨겨진다)
function advance(state) {
  state.offset += 1;
  if (state.offset >= SEATS) {
    state.round += 1;
    state.firstSeat = mod(state.firstSeat + 1, SEATS);
    state.offset = 0;
    pushEvent(state, {
      type: 'roundStart',
      round: state.round,
      firstSeat: state.firstSeat,
      by: state.seats[state.firstSeat],
    });
  }
}

function finish(state) {
  state.phase = 'ended';
  const shots = [];
  let hits = 0;
  for (let k = 0; k < CHAMBERS && hits < BULLETS; k++) {
    const seat = seatForChamber(k, state.aim);
    const hit = state.chambers[k];
    shots.push({ seat, chamber: k, playerId: state.seats[seat], hit });
    if (hit) hits++;
  }
  state.result = {
    aim: state.aim,
    chambers: state.chambers.slice(),
    shots,
    eliminated: shots.filter((s) => s.hit).map((s) => s.playerId),
  };
  pushEvent(state, { type: 'end', eliminated: state.result.eliminated });
}

/* ------------------------------------------------------------------ */
/* 정보 은닉: 플레이어별 시점                                          */
/* ------------------------------------------------------------------ */

const PRIVATE_TYPES = new Set(['privateCheck', 'manipSubmit', 'pass']);

/** 다른 사람의 비공개 조사 / 조작 / 패스는 '비공개 행동'으로 통일. 조작 실행 자체는 보이지 않는다. */
function eventFor(ev, viewerId, revealAll) {
  const mine = ev.by === viewerId;
  if (revealAll || mine) return { ...ev, mine };
  if (PRIVATE_TYPES.has(ev.type)) return { type: 'private', by: ev.by, turn: ev.turn, round: ev.round, mine };
  if (ev.type === 'manip') return null;
  return { ...ev, mine };
}

function isPrivateByOther(ev, viewerId) {
  return PRIVATE_TYPES.has(ev.type) && ev.by !== viewerId;
}

/**
 * 해당 플레이어가 알고 있는 약실 정보.
 * 그 뒤에 다른 사람의 비공개 행동이 있었다면(조작이었을 수도 있으므로) '불확실(stale)'로 표시.
 * 내가 조작하면 내 정보도 같이 바꿔준다.
 */
function knowledgeFor(state, viewerId) {
  const know = Array(CHAMBERS).fill(null);
  for (const ev of state.events) {
    if (ev.type === 'publicCheck' || (ev.type === 'privateCheck' && ev.by === viewerId)) {
      pairChambers(ev.pair).forEach((c, i) => {
        know[c] = {
          loaded: ev.results[i],
          source: ev.type === 'publicCheck' ? 'public' : 'private',
          turn: ev.turn,
          stale: false,
        };
      });
    } else if (ev.type === 'manip' && ev.by === viewerId) {
      const [a, b] = pairChambers(ev.pair);
      [know[a], know[b]] = [know[b], know[a]];
    } else if (isPrivateByOther(ev, viewerId)) {
      know.forEach((k) => k && (k.stale = true));
    }
  }
  return know;
}

function viewFor(state, viewerId) {
  const me = state.players[viewerId] || null;
  const ended = state.phase === 'ended';
  return {
    phase: state.phase,
    seats: state.seats.map((id, seat) => {
      const p = state.players[id];
      return {
        seat,
        id,
        name: p.name,
        out: ended || id === viewerId ? p.credits === 0 : null,
        credits: ended || id === viewerId ? p.credits : null,
      };
    }),
    me: me
      ? {
          id: me.id,
          seat: me.seat,
          credits: me.credits,
          chamber: chamberForSeat(me.seat, state.aim),
          pendingManip: state.pendingManip && state.pendingManip.by === viewerId ? { wasted: state.pendingManip.wasted } : null,
        }
      : null,
    aim: state.aim,
    round: state.round,
    firstSeat: state.firstSeat,
    currentSeat: state.phase === 'playing' ? currentSeat(state) : null,
    currentPlayerId: currentPlayerId(state),
    turn: state.turn,
    emptyCount: ended ? emptyCount(state) : null,
    events: state.events.map((ev) => eventFor(ev, viewerId, ended)).filter(Boolean),
    knowledge: me ? knowledgeFor(state, viewerId) : Array(CHAMBERS).fill(null),
    actions: availableActions(state, viewerId),
    result: ended ? state.result : null,
    rules: {
      cost: COST,
      startCredits: START_CREDITS,
      manipTarget: MANIP_TARGET,
      manipMin: MANIP_MIN,
      manipMax: MANIP_MAX,
      endWhenEmpty: EMPTY_PLAYERS_TO_END,
    },
  };
}

return {
  SEATS,
  CHAMBERS,
  BULLETS,
  START_CREDITS,
  MANIP_TARGET,
  MANIP_MIN,
  MANIP_MAX,
  EMPTY_PLAYERS_TO_END,
  COST,
  mod,
  pairChambers,
  chamberForSeat,
  seatForChamber,
  createGame,
  applyAction,
  availableActions,
  currentPlayerId,
  currentSeat,
  emptyCount,
  viewFor,
  eventFor,
  knowledgeFor,
};
});
