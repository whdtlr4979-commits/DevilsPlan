/**
 * 경매 빙고 게임 엔진 (순수 로직, 네트워크와 무관)
 *
 * 진행: 7라운드 × [도형 선택 → 입찰 → 결과 발표] → 빙고판 자동 배치 → 순위
 *
 * 정보 공개 규칙
 *  - 도형 선택: 누가 어느 상자에 티켓을 넣었는지 넣는 즉시 전체 공개
 *  - 입찰: 금액은 본인만 안다. 최소 1원. 1원 이상 입찰하지 못하면 즉시 탈락(이후 라운드 제외, 최하위)
 *    사용한 코인은 결과와 상관없이 소멸
 *  - 낙찰자는 그 도형에 '입찰한' 인원 수만큼 획득 (동률이면 나눠 갖고 소수점 버림)
 *  - 결과 발표: 도형별 낙찰가만 공개. 낙찰가가 가장 높은 도형은 시크릿(낙찰가 비공개),
 *    단 최고가가 두 도형 이상 동률이면 시크릿 없음
 *    누가 낙찰받았는지는 낙찰자 본인에게도 비공개
 *  - 게임이 끝나면 모든 정보 공개
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ABEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHAPES = ['circle', 'triangle', 'star'];
  const SHAPE_KO = { circle: '동그라미', triangle: '세모', star: '별' };
  // 모든 플레이어가 같은 빙고판을 쓴다.
  //   △ ○ △
  //   ○ ☆ ○
  //   ☆ ○ △      → 칸 수: ○ 4, △ 3, ☆ 2
  const BOARD = ['triangle', 'circle', 'triangle', 'circle', 'star', 'circle', 'star', 'circle', 'triangle'];
  /** 도형별 빙고판 칸 수 (이보다 많이 얻은 도형은 버려진다) */
  const CAPACITY = {};
  SHAPES.forEach((s) => (CAPACITY[s] = BOARD.filter((b) => b === s).length));
  const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  const ROUNDS = 7;
  const COIN_VALUES = [1, 2, 3, 5, 10];
  const START_COINS = { 1: 3, 2: 3, 3: 2, 5: 1, 10: 1 }; // 10개, 총 30원
  const MIN_PLAYERS = 3;
  const MAX_PLAYERS = 8;
  // 원작은 선택 15분 / 입찰 20분이지만 온라인용으로 줄였다. 방장이 대기실에서 고른다.
  const TIMER_PRESETS = {
    fast: { label: '빠름', choose: 30, bid: 45, result: 6 },
    normal: { label: '보통', choose: 60, bid: 90, result: 8 },
    relaxed: { label: '여유', choose: 180, bid: 300, result: 10 },
    original: { label: '원작', choose: 900, bid: 1200, result: 10 },
  };

  /* ---------------- 코인 ---------------- */

  const emptyCoins = () => ({ 1: 0, 2: 0, 3: 0, 5: 0, 10: 0 });
  const coinValue = (c) => COIN_VALUES.reduce((s, v) => s + v * (c[v] || 0), 0);
  const coinCount = (c) => COIN_VALUES.reduce((s, v) => s + (c[v] || 0), 0);

  /** 입력을 {1:n,2:n,...} 로 정규화. 잘못되면 null */
  function normalizeCoins(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = emptyCoins();
    for (const v of COIN_VALUES) {
      const n = raw[v] === undefined ? 0 : raw[v];
      if (!Number.isInteger(n) || n < 0 || n > 10) return null;
      out[v] = n;
    }
    return out;
  }
  const hasCoins = (have, want) => COIN_VALUES.every((v) => (have[v] || 0) >= (want[v] || 0));

  /* ---------------- 빙고판 배치 ---------------- */

  function combos(arr, k) {
    if (k === 0) return [[]];
    if (k > arr.length) return [];
    const out = [];
    arr.forEach((x, i) => combos(arr.slice(i + 1), k - 1).forEach((rest) => out.push([x, ...rest])));
    return out;
  }

  /**
   * 획득한 도형을 빙고 줄 수가 최대가 되도록 배치. 배치할 수 없는 도형은 버린다.
   * @returns {{cells:number[], lines:number[][], lineCount:number, filled:number, discarded:object}}
   */
  function bestPlacement(won) {
    const options = SHAPES.map((s) => {
      const cells = BOARD.map((b, i) => (b === s ? i : -1)).filter((i) => i >= 0);
      return combos(cells, Math.min(won[s] || 0, cells.length));
    });
    let best = null;
    for (const a of options[0]) {
      for (const b of options[1]) {
        for (const c of options[2]) {
          const filled = new Set([...a, ...b, ...c]);
          const lines = LINES.filter((l) => l.every((i) => filled.has(i)));
          if (!best || lines.length > best.lines.length) best = { cells: [...filled].sort((x, y) => x - y), lines };
        }
      }
    }
    const discarded = {};
    SHAPES.forEach((s) => (discarded[s] = Math.max(0, (won[s] || 0) - CAPACITY[s])));
    return { cells: best.cells, lines: best.lines, lineCount: best.lines.length, filled: best.cells.length, discarded };
  }

  /* ---------------- 게임 ---------------- */

  function timers(settings) {
    const t = TIMER_PRESETS[(settings && settings.timer) || 'normal'] || TIMER_PRESETS.normal;
    return { chooseMs: t.choose * 1000, bidMs: t.bid * 1000, resultMs: t.result * 1000 };
  }

  function setPhase(state, phase, now, ms, rng) {
    state.phase = phase;
    state.phaseAt = now;
    state.deadline = ms == null ? null : now + ms;
    state.botDelays = {};
    // 봇이 '생각하는 척' 할 시간 (제한 시간보다 짧게)
    const span = ms == null ? 0 : Math.min(ms * 0.6, 9000);
    state.order.forEach((id) => (state.botDelays[id] = Math.round(1200 + (rng || Math.random)() * Math.max(800, span - 1200))));
  }

  /**
   * @param {{id:string,name:string}[]} players 3~8명
   */
  function createGame(players, settings, now = Date.now(), rng = Math.random) {
    if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
      throw new Error(`플레이어는 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다.`);
    }
    const state = {
      round: 1,
      order: players.map((p) => p.id),
      players: {},
      timers: timers(settings),
      choices: {},
      bids: {},
      history: [],
      result: null,
    };
    players.forEach((p) => {
      state.players[p.id] = { id: p.id, name: p.name, coins: { ...START_COINS }, won: { circle: 0, triangle: 0, star: 0 }, out: null };
    });
    setPhase(state, 'choose', now, state.timers.chooseMs, rng);
    return state;
  }

  const fail = (error) => ({ ok: false, error });

  /** 탈락하지 않은 플레이어 */
  const active = (state) => state.order.filter((id) => !state.players[id].out);

  /**
   * action: { type:'choose', shape } | { type:'bid', coins:{1:n,2:n,3:n,5:n,10:n} }
   */
  function applyAction(state, pid, action, now = Date.now(), rng = Math.random) {
    const p = state.players[pid];
    if (!p) return fail('참가자가 아닙니다.');
    if (!action || typeof action !== 'object') return fail('잘못된 행동입니다.');
    if (p.out) return fail('탈락했습니다.');
    if (action.type === 'choose') {
      if (state.phase !== 'choose') return fail('지금은 도형 선택 시간이 아닙니다.');
      if (state.choices[pid]) return fail('이미 티켓을 넣었습니다.');
      if (!SHAPES.includes(action.shape)) return fail('도형을 고르세요.');
      state.choices[pid] = action.shape;
      if (active(state).every((id) => state.choices[id])) endChoose(state, now, rng);
      return { ok: true };
    }
    if (action.type === 'bid') {
      if (state.phase !== 'bid') return fail('지금은 입찰 시간이 아닙니다.');
      if (state.bids[pid]) return fail('이미 입찰했습니다.');
      const coins = normalizeCoins(action.coins);
      if (!coins) return fail('잘못된 입찰입니다.');
      if (!hasCoins(p.coins, coins)) return fail('가진 코인보다 많이 낼 수 없습니다.');
      if (coinValue(coins) < 1) return fail('최소 1원 이상 입찰해야 합니다.');
      COIN_VALUES.forEach((v) => (p.coins[v] -= coins[v])); // 결과와 상관없이 소멸
      state.bids[pid] = coins;
      if (active(state).every((id) => state.bids[id])) resolve(state, now, rng);
      return { ok: true };
    }
    return fail('알 수 없는 행동입니다.');
  }

  function eliminate(state, id, why) {
    state.players[id].out = { round: state.round, why };
  }

  function endChoose(state, now, rng = Math.random) {
    state.autoChoose = [];
    active(state).forEach((id) => {
      if (!state.choices[id]) {
        state.choices[id] = SHAPES[Math.floor(rng() * SHAPES.length)]; // 시간 초과 → 무작위 상자
        state.autoChoose.push(id);
      }
    });
    // 코인이 하나도 없으면 1원 이상 입찰할 수 없으므로 바로 탈락
    state.outAtBid = [];
    active(state).forEach((id) => {
      if (coinValue(state.players[id].coins) < 1) {
        eliminate(state, id, 'nocoin');
        state.outAtBid.push(id);
      }
    });
    setPhase(state, 'bid', now, state.timers.bidMs, rng);
    if (!active(state).length) resolve(state, now, rng);
  }

  function resolve(state, now, rng) {
    // 시간 안에 1원 이상 입찰하지 못한 플레이어는 즉시 탈락
    const outNow = [...(state.outAtBid || [])];
    active(state).forEach((id) => {
      if (!state.bids[id]) {
        eliminate(state, id, 'nobid');
        outNow.push(id);
      }
    });
    const amounts = {};
    state.order.forEach((id) => (amounts[id] = state.bids[id] ? coinValue(state.bids[id]) : 0));
    const byShape = {};
    for (const s of SHAPES) {
      const chosen = state.order.filter((id) => state.choices[id] === s).length;
      const bidders = state.order.filter((id) => state.choices[id] === s && state.bids[id]);
      const n = bidders.length; // 그 도형에 '입찰한' 인원
      if (!n) {
        byShape[s] = { count: 0, chosen, status: chosen ? 'unsold' : 'none', price: null, winners: [], each: 0 };
        continue;
      }
      const max = Math.max(...bidders.map((id) => amounts[id]));
      const winners = bidders.filter((id) => amounts[id] === max);
      const each = Math.floor(n / winners.length); // 동률이면 똑같이 나누고 소수점은 버림
      winners.forEach((id) => (state.players[id].won[s] += each));
      byShape[s] = { count: n, chosen, status: 'sold', price: max, winners, each };
    }
    const sold = SHAPES.filter((s) => byShape[s].status === 'sold');
    const top = sold.length ? Math.max(...sold.map((s) => byShape[s].price)) : null;
    // 낙찰가가 가장 높은 도형 하나만 시크릿. 최고가가 동률이면 시크릿 없이 모두 공개
    const tops = sold.filter((s) => byShape[s].price === top);
    const secret = tops.length === 1 ? tops : [];
    state.history.push({
      round: state.round,
      choices: { ...state.choices },
      amounts,
      byShape,
      secret,
      autoChoose: state.autoChoose || [],
      eliminated: outNow,
    });
    state.outAtBid = [];
    setPhase(state, 'result', now, state.timers.resultMs, rng);
  }

  function nextRound(state, now, rng) {
    if (state.round >= ROUNDS || !active(state).length) return finish(state, now);
    state.round += 1;
    state.choices = {};
    state.bids = {};
    state.autoChoose = [];
    setPhase(state, 'choose', now, state.timers.chooseMs, rng);
  }

  function finish(state, now) {
    setPhase(state, 'ended', now, null);
    const rows = state.order.map((id) => {
      const p = state.players[id];
      const place = bestPlacement(p.won);
      return {
        id,
        name: p.name,
        won: { ...p.won },
        cells: place.cells,
        lines: place.lines,
        lineCount: place.lineCount,
        filled: place.filled,
        discarded: place.discarded,
        coins: { ...p.coins },
        coinValue: coinValue(p.coins),
        coinCount: coinCount(p.coins),
        out: p.out,
      };
    });
    // 탈락자는 생존자 전원보다 아래 (먼저 탈락할수록 아래). 그 다음 빙고 → 칸 → 남은 코인
    const outRank = (r) => (r.out ? r.out.round : ROUNDS + 1);
    const cmp = (a, b) => outRank(b) - outRank(a) || b.lineCount - a.lineCount || b.filled - a.filled || b.coinValue - a.coinValue;
    rows.sort(cmp);
    rows.forEach((r, i) => (r.rank = i > 0 && cmp(rows[i - 1], r) === 0 ? rows[i - 1].rank : i + 1));
    state.result = { standings: rows };
  }

  /** 제한 시간 처리. 바뀌었으면 true */
  function tick(state, now = Date.now(), rng = Math.random) {
    if (state.phase === 'ended' || state.deadline == null || now < state.deadline) return false;
    if (state.phase === 'choose') endChoose(state, now, rng);
    else if (state.phase === 'bid') resolve(state, now, rng);
    else if (state.phase === 'result') nextRound(state, now, rng);
    return true;
  }

  const submitted = (state, id) =>
    state.players[id].out ? false : state.phase === 'choose' ? !!state.choices[id] : state.phase === 'bid' ? !!state.bids[id] : false;

  /* ---------------- 플레이어별 시점 ---------------- */

  function viewFor(state, viewerId, now = Date.now()) {
    const ended = state.phase === 'ended';
    const me = state.players[viewerId] || null;
    return {
      phase: state.phase,
      round: state.round,
      rounds: ROUNDS,
      remainingMs: state.deadline == null ? null : Math.max(0, state.deadline - now),
      phaseMs: state.deadline == null ? null : state.deadline - state.phaseAt,
      players: state.order.map((id) => ({
        id,
        name: state.players[id].name,
        submitted: submitted(state, id),
        choice: state.choices[id] || null, // 넣는 즉시 공개
        out: state.players[id].out, // 탈락은 공개
      })),
      me: me
        ? {
            id: me.id,
            coins: { ...me.coins },
            coinValue: coinValue(me.coins),
            tickets: ROUNDS - state.history.length - (state.phase === 'choose' && state.choices[me.id] ? 1 : 0) - (state.phase === 'bid' ? 1 : 0),
            choice: state.choices[me.id] || null,
            bid: state.bids[me.id] ? coinValue(state.bids[me.id]) : null,
            won: ended ? { ...me.won } : null, // 끝나기 전에는 본인도 모른다
            out: me.out,
          }
        : null,
      history: state.history.map((h) => {
        const shapes = {};
        SHAPES.forEach((s) => {
          const b = h.byShape[s];
          const isSecret = h.secret.includes(s);
          shapes[s] = {
            count: b.count,
            chosen: b.chosen,
            status: b.status,
            secret: isSecret,
            price: ended || !isSecret ? b.price : null,
            winners: ended ? b.winners : undefined,
            each: ended ? b.each : undefined,
          };
        });
        return {
          round: h.round,
          choices: h.choices,
          shapes,
          myShape: h.choices[viewerId] || null,
          myBid: h.amounts[viewerId] ?? null,
          eliminated: h.eliminated || [], // 이번 라운드에 탈락한 사람 (공개)
          amounts: ended ? h.amounts : undefined,
        };
      }),
      result: ended ? state.result : null,
    };
  }

  return {
    SHAPES,
    SHAPE_KO,
    BOARD,
    CAPACITY,
    LINES,
    ROUNDS,
    COIN_VALUES,
    START_COINS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    TIMER_PRESETS,
    emptyCoins,
    coinValue,
    coinCount,
    normalizeCoins,
    hasCoins,
    active,
    bestPlacement,
    createGame,
    applyAction,
    tick,
    viewFor,
  };
});
