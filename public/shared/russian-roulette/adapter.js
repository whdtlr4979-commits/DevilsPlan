/**
 * 러시안 룰렛 어댑터 — 공용 방(shared/room.js)에 게임 규칙을 연결한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./bot'));
  else root.RRAdapter = factory(root.RREngine, root.RRBot);
})(typeof self !== 'undefined' ? self : this, function (engine, bot) {
  'use strict';

  return {
    id: 'russian-roulette',
    minPlayers: engine.SEATS,
    maxPlayers: engine.SEATS,
    practicePlayers: engine.SEATS,
    // 크레딧 0 → 자동 패스. 생각하는 척 무작위로 기다려 크레딧 소진을 숨긴다
    defaultOpts: { passDelay: [1800, 4200] },

    fillTo: () => engine.SEATS,
    create: (players) => engine.createGame(players),
    isEnded: (g) => g.phase === 'ended',
    view: (g, viewerId) => engine.viewFor(g, viewerId),
    act: (g, pid, action) => engine.applyAction(g, pid, action),
    startMessage: () => '게임이 시작되었습니다. 자리 추첨 완료!',
    endMessage: (g) => `게임 종료! 탈락: ${g.result.eliminated.map((id) => g.players[id].name).join(', ')}`,

    next(g, ctx) {
      if (g.phase !== 'playing') return null;
      const pid = engine.currentPlayerId(g);
      const turn = g.turn;
      const still = () => g.phase === 'playing' && g.turn === turn && engine.currentPlayerId(g) === pid;

      if (ctx.isBot(pid) || !ctx.isConnected(pid)) {
        const delay = ctx.isBot(pid) ? ctx.opts.botDelay : ctx.opts.disconnectDelay;
        return {
          at: ctx.now + delay,
          run: () => {
            if (!still() || (!ctx.isBot(pid) && ctx.isConnected(pid))) return false; // 그 사이 재접속
            let res = engine.applyAction(g, pid, bot.decide(g, pid));
            if (!res.ok) res = engine.applyAction(g, pid, { type: 'publicCheck', pair: 0 }); // 안전장치
            if (!res.ok) res = engine.applyAction(g, pid, { type: 'manipSwap', pair: 0 });
            if (!res.ok) res = engine.applyAction(g, pid, { type: 'manip', amount: 1 });
            if (!res.ok) res = engine.applyAction(g, pid, { type: 'pass' });
            return res.ok;
          },
        };
      }
      if (g.players[pid].credits === 0 && !g.pendingManip) {
        const pd = ctx.opts.passDelay;
        const [lo, hi] = Array.isArray(pd) ? pd : [pd, pd];
        return {
          at: ctx.now + lo + Math.random() * (hi - lo),
          run: () => still() && engine.applyAction(g, pid, { type: 'pass' }).ok,
        };
      }
      return null;
    },
  };
});
