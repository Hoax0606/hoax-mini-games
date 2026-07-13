/**
 * Hoax Minigames 전용 PeerJS 시그널링 서버
 *
 * 왜 필요한가:
 *   PeerJS 기본 무료 공용 서버(0.peerjs.com)가 자주 느리거나 죽어서
 *   "연결 중"에서 멈추는 문제가 잦았음 → 우리 서버를 직접 띄워 안정화.
 *
 * 역할:
 *   방 코드로 두 피어를 "소개"만 해준다(시그널링). 실제 게임 데이터는
 *   여기를 거치지 않고 P2P(WebRTC)로 직접 오간다. 그래서 서버 부하 거의 없음
 *   → 무료 티어(Render/Railway 등)로 충분.
 *
 * 클라이언트 쪽 대응:
 *   src/core/netConfig.ts 의 PEER_HOST / PEER_PATH 가 여기 host/path 와 일치해야 함.
 */

import { PeerServer } from 'peer';

// Render/Railway 등은 PORT 를 환경변수로 주입한다. 로컬은 9000.
const port = Number(process.env.PORT) || 9000;

// 클라이언트(netConfig.ts)의 PEER_PATH 와 반드시 동일하게.
const path = process.env.PEER_PATH || '/hoaxmg';

const server = PeerServer({
  port,
  path,
  // 호스팅 플랫폼의 리버스 프록시(HTTPS 종단) 뒤에 있음을 알림 → 올바른 클라이언트 IP 인식
  proxied: true,
  // 좀비 연결 정리: 60초마다 살아있는지 확인, 15초 무응답이면 끊음
  alive_timeout: 60000,
  expire_timeout: 5000,
});

server.on('connection', (client) => {
  console.log(`[peerserver] connected: ${client.getId()}`);
});
server.on('disconnect', (client) => {
  console.log(`[peerserver] disconnected: ${client.getId()}`);
});

console.log(`[peerserver] listening on :${port}${path}`);
