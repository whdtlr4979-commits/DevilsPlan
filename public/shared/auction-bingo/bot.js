/**
 * 경매 빙고 봇 — 사람과 똑같이 공개 정보(선택 결과, 공개된 낙찰가)와 자기 입찰만 사용한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.ABBot = factory(root.ABEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const { SHAPES, COIN_VALUES, ROUNDS } = E;

  /** 자기가 지금까지 얼마나 낙찰받았을지 추정 (공개 정보만 사용) */
  function estimateHoldings(state, pid) {
    const est = { circle: 0, triangle: 0, star: 0 };
    for (const h of state.history) {
      const s = h.choices[pid];
      const info = h.byShape[s];
      const mine = h.amounts[pid];
      if (!info || info.status !== 'sold' || mine < 1) continue;
      if (h.secret.includes(s)) {
        // 낙찰가 비공개: 공개된 다른 낙찰가보다 많이 냈다면 이겼을 가능성이 높다
        const shown = SHAPES.filter((x) => h.byShape[x].status === 'sold' && !h.secret.includes(x)).map((x) => h.byShape[x].price);
        const p = shown.every((x) => mine > x) ? 0.6 : 0.3;
        est[s] += p * info.count;
      } else if (mine === info.price) {
        est[s] += 0.8 * info.count; // 동률이면 나눠 가졌을 수도
      }
    }
    return est;
  }

  function pickWeighted(weights, rng) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  function decideChoice(state, pid, rng = Math.random) {
    const est = estimateHoldings(state, pid);
    // 이미 공개된 선택을 보고, 사람이 몰린 상자는 조금 피한다
    const crowd = (s) => state.order.filter((id) => state.choices[id] === s).length;
    const weights = SHAPES.map((s) => (Math.max(0, 3 - est[s]) + 0.35) / (1 + 0.25 * crowd(s)));
    return { type: 'choose', shape: SHAPES[pickWeighted(weights, rng)] };
  }

  /** 목표 금액 이상이 되는 가장 작은 코인 조합 (없으면 전부) */
  function coinsFor(have, target) {
    let best = null;
    const rec = (i, cur, sum) => {
      if (i === COIN_VALUES.length) {
        if (sum >= target && (!best || sum < best.sum || (sum === best.sum && E.coinCount(cur) < E.coinCount(best.coins)))) {
          best = { coins: { ...cur }, sum };
        }
        return;
      }
      const v = COIN_VALUES[i];
      for (let n = 0; n <= (have[v] || 0); n++) {
        cur[v] = n;
        rec(i + 1, cur, sum + n * v);
      }
      cur[v] = 0;
    };
    rec(0, E.emptyCoins(), 0);
    return best ? best.coins : { ...have };
  }

  function decideBid(state, pid, rng = Math.random) {
    const p = state.players[pid];
    const wallet = E.coinValue(p.coins);
    if (wallet === 0) return { type: 'bid', coins: E.emptyCoins() };
    const shape = state.choices[pid];
    const n = state.order.filter((id) => state.choices[id] === shape).length;
    const rivals = n - 1;
    const roundsLeft = ROUNDS - state.round + 1;
    const need = Math.max(0, 3 - estimateHoldings(state, pid)[shape]);
    let target;
    if (rivals === 0) target = 1; // 혼자면 1원이면 충분
    else {
      const base = wallet / roundsLeft;
      const worth = Math.min(n, need || 0.4);
      target = base * (0.55 + 0.3 * rivals) * (0.5 + 0.25 * worth) * (0.7 + 0.6 * rng());
      if (roundsLeft === 1) target *= 1.3;
    }
    target = Math.max(1, Math.min(wallet, Math.round(target)));
    return { type: 'bid', coins: coinsFor(p.coins, target) };
  }

  return { estimateHoldings, decideChoice, decideBid, coinsFor };
});
