/**
 * 경매 빙고 어댑터 — 공용 방(shared/room.js)에 게임 규칙을 연결한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./bot'));
  else root.ABAdapter = factory(root.ABEngine, root.ABBot);
})(typeof self !== 'undefined' ? self : this, function (engine, bot) {
  'use strict';

  const PRACTICE = 5;

  return {
    id: 'auction-bingo',
    minPlayers: engine.MIN_PLAYERS,
    maxPlayers: engine.MAX_PLAYERS,
    practicePlayers: PRACTICE,
    defaultSettings: { timer: 'normal' },
    normalizeSettings: (raw) => (raw && engine.TIMER_PRESETS[raw.timer] ? { timer: raw.timer } : null),

    fillTo: (count) => Math.max(count, PRACTICE),
    create: (players, settings, now) => engine.createGame(players, settings, now),
    isEnded: (g) => g.phase === 'ended',
    view: (g, viewerId, now) => engine.viewFor(g, viewerId, now),
    act: (g, pid, action, now) => engine.applyAction(g, pid, action, now),
    startMessage: () => '경매 빙고 시작! 총 7라운드',
    endMessage: (g) => {
      const top = g.result.standings.filter((r) => r.rank === 1).map((r) => r.name);
      return `게임 종료! 1위: ${top.join(', ')}`;
    },

    /** 봇 / 접속 끊긴 플레이어의 제출, 제한 시간 처리 */
    next(g, ctx) {
      if (g.phase === 'ended') return null;
      const due = [];
      if (g.phase === 'choose' || g.phase === 'bid') {
        for (const id of engine.active(g)) {
          const done = g.phase === 'choose' ? g.choices[id] : g.bids[id];
          if (done) continue;
          if (ctx.isBot(id)) due.push({ id, at: g.phaseAt + (g.botDelays[id] || ctx.opts.botDelay) });
          else if (!ctx.isConnected(id)) due.push({ id, at: g.phaseAt + ctx.opts.disconnectDelay });
        }
      }
      const times = due.map((d) => d.at);
      if (g.deadline != null) times.push(g.deadline);
      if (!times.length) return null;
      const phase = g.phase;
      const round = g.round;
      return {
        at: Math.min(...times),
        run: () => {
          if (g.phase !== phase || g.round !== round) return false;
          const now = Date.now();
          let changed = false;
          for (const d of due) {
            if (d.at > now || g.phase !== phase) continue;
            if (!ctx.isBot(d.id) && ctx.isConnected(d.id)) continue; // 그 사이 재접속
            const action = phase === 'choose' ? bot.decideChoice(g, d.id) : bot.decideBid(g, d.id);
            if (engine.applyAction(g, d.id, action, now).ok) changed = true;
          }
          if (engine.tick(g, now)) changed = true;
          return changed;
        },
      };
    },
  };
});
