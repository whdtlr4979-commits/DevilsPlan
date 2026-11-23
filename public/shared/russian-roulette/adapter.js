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
    // 공개 조사 결과는 모든 플레이어가 확인하거나 ackMs 가 지나면 다음 차례로
    defaultOpts: { passDelay: [1800, 4200], ackMs: 5000 },

    fillTo: () => engine.SEATS,
    create: (players) => engine.createGame(players),
    isEnded: (g) => g.phase === 'ended',
    view(g, viewerId, now = Date.now()) {
      const v = engine.viewFor(g, viewerId);
      const a = g.phase === 'playing' ? g.pendingAck : null;
      v.ack = a ? { turn: a.turn, by: a.by, acked: a.acked.slice(), remainingMs: Math.max(0, a.deadline - now) } : null;
      if (a) v.actions = []; // 확인이 끝날 때까지 다음 행동 불가
      return v;
    },

    act(g, pid, action, now = Date.now(), ctx) {
      if (action && action.type === 'ack') {
        if (!g.pendingAck) return { ok: false, error: '확인할 결과가 없습니다.' };
        if (!g.pendingAck.acked.includes(pid)) g.pendingAck.acked.push(pid);
        return { ok: true };
      }
      if (g.pendingAck) return { ok: false, error: '조사 결과를 확인하는 중이에요.' };
      const res = engine.applyAction(g, pid, action);
      if (res.ok && action.type === 'publicCheck' && g.phase === 'playing') {
        const ev = g.events.filter((e) => e.type === 'publicCheck').pop();
        const ms = (ctx && ctx.opts && ctx.opts.ackMs) ?? 5000;
        g.pendingAck = { turn: ev.turn, by: pid, acked: [], deadline: now + ms };
      }
      return res;
    },
    startMessage: () => '게임이 시작되었습니다. 자리 추첨 완료!',
    endMessage: (g) => `게임 종료! 탈락: ${g.result.eliminated.map((id) => g.players[id].name).join(', ')}`,

    next(g, ctx) {
      if (g.phase !== 'playing') return null;
      // 공개 조사 결과 확인 대기: 접속 중인 사람이 모두 확인했거나 시간이 지나면 다음으로
      if (g.pendingAck) {
        const ack = g.pendingAck;
        const need = g.seats.filter((id) => !ctx.isBot(id) && ctx.isConnected(id));
        const done = need.every((id) => ack.acked.includes(id));
        return {
          at: done ? ctx.now : ack.deadline,
          run: () => {
            if (g.pendingAck !== ack) return false;
            g.pendingAck = null;
            return true;
          },
        };
      }
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
