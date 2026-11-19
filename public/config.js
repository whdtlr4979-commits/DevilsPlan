/**
 * 정적 호스팅(GitHub Pages 등) 기본 설정: P2P 모드
 *  - 방을 만든 사람의 브라우저가 게임 서버 역할을 하고, 다른 플레이어는 WebRTC 로 직접 접속한다.
 *  - 접속 중계(시그널링)는 PeerJS 무료 공용 서버(0.peerjs.com)를 사용한다.
 * Node 서버(npm start)로 실행하면 이 파일 대신 서버가 { mode: 'server' } 를 내려준다.
 *
 * peer: PeerJS 서버를 직접 운영한다면 { host, port, path, secure } 를 지정
 */
window.PLAN_CONFIG = Object.assign({ mode: 'p2p', peer: null }, window.PLAN_CONFIG);
