(() => {
  'use strict';

  const E = window.ABEngine;
  const { SHAPES, SHAPE_KO, BOARD, LINES, COIN_VALUES } = E;
  const $ = (id) => document.getElementById(id);
  const esc = window.PlanShell.esc;
  const BASE_TITLE = document.title;

  /* ------------------------------------------------------------ */
  /* 그림                                                          */
  /* ------------------------------------------------------------ */

  const SHAPE_PATH = {
    circle: '<circle cx="12" cy="12" r="8.2"/>',
    triangle: '<path d="M12 3.6 20.8 19.4H3.2z"/>',
    star: '<path d="M12 2.6l2.75 5.75 6.3.85-4.6 4.35 1.15 6.25L12 16.8l-5.6 3 1.15-6.25-4.6-4.35 6.3-.85z"/>',
  };
  const SYM = { circle: '○', triangle: '△', star: '☆' };
  const shp = (s, cls = '') => `<svg class="shp shp-${s} ${cls}" viewBox="0 0 24 24" aria-label="${SHAPE_KO[s]}">${SHAPE_PATH[s]}</svg>`;
  const coinHtml = (v, extra = '') => `<span class="coin coin-${v} ${extra}">${v}</span>`;

  /** 3×3 빙고판. filled: 채운 칸 인덱스, lines: 완성된 줄 */
  function boardHtml(filled = [], lines = [], cls = '') {
    const set = new Set(filled);
    const cells = BOARD.map((s, i) => `<div class="cell ${set.has(i) ? 'on' : ''}">${shp(s, set.has(i) ? 'fill' : '')}</div>`).join('');
    const strokes = lines.map((l) => {
      const p = (i) => [(i % 3) + 0.5, Math.floor(i / 3) + 0.5];
      const [a, b] = [p(l[0]), p(l[2])];
      const dx = (b[0] - a[0]) * 0.18;
      const dy = (b[1] - a[1]) * 0.18;
      return `<line x1="${a[0] - dx}" y1="${a[1] - dy}" x2="${b[0] + dx}" y2="${b[1] + dy}"/>`;
    }).join('');
    return `<div class="bboard ${cls}">${cells}<svg class="blines" viewBox="0 0 3 3" preserveAspectRatio="none">${strokes}</svg></div>`;
  }

  function heroArt(el) {
    const cells = BOARD.map((s, i) => {
      const x = 30 + (i % 3) * 50;
      const y = 30 + Math.floor(i / 3) * 50;
      const on = [0, 4, 8, 2, 6].includes(i);
      return `<rect x="${x}" y="${y}" width="44" height="44" rx="10" fill="${on ? 'rgba(255,46,77,.18)' : '#14141b'}" stroke="${on ? '#ff5c74' : '#33333f'}" stroke-width="2.5"/>
        <g transform="translate(${x + 8} ${y + 8}) scale(1.17)" class="shp shp-${s} ${on ? 'fill' : ''}">${SHAPE_PATH[s]}</g>`;
    }).join('');
    el.innerHTML = `<g class="spin-slow">${cells}<line x1="40" y1="40" x2="160" y2="160" stroke="#ff2e4d" stroke-width="6" stroke-linecap="round" opacity=".9"/></g>`;
  }

  /* ------------------------------------------------------------ */
  /* 상태                                                          */
  /* ------------------------------------------------------------ */

  const L = {
    sel: null,
    tray: E.emptyCoins(),
    deadlineAt: null,
    phaseMs: null,
    phaseKey: null,
    gameNo: null,
    lastSec: null,
    resultShown: false,
  };
  let api = null;

  const g = () => api && api.room && api.room.game;
  const phaseLabel = { choose: '도형 선택', bid: '입찰', result: '결과 발표', ended: '게임 종료' };

  /* ------------------------------------------------------------ */
  /* 타이머                                                        */
  /* ------------------------------------------------------------ */

  function updateTimer() {
    const game = g();
    const box = $('abTimer');
    if (!game || L.deadlineAt == null) {
      box.classList.add('off');
      return;
    }
    box.classList.remove('off');
    const left = Math.max(0, L.deadlineAt - Date.now());
    const sec = Math.ceil(left / 1000);
    $('abTimerText').textContent = sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : String(sec);
    const frac = L.phaseMs ? left / L.phaseMs : 0;
    $('abTimerRing').style.strokeDashoffset = String(94.25 * (1 - frac));
    const mine = game.players.find((p) => p.id === api.meId());
    const waiting = (game.phase === 'choose' || game.phase === 'bid') && mine && !mine.submitted;
    box.classList.toggle('urgent', waiting && sec <= 10);
    if (waiting && sec <= 5 && sec > 0 && sec !== L.lastSec) api.SFX.tick();
    L.lastSec = sec;
  }
  setInterval(updateTimer, 250);

  /* ------------------------------------------------------------ */
  /* 방 상태 변화                                                   */
  /* ------------------------------------------------------------ */

  function onRoom(room, prev, a) {
    api = a;
    const game = room.game;
    if (room.gameNo !== L.gameNo) {
      L.gameNo = room.gameNo;
      L.resultShown = false;
      $('result').classList.add('hidden');
    }
    if (!game) {
      L.deadlineAt = null;
      L.phaseKey = null;
      $('result').classList.add('hidden');
      document.title = BASE_TITLE;
      return;
    }
    L.deadlineAt = game.remainingMs == null ? null : Date.now() + game.remainingMs;
    L.phaseMs = game.phaseMs;
    const key = `${room.gameNo}:${game.round}:${game.phase}`;
    if (key !== L.phaseKey) {
      const first = L.phaseKey === null;
      L.phaseKey = key;
      L.sel = null;
      L.tray = E.emptyCoins();
      if (!first) {
        if (game.phase === 'choose') { a.SFX.turn(); a.buzz([30, 50, 30]); }
        else if (game.phase === 'bid') { a.SFX.reveal(); a.buzz(30); }
        else if (game.phase === 'result') { a.SFX.fanfare(); a.buzz([40, 40, 80]); }
      }
      if (game.phase === 'ended' && !L.resultShown) setTimeout(() => showResult(), first ? 0 : 900);
    }
    const me = game.players.find((p) => p.id === room.meId);
    const needAct = (game.phase === 'choose' || game.phase === 'bid') && me && !me.submitted;
    document.title = needAct ? `⏳ ${phaseLabel[game.phase]} · ${BASE_TITLE}` : BASE_TITLE;
  }

  /* ------------------------------------------------------------ */
  /* 그리기                                                        */
  /* ------------------------------------------------------------ */

  function renderGame(room, a) {
    api = a;
    const game = room.game;
    if (!game) return;
    $('abRound').textContent = `ROUND ${Math.min(game.round, game.rounds)}/${game.rounds}`;
    $('abPhase').className = `ab-phase ph-${game.phase}`;
    $('abPhase').textContent = phaseLabel[game.phase];
    renderPlayers(game);
    const main = $('abMain');
    // 단계가 바뀐 첫 렌더에서만 등장 애니메이션
    const animKey = `${room.gameNo}:${game.round}:${game.phase}`;
    const fresh = L.animKey !== animKey;
    L.animKey = animKey;
    main.className = `ab-main glass m-${game.phase} ${fresh ? 'anim' : ''}`;
    if (game.phase === 'choose') main.innerHTML = renderChoose(game);
    else if (game.phase === 'bid') main.innerHTML = renderBid(game);
    else if (game.phase === 'result') main.innerHTML = renderResult(game);
    else main.innerHTML = renderEnded(game);
    renderBar(game);
    updateTimer();
  }

  function renderPlayers(game) {
    const active = game.phase === 'choose' || game.phase === 'bid';
    $('abPlayers').innerHTML = game.players.map((p) => {
      const rp = api.player(p.id) || {};
      const me = p.id === api.meId();
      let badge = '';
      if (active) badge = p.submitted ? '<i class="pb ok">✓</i>' : '<i class="pb wait"><b></b><b></b><b></b></i>';
      const choice = p.choice && (game.phase !== 'choose' || me) ? `<span class="pc">${shp(p.choice, 'fill')}</span>` : '';
      return `<div class="pl ${me ? 'me' : ''} ${rp.connected === false ? 'off' : ''} ${active && p.submitted ? 'done' : ''}">
        <div class="pa">${rp.isBot ? '🤖' : esc(p.name.slice(0, 1))}${choice}${badge}</div>
        <div class="pn">${me ? '나' : esc(p.name)}</div></div>`;
    }).join('');
  }

  function waitingLine(game) {
    const done = game.players.filter((p) => p.submitted).length;
    return `<div class="ab-wait"><span class="dots"><i></i><i></i><i></i></span> 다른 플레이어를 기다리는 중 <b>${done}/${game.players.length}</b></div>`;
  }

  function renderChoose(game) {
    const me = game.me;
    const done = !!me.choice;
    let h = `<div class="ab-q">${done ? '티켓을 넣었어요' : '어느 상자에 티켓을 넣을까?'}</div><div class="boxes">`;
    for (const s of SHAPES) {
      const on = (done ? me.choice : L.sel) === s;
      h += `<button class="box box-${s} ${on ? 'on' : ''}" data-shape="${s}" ${done ? 'disabled' : ''}>
        <span class="slot-line"></span>${shp(s, on ? 'fill big' : 'big')}<span class="bx-name">${SHAPE_KO[s]}</span>
        ${on && done ? '<span class="ticket">🎫</span>' : ''}</button>`;
    }
    h += '</div>';
    h += done
      ? waitingLine(game)
      : `<button class="btn btn-primary btn-lg btn-block" data-choose ${L.sel ? '' : 'disabled'}>🎫 ${L.sel ? `${SHAPE_KO[L.sel]} 상자에 ` : ''}티켓 넣기</button>`;
    return h;
  }

  function boxesSummary(game, opts = {}) {
    let h = '<div class="boxes compact">';
    for (const s of SHAPES) {
      const who = game.players.filter((p) => p.choice === s);
      const mine = game.me.choice === s;
      h += `<div class="box box-${s} ${mine ? 'on' : ''}">
        <div class="bx-head">${shp(s, 'fill')}<span class="bx-count">×${who.length}</span></div>
        <div class="bx-who">${who.map((p) => `<span class="${p.id === api.meId() ? 'me' : ''}">${p.id === api.meId() ? '나' : esc(p.name)}</span>`).join('') || '<span class="none">없음</span>'}</div>
        ${opts.extra ? opts.extra(s) : ''}</div>`;
    }
    return h + '</div>';
  }

  function renderBid(game) {
    const me = game.me;
    const s = me.choice;
    const n = game.players.filter((p) => p.choice === s).length;
    let h = boxesSummary(game);
    h += `<div class="ab-mine">${shp(s, 'fill')} <span>${n === 1 ? '혼자예요! <b>1원</b>만 내도 낙찰' : `낙찰되면 <b>${SHAPE_KO[s]} ×${n}</b> · 경쟁 ${n - 1}명`}</span></div>`;
    if (me.bid != null) {
      h += `<div class="ab-done">입찰 완료 <b>${me.bid}원</b></div>${waitingLine(game)}`;
      return h;
    }
    const total = E.coinValue(L.tray);
    h += '<div class="wallet">';
    for (const v of COIN_VALUES) {
      const left = me.coins[v] - L.tray[v];
      h += `<button class="wcoin" data-add="${v}" ${left > 0 ? '' : 'disabled'}>${coinHtml(v)}<span class="wc-n">×${left}</span></button>`;
    }
    h += '</div>';
    const trayCoins = COIN_VALUES.flatMap((v) => Array(L.tray[v]).fill(v));
    h += `<div class="tray ${trayCoins.length ? '' : 'empty'}">
      <div class="tray-coins">${trayCoins.length ? trayCoins.map((v) => `<button class="tcoin" data-rem="${v}">${coinHtml(v, 'sm')}</button>`).join('') : '<span class="tray-hint">코인을 눌러 담으세요</span>'}</div>
      <div class="tray-total"><b>${total}</b>원</div></div>`;
    h += `<div class="bid-row">
      <button class="btn" data-bid0>포기</button>
      <button class="btn btn-primary btn-lg" data-bid ${total ? '' : 'disabled'}>🔨 ${total}원 입찰</button></div>`;
    return h;
  }

  function priceHtml(info) {
    if (info.status === 'none') return '<div class="price none">—</div>';
    if (info.status === 'unsold') return '<div class="price unsold">유찰</div>';
    if (info.secret && info.price == null) return '<div class="price secret">🤫 SECRET</div>';
    return `<div class="price">${info.price}<small>원</small></div>`;
  }

  function renderResult(game) {
    const h0 = game.history[game.history.length - 1];
    if (!h0) return '';
    let h = `<div class="ab-q">ROUND ${h0.round} 낙찰가</div><div class="results">`;
    for (const s of SHAPES) {
      const info = h0.shapes[s];
      const mine = h0.myShape === s;
      h += `<div class="rcard box-${s} ${mine ? 'on' : ''} ${info.secret ? 'is-secret' : ''}">
        ${shp(s, 'fill big')}<div class="r-count">${info.count}명</div>${priceHtml(info)}
        ${mine ? `<div class="r-mine">내 입찰 ${h0.myBid}원</div>` : ''}</div>`;
    }
    h += '</div>';
    h += `<div class="ab-hint">누가 낙찰받았는지는 <b>비밀</b> · ${game.round >= game.rounds ? '곧 최종 공개!' : '곧 다음 라운드'}</div>`;
    return h;
  }

  function myRow(game) {
    return game.result && game.result.standings.find((r) => r.id === api.meId());
  }

  function renderEnded(game) {
    const r = myRow(game);
    if (!r) return '<div class="ab-q">게임 종료</div>';
    return `<div class="ab-q">${r.rank}위 · 내 빙고판</div>
      ${boardHtml(r.cells, r.lines, 'big')}
      <div class="final-stats"><span><b>${r.lineCount}</b>빙고</span><span><b>${r.filled}</b>칸</span><span><b>${r.coinValue}</b>원 남음</span></div>
      <button class="btn btn-primary btn-lg btn-block" data-show-result>전체 결과 보기</button>`;
  }

  function renderBar(game) {
    const me = game.me;
    $('abBar').innerHTML = `
      <div class="bar-coins">💰<b>${me.coinValue}</b><small>원</small></div>
      <div class="bar-tix">🎫 <b>${Math.max(0, me.tickets)}</b></div>
      <button class="btn bar-btn" data-mine>📒 내 기록</button>
      <button class="btn bar-btn" data-log>📜 전체</button>`;
  }

  /* ------------------------------------------------------------ */
  /* 입력                                                          */
  /* ------------------------------------------------------------ */

  $('abMain').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const game = g();
    if (!game) return;
    if (b.dataset.shape) {
      L.sel = b.dataset.shape;
      api.SFX.select();
    } else if (b.hasAttribute('data-choose')) {
      if (!L.sel) return;
      const res = await api.act({ type: 'choose', shape: L.sel });
      if (res.ok) api.SFX.drop();
      return;
    } else if (b.dataset.add) {
      const v = Number(b.dataset.add);
      if (game.me.coins[v] - L.tray[v] > 0) { L.tray[v] += 1; api.SFX.coin(); }
    } else if (b.dataset.rem) {
      const v = Number(b.dataset.rem);
      if (L.tray[v] > 0) { L.tray[v] -= 1; api.SFX.select(); }
    } else if (b.hasAttribute('data-bid')) {
      const res = await api.act({ type: 'bid', coins: { ...L.tray } });
      if (res.ok) { api.SFX.drop(); L.tray = E.emptyCoins(); }
      return;
    } else if (b.hasAttribute('data-bid0')) {
      if (!confirm('입찰을 포기할까요? (0원 · 이 상자에서 최하위)')) return;
      await api.act({ type: 'bid', coins: E.emptyCoins() });
      return;
    } else if (b.hasAttribute('data-show-result')) {
      return showResult();
    }
    api.render();
  });

  $('abBar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-log')) api.openLog();
    if (b.hasAttribute('data-mine')) { renderMine(); api.openSheet('sheetMine'); }
  });

  /* ------------------------------------------------------------ */
  /* 기록                                                          */
  /* ------------------------------------------------------------ */

  function priceText(info) {
    if (info.status === 'none') return '—';
    if (info.status === 'unsold') return '유찰';
    if (info.secret && info.price == null) return 'SECRET';
    return `${info.price}원`;
  }

  function renderMine() {
    const game = g();
    if (!game) return;
    const ended = game.phase === 'ended';
    const r = myRow(game);
    let h = `<div class="mine-board">${boardHtml(r ? r.cells : [], r ? r.lines : [], 'mid')}
      <div class="mine-note">${ended ? `${r.lineCount}빙고 · ${r.filled}칸` : '모든 플레이어의 빙고판은 같아요.<br/>내가 무엇을 낙찰받았는지는 <b>끝날 때</b> 공개!'}</div></div>`;
    h += '<div class="mine-rows">';
    if (!game.history.length) h += '<div class="empty-note">아직 기록이 없어요</div>';
    game.history.forEach((hh) => {
      const s = hh.myShape;
      const info = hh.shapes[s];
      let guess = '';
      if (info.status === 'sold' && info.price != null) guess = hh.myBid === info.price ? '<span class="tag win">최고가 = 내 입찰</span>' : '<span class="tag lose">밀림</span>';
      else if (info.secret) guess = '<span class="tag">?</span>';
      if (ended && info.winners) guess = info.winners.includes(api.meId()) ? `<span class="tag win">낙찰 +${info.each}</span>` : '<span class="tag lose">실패</span>';
      h += `<div class="mrow"><span class="mr-r">R${hh.round}</span>${shp(s, 'fill')}<span class="mr-n">${info.count}명</span>
        <span class="mr-b">내 ${hh.myBid}원</span><span class="mr-p">${priceText(info)}</span>${guess}</div>`;
    });
    h += '</div>';
    $('mineBody').innerHTML = h;
  }

  function logItems(room) {
    const game = room.game;
    const items = [];
    const ended = game.phase === 'ended';
    for (const hh of game.history) {
      items.push({ cls: 'round', html: `ROUND ${hh.round}` });
      items.push({ html: SHAPES.map((s) => `${SYM[s]} ${hh.shapes[s].count}명`).join(' · ') });
      items.push({ html: SHAPES.map((s) => `${SYM[s]} <b>${priceText(hh.shapes[s])}</b>`).join(' · ') });
      items.push({ cls: 'mine', html: `내 선택 ${SYM[hh.myShape]} · 입찰 ${hh.myBid}원` });
      if (ended) {
        SHAPES.forEach((s) => {
          const info = hh.shapes[s];
          if (info.winners && info.winners.length) {
            items.push({ html: `🔓 ${SYM[s]} 낙찰: ${info.winners.map((id) => `<b>${api.nm(id)}</b>`).join(', ')} <span class="dim">(각 ${info.each}개 · 입찰 ${info.winners.map((id) => hh.amounts[id]).join('/')}원)</span>` });
          }
        });
      }
    }
    if (game.phase === 'choose' || game.phase === 'bid') {
      items.push({ cls: 'round', html: `ROUND ${game.round} 진행 중 · ${phaseLabel[game.phase]}` });
    }
    if (ended) items.push({ cls: 'end', html: '🏁 게임 종료 · 모든 정보 공개' });
    return items.reverse();
  }

  /* ------------------------------------------------------------ */
  /* 최종 결과                                                     */
  /* ------------------------------------------------------------ */

  function showResult() {
    const game = g();
    if (!game || !game.result) return;
    L.resultShown = true;
    const rows = game.result.standings;
    const r = rows.find((x) => x.id === api.meId());
    const win = r && r.rank === 1;
    $('result').classList.toggle('win', !!(r && r.rank <= Math.ceil(rows.length / 2)));
    $('resultTitle').className = `result-title ${win ? 'gold' : r && r.rank <= Math.ceil(rows.length / 2) ? 'alive' : 'dead'}`;
    $('resultTitle').textContent = r ? `${r.rank}위` : '종료';
    $('resultSub').innerHTML = r ? `${r.lineCount}빙고 · ${r.filled}칸 · ${r.coinValue}원 남음` : '';
    $('resultBoard').innerHTML = r ? boardHtml(r.cells, r.lines, 'mid') : '';
    $('resultList').innerHTML = rows.map((x) => `<div class="rrow ${x.id === api.meId() ? 'me' : ''} ${x.rank === 1 ? 'first' : ''}">
        <span class="rk">${x.rank === 1 ? '🏆' : x.rank}</span>${boardHtml(x.cells, x.lines, 'tiny')}
        <span class="nm">${api.nm(x.id)}<small>${SHAPES.map((s) => `${SYM[s]}${x.won[s]}`).join(' ')}</small></span>
        <span class="info"><b>${x.lineCount}</b>빙고 · ${x.filled}칸</span><span class="cr">${x.coinValue}원</span></div>`).join('');
    $('resultActions').innerHTML =
      (api.isHost() ? '<button class="btn btn-primary btn-lg btn-block" id="btnLobby">한 판 더!</button>' : '<div class="waiting">방장이 다음 판을 준비해요<i>.</i><i>.</i><i>.</i></div>') +
      '<button class="btn btn-block" data-close-result>닫기</button>';
    $('result').classList.remove('hidden');
    if (win) api.SFX.win();
    else if (r && r.rank <= Math.ceil(rows.length / 2)) api.SFX.fanfare();
    else api.SFX.lose();
  }

  $('resultActions').addEventListener('click', async (e) => {
    if (e.target.closest('[data-close-result]')) return $('result').classList.add('hidden');
    if (e.target.id === 'btnLobby') {
      const res = await api.emit('backToLobby');
      if (!res.ok) api.toast(res.error, true);
    }
  });

  /* ------------------------------------------------------------ */
  /* 대기실: 제한 시간 설정                                         */
  /* ------------------------------------------------------------ */

  function lobbyExtra(room, el, a) {
    const cur = room.settings.timer;
    const host = a.isHost();
    el.innerHTML = `<div class="set-row"><span class="set-label">⏱ 제한 시간</span><div class="set-seg">${Object.entries(E.TIMER_PRESETS).map(([k, t]) =>
      `<button class="${k === cur ? 'on' : ''}" data-timer="${k}" ${host ? '' : 'disabled'}><b>${t.label}</b><small>${t.choose < 60 ? `${t.choose}초` : `${t.choose / 60}분`} / ${t.bid < 60 ? `${t.bid}초` : `${t.bid / 60}분`}</small></button>`).join('')}</div></div>`;
  }

  $('lobbyExtra').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-timer]');
    if (!b || b.disabled) return;
    const res = await api.emit('settings', { timer: b.dataset.timer });
    if (!res.ok) api.toast(res.error, true);
  });

  /* ------------------------------------------------------------ */
  /* 시작                                                          */
  /* ------------------------------------------------------------ */

  $('ruleBoard').innerHTML = `<div class="rb-label">공통 빙고판</div>${boardHtml([], [], 'mid')}`;
  const info = (window.GAMES || []).find((x) => x.id === 'auction-bingo');
  $('rulesFull').innerHTML = info ? info.rules.map((r) => `<li>${r}</li>`).join('') : '';

  api = window.PlanShell.start({
    gameId: 'auction-bingo',
    peerTag: 'ab',
    adapter: window.ABAdapter,
    title: '경매 빙고',
    baseTitle: BASE_TITLE,
    heroArt,
    lobbyExtra,
    onRoom,
    renderGame,
    logItems,
    onLeave: () => { L.phaseKey = null; L.deadlineAt = null; },
  });
})();
