/**
 * 공용 게임 앱 셸 — 입장 / 대기실 / 채팅·기록 시트 / 룰 시트 / 효과음 / 토스트 / 재접속
 *
 * 각 게임은 화면(#screenGame)과 몇 가지 훅만 구현한다.
 *  PlanShell.start({
 *    gameId, peerTag, adapter, title,
 *    heroArt(svgEl),                 입장 화면 장식
 *    lobbyExtra(room, el, api),      대기실 추가 UI (예: 방 설정)
 *    onRoom(room, prev, api),        새 방 상태가 왔을 때 (효과음, 전환 감지)
 *    renderGame(room, api),          게임 화면 그리기
 *    logItems(room, api) → [{cls, html}]  기록 시트 내용 (최신순)
 *  })
 *
 * 페이지에는 러시안 룰렛과 같은 id 구조(hud, screenLoading/Entry/Lobby/Game, sheetLog, sheetRules)가 있어야 한다.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const NAME_KEY = 'plan:name';
  const SOUND_KEY = 'plan:sound';

  /* ---------------- 효과음 / 진동 ---------------- */

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
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f1, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination);
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
      const g = c.createGain();
      g.gain.value = vol;
      src.connect(f).connect(g).connect(c.destination);
      src.start(t);
    }
    return {
      tone,
      noise,
      get on() { return on; },
      toggle() { on = !on; ls.set(SOUND_KEY, on ? 'on' : 'off'); if (on) this.select(); return on; },
      unlock() { if (on) ac(); },
      select() { tone(700, 950, 0.07, 'triangle', 0.07); },
      turn() { tone(660, 0, 0.12, 'sine', 0.13); tone(990, 0, 0.2, 'sine', 0.13, 0.12); },
      coin() { tone(1300, 1800, 0.06, 'triangle', 0.08); tone(1800, 0, 0.08, 'sine', 0.05, 0.05); },
      drop() { tone(420, 220, 0.12, 'sine', 0.1); },
      reveal() { tone(320, 640, 0.14, 'sine', 0.08); },
      soft() { tone(240, 200, 0.08, 'sine', 0.06); },
      tick() { tone(1200, 0, 0.03, 'square', 0.03); },
      fanfare() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0, 0.2, 'triangle', 0.1, i * 0.1)); },
      win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0, 0.2, 'triangle', 0.1, i * 0.1)); },
      lose() { [392, 330, 262].forEach((f, i) => tone(f, f * 0.96, 0.32, 'sawtooth', 0.05, i * 0.2)); },
    };
  })();
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };
  document.addEventListener('pointerdown', () => SFX.unlock(), { once: true });

  /* ---------------- 토스트 ---------------- */

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
    void el.offsetHeight;
    el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function start(game) {
    const T = window.PlanNet.create({ gameId: game.gameId, peerTag: game.peerTag, adapter: game.adapter });
    const S = { room: null, prev: null, busy: false, tab: 'log', chatSeenAt: Date.now() };

    const meId = () => S.room && S.room.meId;
    const isHost = () => !!S.room && S.room.hostId === S.room.meId;
    const player = (id) => (S.room ? S.room.players.find((p) => p.id === id) : null);
    const nm = (id) => (id === meId() ? '나' : esc((player(id) || {}).name || '?'));
    const emit = (ev, payload) => T.request(ev, payload);

    async function act(action) {
      if (S.busy) return { ok: false };
      S.busy = true;
      const res = await emit('action', action);
      S.busy = false;
      if (!res.ok) toast(res.error, true);
      else buzz(15);
      return res;
    }

    function openSheet(id) { $(id).classList.remove('hidden'); }
    function closeSheet(id) { $(id).classList.add('hidden'); }

    const api = { $, esc, toast, SFX, buzz, emit, act, nm, meId, isHost, player, openSheet, closeSheet, get room() { return S.room; }, mode: T.mode };

    /* ---------------- 화면 전환 ---------------- */

    function showScreen(id) {
      ['screenLoading', 'screenEntry', 'screenLobby', 'screenGame'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
      const inRoom = id === 'screenLobby' || id === 'screenGame';
      $('btnLeave').classList.toggle('hidden', !inRoom);
      $('btnChat').classList.toggle('hidden', !inRoom);
      $('hudTitle').textContent = id === 'screenLobby' ? '대기실' : game.title;
      document.querySelector('.app').classList.toggle('in-game', id === 'screenGame');
    }
    function showLoading(text) {
      $('loadingText').textContent = text;
      showScreen('screenLoading');
    }
    function setUrlRoom(code) {
      const url = new URL(location.href);
      if (code) url.searchParams.set('room', code);
      else url.searchParams.delete('room');
      history.replaceState(null, '', url);
    }

    /* ---------------- 입장 ---------------- */

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
      S.prev = null;
      document.title = game.baseTitle;
      $('nameInput').value = $('nameInput').value || ls.get(NAME_KEY) || '';
      const urlCode = new URL(location.href).searchParams.get('room');
      if (urlCode) $('codeInput').value = urlCode.toUpperCase();
      document.querySelectorAll('.sheet-backdrop, .result').forEach((m) => m.classList.add('hidden'));
      if (game.onLeave) game.onLeave(api);
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
      const playing = S.room && S.room.phase === 'playing';
      const msg = T.mode === 'p2p' && isHost() ? '방을 닫고 나갈까요?' : playing ? '나가면 남은 진행은 봇이 대신해요. 나갈까요?' : '방에서 나갈까요?';
      if (!confirm(msg)) return;
      await T.leave();
      setUrlRoom(null);
      showEntry();
    };

    /* ---------------- 네트워크 이벤트 ---------------- */

    T.on('status', (d) => toast(d.message, d.state !== 'connected'));
    T.on('kicked', () => { setUrlRoom(null); toast('방장이 내보냈어요', true); showEntry(); });
    T.on('closed', (d) => { setUrlRoom(null); toast((d && d.reason) || '방이 닫혔어요', true); showEntry(); });
    T.on('room', (room) => {
      S.prev = S.room;
      S.room = room;
      if (game.onRoom) game.onRoom(room, S.prev, api);
      render();
    });

    function render() {
      if (!S.room) return showEntry();
      if (S.room.phase === 'lobby') {
        showScreen('screenLobby');
        renderLobby();
      } else {
        showScreen('screenGame');
        game.renderGame(S.room, api);
      }
      renderSheet();
    }
    api.render = render;

    /* ---------------- 대기실 ---------------- */

    function renderLobby() {
      const room = S.room;
      $('lobbyCode').textContent = room.code;
      const tiles = [];
      for (let i = 0; i < room.maxPlayers; i++) {
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
      $('slots').dataset.cols = room.maxPlayers > 6 ? 4 : 3;
      const target = Math.min(room.maxPlayers, game.adapter.fillTo(room.players.length, room.settings));
      const bots = target - room.players.length;
      const hints = [`${room.minPlayers === room.maxPlayers ? room.maxPlayers : `${room.minPlayers}~${room.maxPlayers}`}명`];
      if (bots > 0) hints.push(`시작하면 봇 ${bots}명이 채워요`);
      if (T.mode === 'p2p' && isHost()) hints.push('방장이 창을 닫으면 방이 사라져요');
      $('lobbyHint').textContent = hints.join(' · ');
      const extra = $('lobbyExtra');
      if (extra) {
        if (game.lobbyExtra) game.lobbyExtra(room, extra, api);
        else extra.innerHTML = '';
      }
      $('lobbyActions').innerHTML = isHost()
        ? `<button class="btn btn-lg" id="btnAddBot" ${room.players.length < room.maxPlayers ? '' : 'disabled'} aria-label="봇 추가">+ 🤖</button>
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
          await navigator.share({ title: game.title, text: `${game.title} 한 판? 방 코드 ${S.room.code}`, url: link });
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

    /* ---------------- 기록 / 채팅 시트 ---------------- */

    document.querySelectorAll('.sheet-backdrop').forEach((m) =>
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden');
      }),
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.sheet-backdrop').forEach((m) => m.classList.add('hidden'));
    });

    api.openLog = () => { S.tab = 'log'; openSheet('sheetLog'); renderSheet(); };
    $('btnChat').onclick = () => { S.tab = 'chat'; openSheet('sheetLog'); renderSheet(); setTimeout(() => $('chatInput').focus(), 250); };
    $('sheetTabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (!t) return;
      S.tab = t.dataset.tab;
      renderSheet();
    });

    function renderSheet() {
      if (!S.room) return;
      const hasGame = !!S.room.game;
      if (!hasGame) S.tab = 'chat';
      const open = !$('sheetLog').classList.contains('hidden');
      document.querySelector('#sheetTabs [data-tab="log"]').classList.toggle('hidden', !hasGame);
      document.querySelectorAll('#sheetTabs .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === S.tab));
      $('logSheet').classList.toggle('hidden', S.tab !== 'log');
      $('chatSheet').classList.toggle('hidden', S.tab !== 'chat');
      $('chatForm').classList.toggle('hidden', S.tab !== 'chat');
      if (S.tab === 'log' && hasGame && game.logItems) {
        $('logSheet').innerHTML = `<div class="log">${game.logItems(S.room, api).map((x) => `<div class="lg-item ${x.cls || ''}">${x.html}</div>`).join('')}</div>`;
      }
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

    /* ---------------- 헤더 ---------------- */

    const soundIcon = () => ($('btnSound').textContent = SFX.on ? '🔊' : '🔇');
    $('btnSound').onclick = () => { SFX.toggle(); soundIcon(); };
    soundIcon();
    $('btnRules').onclick = () => openSheet('sheetRules');

    /* ---------------- 시작 ---------------- */

    if (game.heroArt) game.heroArt($('heroArt'));
    showLoading('불러오는 중…');
    T.ready()
      .then(tryResume)
      .catch((e) => {
        console.error(e);
        showEntry();
        toast(e.message || '초기화 실패', true);
      });
    return api;
  }

  window.PlanShell = { start, SFX, buzz, toast, esc };
})();
