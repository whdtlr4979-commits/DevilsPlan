'use strict';

/**
 * 러시안 룰렛 게임 엔진 (순수 로직, 네트워크와 무관)
 *
 * 좌표계
 *  - 좌석(seat) 0~5 : 시계 방향. 좌석 0이 1번 플레이어(선 플레이어).
 *  - 약실(chamber) 0~5 : 격발 순서. 약실 k는 "총구가 향한 좌석 + k" 의 플레이어에게 격발된다.
 *    → 좌석 s 의 플레이어에게 걸리는 약실 = (s - aim) mod 6
 *  - 인접 약실 쌍(pair) i : 약실 i 와 약실 (i+1) mod 6
 *  - 총구 회전: aim 이 시계 방향(좌석 번호 증가 방향)으로 이동
 */

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
  };
  order.forEach((p, seat) => {
    state.players[p.id] = {
      id: p.id,
      name: p.name,
      seat,
      credits: START_CREDITS,
      manip: 0,
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
  const c = p.credits;
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
 *  { type:'manip', amount: 1~3, pair? }  // 누적 6 이상 도달 시 pair 필수
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function applyAction(state, playerId, action) {
  if (state.phase !== 'playing') return fail('게임이 진행 중이 아닙니다.');
  if (currentPlayerId(state) !== playerId) return fail('당신의 차례가 아닙니다.');
  const p = state.players[playerId];
  if (!action || typeof action !== 'object') return fail('잘못된 행동입니다.');

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
      const reaches = p.manip + amount >= MANIP_TARGET;
      if (reaches && !isValidPair(action.pair)) {
        return fail('조작권 획득! 탄약을 바꿀 인접 약실 2개를 선택하세요.');
      }
      p.credits -= amount;
      p.manip += amount;
      pushEvent(state, { type: 'manipSubmit', by: playerId, amount, total: Math.min(p.manip, MANIP_TARGET) });
      if (reaches) {
        const wasted = p.manip - MANIP_TARGET; // 초과분 소멸
        p.manip = 0;
        swapPair(state.chambers, action.pair);
        pushEvent(state, { type: 'manip', by: playerId, pair: action.pair, wasted });
      }
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

function advance(state) {
  // 최대 한 바퀴 반 정도만 돌면 반드시 크레딧 보유자가 나온다 (종료조건이 3명이므로)
  for (let guard = 0; guard < SEATS * 2; guard++) {
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
    const pid = state.seats[currentSeat(state)];
    if (state.players[pid].credits > 0) return;
    pushEvent(state, { type: 'pass', by: pid, auto: true });
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

function eventFor(ev, viewerId) {
  const mine = ev.by === viewerId;
  switch (ev.type) {
    case 'privateCheck':
      return mine ? { ...ev, mine } : { ...ev, results: undefined, mine };
    case 'manipSubmit':
      return mine ? { ...ev, mine } : { type: ev.type, by: ev.by, turn: ev.turn, round: ev.round, mine };
    case 'manip':
      return mine ? { ...ev, mine } : { type: ev.type, by: ev.by, turn: ev.turn, round: ev.round, mine };
    default:
      return { ...ev, mine };
  }
}

/**
 * 해당 플레이어가 알고 있는 약실 정보.
 * 다른 사람이 조작하면(어떤 약실인지 모르므로) 기존 정보는 모두 '오래됨(stale)'으로 표시.
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
    } else if (ev.type === 'manip') {
      if (ev.by === viewerId) {
        const [a, b] = pairChambers(ev.pair);
        [know[a], know[b]] = [know[b], know[a]];
      } else {
        know.forEach((k) => k && (k.stale = true));
      }
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
        out: p.credits === 0,
        credits: ended || id === viewerId ? p.credits : null,
      };
    }),
    me: me
      ? { id: me.id, seat: me.seat, credits: me.credits, manip: me.manip, chamber: chamberForSeat(me.seat, state.aim) }
      : null,
    aim: state.aim,
    round: state.round,
    firstSeat: state.firstSeat,
    currentSeat: state.phase === 'playing' ? currentSeat(state) : null,
    currentPlayerId: currentPlayerId(state),
    turn: state.turn,
    emptyCount: emptyCount(state),
    events: state.events.map((ev) => eventFor(ev, viewerId)),
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

module.exports = {
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
  knowledgeFor,
};
