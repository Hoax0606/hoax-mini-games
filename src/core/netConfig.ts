/**
 * P2P 네트워크 설정 — 한 곳에서 관리
 *
 * 여기서 두 가지를 정한다:
 *   1. 시그널링 서버 (PeerJS broker) — "방 코드로 서로를 찾아주는" 중개 서버.
 *      기본값(무료 공용 0.peerjs.com)이 자주 죽거나 느려서 "연결 중"에서 멈추는
 *      주범이었음 → 우리가 직접 띄운 PeerServer 를 쓰도록 host 를 지정한다.
 *   2. ICE 서버 (STUN/TURN) — 실제 영상/데이터가 지나가는 WebRTC 경로를 뚫는 서버.
 *      시그널링과는 별개다. NAT/방화벽(회사망·모바일) 뒤에서도 연결되게 해준다.
 *        - STUN: 내 공인 IP 를 알아내는 용도 (가벼움, 대부분의 가정용 NAT 해결)
 *        - TURN: STUN 으로도 못 뚫는 경우 트래픽을 중계 (무거움, 최후 수단)
 *
 * TS 참고: 아래 PEER_OPTIONS 는 peerjs 의 `PeerOptions` 타입이다.
 *   `new Peer(id, PEER_OPTIONS)` 처럼 두 번째 인자로 넘긴다.
 */

import type { PeerJSOption } from 'peerjs';

/**
 * 우리가 직접 배포한 PeerServer 주소.
 *
 * 배포 전(로컬 개발)엔 비워두면 됨 → 그러면 PeerJS 기본 공용 서버로 fallback.
 * 배포 후엔 아래 DEFAULT_PEER_HOST 를 실제 주소로 바꾸거나,
 * 빌드 시 환경변수 VITE_PEER_HOST 로 주입하면 된다. (예: peerserver/README.md 참고)
 *
 * 형식: 순수 호스트명만. "https://" 나 끝 슬래시 붙이지 말 것.
 *   예) 'hoax-peerserver.onrender.com'
 */
const DEFAULT_PEER_HOST = 'hoax-mini-games.onrender.com';

/** 빌드 환경변수 우선, 없으면 위 기본값 */
const PEER_HOST: string =
  (import.meta.env.VITE_PEER_HOST as string | undefined)?.trim() || DEFAULT_PEER_HOST;

/** PeerServer 에 설정한 경로. peerserver/index.js 의 path 와 반드시 일치해야 함. */
const PEER_PATH = '/hoaxmg';

/**
 * ICE 서버 목록.
 *   - STUN: 공개 서버 여러 개 (무료, 인증 불필요). 대부분의 가정용 NAT 는 STUN 만으로 뚫린다.
 *   - TURN: 무가입 무료 TURN(openrelay 등)은 남용으로 다 죽어서 제거했다.
 *     엄격한 NAT(모바일·회사망·대칭형 공유기) 뒤 사용자를 커버하려면 진짜 TURN 이 필요하며,
 *     metered.ca / Cloudflare 무료 키를 발급받아 아래 빌드 환경변수로 주입한다:
 *       VITE_TURN_URL   예) turn:standard.relay.metered.ca:443
 *       VITE_TURN_USER  발급받은 username
 *       VITE_TURN_CRED  발급받은 credential
 *     (GitHub 저장소 Secrets 에 넣고 deploy 워크플로에서 env 로 전달하면 코드 수정 불필요)
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },
];

// 진짜 TURN 은 환경변수로 주입될 때만 추가 (무료 키 발급 후). 없으면 STUN 만으로 동작.
const TURN_URL = (import.meta.env.VITE_TURN_URL as string | undefined)?.trim();
const TURN_USER = (import.meta.env.VITE_TURN_USER as string | undefined)?.trim();
const TURN_CRED = (import.meta.env.VITE_TURN_CRED as string | undefined)?.trim();
if (TURN_URL && TURN_USER && TURN_CRED) {
  ICE_SERVERS.push({ urls: TURN_URL, username: TURN_USER, credential: TURN_CRED });
}

/**
 * PeerJS 생성 옵션.
 *
 * PEER_HOST 가 비어있으면(로컬/미배포) host 관련 필드를 빼서 PeerJS 기본 서버를 쓴다.
 * 어느 경우든 iceServers 는 항상 적용한다 (NAT 뚫기).
 */
export const PEER_OPTIONS: PeerJSOption = PEER_HOST
  ? {
      host: PEER_HOST,
      port: 443,
      secure: true, // https 배포라 wss 필요
      path: PEER_PATH,
      config: { iceServers: ICE_SERVERS },
    }
  : {
      config: { iceServers: ICE_SERVERS },
    };
