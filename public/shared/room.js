/**
 * 공용 게임 방 (로비 + 게임 진행) — 게임 규칙과 전송 계층 모두와 무관
 *
 * 게임마다 '어댑터'를 넘긴다. (예: shared/russian-roulette/adapter.js)
 *  adapter = {
 *    id, minPlayers, maxPlayers,
 *    fillTo(count, settings)          시작할 때 봇으로 채울 목표 인원
 *    defaultSettings, normalizeSettings(raw)   (선택) 방장이 바꾸는 방 설정
 *    create(players, settings, now)   새 게임 상태
 *    isEnded(state)
 *    view(state, viewerId, now)       플레이어별 화면 (정보 은닉은 어댑터 책임)
 *    act(state, playerId, action, now, ctx) → {ok} | {ok:false, error}
 *    next(state, ctx)                 다음 자동 진행 {at, run() → changed?} | null (봇, 시간 초과 등)
 *    startMessage(state), endMessage(state)
 *  }
 *
 * 브라우저(P2P 호스트)와 Node 서버(Socket.IO)에서 똑같이 사용한다.
 * 클라이언트는 문자열 clientId 로 식별하며, 메시지는 send(clientId, type, data) 로 보낸다.
 *  보내는 메시지: 'room'(방 상태), 'kicked', 'closed'
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanRoom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_OPTS = {
    botDelay: 1500, // 봇이 생각하는 시간
    disconnectDelay: 8000, // 접속이 끊긴 플레이어는 이 시간 후 봇이 대신 진행
  };
  const CHAT_LIMIT = 60;
  const BOT_NAMES = ['알파봇', '베타봇', '감마봇', '델타봇', '제타봇', '오메가', '시그마', '람다봇'];
  const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const webcrypto =
    (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues && globalThis.crypto) ||
    (typeof require === 'function' ? require('crypto').webcrypto : null);

  function randInt(n) {
    const a = new Uint32Array(1);
    webcrypto.getRandomValues(a);
    return a[0] % n;
  }
  function randStr(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[randInt(chars.length)];
    return s;
  }
  const newId = () => 'p_' + randStr(16);
  const newToken = () => randStr(32);

  function randomCode(len = 4) {
    let c = '';
    for (let i = 0; i < len; i++) c += CODE_LETTERS[randInt(CODE_LETTERS.length)];
    return c;
  }

  function cleanName(name) {
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 12);
    return n || null;
  }

  const ok = (extra) => Object.assign({ ok: true }, extra);
  const fail = (error) => ({ ok: false, error });

  class Room {
    /**
     * @param {object} o
     * @param {object} o.adapter     게임 어댑터
     * @param {string} o.code
     * @param {(clientId:string, type:string, data?:any) => void} o.send
     * @param {() => void} [o.onClose]   방이 사라질 때
     * @param {() => void} [o.onChange]  상태가 바뀔 때 (저장용)
     * @param {boolean} [o.hostIsServer] P2P: 방장 브라우저가 서버이므로 방장이 나가면 방이 닫힌다
     *  그 밖의 값(botDelay, disconnectDelay, 게임별 옵션)은 어댑터의 next() 에 ctx.opts 로 전달된다.
     */
    constructor(o) {
      if (!o.adapter) throw new Error('adapter 가 필요합니다.');
      this.adapter = o.adapter;
      this.code = o.code;
      this.send = o.send;
      this.onClose = o.onClose || null;
      this.onChange = o.onChange || null;
      this.hostIsServer = !!o.hostIsServer;
      this.opts = Object.assign({}, DEFAULT_OPTS, this.adapter.defaultOpts, o);
      this.settings = Object.assign({}, this.adapter.defaultSettings);
      this.hostId = null;
      this.players = [];
      this.game = null;
      this.chat = [];
      this.gameNo = 0;
      this.endAnnounced = false;
      this.timer = null;
      this.closed = false;
      this.lastActive = Date.now();
      this.clients = new Map(); // clientId -> playerId
    }

    /* ---------------- 헬퍼 ---------------- */

    get maxPlayers() {
      return this.adapter.maxPlayers;
    }
    humans() {
      return this.players.filter((p) => !p.isBot);
    }
    findPlayer(id) {
      return this.players.find((p) => p.id === id);
    }
    playerOf(clientId) {
      return this.findPlayer(this.clients.get(clientId));
    }
    hasConnectedHumans() {
      return this.humans().some((p) => p.connected);
    }
    isPlaying() {
      return !!this.game && !this.adapter.isEnded(this.game);
    }
    phase() {
      return !this.game ? 'lobby' : this.adapter.isEnded(this.game) ? 'ended' : 'playing';
    }

    view(viewerId) {
      return {
        gameId: this.adapter.id,
        code: this.code,
        hostId: this.hostId,
        meId: viewerId,
        gameNo: this.gameNo,
        phase: this.phase(),
        minPlayers: this.adapter.minPlayers,
        maxPlayers: this.adapter.maxPlayers,
        settings: this.settings,
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          isBot: p.isBot,
          connected: p.isBot ? true : p.connected,
        })),
        game: this.game ? this.adapter.view(this.game, viewerId, Date.now()) : null,
        chat: this.chat,
      };
    }

    broadcast() {
      if (this.closed) return;
      for (const p of this.players) {
        if (!p.isBot && p.connected && p.clientId) this.send(p.clientId, 'room', this.view(p.id));
      }
      if (this.onChange) this.onChange();
    }

    systemChat(text) {
      if (!text) return;
      this.chat.push({ system: true, text, at: Date.now() });
      if (this.chat.length > CHAT_LIMIT) this.chat.shift();
    }

    ctx() {
      return {
        now: Date.now(),
        opts: this.opts,
        isBot: (id) => {
          const p = this.findPlayer(id);
          return !!p && p.isBot;
        },
        isConnected: (id) => {
          const p = this.findPlayer(id);
          return !!p && (p.isBot || p.connected);
        },
      };
    }

    /** 어댑터가 알려준 다음 자동 진행(봇 행동, 시간 초과 등)을 예약 */
    schedule() {
      clearTimeout(this.timer);
      this.timer = null;
      if (this.closed || !this.isPlaying()) return;
      const plan = this.adapter.next(this.game, this.ctx());
      if (!plan) return;
      const delay = Math.max(0, plan.at - Date.now());
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.closed || !this.isPlaying()) return;
        let changed = false;
        try {
          changed = plan.run();
        } catch (e) {
          console.error(e);
        }
        if (changed) this.changed();
        else this.schedule();
      }, delay);
    }

    changed() {
      this.lastActive = Date.now();
      if (this.game && this.adapter.isEnded(this.game) && !this.endAnnounced) {
        this.endAnnounced = true;
        this.systemChat(this.adapter.endMessage && this.adapter.endMessage(this.game));
      }
      this.broadcast();
      this.schedule();
    }

    bind(clientId, player) {
      if (player.clientId && player.clientId !== clientId) this.clients.delete(player.clientId);
      const prev = this.clients.get(clientId);
      if (prev && prev !== player.id) this.unbind(clientId);
      player.clientId = clientId;
      player.connected = true;
      this.clients.set(clientId, player.id);
    }

    unbind(clientId) {
      const p = this.playerOf(clientId);
      this.clients.delete(clientId);
      if (p && p.clientId === clientId) {
        p.clientId = null;
        p.connected = false;
      }
      return p;
    }

    removePlayer(playerId) {
      const p = this.findPlayer(playerId);
      if (p && p.clientId) this.clients.delete(p.clientId);
      this.players = this.players.filter((x) => x.id !== playerId);
      if (this.hostId === playerId) {
        if (this.hostIsServer) return this.close('방장이 방을 닫았습니다.');
        const next = this.humans().find((x) => x.connected) || this.humans()[0];
        this.hostId = next ? next.id : null;
      }
      if (!this.humans().length) this.close();
    }

    close(reason) {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.timer);
      for (const p of this.humans()) {
        if (p.connected && p.clientId) this.send(p.clientId, 'closed', { reason: reason || '방이 닫혔습니다.' });
      }
      if (this.onClose) this.onClose();
    }

    addBotPlayer() {
      const used = new Set(this.players.map((p) => p.name));
      const name = BOT_NAMES.find((b) => !used.has(b)) || `봇${this.players.length + 1}`;
      this.players.push({ id: newId(), name, isBot: true, connected: true });
    }

    startGame() {
      const target = Math.min(this.maxPlayers, this.adapter.fillTo(this.players.length, this.settings));
      while (this.players.length < target) this.addBotPlayer();
      this.gameNo += 1;
      this.game = this.adapter.create(this.players.map((p) => ({ id: p.id, name: p.name })), this.settings, Date.now());
      this.endAnnounced = false;
      this.systemChat(this.adapter.startMessage ? this.adapter.startMessage(this.game) : '게임이 시작되었습니다.');
    }

    /* ---------------- 공개 API ---------------- */

    createHost(clientId, { name, practice } = {}) {
      const n = cleanName(name);
      if (!n) return fail('닉네임을 입력하세요.');
      const player = { id: newId(), name: n, token: newToken(), isBot: false, connected: true };
      this.players.push(player);
      this.hostId = player.id;
      this.bind(clientId, player);
      this.systemChat(`${n} 님이 방을 만들었습니다.`);
      if (practice) {
        const want = this.adapter.practicePlayers || this.adapter.minPlayers;
        while (this.players.length < want) this.addBotPlayer();
        this.startGame();
      }
      this.changed();
      return ok({ code: this.code, playerId: player.id, token: player.token });
    }

    join(clientId, { name, token } = {}) {
      if (this.closed) return fail('닫힌 방입니다.');
      if (token) {
        const existing = this.players.find((p) => !p.isBot && p.token === token);
        if (existing) {
          this.bind(clientId, existing);
          this.changed();
          return ok({ code: this.code, playerId: existing.id, token: existing.token });
        }
        if (!name) return fail('이전 세션을 찾을 수 없습니다.');
      }
      const n = cleanName(name);
      if (!n) return fail('닉네임을 입력하세요.');
      if (this.isPlaying()) return fail('이미 게임이 진행 중입니다.');
      if (this.players.some((p) => p.name === n)) return fail('이미 사용 중인 닉네임입니다.');
      if (this.players.length >= this.maxPlayers) {
        const botIdx = this.players.findIndex((p) => p.isBot);
        if (botIdx < 0) return fail(`방이 가득 찼습니다. (최대 ${this.maxPlayers}명)`);
        this.players.splice(botIdx, 1); // 봇 한 명을 내보낸다
      }
      const player = { id: newId(), name: n, token: newToken(), isBot: false, connected: true };
      this.players.push(player);
      this.bind(clientId, player);
      this.systemChat(`${n} 님이 입장했습니다.`);
      this.changed();
      return ok({ code: this.code, playerId: player.id, token: player.token });
    }

    /** 접속 끊김 (재접속 가능) */
    disconnect(clientId) {
      const p = this.unbind(clientId);
      if (p) this.changed();
    }

    request(clientId, ev, payload) {
      if (this.closed) return fail('닫힌 방입니다.');
      const player = this.playerOf(clientId);
      if (!player) return fail('방에 참가하고 있지 않습니다.');
      const isHost = this.hostId === player.id;
      const playing = this.isPlaying();
      payload = payload || {};

      switch (ev) {
        case 'addBot': {
          if (!isHost) return fail('방장만 할 수 있습니다.');
          if (playing) return fail('게임 중에는 할 수 없습니다.');
          if (this.players.length >= this.maxPlayers) return fail('자리가 없습니다.');
          this.addBotPlayer();
          this.changed();
          return ok();
        }
        case 'kick': {
          if (!isHost) return fail('방장만 할 수 있습니다.');
          if (playing) return fail('게임 중에는 할 수 없습니다.');
          const target = this.findPlayer(payload.playerId);
          if (!target || target.id === player.id) return fail('대상을 찾을 수 없습니다.');
          if (!target.isBot && target.connected && target.clientId) this.send(target.clientId, 'kicked');
          this.removePlayer(target.id);
          if (!target.isBot) this.systemChat(`${target.name} 님이 강퇴되었습니다.`);
          this.changed();
          return ok();
        }
        case 'settings': {
          if (!isHost) return fail('방장만 바꿀 수 있습니다.');
          if (playing) return fail('게임 중에는 바꿀 수 없습니다.');
          const next = this.adapter.normalizeSettings ? this.adapter.normalizeSettings(payload) : null;
          if (!next) return fail('잘못된 설정입니다.');
          this.settings = next;
          this.changed();
          return ok();
        }
        case 'start': {
          if (!isHost) return fail('방장만 시작할 수 있습니다.');
          if (playing) return fail('이미 진행 중입니다.');
          this.startGame();
          this.changed();
          return ok();
        }
        case 'action': {
          if (!this.game) return fail('게임을 찾을 수 없습니다.');
          const res = this.adapter.act(this.game, player.id, payload, Date.now(), this.ctx());
          if (res.ok) this.changed();
          return res;
        }
        case 'backToLobby': {
          if (!isHost) return fail('방장만 할 수 있습니다.');
          if (!this.game || !this.adapter.isEnded(this.game)) return fail('게임이 끝난 뒤에만 가능합니다.');
          this.game = null;
          this.humans()
            .filter((p) => !p.connected)
            .forEach((p) => this.removePlayer(p.id)); // 나간 사람 정리
          if (this.closed) return ok();
          this.systemChat('대기실로 돌아왔습니다.');
          this.changed();
          return ok();
        }
        case 'chat': {
          const t = String(payload.text || '').trim().slice(0, 200);
          if (!t) return fail('메시지를 입력하세요.');
          this.chat.push({ from: player.name, playerId: player.id, text: t, at: Date.now() });
          if (this.chat.length > CHAT_LIMIT) this.chat.shift();
          this.broadcast();
          return ok();
        }
        case 'leave': {
          this.clients.delete(clientId);
          if (isHost && this.hostIsServer) {
            this.close('방장이 방을 닫았습니다.');
            return ok();
          }
          if (playing) {
            // 게임 중 이탈: 자리는 유지하고 봇이 대신 플레이
            player.connected = false;
            player.clientId = null;
            player.token = null;
            this.systemChat(`${player.name} 님이 나갔습니다. 남은 진행은 봇이 대신합니다.`);
            if (isHost) {
              const next = this.humans().find((p) => p.connected);
              if (next) this.hostId = next.id;
            }
            if (!this.hasConnectedHumans()) {
              this.close();
              return ok();
            }
          } else {
            this.systemChat(`${player.name} 님이 나갔습니다.`);
            this.removePlayer(player.id);
            if (this.closed) return ok();
          }
          this.changed();
          return ok();
        }
        default:
          return fail('알 수 없는 요청입니다.');
      }
    }

    /* ---------------- 저장 / 복원 (P2P 호스트 새로고침 대비) ---------------- */

    serialize() {
      return {
        v: 2,
        gameId: this.adapter.id,
        code: this.code,
        hostId: this.hostId,
        players: this.players.map((p) => ({ id: p.id, name: p.name, token: p.token || null, isBot: p.isBot })),
        settings: this.settings,
        game: this.game,
        chat: this.chat,
        gameNo: this.gameNo,
        endAnnounced: this.endAnnounced,
      };
    }

    static restore(data, opts) {
      const room = new Room(Object.assign({}, opts, { code: data.code }));
      room.hostId = data.hostId;
      room.players = data.players.map((p) => Object.assign({}, p, { connected: !!p.isBot, clientId: null }));
      if (data.settings) room.settings = data.settings;
      room.game = data.game;
      room.chat = data.chat || [];
      room.gameNo = data.gameNo || 0;
      room.endAnnounced = !!data.endAnnounced;
      return room;
    }
  }

  return { Room, randomCode, cleanName, BOT_NAMES };
});
