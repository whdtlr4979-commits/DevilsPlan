/**
 * 네트워크 계층 — 화면 코드(rr.js)는 이 인터페이스만 사용한다.
 *
 *  ready()                  라이브러리 로드/연결
 *  create({name, practice}) 방 만들기 → {ok, code, token}
 *  join({code, name, token})
 *  resume(urlCode)          저장된 세션으로 재접속
 *  request(ev, payload)     addBot / kick / start / action / backToLobby / chat
 *  leave()
 *  on('room' | 'kicked' | 'closed' | 'status', cb)
 *
 * 모드
 *  - server : Node 서버(Socket.IO). `npm start` 로 실행했을 때
 *  - p2p    : 정적 호스팅(GitHub Pages). 방장 브라우저가 Room(공용 로직)을 직접 돌리고
 *             다른 플레이어는 PeerJS(WebRTC 데이터 채널)로 방장에게 접속한다.
 */
(function () {
  'use strict';

  const CONFIG = window.PLAN_CONFIG || { mode: 'p2p' };
  const MODE = CONFIG.mode === 'server' ? 'server' : 'p2p';
  const SESSION_KEY = 'plan:rr:session:' + MODE;
  const HOST_ROOM_KEY = 'plan:rr:hostroom';
  const PEER_PREFIX = 'devilsplan-rr-v1-';
  const PEERJS_SRC = '../../vendor/peerjs-1.5.4.min.js';

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`스크립트를 불러오지 못했습니다: ${src}`));
      document.head.appendChild(s);
    });
  }

  class Emitter {
    constructor() { this.handlers = {}; }
    on(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
    emit(type, data) { (this.handlers[type] || []).forEach((fn) => fn(data)); }
  }

  /* ================================================================ */
  /* server (Socket.IO)                                                */
  /* ================================================================ */

  class ServerTransport extends Emitter {
    constructor() {
      super();
      this.mode = 'server';
      this.session = null;
    }

    async ready() {
      if (!window.io) await loadScript('/socket.io/socket.io.js');
      const socket = (this.socket = window.io('/russian-roulette'));
      socket.on('room', (d) => this.emit('room', d));
      socket.on('kicked', () => { this.drop(); this.emit('kicked'); });
      socket.on('closed', (d) => { this.drop(); this.emit('closed', d); });
      socket.on('disconnect', () => {
        if (this.session) this.emit('status', { state: 'reconnecting', message: '서버와 연결이 끊겼습니다. 재연결 중…' });
      });
      let first = true;
      socket.on('connect', async () => {
        if (first) return void (first = false);
        if (!this.session) return;
        const r = await this.join({ code: this.session.code, token: this.session.token });
        if (r.ok) this.emit('status', { state: 'connected', message: '다시 연결되었습니다.' });
        else { this.drop(); this.emit('closed', { reason: r.error }); }
      });
      if (!socket.connected) await new Promise((r) => socket.once('connect', r));
    }

    call(ev, payload) {
      return new Promise((resolve) => this.socket.emit(ev, payload, (r) => resolve(r || { ok: true })));
    }
    save(res) {
      if (res.ok) ls.set(SESSION_KEY, (this.session = { code: res.code, token: res.token }));
      return res;
    }
    drop() { this.session = null; ls.del(SESSION_KEY); }

    async create(p) { return this.save(await this.call('create', p)); }
    async join(p) { return this.save(await this.call('join', p)); }
    request(ev, p) { return this.call(ev, p); }
    async leave() { const r = await this.call('leave'); this.drop(); return r; }
    async resume(urlCode) {
      const s = ls.get(SESSION_KEY);
      if (!s || (urlCode && urlCode !== s.code)) return { ok: false };
      const r = await this.join({ code: s.code, token: s.token });
      if (!r.ok) this.drop();
      return r;
    }
  }

  /* ================================================================ */
  /* p2p (PeerJS / WebRTC)                                             */
  /* ================================================================ */

  function peerErrorText(e) {
    switch (e && e.type) {
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        return 'P2P 중계 서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.';
      case 'browser-incompatible':
        return '이 브라우저는 WebRTC(P2P)를 지원하지 않습니다.';
      case 'unavailable-id':
        return '방 코드가 아직 사용 중입니다. 잠시 후 다시 시도하세요.';
      case 'peer-unavailable':
        return '방을 찾을 수 없습니다. 코드를 확인하거나 방장이 접속 중인지 확인하세요.';
      case 'timeout':
        return '연결 시간이 초과되었습니다. 네트워크 환경에 따라 P2P 연결이 막혀 있을 수 있습니다.';
      default:
        return `연결 오류 (${(e && (e.type || e.message)) || '알 수 없음'})`;
    }
  }

  class P2PTransport extends Emitter {
    constructor() {
      super();
      this.mode = 'p2p';
      this.peer = null;
      this.role = null; // 'host' | 'guest'
      this.room = null; // host 전용
      this.practice = false;
      this.conns = new Map(); // host: clientId -> DataConnection
      this.conn = null; // guest: 방장과의 연결
      this.pending = new Map();
      this.seq = 0;
      this.session = null;
      this.leaving = false;
      this.reconnecting = false;
      this.retryTimer = null;
    }

    async ready() {
      if (!window.Peer) await loadScript(PEERJS_SRC);
      if (!window.RRRoom) throw new Error('게임 로직을 불러오지 못했습니다.');
      window.addEventListener('beforeunload', () => {
        if (this.peer && !this.peer.destroyed) this.peer.destroy(); // ID 를 즉시 반납 → 새로고침 후 같은 코드로 복구
      });
    }

    peerOptions() {
      const o = { debug: 1 };
      const dev = new URLSearchParams(location.search).get('peer'); // 개발용: ?peer=localhost:9000
      if (dev) {
        const [host, port] = dev.split(':');
        Object.assign(o, { host, port: Number(port) || 9000, path: '/', secure: false });
      } else if (CONFIG.peer) Object.assign(o, CONFIG.peer);
      return o;
    }

    newPeer(id) {
      return new Promise((resolve, reject) => {
        const peer = id ? new window.Peer(id, this.peerOptions()) : new window.Peer(this.peerOptions());
        const timer = setTimeout(() => { peer.destroy(); reject({ type: 'timeout' }); }, 12000);
        peer.once('open', () => {
          clearTimeout(timer);
          peer.on('disconnected', () => setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500));
          peer.on('error', (e) => console.warn('[peer]', e.type, e.message));
          resolve(peer);
        });
        peer.once('error', (e) => { clearTimeout(timer); peer.destroy(); reject(e); });
      });
    }

    saveSession(s) { ls.set(SESSION_KEY, (this.session = s)); }
    drop() { this.session = null; ls.del(SESSION_KEY); }

    /* ---------------- host ---------------- */

    hostSend = (clientId, type, data) => {
      if (clientId === 'local') {
        setTimeout(() => {
          if (type !== 'room') {
            if (this.leaving) return;
            this.drop();
          }
          this.emit(type, data);
        }, 0);
        return;
      }
      const c = this.conns.get(clientId);
      if (c && c.open) {
        try { c.send({ t: type, data }); } catch (e) { console.warn('send failed', e); }
      }
    };

    makeRoom(code, saved) {
      let room = null;
      const opts = {
        code,
        send: this.hostSend,
        hostIsServer: true,
        onChange: () => this.persistHost(),
        onClose: () => {
          ls.del(HOST_ROOM_KEY);
          // 'closed' 메시지가 참가자에게 전달될 시간을 준 뒤 정리 (그 사이 새 방을 만들었다면 건드리지 않음)
          setTimeout(() => this.room === room && this.teardown(), 600);
        },
      };
      room = saved ? window.RRRoom.Room.restore(saved, opts) : new window.RRRoom.Room(opts);
      return room;
    }

    persistHost() {
      if (this.room && !this.room.closed) ls.set(HOST_ROOM_KEY, { practice: this.practice, data: this.room.serialize() });
    }

    attachHostPeer(peer) {
      this.peer = peer;
      peer.on('connection', (c) => {
        const clientId = 'c_' + Math.random().toString(36).slice(2, 10);
        c.on('open', () => this.conns.set(clientId, c));
        c.on('data', (msg) => {
          if (!msg || msg.t !== 'req' || !this.room) return;
          let res;
          try {
            if (msg.ev === 'join') res = this.room.join(clientId, msg.payload || {});
            else if (msg.ev === 'create') res = { ok: false, error: '잘못된 요청입니다.' };
            else res = this.room.request(clientId, msg.ev, msg.payload);
          } catch (e) {
            console.error(e);
            res = { ok: false, error: '처리 중 오류가 발생했습니다.' };
          }
          try { c.send({ t: 'res', id: msg.id, res }); } catch {}
        });
        const gone = () => {
          if (this.conns.get(clientId) !== c) return;
          this.conns.delete(clientId);
          if (this.room && !this.room.closed) this.room.disconnect(clientId);
        };
        c.on('close', gone);
        c.on('error', gone);
      });
    }

    async openHostPeer(code, retryUnavailableMs = 0) {
      const deadline = Date.now() + retryUnavailableMs;
      for (;;) {
        try {
          return await this.newPeer(PEER_PREFIX + code);
        } catch (e) {
          if (e.type === 'unavailable-id' && Date.now() < deadline) {
            await sleep(2000);
            continue;
          }
          throw e;
        }
      }
    }

    async create({ name, practice } = {}) {
      this.teardown();
      if (!window.RRRoom.cleanName(name)) return { ok: false, error: '닉네임을 입력하세요.' };
      this.practice = !!practice;
      let code;
      let peer = null;
      if (practice) {
        code = window.RRRoom.randomCode(); // 연습은 혼자 하므로 네트워크 불필요
      } else {
        for (let i = 0; ; i++) {
          code = window.RRRoom.randomCode();
          try {
            peer = await this.openHostPeer(code);
            break;
          } catch (e) {
            if (e.type === 'unavailable-id' && i < 4) continue;
            return { ok: false, error: peerErrorText(e) };
          }
        }
      }
      this.role = 'host';
      this.leaving = false;
      this.room = this.makeRoom(code);
      if (peer) this.attachHostPeer(peer);
      const res = this.room.createHost('local', { name, practice });
      if (res.ok) this.saveSession({ code, token: res.token, role: 'host' });
      return res;
    }

    /* ---------------- guest ---------------- */

    async ensureGuestPeer() {
      if (this.peer && !this.peer.destroyed) return this.peer;
      this.peer = await this.newPeer();
      return this.peer;
    }

    connectTo(code) {
      return new Promise((resolve, reject) => {
        const peer = this.peer;
        const c = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        const cleanup = () => { clearTimeout(timer); peer.off('error', onErr); };
        const onErr = (e) => {
          if (e.type === 'peer-unavailable') { cleanup(); reject(e); }
        };
        const timer = setTimeout(() => { cleanup(); try { c.close(); } catch {} reject({ type: 'timeout' }); }, 15000);
        peer.on('error', onErr);
        c.on('open', () => { cleanup(); resolve(c); });
        c.on('error', (e) => { cleanup(); reject(e); });
      });
    }

    bindGuestConn(c) {
      this.conn = c;
      c.on('data', (msg) => {
        if (!msg) return;
        if (msg.t === 'res') {
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg.res); }
        } else if (msg.t === 'room') {
          this.emit('room', msg.data);
        } else if (msg.t === 'kicked' || msg.t === 'closed') {
          this.drop();
          this.closeConn();
          this.emit(msg.t, msg.data);
        }
      });
      c.on('close', () => {
        if (this.conn !== c) return;
        this.conn = null;
        this.failPending();
        if (this.session && this.role === 'guest') this.startReconnect();
      });
    }

    guestCall(ev, payload) {
      return new Promise((resolve) => {
        if (!this.conn || !this.conn.open) return resolve({ ok: false, error: '방장과 연결되어 있지 않습니다.' });
        const id = ++this.seq;
        const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: '방장의 응답이 없습니다.' }); }, 10000);
        this.pending.set(id, { resolve, timer });
        this.conn.send({ t: 'req', id, ev, payload });
      });
    }

    failPending() {
      this.pending.forEach((p) => { clearTimeout(p.timer); p.resolve({ ok: false, error: '연결이 끊겼습니다.' }); });
      this.pending.clear();
    }

    closeConn() {
      const c = this.conn;
      this.conn = null;
      if (c) try { c.close(); } catch {}
    }

    async join({ code, name, token } = {}) {
      code = String(code || '').toUpperCase().trim();
      if (this.role === 'host') this.teardown();
      this.role = 'guest';
      let c;
      try {
        await this.ensureGuestPeer();
        c = await this.connectTo(code);
      } catch (e) {
        return { ok: false, error: peerErrorText(e), network: true };
      }
      if (this.conn && this.conn !== c) this.closeConn();
      this.bindGuestConn(c);
      const res = await this.guestCall('join', { code, name, token });
      if (res.ok) this.saveSession({ code, token: res.token, role: 'guest' });
      else this.closeConn();
      return res;
    }

    startReconnect() {
      if (this.reconnecting) return;
      this.reconnecting = true;
      this.emit('status', { state: 'reconnecting', message: '방장과 연결이 끊겼습니다. 재연결 중…' });
      let tries = 0;
      const attempt = async () => {
        if (!this.session || this.role !== 'guest') return void (this.reconnecting = false);
        tries++;
        const r = await this.join({ code: this.session.code, token: this.session.token });
        if (r.ok) {
          this.reconnecting = false;
          this.emit('status', { state: 'connected', message: '다시 연결되었습니다.' });
          return;
        }
        if (!r.network || tries >= 20) {
          this.reconnecting = false;
          this.drop();
          this.emit('closed', { reason: '방장과 연결할 수 없습니다. 방이 닫혔을 수 있습니다.' });
          return;
        }
        this.retryTimer = setTimeout(attempt, 3000);
      };
      this.retryTimer = setTimeout(attempt, 1500);
    }

    /* ---------------- 공통 ---------------- */

    async request(ev, payload) {
      if (this.role === 'host') {
        if (!this.room || this.room.closed) return { ok: false, error: '방이 없습니다.' };
        return this.room.request('local', ev, payload);
      }
      return this.guestCall(ev, payload);
    }

    async leave() {
      let r = { ok: true };
      if (this.role === 'host' && this.room) {
        this.leaving = true;
        r = this.room.request('local', 'leave'); // 방이 닫히고 참가자에게 'closed' 전송
        ls.del(HOST_ROOM_KEY);
      } else if (this.role === 'guest') {
        const s = this.session;
        this.session = null; // 재연결 막기
        if (s) r = await this.guestCall('leave');
        this.closeConn();
      }
      this.drop();
      return r;
    }

    async resume(urlCode) {
      const s = ls.get(SESSION_KEY);
      if (!s || (urlCode && urlCode !== s.code)) return { ok: false };

      if (s.role === 'host') {
        const saved = ls.get(HOST_ROOM_KEY);
        if (!saved || !saved.data || saved.data.code !== s.code) {
          this.drop();
          return { ok: false };
        }
        this.practice = !!saved.practice;
        let peer = null;
        if (!this.practice) {
          try {
            peer = await this.openHostPeer(s.code, 20000); // 이전 탭의 ID 가 반납될 때까지 대기
          } catch (e) {
            this.drop();
            ls.del(HOST_ROOM_KEY);
            return { ok: false, error: peerErrorText(e) };
          }
        }
        this.role = 'host';
        this.leaving = false;
        this.room = this.makeRoom(s.code, saved.data);
        if (peer) this.attachHostPeer(peer);
        const res = this.room.join('local', { token: s.token });
        if (!res.ok) this.drop();
        else this.session = s;
        return res;
      }

      const r = await this.join({ code: s.code, token: s.token });
      if (!r.ok) this.drop();
      return r;
    }

    teardown() {
      clearTimeout(this.retryTimer);
      this.reconnecting = false;
      this.failPending();
      this.closeConn();
      this.conns.forEach((c) => { try { c.close(); } catch {} });
      this.conns.clear();
      if (this.room && !this.room.closed) {
        this.leaving = true; // 로컬로 'closed' 이벤트를 보내지 않음
        this.room.onClose = null;
        this.room.close();
      }
      this.room = null;
      if (this.peer && !this.peer.destroyed) this.peer.destroy();
      this.peer = null;
      this.role = null;
    }
  }

  window.RRNet = {
    mode: MODE,
    create: () => (MODE === 'server' ? new ServerTransport() : new P2PTransport()),
  };
})();
