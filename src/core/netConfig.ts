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
const DEFAULT_PEER_HOST = '';

/** 빌드 환경변수 우선, 없으면 위 기본값 */
const PEER_HOST: string =
  (import.meta.env.VITE_PEER_HOST as string | undefined)?.trim() || DEFAULT_PEER_HOST;

/** PeerServer 에 설정한 경로. peerserver/index.js 의 path 와 반드시 일치해야 함. */
const PEER_PATH = '/hoaxmg';

/**
 * ICE 서버 목록.
 *   - STUN 은 Google 공개 서버 (안정적, 무료, 인증 불필요)
 *   - TURN 은 Open Relay Project 무료 서버. 인증 크레덴셜이 바뀔 수 있으니
 *     연결이 여전히 안 되면 https://www.metered.ca/tools/openrelay 에서 최신 값 확인.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

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
