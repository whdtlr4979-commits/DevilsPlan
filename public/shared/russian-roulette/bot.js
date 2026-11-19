/**
 * 러시안 룰렛 봇 AI
 *
 * 봇은 자신이 볼 수 있는 정보(공개 조사, 자신의 비공개 조사, 자신의 조작)만으로
 * 총알 배치 15가지(6C2)에 대한 확률 분포를 추론한다.
 *  - 다른 플레이어의 조작: 어떤 인접 쌍이 바뀌었는지 모르므로 6가지 경우를 평균낸다.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.RRBot = factory(root.RREngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

const { CHAMBERS, COST, MANIP_TARGET, MANIP_MAX, mod, pairChambers } = E;

const CONFIGS = [];
for (let i = 0; i < CHAMBERS; i++) for (let j = i + 1; j < CHAMBERS; j++) CONFIGS.push([i, j]);
const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);

function uniform() {
  const m = new Map();
  CONFIGS.forEach(([a, b]) => m.set(key(a, b), 1 / CONFIGS.length));
  return m;
}

function normalize(m) {
  let total = 0;
  m.forEach((w) => (total += w));
  if (total <= 0) return uniform();
  m.forEach((w, k) => m.set(k, w / total));
  return m;
}

function applySwap(m, pair) {
  const [x, y] = pairChambers(pair);
  const out = new Map();
  m.forEach((w, k) => {
    const [a, b] = k.split(',').map(Number).map((c) => (c === x ? y : c === y ? x : c));
    const nk = key(a, b);
    out.set(nk, (out.get(nk) || 0) + w);
  });
  return out;
}

function belief(state, botId) {
  let m = uniform();
  for (const ev of state.events) {
    if (ev.type === 'publicCheck' || (ev.type === 'privateCheck' && ev.by === botId)) {
      const chs = pairChambers(ev.pair);
      m.forEach((w, k) => {
        const set = k.split(',').map(Number);
        const ok = chs.every((c, i) => set.includes(c) === ev.results[i]);
        if (!ok) m.set(k, 0);
      });
      m = normalize(m);
    } else if (ev.type === 'manip') {
      if (ev.by === botId) {
        m = applySwap(m, ev.pair);
      } else {
        const mixed = new Map();
        for (let p = 0; p < CHAMBERS; p++) {
          applySwap(m, p).forEach((w, k) => mixed.set(k, (mixed.get(k) || 0) + w / CHAMBERS));
        }
        m = normalize(mixed);
      }
    }
  }
  const prob = Array(CHAMBERS).fill(0);
  m.forEach((w, k) => k.split(',').map(Number).forEach((c) => (prob[c] += w)));
  return prob;
}

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const uncertainty = (p) => 0.5 - Math.abs(p - 0.5); // 0 = 확실, 0.5 = 모름

/** 내 약실 c를 포함하는 쌍 중, 다른 약실이 가장 불확실한 쌍 */
function bestPairWith(c, prob) {
  const left = mod(c - 1, CHAMBERS); // pair(left) = [c-1, c]
  const right = c; // pair(c) = [c, c+1]
  return uncertainty(prob[mod(c - 1, CHAMBERS)]) >= uncertainty(prob[mod(c + 1, CHAMBERS)]) ? left : right;
}

/** 전체에서 정보량이 가장 많은 쌍 */
function mostUncertainPair(prob) {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < CHAMBERS; i++) {
    const [a, b] = pairChambers(i);
    const s = uncertainty(prob[a]) + uncertainty(prob[b]);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

/** 조작 시 내 약실 위험도를 가장 낮추는 쌍 (myCh에 영향 없는 쌍은 위험 유지) */
function bestSwapFor(myCh, prob, rng) {
  let best = [];
  let bestP = Infinity;
  for (let i = 0; i < CHAMBERS; i++) {
    const [a, b] = pairChambers(i);
    const np = a === myCh ? prob[b] : b === myCh ? prob[a] : prob[myCh];
    if (np < bestP - 1e-9) {
      bestP = np;
      best = [i];
    } else if (Math.abs(np - bestP) < 1e-9) best.push(i);
  }
  return { pair: pick(best, rng), p: bestP };
}

/**
 * 봇의 행동 결정
 * @returns {object} engine.applyAction 에 넣을 action
 */
function decide(state, botId, rng = Math.random) {
  const me = state.players[botId];
  const C = me.credits;
  const prob = belief(state, botId);
  const chAt = (r) => mod(me.seat - state.aim - r, CHAMBERS);
  const myCh = chAt(0);
  const p0 = prob[myCh];

  const manipNeed = MANIP_TARGET - me.manip; // 조작권까지 남은 크레딧
  const canTriggerManip = manipNeed <= Math.min(MANIP_MAX, C);
  const rotations = [1, 2]
    .filter((r) => C >= (r === 1 ? COST.rotate1 : COST.rotate2))
    .map((r) => ({ r, p: prob[chAt(r)] }))
    .sort((a, b) => a.p - b.p || a.r - b.r);

  const publicCheck = (pair) => ({ type: 'publicCheck', pair });
  const privateCheck = (pair) => ({ type: 'privateCheck', pair });
  const manipSubmit = (amount) => {
    const amt = Math.max(1, Math.min(MANIP_MAX, C, amount));
    const action = { type: 'manip', amount: amt };
    if (me.manip + amt >= MANIP_TARGET) action.pair = bestSwapFor(myCh, prob, rng).pair;
    return action;
  };

  // 1) 위험: 내 약실에 총알이 있을 가능성이 높음
  if (p0 >= 0.5) {
    if (canTriggerManip) {
      const s = bestSwapFor(myCh, prob, rng);
      if (s.p <= p0 - 0.3) return manipSubmit(manipNeed);
    }
    if (rotations.length && rotations[0].p <= p0 - 0.3) return { type: 'rotate', steps: rotations[0].r };
    if (p0 < 0.95 && C >= COST.publicCheck) {
      // 정말 위험한지 확인 (크레딧이 넉넉하면 비공개)
      const pair = bestPairWith(myCh, prob);
      return C >= 8 && rng() < 0.5 ? privateCheck(pair) : publicCheck(pair);
    }
    // 확실히 위험한데 당장 피할 수단이 없다 → 조작을 모으거나 최소 지출로 시간 끌기
    if (me.manip > 0 || C >= manipNeed) return manipSubmit(Math.min(MANIP_MAX, manipNeed));
    return publicCheck(mostUncertainPair(prob));
  }

  // 2) 불확실: 내 약실을 조사
  if (p0 > 0.12) {
    const pair = bestPairWith(myCh, prob);
    if (C >= 8 && rng() < 0.45) return privateCheck(pair);
    return publicCheck(pair);
  }

  // 3) 안전: 크레딧을 빨리 소진해 게임을 끝내는 게 유리
  const safeRot = rotations.filter((x) => x.p <= 0.12);
  const roll = rng();
  if (safeRot.length && roll < 0.35) {
    // 안전한 범위에서 가장 많이 소모하는 회전
    const r = safeRot.reduce((a, b) => (b.r > a.r ? b : a));
    return { type: 'rotate', steps: r.r };
  }
  if (roll < 0.8) return manipSubmit(MANIP_MAX);
  if (C >= COST.privateCheck && rng() < 0.5) return privateCheck(mostUncertainPair(prob));
  return publicCheck(mostUncertainPair(prob));
}

return { decide, belief };
});
