(() => {
  'use strict';

  const N = 6;
  const NAME_KEY = 'plan:name';
  const BASE_TITLE = document.title;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mod = (n, m) => ((n % m) + m) % m;
  const pairChs = (i) => [mod(i, N), mod(i + 1, N)];
  const pairLabel = (i) => pairChs(i).map((c) => c + 1).join('·');

  const store = {
    name() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } },
    setName(n) { try { localStorage.setItem(NAME_KEY, n); } catch {} },
  };

  const S = {
    room: null,
    sel: { type: null, pair: null, amount: null },
    hoverPair: null,
    boardFor: null,
    cylAngle: 0,
    lastAim: null,
    anim: { running: false, step: -1, done: false, timer: null },
    prevPhase: null,
    prevGameNo: null,
    tab: 'log',
    chatSeenAt: Date.now(),
    busy: false,
  };

  const T = window.RRNet.create();
  const emit = (ev, payload) => T.request(ev, payload);

  /* ------------------------------------------------------------ */
  /* util                                                          */
  /* ------------------------------------------------------------ */

  let toastTimer;
  function toast(msg, isError) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function setUrlRoom(code) {
    const url = new URL(location.href);
    if (code) url.searchParams.set('room', code);
    else url.searchParams.delete('room');
    history.replaceState(null, '', url);
  }

  function showLoading(text) {
    $('loadingText').textContent = text;
    showScreen('screenLoading');
  }

  function showScreen(id) {
    ['screenLoading', 'screenEntry', 'screenLobby', 'screenGame'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
    $('btnLeave').classList.toggle('hidden', id === 'screenEntry' || id === 'screenLoading');
  }

  const g = () => S.room && S.room.game;
  const meId = () => S.room && S.room.meId;
  const isHost = () => S.room && S.room.hostId === S.room.meId;
  const roomPlayer = (id) => S.room.players.find((p) => p.id === id);
  function nameOf(id) {
    const game = g();
    const seat = game && game.seats.find((s) => s.id === id);
    const n = seat ? seat.name : roomPlayer(id)?.name || '?';
    return id === meId() ? `${n}(나)` : n;
  }

  /* ------------------------------------------------------------ */
  /* entry                                                         */
  /* ------------------------------------------------------------ */

  function readName() {
    const n = $('nameInput').value.trim();
    if (!n) {
      toast('닉네임을 입력하세요.', true);
      $('nameInput').focus();
      return null;
    }
    store.setName(n);
    return n;
  }

  async function enter(ev, payload) {
    if (S.busy) return;
    S.busy = true;
    showLoading(ev === 'create' ? (payload.practice ? '연습 게임을 준비하는 중…' : '방을 여는 중…') : '방에 접속하는 중…');
    const res = ev === 'create' ? await T.create(payload) : await T.join(payload);
    S.busy = false;
    if (!res.ok) {
      showEntry();
      return toast(res.error, true);
    }
    setUrlRoom(res.code);
    if (!S.room) showLoading('방 정보를 받는 중…');
  }

  $('btnCreate').onclick = () => { const name = readName(); if (name) enter('create', { name }); };
  $('btnPractice').onclick = () => { const name = readName(); if (name) enter('create', { name, practice: true }); };
  $('btnJoin').onclick = () => {
    const name = readName();
    const code = $('codeInput').value.trim().toUpperCase();
    if (!name) return;
    if (code.length !== 4) return toast('4자리 방 코드를 입력하세요.', true);
    enter('join', { code, name });
  };
  $('codeInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('btnJoin').click());
  $('nameInput').addEventListener('keydown', (e) => e.key === 'Enter' && ($('codeInput').value.trim() ? $('btnJoin') : $('btnCreate')).click());

  function showEntry() {
    S.room = null;
    S.boardFor = null;
    document.title = BASE_TITLE;
    $('nameInput').value = $('nameInput').value || store.name();
    const urlCode = new URL(location.href).searchParams.get('room');
    if (urlCode) $('codeInput').value = urlCode.toUpperCase();
    showScreen('screenEntry');
  }

  async function tryResume() {
    const urlCode = (new URL(location.href).searchParams.get('room') || '').toUpperCase();
    showLoading('이전 게임에 다시 연결하는 중…');
    const res = await T.resume(urlCode);
    if (res.ok) {
      setUrlRoom(res.code);
      return;
    }
    if (res.error) toast(res.error, true);
    showEntry();
  }

  $('btnLeave').onclick = async () => {
    const playing = g() && g().phase === 'playing';
    if (playing && !confirm('게임 중에 나가면 남은 차례는 봇이 대신합니다. 나갈까요?')) return;
    await T.leave();
    setUrlRoom(null);
    closeModal('resultModal');
    showEntry();
  };

  /* ------------------------------------------------------------ */
  /* network events                                                */
  /* ------------------------------------------------------------ */

  T.on('status', (d) => toast(d.message, d.state !== 'connected'));
  T.on('kicked', () => {
    setUrlRoom(null);
    closeModal('resultModal');
    toast('방장에 의해 퇴장되었습니다.', true);
    showEntry();
  });
  T.on('closed', (d) => {
    setUrlRoom(null);
    closeModal('resultModal');
    toast((d && d.reason) || '방이 닫혔습니다.', true);
    showEntry();
  });
  T.on('room', (room) => {
    S.room = room;
    onRoom();
  });

  function onRoom() {
    const room = S.room;
    const game = room.game;
    const phase = room.phase;

    if (room.gameNo !== S.prevGameNo) {
      // 새 게임 (또는 처음 접속)
      stopAnim();
      S.sel = { type: null, pair: null, amount: null };
      S.boardFor = null;
      if (phase === 'ended') S.anim.done = true; // 이미 끝난 게임에 접속
      S.prevGameNo = room.gameNo;
    } else if (S.prevPhase === 'playing' && phase === 'ended') {
      startAnim();
    }
    if (phase === 'lobby') {
      stopAnim();
      closeModal('resultModal');
    }
    if (game && game.currentPlayerId !== room.meId) S.sel = { type: null, pair: null, amount: null };
    S.prevPhase = phase;

    document.title = game && game.phase === 'playing' && game.currentPlayerId === room.meId ? `▶ 내 차례 · ${BASE_TITLE}` : BASE_TITLE;
    render();
    if (phase === 'ended' && S.anim.done && !S.resultShown) showResult();
  }

  /* ------------------------------------------------------------ */
  /* render                                                        */
  /* ------------------------------------------------------------ */

  function render() {
    if (!S.room) return showEntry();
    if (S.room.phase === 'lobby') {
      showScreen('screenLobby');
      renderLobby();
    } else {
      showScreen('screenGame');
      renderGame();
    }
  }

  /* ---------- lobby ---------- */

  function renderLobby() {
    const room = S.room;
    $('lobbyCode').textContent = room.code;
    const slots = [];
    for (let i = 0; i < N; i++) {
      const p = room.players[i];
      if (!p) {
        slots.push(`<div class="slot empty"><div class="avatar">·</div><div class="nm">빈자리 <span class="dim" style="font-weight:500;font-size:12px">— 시작 시 봇이 채웁니다</span></div></div>`);
        continue;
      }
      const tags = [];
      if (p.id === room.hostId) tags.push('<span class="badge badge-gold">방장</span>');
      if (p.id === room.meId) tags.push('<span class="badge badge-accent">나</span>');
      if (p.isBot) tags.push('<span class="badge">BOT</span>');
      if (!p.connected) tags.push('<span class="badge">연결 끊김</span>');
      const kick = isHost() && p.id !== room.meId ? `<button class="btn btn-sm btn-ghost" data-kick="${p.id}">내보내기</button>` : '';
      slots.push(`<div class="slot ${p.id === room.meId ? 'me' : ''}">
        <div class="avatar">${p.isBot ? '🤖' : esc(p.name.slice(0, 1))}</div>
        <div class="nm">${esc(p.name)} ${tags.join('')}</div>${kick}</div>`);
    }
    $('slots').innerHTML = slots.join('');

    const empty = N - room.players.length;
    $('lobbyActions').innerHTML = isHost()
      ? `<button class="btn" id="btnAddBot" ${empty ? '' : 'disabled'}>+ 봇 추가</button>
         <button class="btn btn-primary" id="btnStart">게임 시작${empty ? ` (빈자리 ${empty}개는 봇)` : ''}</button>`
      : `<div class="muted" style="padding:10px 0">방장이 게임을 시작하기를 기다리는 중…</div>`;
    $('lobbyNote').classList.toggle('hidden', T.mode !== 'p2p');
    renderChat($('lobbyChat'));
  }

  $('slots').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-kick]')?.dataset.kick;
    if (!id) return;
    const res = await emit('kick', { playerId: id });
    if (!res.ok) toast(res.error, true);
  });
  $('lobbyActions').addEventListener('click', async (e) => {
    if (e.target.id === 'btnAddBot') {
      const res = await emit('addBot');
      if (!res.ok) toast(res.error, true);
    } else if (e.target.id === 'btnStart') {
      const res = await emit('start');
      if (!res.ok) toast(res.error, true);
    }
  });
  $('btnCopy').onclick = async () => {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', S.room.code);
    const dev = new URLSearchParams(location.search).get('peer');
    if (dev) url.searchParams.set('peer', dev);
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
      toast('초대 링크를 복사했습니다.');
    } catch {
      prompt('초대 링크', link);
    }
  };

  /* ---------- chat ---------- */

  function renderChat(container) {
    if (!container.dataset.built) {
      container.dataset.built = '1';
      container.innerHTML = `<div class="label">채팅</div><div class="chat-list"></div>
        <form class="chat-form"><input class="input" maxlength="200" placeholder="메시지를 입력하세요" /><button class="btn">전송</button></form>`;
      container.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = container.querySelector('input');
        const text = input.value.trim();
        if (!text) return;
        emit('chat', { text }).then((r) => !r.ok && toast(r.error, true));
        input.value = '';
      });
    }
    const list = container.querySelector('.chat-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = S.room.chat
      .map((m) =>
        m.system
          ? `<div class="chat-msg sys">· ${esc(m.text)}</div>`
          : `<div class="chat-msg ${m.playerId === meId() ? 'me' : ''}"><b>${esc(m.from)}</b>${esc(m.text)}</div>`,
      )
      .join('') || '<div class="chat-msg sys">아직 메시지가 없습니다.</div>';
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  /* ---------- game ---------- */

  function renderGame() {
    const game = g();
    if (!game) return;
    if (S.boardFor !== S.room.gameNo) buildBoard();
    renderStatus(game);
    updateBoard(game);
    renderMe(game);
    renderActions(game);
    renderLog(game);
    renderChat($('tabChat'));
    if (S.tab === 'chat') S.chatSeenAt = Date.now();
    const unread = S.room.chat.filter((m) => !m.system && m.playerId !== meId() && m.at > S.chatSeenAt).length;
    $('chatBadge').textContent = unread;
    $('chatBadge').classList.toggle('hidden', !unread || S.tab === 'chat');
  }

  function renderStatus(game) {
    const seatName = (s) => esc(nameOf(game.seats[s].id));
    const chips = [`<div class="chip"><span>라운드</span><b>${game.round}</b></div>`];
    chips.push(`<div class="chip"><span>선 플레이어</span><b>${seatName(game.firstSeat)}</b></div>`);
    if (game.phase === 'playing') {
      const mine = game.currentPlayerId === meId();
      chips.push(`<div class="chip ${mine ? 'turn-me' : ''}"><span>현재 차례</span><b>${mine ? '나' : seatName(game.currentSeat)}</b></div>`);
    } else {
      chips.push(`<div class="chip turn-me"><span>상태</span><b>게임 종료</b></div>`);
    }
    chips.push(`<div class="chip"><span>총구 방향</span><b>${seatName(game.aim)}</b></div>`);
    const pips = Array.from({ length: game.rules.endWhenEmpty }, (_, i) => `<i class="pip ${i < game.emptyCount ? 'on' : ''}"></i>`).join('');
    chips.push(`<div class="chip"><span>크레딧 소진 ${game.emptyCount}/${game.rules.endWhenEmpty}</span><div class="pips">${pips}</div></div>`);
    $('statusbar').innerHTML = chips.join('');
  }

  /* ---------- board ---------- */

  const SEAT_R = 240;
  const CH_R = 88;
  const pos = (i, r) => {
    const a = ((-90 + i * 60) * Math.PI) / 180;
    return [300 + r * Math.cos(a), 300 + r * Math.sin(a)];
  };

  function buildBoard() {
    const svg = $('board');
    let h = `<defs>
      <radialGradient id="felt" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#2b1118"/><stop offset="100%" stop-color="#120a0d"/></radialGradient>
    </defs>
    <circle class="table-felt" cx="300" cy="300" r="186"/>
    <circle class="table-ring" cx="300" cy="300" r="162"/>
    <g class="cyl" id="cyl">
      <rect class="barrel" x="287" y="126" width="26" height="60" rx="4"/>
      <polygon class="muzzle" points="300,112 289,132 311,132"/>
      <circle class="cyl-body" cx="300" cy="300" r="132"/>`;
    for (let k = 0; k < N; k++) {
      const [x, y] = pos(k, CH_R);
      h += `<g class="ch" data-ch="${k}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><g class="ch-inner">
        <circle class="mine-ring" r="37"/><circle class="hole" r="30"/>
        <text class="num" y="3">${k + 1}</text><text class="st" y="18">?</text></g></g>`;
    }
    h += `<circle class="cyl-groove" cx="300" cy="300" r="18"/></g>`;
    for (let s = 0; s < N; s++) {
      const [x, y] = pos(s, SEAT_R);
      h += `<g class="seat" data-seat="${s}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
        <circle class="halo" r="48"/><circle class="base" r="48"/>
        <g class="crosshair"><circle r="56"/><line x1="0" y1="-64" x2="0" y2="-50"/><line x1="0" y1="50" x2="0" y2="64"/><line x1="-64" y1="0" x2="-50" y2="0"/><line x1="50" y1="0" x2="64" y2="0"/></g>
        <text class="tag" y="-22"></text><text class="name" y="4"></text><text class="sub" y="22"></text>
        <line class="x" x1="-24" y1="-24" x2="24" y2="24"/><line class="x" x1="24" y1="-24" x2="-24" y2="24"/>
      </g>`;
    }
    h += `<text class="center-msg" id="centerMsg" x="300" y="316"></text>`;
    svg.innerHTML = h;
    S.boardFor = S.room.gameNo;
    S.lastAim = null;
  }

  function firedChambers(game) {
    if (!game.result) return { set: new Set(), current: null };
    const shots = game.result.shots;
    const upto = S.anim.done ? shots.length - 1 : S.anim.step;
    const set = new Set();
    for (let i = 0; i <= upto && i < shots.length; i++) set.add(shots[i].chamber);
    const current = S.anim.running && S.anim.step >= 0 ? shots[S.anim.step] : null;
    return { set, current };
  }

  function updateBoard(game) {
    const svg = $('board');
    if (S.lastAim === null) S.cylAngle = game.aim * 60;
    else if (game.aim !== S.lastAim) S.cylAngle += mod(game.aim - S.lastAim, N) * 60;
    S.lastAim = game.aim;
    svg.querySelector('#cyl').style.transform = `rotate(${S.cylAngle}deg)`;

    const ended = game.phase === 'ended';
    const { set: fired, current } = firedChambers(game);
    const revealAll = ended && S.anim.done;
    const selPair = S.sel.pair != null ? pairChs(S.sel.pair) : [];
    const hovPair = S.hoverPair != null ? pairChs(S.hoverPair) : [];

    svg.querySelectorAll('.ch').forEach((el) => {
      const k = Number(el.dataset.ch);
      el.querySelector('.ch-inner').style.transform = `rotate(${-S.cylAngle}deg)`;
      const cls = ['ch'];
      let st = '?';
      if (game.result && (revealAll || fired.has(k))) {
        const loaded = game.result.chambers[k];
        cls.push(loaded ? 'loaded' : 'empty');
        st = loaded ? '실탄' : '빈';
      } else {
        const kn = game.knowledge[k];
        if (kn) {
          cls.push(kn.loaded ? 'loaded' : 'empty');
          if (kn.source === 'private') cls.push('priv');
          if (kn.stale) cls.push('stale');
          st = (kn.loaded ? '실탄' : '빈') + (kn.stale ? '?' : '');
        }
      }
      if (game.me && !ended && k === game.me.chamber) cls.push('mine');
      if (selPair.includes(k)) cls.push('sel');
      if (hovPair.includes(k)) cls.push('hov');
      if (current && current.chamber === k) cls.push('fired');
      el.setAttribute('class', cls.join(' '));
      el.querySelector('.st').textContent = st;
    });

    const eliminated = new Set();
    if (game.result) {
      game.result.shots.forEach((s) => {
        if (s.hit && (revealAll || fired.has(s.chamber))) eliminated.add(s.playerId);
      });
    }

    svg.querySelectorAll('.seat').forEach((el) => {
      const s = Number(el.dataset.seat);
      const seat = game.seats[s];
      const rp = roomPlayer(seat.id);
      const cls = ['seat'];
      if (seat.id === meId()) cls.push('me');
      if (!ended && s === game.currentSeat) cls.push('turn');
      if (seat.out && !ended) cls.push('out');
      if (!ended && s === game.aim) cls.push('aimed');
      if (eliminated.has(seat.id)) cls.push('dead');
      if (current && current.seat === s) cls.push('firing');
      if (revealAll && !eliminated.has(seat.id)) cls.push('safe');
      el.setAttribute('class', cls.join(' '));

      const tags = [`<tspan fill="#6f6e80">${s + 1}번</tspan>`];
      if (s === game.firstSeat && !ended) tags.push('<tspan fill="#e8b14a"> · 선</tspan>');
      if (rp && rp.isBot) tags.push('<tspan fill="#a9a8b8"> · BOT</tspan>');
      if (rp && !rp.connected) tags.push('<tspan fill="#ff5468"> · 끊김</tspan>');
      el.querySelector('.tag').innerHTML = tags.join('');
      const nm = seat.name.length > 6 ? seat.name.slice(0, 5) + '…' : seat.name;
      el.querySelector('.name').textContent = nm;

      let sub;
      if (ended) {
        sub = eliminated.has(seat.id) ? '탈락' : revealAll ? `생존 · ${seat.credits}cr` : '';
      } else if (seat.out) {
        sub = '크레딧 소진';
      } else {
        sub = `약실 ${mod(s - game.aim, N) + 1}`;
        if (seat.id === meId()) sub += ` · ${seat.credits}cr`;
      }
      el.querySelector('.sub').textContent = sub;
    });
  }

  function showCenterMsg(text, hit) {
    const el = $('centerMsg');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('show', 'hit');
    el.getBoundingClientRect();
    el.classList.add('show');
    if (hit) el.classList.add('hit');
  }

  /* ---------- me panel ---------- */

  function knowText(kn) {
    if (!kn) return '<span class="dim">미확인</span>';
    const t = kn.loaded ? '<b style="color:var(--accent-2)">실탄</b>' : '<b>빈 약실</b>';
    return t + (kn.stale ? ' <span class="dim">(조작 이후 불확실)</span>' : kn.source === 'private' ? ' <span class="dim">(비공개 확인)</span>' : '');
  }

  function renderMe(game) {
    const me = game.me;
    if (!me) {
      $('mePanel').innerHTML = '<div class="me-note">관전 중</div>';
      return;
    }
    const r = game.rules;
    const note =
      game.phase === 'playing'
        ? `당신은 <b>${me.seat + 1}번 자리</b>. 지금 격발되면 <b>약실 ${me.chamber + 1}</b> → ${knowText(game.knowledge[me.chamber])}`
        : game.result.eliminated.includes(me.id)
          ? '<b style="color:var(--accent-2)">피탄되어 탈락했습니다.</b>'
          : S.anim.done ? '<b style="color:var(--ok)">살아남았습니다!</b>' : '격발 중…';
    $('mePanel').innerHTML = `
      <div><div class="lbl">내 크레딧 (비공개)</div><div class="big">${me.credits}<small> / ${r.startCredits}</small></div></div>
      <div><div class="lbl">조작 누적 (비공개)</div><div class="big">${me.manip}<small> / ${r.manipTarget}</small></div>
        <div class="progress"><div style="width:${(me.manip / r.manipTarget) * 100}%"></div></div></div>
      <div class="me-note">${note}</div>`;
  }

  /* ---------- actions ---------- */

  const ACTS = [
    { key: 'publicCheck', t: '공개 조사', c: '1', d: '인접 약실 2개 · 전체 공개' },
    { key: 'privateCheck', t: '비공개 조사', c: '2', d: '인접 약실 2개 · 나만 확인' },
    { key: 'rotate1', t: '1칸 회전', c: '3', d: '총구를 시계 방향 1칸' },
    { key: 'rotate2', t: '2칸 회전', c: '4', d: '총구를 시계 방향 2칸' },
    { key: 'manip', t: '조작', c: '1~3', d: '비공개 제출 · 누적 6이면 인접 약실 2개의 탄약을 교환', wide: true },
  ];

  function pairButtons(game, selected) {
    const glyph = (c) => {
      const kn = game.knowledge[c];
      if (!kn) return '?';
      return (kn.loaded ? '실' : '빈') + (kn.stale ? '?' : '');
    };
    let h = '<div class="pairs">';
    for (let i = 0; i < N; i++) {
      const [a, b] = pairChs(i);
      h += `<button class="pair ${selected === i ? 'on' : ''}" data-pair="${i}">${pairLabel(i)}<small>${glyph(a)} · ${glyph(b)}</small></button>`;
    }
    return h + '</div>';
  }

  function renderActions(game) {
    const panel = $('actionPanel');
    const myTurn = game.phase === 'playing' && game.currentPlayerId === meId();
    const me = game.me;
    let banner;
    if (game.phase !== 'playing') banner = '<div class="turn-banner"><span class="dot"></span>게임이 끝났습니다</div>';
    else if (myTurn) banner = '<div class="turn-banner me"><span class="dot"></span>당신의 차례입니다 — 행동을 선택하세요</div>';
    else {
      const cur = roomPlayer(game.currentPlayerId);
      const who = esc(nameOf(game.currentPlayerId));
      banner = `<div class="turn-banner"><span class="dot"></span>${who} 님의 차례${cur && (cur.isBot || !cur.connected) ? ' <span class="dim" style="font-weight:500">(자동 진행)</span>' : ''}</div>`;
    }

    const acts = ACTS.map((a) => {
      const enabled = myTurn && game.actions.includes(a.key);
      return `<button class="act ${a.wide ? 'wide' : ''} ${S.sel.type === a.key ? 'on' : ''}" data-act="${a.key}" ${enabled ? '' : 'disabled'}>
        <span class="t">${a.t}<span class="c">${a.c}cr</span></span><span class="d">${a.d}</span></button>`;
    }).join('');

    let detail = '';
    const sel = S.sel;
    if (myTurn && sel.type) {
      if (sel.type === 'publicCheck' || sel.type === 'privateCheck') {
        const cost = game.rules.cost[sel.type];
        detail = `<div class="hint">조사할 <b>인접한 약실 2개</b>를 고르세요. ${sel.type === 'publicCheck' ? '결과가 <b>모두에게 공개</b>됩니다.' : '결과는 <b>나만</b> 볼 수 있습니다.'}</div>
          ${pairButtons(game, sel.pair)}
          <button class="btn btn-primary btn-block" data-confirm ${sel.pair == null ? 'disabled' : ''}>
            ${sel.type === 'publicCheck' ? '공개' : '비공개'} 조사${sel.pair != null ? ` [약실 ${pairLabel(sel.pair)}]` : ''} 실행 (−${cost}cr)</button>`;
      } else if (sel.type === 'rotate1' || sel.type === 'rotate2') {
        const steps = sel.type === 'rotate1' ? 1 : 2;
        const newAim = mod(game.aim + steps, N);
        const myCh = mod(me.seat - newAim, N);
        detail = `<div class="hint">총구가 <b>${esc(nameOf(game.seats[newAim].id))}</b> 님을 향하게 됩니다.<br/>
          회전 후 내 자리는 <b>약실 ${myCh + 1}</b> → ${knowText(game.knowledge[myCh])}</div>
          <button class="btn btn-primary btn-block" data-confirm>${steps}칸 회전 실행 (−${game.rules.cost[sel.type]}cr)</button>`;
      } else if (sel.type === 'manip') {
        const r = game.rules;
        const amounts = [];
        for (let a = r.manipMin; a <= r.manipMax; a++) {
          amounts.push(`<button class="pair ${sel.amount === a ? 'on' : ''}" data-amt="${a}" ${a > me.credits ? 'disabled' : ''}>${a}<small>크레딧</small></button>`);
        }
        const reaches = sel.amount && me.manip + sel.amount >= r.manipTarget;
        const waste = reaches ? me.manip + sel.amount - r.manipTarget : 0;
        detail = `<div class="hint">현재 조작 누적 <b>${me.manip}/${r.manipTarget}</b>. 제출 금액은 <b>나만</b> 압니다.</div>
          <div class="amounts">${amounts.join('')}</div>`;
        if (sel.amount) {
          detail += reaches
            ? `<div class="hint" style="color:var(--gold)"><b>조작권 획득!</b> 탄약을 서로 바꿀 인접 약실 2개를 고르세요.${waste ? ` (초과 ${waste}크레딧 소멸)` : ''}</div>${pairButtons(game, sel.pair)}`
            : `<div class="hint">제출 후 누적 <b>${me.manip + sel.amount}/${r.manipTarget}</b></div>`;
        }
        const ready = sel.amount && (!reaches || sel.pair != null);
        detail += `<button class="btn btn-primary btn-block" data-confirm ${ready ? '' : 'disabled'}>
          ${reaches ? `조작 실행${sel.pair != null ? ` [약실 ${pairLabel(sel.pair)} 교환]` : ''}` : '조작 크레딧 제출'}${sel.amount ? ` (−${sel.amount}cr)` : ''}</button>`;
      }
      detail = `<div class="detail">${detail}</div>`;
    }

    panel.innerHTML = banner + `<div class="acts">${acts}</div>` + detail;
  }

  $('actionPanel').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.act) {
      S.sel = { type: t.dataset.act === S.sel.type ? null : t.dataset.act, pair: null, amount: null };
    } else if (t.dataset.pair != null) {
      S.sel.pair = Number(t.dataset.pair);
    } else if (t.dataset.amt != null) {
      S.sel.amount = Number(t.dataset.amt);
      S.sel.pair = null;
    } else if (t.hasAttribute('data-confirm')) {
      return submitAction();
    }
    S.hoverPair = null;
    renderGame();
  });
  $('actionPanel').addEventListener('mouseover', (e) => {
    const p = e.target.closest('[data-pair]');
    const v = p ? Number(p.dataset.pair) : null;
    if (v !== S.hoverPair) {
      S.hoverPair = v;
      updateBoard(g());
    }
  });
  $('actionPanel').addEventListener('mouseleave', () => {
    if (S.hoverPair != null) {
      S.hoverPair = null;
      updateBoard(g());
    }
  });

  async function submitAction() {
    const sel = S.sel;
    let action;
    if (sel.type === 'publicCheck' || sel.type === 'privateCheck') action = { type: sel.type, pair: sel.pair };
    else if (sel.type === 'rotate1') action = { type: 'rotate', steps: 1 };
    else if (sel.type === 'rotate2') action = { type: 'rotate', steps: 2 };
    else if (sel.type === 'manip') {
      action = { type: 'manip', amount: sel.amount };
      if (sel.pair != null) action.pair = sel.pair;
    }
    if (!action || S.busy) return;
    S.busy = true;
    const res = await emit('action', action);
    S.busy = false;
    if (!res.ok) return toast(res.error, true);
    S.sel = { type: null, pair: null, amount: null };
    S.hoverPair = null;
  }

  /* ---------- log ---------- */

  const resTag = (b) => (b ? '<span class="res y">실탄</span>' : '<span class="res n">빈</span>');

  function evHtml(ev, game) {
    const who = `<b>${esc(nameOf(ev.by))}</b>`;
    switch (ev.type) {
      case 'start':
        return { cls: 'round', html: `게임 시작 · 총구가 ${esc(nameOf(game.seats[ev.aim].id))} 님을 향합니다` };
      case 'roundStart':
        return { cls: 'round', html: `— 라운드 ${ev.round} · 선 플레이어 ${esc(nameOf(ev.by))} —` };
      case 'publicCheck': {
        const [a, b] = pairChs(ev.pair);
        return { cls: '', html: `${who} 공개 조사 · 약실 ${a + 1} ${resTag(ev.results[0])} 약실 ${b + 1} ${resTag(ev.results[1])}` };
      }
      case 'privateCheck': {
        const [a, b] = pairChs(ev.pair);
        if (ev.mine) return { cls: 'mine', html: `🔒 ${who} 비공개 조사 · 약실 ${a + 1} ${resTag(ev.results[0])} 약실 ${b + 1} ${resTag(ev.results[1])}` };
        return { cls: '', html: `${who} 비공개 조사 · 약실 ${a + 1}·${b + 1} <span class="dim">(결과 비공개)</span>` };
      }
      case 'rotate':
        return { cls: '', html: `${who} 총구 ${ev.steps}칸 회전 → <b>${esc(nameOf(game.seats[ev.aim].id))}</b> 님을 향함` };
      case 'manipSubmit':
        if (ev.mine) return { cls: 'mine', html: `🔒 ${who} 조작 크레딧 ${ev.amount}개 제출 <span class="dim">(누적 ${ev.total}/6)</span>` };
        return { cls: '', html: `${who} 조작 크레딧 제출 <span class="dim">(금액 비공개)</span>` };
      case 'manip':
        if (ev.mine) return { cls: 'warn', html: `⚡ ${who} 조작 실행 · 약실 ${pairLabel(ev.pair)} 탄약 교환${ev.wasted ? ` <span class="dim">(초과 ${ev.wasted} 소멸)</span>` : ''}` };
        return { cls: 'warn', html: `⚡ ${who} 조작 실행! <span class="dim">어느 약실이 바뀌었는지는 비공개</span>` };
      case 'pass':
        return { cls: '', html: `${who} 크레딧 소진 · 자동 패스` };
      case 'end':
        return { cls: 'end', html: `💥 게임 종료 · 격발 시작` };
      default:
        return null;
    }
  }

  function renderLog(game) {
    const items = game.events
      .map((ev) => evHtml(ev, game))
      .filter(Boolean)
      .reverse()
      .map((x) => `<div class="log-item ${x.cls}">${x.html}</div>`);
    $('tabLog').innerHTML = items.join('');
  }

  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      S.tab = t.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
      $('tabLog').classList.toggle('hidden', S.tab !== 'log');
      $('tabChat').classList.toggle('hidden', S.tab !== 'chat');
      renderGame();
    }),
  );

  /* ------------------------------------------------------------ */
  /* end animation & result                                       */
  /* ------------------------------------------------------------ */

  function stopAnim() {
    clearTimeout(S.anim.timer);
    S.anim = { running: false, step: -1, done: false, timer: null };
    S.resultShown = false;
  }

  function startAnim() {
    stopAnim();
    S.anim.running = true;
    const shots = g().result.shots;
    const tick = () => {
      if (!g() || !g().result) return stopAnim();
      S.anim.step += 1;
      if (S.anim.step >= shots.length) {
        S.anim.running = false;
        S.anim.done = true;
        render();
        S.anim.timer = setTimeout(showResult, 900);
        return;
      }
      const shot = shots[S.anim.step];
      render();
      showCenterMsg(shot.hit ? '탕!' : '찰칵', shot.hit);
      S.anim.timer = setTimeout(tick, shot.hit ? 1700 : 1200);
    };
    render();
    showCenterMsg('격발!', false);
    S.anim.timer = setTimeout(tick, 1400);
  }

  function showResult() {
    const game = g();
    if (!game || !game.result) return;
    S.resultShown = true;
    const res = game.result;
    const dead = new Set(res.eliminated);
    const order = res.shots.map((s) => s.seat);
    const rows = game.seats
      .map((s) => {
        const shotIdx = order.indexOf(s.seat);
        const shot = shotIdx >= 0 ? `${shotIdx + 1}번째 격발 · 약실 ${res.shots[shotIdx].chamber + 1}` : '격발 전 종료';
        return `<div class="result-row ${dead.has(s.id) ? 'dead' : ''}">
          <span>${dead.has(s.id) ? '💀' : '🟢'}</span>
          <span class="nm">${esc(nameOf(s.id))}</span>
          <span class="dim" style="font-size:12px">${shot}</span>
          <span class="cr">${s.credits}cr</span></div>`;
      })
      .join('');
    const iDied = dead.has(meId());
    $('resultBody').innerHTML = `
      <div style="font-size:15px">${iDied ? '<b style="color:var(--accent-2)">당신은 탈락했습니다.</b>' : '<b style="color:var(--ok)">당신은 살아남았습니다!</b>'}
        <span class="muted">탈락: ${res.eliminated.map((id) => esc(nameOf(id))).join(', ')}</span></div>
      <div class="label" style="margin-top:14px">최종 약실 (총구: ${esc(nameOf(game.seats[res.aim].id))})</div>
      <div class="reveal">${res.chambers.map((b, i) => `<span class="${b ? 'y' : ''}">${i + 1}</span>`).join('')}</div>
      <div class="result-list">${rows}</div>`;
    $('resultActions').innerHTML =
      (isHost() ? '<button class="btn btn-primary" id="btnLobby">대기실로 (다시 하기)</button>' : '<div class="muted" style="align-self:center">방장이 다음 게임을 준비합니다.</div>') +
      '<button class="btn" data-close>보드 보기</button>';
    openModal('resultModal');
  }

  $('resultActions').addEventListener('click', async (e) => {
    if (e.target.id === 'btnLobby') {
      const res = await emit('backToLobby');
      if (!res.ok) toast(res.error, true);
    }
  });

  /* ------------------------------------------------------------ */
  /* modals                                                        */
  /* ------------------------------------------------------------ */

  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }
  document.querySelectorAll('.modal-backdrop').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden');
    }),
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
  });

  const info = (window.GAMES || []).find((x) => x.id === 'russian-roulette');
  $('rulesBody').innerHTML = info ? info.rules.map((r) => `<li>${r}</li>`).join('') : '';
  $('btnRules').onclick = () => openModal('rulesModal');

  /* ------------------------------------------------------------ */
  /* start                                                         */
  /* ------------------------------------------------------------ */

  $('entryNote').classList.toggle('hidden', T.mode !== 'p2p');
  showLoading('불러오는 중…');
  T.ready()
    .then(tryResume)
    .catch((e) => {
      console.error(e);
      showEntry();
      toast(e.message || '초기화에 실패했습니다.', true);
    });
})();
