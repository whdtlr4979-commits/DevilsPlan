(() => {
  'use strict';

  const N = 6;
  const NAME_KEY = 'plan:name';
  const SOUND_KEY = 'plan:sound';
  const BASE_TITLE = document.title;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mod = (n, m) => ((n % m) + m) % m;
  const pairChs = (i) => [mod(i, N), mod(i + 1, N)];
  const CH = 'ABCDEF'; // 약실 이름 (A 가 총구 쪽 = 첫 번째 격발)
  const chName = (k) => CH[mod(k, N)];
  const pairLabel = (i) => pairChs(i).map(chName).join('·');
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  /* ------------------------------------------------------------ */
  /* icons                                                         */
  /* ------------------------------------------------------------ */

  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const rot = (n) => svg(`<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3.5V8h-4.5"/><text x="12" y="15.6" text-anchor="middle" font-size="9.5" font-weight="900" fill="currentColor" stroke="none" font-family="system-ui">${n}</text>`);
  const ICON = {
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    rot1: rot(1),
    rot2: rot(2),
    swap: svg('<path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 20l4-4-4-4"/><path d="M21 16H7"/>'),
  };
  const COIN = `<svg class="coin" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#e89a10"/></linearGradient></defs>
    <circle cx="16" cy="16" r="14" fill="url(#cg)" stroke="#a86a00" stroke-width="1.5"/><circle cx="16" cy="16" r="9.5" fill="none" stroke="#a86a00" stroke-width="1.5" opacity=".6"/>
    <text x="16" y="21" text-anchor="middle" font-size="13" font-weight="900" fill="#7a4a00" font-family="system-ui">C</text></svg>`;

  const ACTS = [
    { key: 'publicCheck', lb: '공개<br>조사', name: '공개 조사', cost: '1', icon: ICON.eye, desc: '붙어 있는 2칸 · 모두에게 공개' },
    { key: 'privateCheck', lb: '비공개<br>조사', name: '비공개 조사', cost: '2', icon: ICON.eyeOff, desc: '붙어 있는 2칸 · 나만 확인', priv: true },
    { key: 'rotate1', lb: '1칸<br>회전', name: '1칸 회전', cost: '3', icon: ICON.rot1, desc: '총구를 시계 방향 1칸' },
    { key: 'rotate2', lb: '2칸<br>회전', name: '2칸 회전', cost: '4', icon: ICON.rot2, desc: '총구를 시계 방향 2칸' },
    { key: 'manip', lb: '몰래<br>조작', name: '조작', cost: '1-3', icon: ICON.swap, desc: '공용 풀에 1~3씩 몰래 · 내 제출로 6이 차면 붙은 2칸 탄약 교환', priv: true },
  ];
  // 공용 풀을 채운 사람만 하는 두 번째 단계 (타일에는 없음)
  const SWAP_ACT = { key: 'manipSwap', name: '조작권 획득!', cost: '', icon: ICON.swap, priv: true };
  const actByKey = Object.fromEntries([...ACTS, SWAP_ACT].map((a) => [a.key, a]));

  /* ------------------------------------------------------------ */
  /* sound & haptics                                               */
  /* ------------------------------------------------------------ */

  const SFX = (() => {
    let ctx = null;
    let on = ls.get(SOUND_KEY) !== 'off';
    const ac = () => {
      if (!ctx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        ctx = new C();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    };
    function tone(f1, f2, dur, type = 'sine', vol = 0.12, delay = 0) {
      if (!on) return;
      const c = ac();
      if (!c) return;
      const t = c.currentTime + delay;
      const o = c.createOscillator();
      const gn = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f1, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      gn.gain.setValueAtTime(vol, t);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(gn).connect(c.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    function noise(dur, vol, freq, type = 'lowpass', delay = 0) {
      if (!on) return;
      const c = ac();
      if (!c) return;
      const t = c.currentTime + delay;
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      const src = c.createBufferSource();
      src.buffer = buf;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      const gn = c.createGain();
      gn.gain.value = vol;
      src.connect(f).connect(gn).connect(c.destination);
      src.start(t);
    }
    return {
      get on() { return on; },
      toggle() { on = !on; ls.set(SOUND_KEY, on ? 'on' : 'off'); if (on) this.select(); return on; },
      unlock() { if (on) ac(); },
      select() { tone(700, 950, 0.07, 'triangle', 0.07); },
      turn() { tone(660, 0, 0.12, 'sine', 0.13); tone(990, 0, 0.2, 'sine', 0.13, 0.12); },
      spin() { for (let i = 0; i < 6; i++) noise(0.03, 0.3, 3200, 'highpass', i * 0.12); },
      reveal() { tone(320, 640, 0.14, 'sine', 0.08); },
      soft() { tone(240, 200, 0.08, 'sine', 0.06); },
      click() { noise(0.05, 0.7, 4200, 'highpass'); tone(1800, 900, 0.04, 'square', 0.035); },
      bang() { noise(0.8, 1.1, 900, 'lowpass'); tone(130, 38, 0.45, 'sine', 0.55); },
      win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0, 0.2, 'triangle', 0.1, i * 0.1)); },
      lose() { [392, 330, 262].forEach((f, i) => tone(f, f * 0.96, 0.32, 'sawtooth', 0.05, i * 0.2)); },
    };
  })();
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };
  document.addEventListener('pointerdown', () => SFX.unlock(), { once: true });

  /* ------------------------------------------------------------ */
  /* state                                                         */
  /* ------------------------------------------------------------ */

  const S = {
    room: null,
    sel: { type: null, pair: null, amount: null },
    pendingCh: null,
    boardFor: null,
    cylAngle: 0,
    lastAim: null,
    anim: { running: false, step: -1, done: false, timer: null },
    prevPhase: null,
    prevGameNo: null,
    lastTurnKey: null,
    lastEvCount: 0,
    tab: 'log',
    chatSeenAt: Date.now(),
    busy: false,
    resultShown: false,
  };

  const T = window.PlanNet.create({ gameId: 'russian-roulette', peerTag: 'rr', adapter: window.RRAdapter });
  const emit = (ev, payload) => T.request(ev, payload);

  const g = () => S.room && S.room.game;
  const meId = () => S.room && S.room.meId;
  const isHost = () => S.room && S.room.hostId === S.room.meId;
  const roomPlayer = (id) => (S.room ? S.room.players.find((p) => p.id === id) : null);
  function rawName(id) {
    const game = g();
    const seat = game && game.seats.find((s) => s.id === id);
    return seat ? seat.name : (roomPlayer(id) || {}).name || '?';
  }
  const nm = (id) => (id === meId() ? '나' : esc(rawName(id)));
  const clearSel = () => { S.sel = { type: null, pair: null, amount: null }; S.pendingCh = null; };

  /* ------------------------------------------------------------ */
  /* ui helpers                                                    */
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
    el.style.animation = 'none';
    void el.offsetHeight; // 애니메이션 재시작
    el.style.animation = '';
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
    const inRoom = id === 'screenLobby' || id === 'screenGame';
    $('btnLeave').classList.toggle('hidden', !inRoom);
    $('btnChat').classList.toggle('hidden', !inRoom);
    $('hudTitle').textContent = id === 'screenLobby' ? '대기실' : '러시안 룰렛';
    document.querySelector('.app').classList.toggle('in-game', id === 'screenGame');
  }

  function openSheet(id) { $(id).classList.remove('hidden'); }
  document.querySelectorAll('.sheet-backdrop').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden');
    }),
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.sheet-backdrop').forEach((m) => m.classList.add('hidden'));
  });

  /* ------------------------------------------------------------ */
  /* entry                                                         */
  /* ------------------------------------------------------------ */

  function heroArt() {
    const holes = [0, 1, 2, 3, 4, 5].map((i) => {
      const a = ((i * 60 - 90) * Math.PI) / 180;
      const x = 100 + 52 * Math.cos(a);
      const y = 100 + 52 * Math.sin(a);
      const live = i === 1 || i === 4;
      return `<circle cx="${x}" cy="${y}" r="20" fill="${live ? '#ff2e4d' : '#0b0b10'}" stroke="${live ? '#ff8a9a' : '#3a3a48'}" stroke-width="3"/>` +
        (live ? `<circle cx="${x}" cy="${y}" r="8" fill="#ffc542"/>` : '');
    }).join('');
    $('heroArt').innerHTML = `<defs><radialGradient id="hcy" cx="40%" cy="35%"><stop offset="0" stop-color="#4a4a58"/><stop offset="1" stop-color="#16161d"/></radialGradient></defs>
      <g class="spin"><circle cx="100" cy="100" r="86" fill="url(#hcy)" stroke="#5c5c6c" stroke-width="3"/>${holes}
      <circle cx="100" cy="100" r="12" fill="#0b0b10" stroke="#3a3a48" stroke-width="3"/></g>`;
  }

  function readName() {
    const n = $('nameInput').value.trim();
    if (!n) {
      toast('닉네임을 입력하세요', true);
      $('nameInput').focus();
      return null;
    }
    ls.set(NAME_KEY, n);
    return n;
  }

  async function enter(ev, payload) {
    if (S.busy) return;
    S.busy = true;
    showLoading(ev === 'create' ? (payload.practice ? '연습 게임 준비 중…' : '방 여는 중…') : '접속 중…');
    const res = ev === 'create' ? await T.create(payload) : await T.join(payload);
    S.busy = false;
    if (!res.ok) {
      showEntry();
      return toast(res.error, true);
    }
    setUrlRoom(res.code);
    if (!S.room) showLoading('방 정보 받는 중…');
  }

  $('btnCreate').onclick = () => { const name = readName(); if (name) enter('create', { name }); };
  $('btnPractice').onclick = () => { const name = readName(); if (name) enter('create', { name, practice: true }); };
  $('btnJoin').onclick = () => {
    const name = readName();
    if (!name) return;
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length !== 4) return toast('방 코드 4자리를 입력하세요', true);
    enter('join', { code, name });
  };
  $('codeInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('btnJoin').click());
  $('nameInput').addEventListener('keydown', (e) => e.key === 'Enter' && ($('codeInput').value.trim() ? $('btnJoin') : $('btnCreate')).click());

  function showEntry() {
    S.room = null;
    S.boardFor = null;
    document.title = BASE_TITLE;
    $('nameInput').value = $('nameInput').value || ls.get(NAME_KEY) || '';
    const urlCode = new URL(location.href).searchParams.get('room');
    if (urlCode) $('codeInput').value = urlCode.toUpperCase();
    closeResult();
    $('sheetLog').classList.add('hidden');
    showScreen('screenEntry');
  }

  async function tryResume() {
    const urlCode = (new URL(location.href).searchParams.get('room') || '').toUpperCase();
    showLoading('다시 연결하는 중…');
    const res = await T.resume(urlCode);
    if (res.ok) return setUrlRoom(res.code);
    if (res.error) toast(res.error, true);
    showEntry();
  }

  $('btnLeave').onclick = async () => {
    const game = g();
    const playing = game && game.phase === 'playing';
    const msg = T.mode === 'p2p' && isHost() ? '방을 닫고 나갈까요?' : playing ? '나가면 남은 차례는 봇이 대신해요. 나갈까요?' : '방에서 나갈까요?';
    if (!confirm(msg)) return;
    await T.leave();
    setUrlRoom(null);
    showEntry();
  };

  /* ------------------------------------------------------------ */
  /* network events                                                */
  /* ------------------------------------------------------------ */

  T.on('status', (d) => toast(d.message, d.state !== 'connected'));
  T.on('kicked', () => { setUrlRoom(null); toast('방장이 내보냈어요', true); showEntry(); });
  T.on('closed', (d) => { setUrlRoom(null); toast((d && d.reason) || '방이 닫혔어요', true); showEntry(); });
  T.on('room', (room) => { S.room = room; onRoom(); });

  function onRoom() {
    const room = S.room;
    const game = room.game;
    const phase = room.phase;

    if (room.gameNo !== S.prevGameNo) {
      stopAnim();
      clearSel();
      S.boardFor = null;
      S.lastEvCount = game ? game.events.length : 0;
      if (phase === 'ended') S.anim.done = true;
      S.prevGameNo = room.gameNo;
    } else if (S.prevPhase === 'playing' && phase === 'ended') {
      startAnim();
    }
    if (phase === 'lobby') { stopAnim(); closeResult(); }
    if (game && game.currentPlayerId !== room.meId) clearSel();
    // 내 제출로 공용 조작 풀이 찼다 → 약실 선택 화면 (취소 불가)
    if (game && game.me && game.me.pendingManip && !(DEV.cur && DEV.cur.kind === 'select' && DEV.cur.act === 'manipSwap')) {
      clearSel();
      openSelect('manipSwap');
      SFX.turn();
      buzz([60, 40, 60]);
    }
    if (game && game.phase !== 'playing') closeDevice(true);
    else if (DEV.cur && DEV.cur.kind === 'select' && game && game.currentPlayerId !== room.meId) closeDevice();
    S.prevPhase = phase;

    // 효과음 + 조사 결과 팝업 (공개 조사는 모두에게, 비공개 조사는 본인에게만)
    if (game) {
      const start = S.lastEvCount;
      const fresh = game.events.slice(start);
      S.lastEvCount = game.events.length;
      if (fresh.some((e) => e.type === 'publicCheck' || (e.type === 'privateCheck' && e.mine))) SFX.reveal();
      else if (fresh.some((e) => e.type === 'private')) SFX.soft();
      if (game.phase === 'playing') {
        fresh.forEach((ev, i) => {
          if (ev.type === 'publicCheck' || (ev.type === 'privateCheck' && ev.mine)) queueResult(game, ev, start + i);
        });
      }
    }
    const turnKey = game && game.phase === 'playing' && game.currentPlayerId === room.meId ? `${room.gameNo}:${game.turn}` : null;
    if (turnKey && turnKey !== S.lastTurnKey) { SFX.turn(); buzz([40, 60, 40]); }
    S.lastTurnKey = turnKey;

    document.title = turnKey ? `🔥 내 차례 · ${BASE_TITLE}` : BASE_TITLE;
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
    renderSheet();
  }

  /* ---------- lobby ---------- */

  function renderLobby() {
    const room = S.room;
    $('lobbyCode').textContent = room.code;
    const tiles = [];
    for (let i = 0; i < N; i++) {
      const p = room.players[i];
      if (!p) {
        tiles.push('<div class="slot empty"><div class="av">+</div><div class="nm">빈자리</div></div>');
        continue;
      }
      const cls = ['slot', p.id === room.meId ? 'me' : '', p.isBot ? 'bot' : '', p.connected ? '' : 'off'].join(' ');
      tiles.push(`<div class="${cls}">
        ${p.id === room.hostId ? '<span class="crown">👑</span>' : ''}
        ${isHost() && p.id !== room.meId ? `<button class="kick" data-kick="${p.id}" aria-label="내보내기">✕</button>` : ''}
        <div class="av">${p.isBot ? '🤖' : esc(p.name.slice(0, 1))}</div>
        <div class="nm">${p.id === room.meId ? '나' : esc(p.name)}</div></div>`);
    }
    $('slots').innerHTML = tiles.join('');
    const empty = N - room.players.length;
    const hints = [];
    if (empty) hints.push(`빈자리 ${empty}개는 봇이 채워요`);
    if (T.mode === 'p2p' && isHost()) hints.push('방장이 창을 닫으면 방이 사라져요');
    $('lobbyHint').textContent = hints.join(' · ');
    $('lobbyActions').innerHTML = isHost()
      ? `<button class="btn btn-lg" id="btnAddBot" ${empty ? '' : 'disabled'} aria-label="봇 추가">+ 🤖</button>
         <button class="btn btn-primary btn-lg" id="btnStart">게임 시작</button>`
      : '<div class="waiting">방장이 곧 시작해요<i>.</i><i>.</i><i>.</i></div>';
  }

  $('slots').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-kick]')?.dataset.kick;
    if (!id) return;
    const res = await emit('kick', { playerId: id });
    if (!res.ok) toast(res.error, true);
  });
  $('lobbyActions').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const res = await emit(b.id === 'btnAddBot' ? 'addBot' : 'start');
    if (!res.ok) toast(res.error, true);
  });
  $('btnShare').onclick = async () => {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', S.room.code);
    const dev = new URLSearchParams(location.search).get('peer');
    if (dev) url.searchParams.set('peer', dev);
    const link = url.toString();
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: '러시안 룰렛', text: `러시안 룰렛 한 판? 방 코드 ${S.room.code}`, url: link });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('초대 링크 복사 완료!');
    } catch {
      prompt('초대 링크', link);
    }
  };

  /* ---------- game ---------- */

  function renderGame() {
    const game = g();
    if (!game) return;
    if (S.boardFor !== S.room.gameNo) buildBoard();
    renderTurnbar(game);
    updateBoard(game);
    renderDock(game);
    renderTicker(game);
    renderLogInto($('logInline'), game, true);
    document.querySelector('.app').classList.toggle('stepping', !!S.sel.type && game.currentPlayerId === meId());
  }

  function renderTurnbar(game) {
    let status;
    if (game.phase === 'ended') status = `<div class="tb-status over">${S.anim.done ? '게임 종료' : '💥 격발'}</div>`;
    else if (game.currentPlayerId === meId()) status = '<div class="tb-status me">🔥 내 차례</div>';
    else status = `<div class="tb-status">${nm(game.currentPlayerId)} <span class="think"><i></i><i></i><i></i></span></div>`;
    $('turnbar').innerHTML = `<div class="tb-round">ROUND ${game.round}</div>${status}`;
  }

  /* ---------- board ---------- */

  const SEAT_R = 232;
  const CH_R = 80;
  const pos = (i, r) => {
    const a = ((-90 + i * 60) * Math.PI) / 180;
    return [300 + r * Math.cos(a), 300 + r * Math.sin(a)];
  };

  function buildBoard() {
    let h = `<defs>
      <radialGradient id="felt" cx="50%" cy="45%" r="55%"><stop offset="0" stop-color="#2d0d15"/><stop offset=".7" stop-color="#150a0e"/><stop offset="1" stop-color="#0b0709"/></radialGradient>
      <radialGradient id="steel" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#5a5a68"/><stop offset=".55" stop-color="#2c2c36"/><stop offset="1" stop-color="#17171e"/></radialGradient>
      <linearGradient id="steel2" x1="0" x2="1"><stop offset="0" stop-color="#2c2c36"/><stop offset=".5" stop-color="#5a5a68"/><stop offset="1" stop-color="#2c2c36"/></linearGradient>
    </defs>
    <circle class="felt" cx="300" cy="300" r="172"/>
    <circle class="felt-ring" cx="300" cy="300" r="150"/>
    <g class="ghost" id="ghost"><polygon points="300,126 287,146 313,146"/></g>
    <g class="cyl" id="cyl">
      <rect class="barrel" x="287" y="142" width="26" height="44" rx="5"/>
      <polygon class="muzzle" points="300,126 287,146 313,146"/>
      <circle class="cyl-body" cx="300" cy="300" r="120"/>`;
    for (let k = 0; k < N; k++) {
      const [x, y] = pos(k, CH_R);
      h += `<g class="ch" data-ch="${k}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><g class="ch-in">
        <circle class="ring" r="35"/><circle class="hole" r="27"/><text class="num" y="8">${chName(k)}</text></g></g>`;
    }
    h += '<circle class="cyl-hub" cx="300" cy="300" r="17"/></g>';
    for (let s = 0; s < N; s++) {
      const [x, y] = pos(s, SEAT_R);
      h += `<g class="seat" data-seat="${s}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
        <g class="cross"><circle r="67"/><path d="M0 -76V-60M0 60V76M-76 0H-60M60 0H76"/></g>
        <circle class="halo" r="56"/><circle class="base" r="56"/>
        <text class="nm" y="3"></text><text class="sub" y="25"></text>
        <g class="pill first hidden" transform="translate(40 -44)"><rect x="-15" y="-11" width="30" height="22"/><text y="5">선</text></g>
        <g class="pill tagme hidden" transform="translate(0 56)"><rect x="-17" y="-11" width="34" height="22"/><text y="5">나</text></g>
        <path class="x" d="M-26 -26L26 26M26 -26L-26 26"/>
      </g>`;
    }
    h += '<text class="bang" id="bang" x="300" y="326"></text>';
    $('board').innerHTML = h;
    S.boardFor = S.room.gameNo;
    S.lastAim = null;
  }

  function firedInfo(game) {
    if (!game.result) return { set: new Set(), current: null };
    const shots = game.result.shots;
    const upto = S.anim.done ? shots.length - 1 : S.anim.step;
    const set = new Set();
    for (let i = 0; i <= upto && i < shots.length; i++) set.add(shots[i].chamber);
    return { set, current: S.anim.running && S.anim.step >= 0 ? shots[S.anim.step] : null };
  }

  function needsPair(game) {
    const t = S.sel.type;
    return false; // 약실 선택은 전용 선택 화면(단말기)에서
  }

  function updateBoard(game) {
    const board = $('board');
    if (S.lastAim === null) S.cylAngle = game.aim * 60;
    else if (game.aim !== S.lastAim) {
      S.cylAngle += mod(game.aim - S.lastAim, N) * 60;
      SFX.spin();
      buzz(25);
    }
    S.lastAim = game.aim;
    board.querySelector('#cyl').style.transform = `rotate(${S.cylAngle}deg)`;

    const ghost = board.querySelector('#ghost');
    const rotSteps = S.sel.type === 'rotate1' ? 1 : S.sel.type === 'rotate2' ? 2 : 0;
    ghost.classList.toggle('on', !!rotSteps);
    ghost.style.transform = `rotate(${S.cylAngle + rotSteps * 60}deg)`;

    const ended = game.phase === 'ended';
    const { set: fired, current } = firedInfo(game);
    const revealAll = ended && S.anim.done;
    const picking = game.phase === 'playing' && game.currentPlayerId === meId() && needsPair(game);
    const selPair = S.sel.pair != null ? pairChs(S.sel.pair) : [];
    const pend = S.pendingCh;

    board.querySelectorAll('.ch').forEach((el) => {
      const k = Number(el.dataset.ch);
      el.querySelector('.ch-in').style.transform = `rotate(${-S.cylAngle}deg)`;
      const cls = ['ch'];
      if (game.result && (revealAll || fired.has(k))) {
        cls.push(game.result.chambers[k] ? 'loaded' : 'empty');
      } else {
        const kn = game.knowledge[k];
        if (kn) {
          cls.push(kn.loaded ? 'loaded' : 'empty');
          if (kn.source === 'private') cls.push('priv');
          if (kn.stale) cls.push('stale');
        }
      }
      if (game.me && !ended && k === game.me.chamber) cls.push('mine');
      if (picking) {
        cls.push('pick');
        if (pend === k) cls.push('pending');
        else if (pend != null && (mod(k - pend, N) === 1 || mod(pend - k, N) === 1)) cls.push('pickn');
      }
      if (selPair.includes(k)) cls.push('sel');
      if (current && current.chamber === k) cls.push('fired');
      el.setAttribute('class', cls.join(' '));
    });

    const dead = new Set();
    if (game.result) game.result.shots.forEach((s) => s.hit && (revealAll || fired.has(s.chamber)) && dead.add(s.playerId));

    board.querySelectorAll('.seat').forEach((el) => {
      const s = Number(el.dataset.seat);
      const seat = game.seats[s];
      const rp = roomPlayer(seat.id);
      const cls = ['seat'];
      if (seat.id === meId()) cls.push('me');
      if (!ended && s === game.currentSeat) cls.push('turn');
      if (!ended && s === game.aim) cls.push('aimed');
      if (rp && !rp.connected) cls.push('off');
      if (dead.has(seat.id)) cls.push('dead');
      if (current && current.seat === s) cls.push('firing');
      if (revealAll && !dead.has(seat.id)) cls.push('safe');
      el.setAttribute('class', cls.join(' '));
      const name = seat.name.length > 5 ? seat.name.slice(0, 4) + '…' : seat.name;
      el.querySelector('.nm').textContent = name;
      let sub;
      if (ended) sub = dead.has(seat.id) ? '탈락' : revealAll ? '생존' : '';
      else if (rp && !rp.connected) sub = '연결 끊김';
      else sub = `약실 ${chName(s - game.aim)}`;
      el.querySelector('.sub').textContent = sub;
      el.querySelector('.first').classList.toggle('hidden', ended || s !== game.firstSeat);
      el.querySelector('.tagme').classList.toggle('hidden', seat.id !== meId());
    });
  }

  $('board').addEventListener('click', (e) => {
    const el = e.target.closest('.ch');
    const game = g();
    if (!el || !game || game.phase !== 'playing' || game.currentPlayerId !== meId() || !needsPair(game)) return;
    const k = Number(el.dataset.ch);
    const p = S.pendingCh;
    if (p === null || p === k) {
      S.pendingCh = p === k ? null : k;
      S.sel.pair = null;
    } else if (mod(k - p, N) === 1) {
      S.sel.pair = p;
      S.pendingCh = null;
    } else if (mod(p - k, N) === 1) {
      S.sel.pair = k;
      S.pendingCh = null;
    } else {
      S.pendingCh = k;
      S.sel.pair = null;
    }
    SFX.select();
    renderGame();
  });

  function bangFx(text, hit) {
    const el = $('bang');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('show', 'hit');
    el.getBoundingClientRect();
    el.classList.add('show');
    if (hit) el.classList.add('hit');
    const wrap = $('boardWrap');
    if (hit) {
      wrap.classList.remove('shake', 'flash');
      wrap.getBoundingClientRect();
      wrap.classList.add('shake', 'flash');
      setTimeout(() => wrap.classList.remove('shake', 'flash'), 600);
    }
  }

  /* ---------- dock ---------- */

  function knowCls(kn) {
    if (!kn) return '';
    return (kn.loaded ? 'loaded' : 'empty') + (kn.stale ? ' stale' : '');
  }

  function renderDock(game) {
    const me = game.me;
    const dock = $('dock');
    if (!me) { dock.innerHTML = '<div class="idle-note">관전 중</div>'; return; }
    const r = game.rules;
    const ended = game.phase === 'ended';
    const myTurn = !ended && game.currentPlayerId === meId();
    let mych;
    if (!ended) mych = `<div class="mych"><span>내 약실</span><b class="${knowCls(game.knowledge[me.chamber])}">${chName(me.chamber)}</b></div>`;
    else {
      const died = S.anim.done && game.result.eliminated.includes(me.id);
      mych = `<div class="mych"><span>결과</span><b class="${died ? 'loaded' : ''}">${S.anim.done ? (died ? '탈락' : '생존') : '…'}</b></div>`;
    }
    const stats = `<div class="stats">
      <div class="coins">${COIN}<b>${me.credits}</b><small>/${r.startCredits}</small></div>
      ${mych}</div>`;

    let body = '';
    if (ended) {
      body = S.anim.done
        ? '<button class="btn btn-primary btn-lg btn-block" data-result>결과 보기</button>'
        : '<div class="idle-note">격발 중…</div>';
    } else if (myTurn && me.credits === 0 && !me.pendingManip) {
      body = `<div class="passbox"><div class="big">크레딧 없음</div>
        <div class="small">곧 자동으로 패스돼요 · 남들에겐 "비공개 행동"</div>
        <button class="btn btn-block" data-pass>지금 패스</button></div>`;
    } else if (myTurn && S.sel.type) {
      // 선택 모드: 보드가 잘 보이도록 도크를 컴팩트하게
      const a = actByKey[S.sel.type];
      const locked = S.sel.type === 'manipSwap'; // 조작권은 취소할 수 없다
      dock.innerHTML = `<div class="step-head">
          ${locked ? '<span class="sh-flash">⚡</span>' : '<button class="icon-btn" data-back aria-label="뒤로">‹</button>'}
          <div class="sh-title ${a.priv ? 'priv' : ''}">${a.icon}<span>${a.name}</span></div>
          <div class="sh-coins">${COIN}<b>${me.credits}</b></div>
        </div>${renderStep(game)}`;
      return;
    } else {
      body = `<div class="acts">${ACTS.map((a) => {
        const enabled = myTurn && game.actions.includes(a.key);
        return `<button class="act ${a.priv ? 'priv' : ''}" data-act="${a.key}" ${enabled ? '' : 'disabled'}>
          <span class="cost"><i class="sc">★</i>${a.cost}</span>${a.icon}<span class="lb">${a.lb}</span></button>`;
      }).join('')}</div>`;
    }
    dock.innerHTML = stats + body;
  }

  function pairChips(selected) {
    let h = '<div class="pairs">';
    for (let i = 0; i < N; i++) h += `<button class="pair ${selected === i ? 'on' : ''}" data-pair="${i}">${pairLabel(i)}</button>`;
    return h + '</div>';
  }

  function renderStep(game) {
    const sel = S.sel;
    const me = game.me;
    const a = actByKey[sel.type];
    let h = '';
    let ready = false;
    let label = a.name;
    if (sel.type === 'publicCheck' || sel.type === 'privateCheck') {
      const hint = sel.pair != null ? `약실 <b>${pairLabel(sel.pair)}</b> 선택`
        : S.pendingCh != null ? '깜빡이는 <b>옆 칸</b>을 누르세요'
        : '보드에서 <b>붙어 있는 약실 2개</b>를 누르세요';
      h += `<div class="step-hint">${hint}</div>${pairChips(sel.pair)}`;
      ready = sel.pair != null;
      label = `${a.name}${sel.pair != null ? ` · ${pairLabel(sel.pair)}` : ''}`;
    } else if (sel.type === 'rotate1' || sel.type === 'rotate2') {
      const steps = sel.type === 'rotate1' ? 1 : 2;
      const newAim = mod(game.aim + steps, N);
      const myCh = mod(me.seat - newAim, N);
      h += `<div class="step-hint">총구 → <b>${nm(game.seats[newAim].id)}</b> · 내 약실 <b>${chName(myCh)}</b></div>`;
      ready = true;
    } else if (sel.type === 'manip') {
      const r = game.rules;
      const seg = [];
      for (let v = r.manipMin; v <= r.manipMax; v++) seg.push(`<button class="${sel.amount === v ? 'on' : ''}" data-amt="${v}" ${v > me.credits ? 'disabled' : ''}>${v}</button>`);
      h += `<div class="step-hint"><b>공용 풀</b>에 몰래 넣을 크레딧 · 내 제출로 <b class="gold">6</b>이 차면 내가 조작</div><div class="seg">${seg.join('')}</div>`;
      ready = !!sel.amount;
      label = '몰래 제출';
    } else if (sel.type === 'manipSwap') {
      const w = me.pendingManip ? me.pendingManip.wasted : 0;
      const hint = sel.pair != null ? `약실 <b>${pairLabel(sel.pair)}</b>의 탄약을 서로 바꿔요`
        : S.pendingCh != null ? '깜빡이는 <b>옆 칸</b>을 누르세요'
        : '풀이 찼어요! 탄약을 바꿀 <b>붙어 있는 약실 2개</b>';
      h += `<div class="step-hint">${hint}${w ? ` <span class="dim">(초과 ${w} 소멸)</span>` : ''}</div>${pairChips(sel.pair)}`;
      ready = sel.pair != null;
      label = `조작 실행${sel.pair != null ? ` · ${pairLabel(sel.pair)} 교환` : ''}`;
    }
    const cost = sel.type === 'manip' ? sel.amount || '' : a.cost;
    h += `<button class="btn btn-primary btn-lg btn-block" data-confirm ${ready ? '' : 'disabled'}>${label}${cost ? ` <span style="opacity:.75">· ${cost}C</span>` : ''}</button>`;
    return `<div class="step">${h}</div>`;
  }

  $('dock').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.act) {
      clearSel();
      SFX.select();
      if (b.dataset.act === 'publicCheck' || b.dataset.act === 'privateCheck') return openSelect(b.dataset.act);
      S.sel.type = b.dataset.act;
      renderGame();
      return;
    }
    if (b.hasAttribute('data-back')) {
      clearSel();
      SFX.select();
      renderGame();
      return;
    }
    if (b.dataset.pair != null) {
      S.sel.pair = Number(b.dataset.pair);
      S.pendingCh = null;
    } else if (b.dataset.amt != null) {
      S.sel.amount = Number(b.dataset.amt);
      S.sel.pair = null;
      S.pendingCh = null;
    } else if (b.hasAttribute('data-confirm')) {
      return submitAction();
    } else if (b.hasAttribute('data-pass')) {
      return send({ type: 'pass' });
    } else if (b.hasAttribute('data-result')) {
      return showResult();
    }
    SFX.select();
    if (g()) renderGame();
  });

  function submitAction() {
    const sel = S.sel;
    let action = null;
    if (sel.type === 'publicCheck' || sel.type === 'privateCheck') action = { type: sel.type, pair: sel.pair };
    else if (sel.type === 'rotate1') action = { type: 'rotate', steps: 1 };
    else if (sel.type === 'rotate2') action = { type: 'rotate', steps: 2 };
    else if (sel.type === 'manip') action = { type: 'manip', amount: sel.amount };
    else if (sel.type === 'manipSwap') action = { type: 'manipSwap', pair: sel.pair };
    if (action) send(action);
  }

  async function send(action) {
    if (S.busy) return { ok: false };
    S.busy = true;
    const res = await emit('action', action);
    S.busy = false;
    if (!res.ok) {
      toast(res.error, true);
      return res;
    }
    buzz(15);
    clearSel();
    // 조작 크레딧을 냈는데 풀이 아직 안 찼다 → 누적 안내
    if (action.type === 'manip' && !res.manip) {
      showDevice({ kind: 'notice', title: '조작', headline: '조작 불가능', text: '크레딧이<br/>누적되었습니다' });
    }
    return res;
  }

  /* ---------- log ---------- */

  const rchip = (c, y) => `<span class="r ${y ? 'y' : 'n'}">${chName(c)} ${y ? 'O' : 'X'}</span>`;

  function evItem(ev, game) {
    const who = `<b>${nm(ev.by)}</b>`;
    switch (ev.type) {
      case 'start':
        return { cls: 'round', html: `START · 총구 → ${nm(game.seats[ev.aim].id)}` };
      case 'roundStart':
        return { cls: 'round', html: `ROUND ${ev.round} · 선 ${nm(ev.by)}` };
      case 'publicCheck': {
        const [a, b] = pairChs(ev.pair);
        return { cls: '', html: `${who} 공개 조사 ${rchip(a, ev.results[0])}${rchip(b, ev.results[1])}` };
      }
      case 'privateCheck': {
        const [a, b] = pairChs(ev.pair);
        return { cls: ev.mine ? 'mine' : '', html: `🔒 ${who} 비공개 조사 ${rchip(a, ev.results[0])}${rchip(b, ev.results[1])}` };
      }
      case 'private':
        return { cls: 'priv', html: `${who} 비공개 행동` };
      case 'rotate':
        return { cls: '', html: `${who} ${ev.steps}칸 회전 → ${nm(game.seats[ev.aim].id)}` };
      case 'manipSubmit':
        return { cls: ev.mine ? 'mine' : '', html: `🔒 ${who} 조작 풀에 +${ev.amount}${ev.reached ? ' <b>→ 6 달성!</b>' : ''}` };
      case 'manip':
        return { cls: ev.mine ? 'mine' : '', html: `⚡ ${who} 조작 · ${pairLabel(ev.pair)} 교환${ev.wasted ? ` <span class="dim">(초과 ${ev.wasted} 소멸)</span>` : ''}` };
      case 'pass':
        return { cls: ev.mine ? 'mine' : '', html: `${ev.mine ? '🔒 ' : ''}${who} 패스` };
      case 'end':
        return { cls: 'end', html: '💥 격발! <span class="dim">모든 기록 공개</span>' };
      default:
        return null;
    }
  }

  /** 최신 라운드가 위. 라운드 제목은 그 라운드 행동들 위, 라운드 안에서는 최신 행동이 위 */
  function logOrder(events) {
    const head = [];
    const groups = [];
    let tail = null;
    for (const ev of events) {
      if (ev.type === 'end') tail = ev;
      else if (ev.type === 'roundStart') groups.push({ title: ev, items: [] });
      else if (!groups.length) head.push(ev);
      else groups[groups.length - 1].items.push(ev);
    }
    const out = tail ? [tail] : [];
    for (const g of groups.reverse()) out.push(g.title, ...g.items.reverse());
    return out.concat(head.reverse());
  }

  function renderLogInto(el, game, withTitle) {
    if (!el || !game) return;
    const items = logOrder(game.events).map((ev) => evItem(ev, game)).filter(Boolean);
    el.innerHTML = (withTitle ? '<div class="log-title">기록</div>' : '') +
      `<div class="log">${items.map((x) => `<div class="lg-item ${x.cls}">${x.html}</div>`).join('')}</div>`;
  }

  function renderTicker(game) {
    const items = game.events
      .filter((e) => e.type !== 'roundStart' && e.type !== 'start')
      .slice(-2)
      .reverse()
      .map((ev) => evItem(ev, game))
      .filter(Boolean);
    $('ticker').innerHTML = items.length
      ? items.map((x) => `<div class="ev">${x.html}</div>`).join('')
      : `<div class="ev">게임 시작! 총구 → ${nm(game.seats[game.aim].id)}</div>`;
  }

  $('ticker').onclick = () => { S.tab = 'log'; openSheet('sheetLog'); renderSheet(); };
  $('btnChat').onclick = () => { S.tab = 'chat'; openSheet('sheetLog'); renderSheet(); setTimeout(() => $('chatInput').focus(), 250); };
  $('sheetTabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    S.tab = t.dataset.tab;
    renderSheet();
  });

  function renderSheet() {
    if (!S.room) return;
    const game = g();
    if (!game) S.tab = 'chat';
    const open = !$('sheetLog').classList.contains('hidden');
    document.querySelector('#sheetTabs [data-tab="log"]').classList.toggle('hidden', !game);
    document.querySelectorAll('#sheetTabs .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === S.tab));
    $('logSheet').classList.toggle('hidden', S.tab !== 'log');
    $('chatSheet').classList.toggle('hidden', S.tab !== 'chat');
    $('chatForm').classList.toggle('hidden', S.tab !== 'chat');
    if (S.tab === 'log' && game) renderLogInto($('logSheet'), game, false);
    renderChat();
    if (open && S.tab === 'chat') S.chatSeenAt = Date.now();
    const unread = S.room.chat.filter((m) => !m.system && m.playerId !== meId() && m.at > S.chatSeenAt).length;
    $('chatBadge').textContent = unread;
    $('chatBadge').classList.toggle('hidden', !unread);
  }

  function renderChat() {
    const list = $('chatList');
    const body = list.closest('.sheet-body');
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    list.innerHTML = S.room.chat.length
      ? S.room.chat.map((m) => (m.system
        ? `<div class="msg sys">${esc(m.text)}</div>`
        : `<div class="msg ${m.playerId === meId() ? 'me' : ''}"><span class="who">${esc(m.from)}</span>${esc(m.text)}</div>`)).join('')
      : '<div class="empty-note">아직 조용하네요</div>';
    if (nearBottom && S.tab === 'chat') body.scrollTop = body.scrollHeight;
  }

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    emit('chat', { text }).then((r) => !r.ok && toast(r.error, true));
    input.value = '';
  });

  /* ------------------------------------------------------------ */
  /* 단말기 팝업: 약실 선택 / 조사 결과 / 조작 안내                  */
  /* ------------------------------------------------------------ */

  const DEV = { cur: null, queue: [], timer: null };

  /** 이벤트 시점의 총구 방향 (그 뒤에 회전이 있었어도 당시 기준으로 이름을 보여준다) */
  function aimAt(game, idx) {
    let aim = game.aim;
    for (let i = 0; i <= idx && i < game.events.length; i++) {
      const ev = game.events[i];
      if (ev.type === 'start' || ev.type === 'rotate') aim = ev.aim;
    }
    return aim;
  }

  function queueResult(game, ev, idx) {
    const aim = aimAt(game, idx);
    const rows = pairChs(ev.pair).map((c, i) => ({ ch: c, name: nm(game.seats[mod(aim + c, N)].id), loaded: ev.results[i] }));
    const pub = ev.type === 'publicCheck';
    const item = {
      kind: 'result',
      title: pub ? '공개 조사 결과' : '비공개 조사 결과',
      by: ev.by === meId() ? '' : `${nm(ev.by)}의 조사`,
      rows,
      auto: ev.by !== meId(), // 남의 공개 조사는 잠시 뒤 자동으로 닫힘
    };
    if (DEV.cur && DEV.cur.kind === 'select') DEV.queue.push(item);
    else if (DEV.cur) DEV.queue.push(item);
    else showDevice(item);
  }

  function openSelect(act) {
    const g0 = g();
    if (!g0) return;
    const a = actByKey[act];
    showDevice({ kind: 'select', act, picks: [], title: act === 'manipSwap' ? '조작' : a.name, cost: act === 'manipSwap' ? 0 : Number(a.cost) });
  }

  function showDevice(item) {
    clearTimeout(DEV.timer);
    DEV.cur = item;
    renderDevice();
    $('device').classList.remove('hidden');
    if (item.kind === 'result' && item.auto) DEV.timer = setTimeout(() => closeDevice(), 4500);
  }

  function closeDevice(all) {
    clearTimeout(DEV.timer);
    if (all) DEV.queue = [];
    DEV.cur = null;
    const next = DEV.queue.shift();
    if (next) return showDevice(next);
    $('device').classList.add('hidden');
  }

  function cylinderSvg(game, picks) {
    let h = `<svg class="dev-cyl" viewBox="0 0 300 300" aria-label="실린더">
      <defs><radialGradient id="dsteel" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#5a5a68"/><stop offset=".55" stop-color="#2c2c36"/><stop offset="1" stop-color="#17171e"/></radialGradient></defs>
      <circle cx="150" cy="150" r="112" fill="url(#dsteel)" stroke="#5a5a6a" stroke-width="3"/>`;
    for (let k = 0; k < N; k++) {
      const a = ((-90 + k * 60) * Math.PI) / 180;
      const x = 150 + 64 * Math.cos(a);
      const y = 150 + 64 * Math.sin(a);
      const tx = 150 + 132 * Math.cos(a);
      const ty = 150 + 132 * Math.sin(a);
      const kn = game.knowledge[k];
      const cls = ['dch', kn ? (kn.loaded ? 'loaded' : 'empty') : '', kn && kn.source === 'private' ? 'priv' : '', kn && kn.stale ? 'stale' : '', picks.includes(k) ? 'pick' : ''].join(' ');
      h += `<g class="dtab" transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) rotate(${k * 60})"><rect x="-17" y="-11" width="34" height="22" rx="4"/><text y="6" transform="rotate(${-k * 60})">${chName(k)}</text></g>`;
      h += `<g class="${cls}" data-dch="${k}"><circle class="dglow" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="33"/><circle class="dhole" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="26"/></g>`;
    }
    return h + '<circle cx="150" cy="150" r="5" fill="#0b0b10"/></svg>';
  }

  function validPair(picks) {
    if (picks.length !== 2) return null;
    const [x, y] = picks;
    if (mod(y - x, N) === 1) return x;
    if (mod(x - y, N) === 1) return y;
    return null;
  }

  function renderDevice() {
    const d = DEV.cur;
    const game = g();
    if (!d || !game) return;
    $('devTab').textContent = rawName(meId());
    $('devTitle').textContent = d.title;
    let body = '';
    let actions = '';
    if (d.kind === 'select') {
      const pair = validPair(d.picks);
      const names = d.picks.map((c) => `<b>${chName(c)}</b> ${nm(game.seats[mod(game.aim + c, N)].id)}`).join(' · ');
      const w = game.me && game.me.pendingManip ? game.me.pendingManip.wasted : 0;
      body = `${cylinderSvg(game, d.picks)}
        <div class="dev-hint">${d.picks.length === 2 && pair == null ? '<span class="warn">서로 붙어 있는 약실을 고르세요</span>'
          : d.picks.length ? names : d.act === 'manipSwap' ? '탄약을 바꿀 <b>붙어 있는 약실 2개</b>' : '조사할 <b>붙어 있는 약실 2개</b>'}</div>
        ${d.act === 'manipSwap' ? `<div class="dev-sub">⚡ 공용 풀이 찼어요${w ? ` · 초과 ${w}크레딧 소멸` : ''}</div>` : `<div class="dev-cost">Credit Cost <span class="sc">★</span>×${d.cost}</div>`}`;
      actions = `${d.act === 'manipSwap' ? '' : '<button class="btn" data-dev-cancel>취소</button>'}
        <button class="btn btn-primary btn-lg" data-dev-ok ${pair == null ? 'disabled' : ''}>선택 완료</button>`;
    } else if (d.kind === 'result') {
      body = `${d.by ? `<div class="dev-sub">${d.by}</div>` : ''}<div class="dev-rows">${d.rows.map((r) => `
        <div class="dev-row ${r.loaded ? 'hit' : ''}"><span class="hex">${chName(r.ch)}</span><span class="dn">${r.name}</span><span class="ox ${r.loaded ? 'o' : 'x'}">${r.loaded ? 'O' : 'X'}</span></div>`).join('')}</div>
        <div class="dev-legend"><span class="ox o">O</span> 총알 있음 · <span class="ox x">X</span> 빈 약실</div>`;
      actions = '<button class="btn btn-primary btn-lg" data-dev-close>확인</button>';
    } else if (d.kind === 'notice') {
      body = `<div class="dev-notice"><div class="dev-warn">!</div><div class="dev-head">${d.headline}</div><div class="dev-text">${d.text}</div></div>`;
      actions = '<button class="btn btn-lg" data-dev-close>확인</button>';
    }
    $('devBody').innerHTML = body;
    $('devActions').innerHTML = actions;
  }

  $('device').addEventListener('click', async (e) => {
    const d = DEV.cur;
    if (!d) return;
    const chEl = e.target.closest('[data-dch]');
    if (chEl && d.kind === 'select') {
      const k = Number(chEl.dataset.dch);
      const picks = d.picks;
      if (picks.includes(k)) d.picks = picks.filter((x) => x !== k);
      else if (picks.length === 0) d.picks = [k];
      else if (picks.length === 1) d.picks = validPair([picks[0], k]) != null ? [picks[0], k] : [k];
      else d.picks = [k];
      SFX.select();
      return renderDevice();
    }
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.hasAttribute('data-dev-cancel') || b.hasAttribute('data-dev-close')) return closeDevice();
    if (b.hasAttribute('data-dev-ok') && d.kind === 'select') {
      const pair = validPair(d.picks);
      if (pair == null) return;
      const action = d.act === 'manipSwap' ? { type: 'manipSwap', pair } : { type: d.act, pair };
      const res = await send(action);
      if (res && res.ok && DEV.cur === d) closeDevice();
    }
  });

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
    clearSel();
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
      if (shot.hit) { SFX.bang(); buzz([120, 40, 200]); } else { SFX.click(); buzz(20); }
      bangFx(shot.hit ? 'BANG!' : '찰칵', shot.hit);
      S.anim.timer = setTimeout(tick, shot.hit ? 1800 : 1250);
    };
    render();
    SFX.spin();
    bangFx('FIRE', false);
    S.anim.timer = setTimeout(tick, 1500);
  }

  function closeResult() { $('result').classList.add('hidden'); }

  function showResult() {
    const game = g();
    if (!game || !game.result) return;
    S.resultShown = true;
    const res = game.result;
    const dead = new Set(res.eliminated);
    const iDied = dead.has(meId());
    const order = res.shots.map((s) => s.seat);
    $('result').classList.toggle('win', !iDied);
    $('resultKicker').textContent = `ROUND ${game.round} · GAME OVER`;
    $('resultTitle').className = `result-title ${iDied ? 'dead' : 'alive'}`;
    $('resultTitle').textContent = iDied ? '탈락' : '생존';
    $('resultSub').innerHTML = `💀 ${res.eliminated.map((id) => nm(id)).join(', ')}`;
    $('resultReveal').innerHTML = res.chambers.map((b, i) => `<span class="${b ? 'y' : ''}" style="animation-delay:${i * 80}ms">${chName(i)}</span>`).join('');
    $('resultList').innerHTML = game.seats.map((s) => {
      const idx = order.indexOf(s.seat);
      return `<div class="rrow ${dead.has(s.id) ? 'dead' : ''}">
        <span>${dead.has(s.id) ? '💀' : '🟢'}</span><span class="nm">${nm(s.id)}</span>
        <span class="info">${idx >= 0 ? `${idx + 1}번째 격발` : '—'}</span><span class="cr">${s.credits}C</span></div>`;
    }).join('');
    $('resultActions').innerHTML =
      (isHost() ? '<button class="btn btn-primary btn-lg btn-block" id="btnLobby">한 판 더!</button>' : '<div class="waiting">방장이 다음 판을 준비해요<i>.</i><i>.</i><i>.</i></div>') +
      '<button class="btn btn-block" data-close-result>보드 보기</button>';
    $('result').classList.remove('hidden');
    if (iDied) SFX.lose(); else SFX.win();
  }

  $('resultActions').addEventListener('click', async (e) => {
    if (e.target.closest('[data-close-result]')) return closeResult();
    if (e.target.id === 'btnLobby') {
      const res = await emit('backToLobby');
      if (!res.ok) toast(res.error, true);
    }
  });

  /* ------------------------------------------------------------ */
  /* header / rules                                                */
  /* ------------------------------------------------------------ */

  const soundIcon = () => ($('btnSound').textContent = SFX.on ? '🔊' : '🔇');
  $('btnSound').onclick = () => { SFX.toggle(); soundIcon(); };
  soundIcon();

  $('ruleActs').innerHTML = ACTS.map((a) => `<div class="rule-act">${a.icon}<div><div class="t">${a.name}</div><div class="d">${a.desc}</div></div><span class="c">${a.cost}</span></div>`).join('');
  const info = (window.GAMES || []).find((x) => x.id === 'russian-roulette');
  $('rulesFull').innerHTML = info ? info.rules.map((r) => `<li>${r}</li>`).join('') : '';
  $('btnRules').onclick = () => openSheet('sheetRules');

  /* ------------------------------------------------------------ */
  /* start                                                         */
  /* ------------------------------------------------------------ */

  heroArt();
  showLoading('불러오는 중…');
  T.ready()
    .then(tryResume)
    .catch((e) => {
      console.error(e);
      showEntry();
      toast(e.message || '초기화 실패', true);
    });
})();
