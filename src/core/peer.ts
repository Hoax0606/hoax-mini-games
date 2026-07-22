/**
 * PeerJS 래퍼 — WebRTC P2P 연결 관리
 *
 * 역할 분담:
 *   - 이 파일(peer.ts): 순수 "전송 계층". 연결 열기/닫기, 메시지 송수신만 담당.
 *   - room.ts(다음 파일): "방 로직". 비번 검증, RoomState 관리, 메시지 라우팅 등.
 *
 * 왜 이렇게 나누나?
 *   peer.ts는 PeerJS 의존성 캡슐화 + 네트워크 에러/타임아웃 처리에 집중.
 *   방 상태 같은 도메인 로직은 room.ts로 분리해야 각 층을 독립적으로 테스트·교체 가능.
 *
 * 짧은 방 코드 방식:
 *   - 사용자에게 보이는 코드: 5자 (예: "PK4M9")
 *   - 실제 PeerJS ID:          "hoaxmg-PK4M9"  (공개 브로커에서 타 앱과 충돌 방지 prefix)
 *   - 0/O/1/I/l 같이 헷갈리는 문자는 알파벳에서 제외
 */

import { Peer, type DataConnection } from 'peerjs';
import type { NetworkMessage, JoinRejectedMsg, RoomState } from '../games/types';
import { PEER_OPTIONS } from './netConfig';

// ============================================
// 방 코드 생성
// ============================================

const ROOM_CODE_LEN = 5;
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32자 (헷갈리는 문자 제외)
const PEER_ID_PREFIX = 'hoaxmg-';

// ============================================
// 창 닫힘/이탈 시 자동 정리
// ============================================
// 탭을 닫거나 다른 페이지로 이동하면 열려있는 Peer 를 전부 destroy 한다.
//   → 호스트는 상대의 conn 'close' 를 받아 나감 처리, 게스트는 방에서 빠진다.
// 이게 없으면 좀비 연결이 남아 "링크 여러 번 눌렀더니 같은 사람이 여러 명"처럼
// 보이거나, 창을 닫아도 방에 계속 남아있던 문제가 생김.
// pagehide 는 탭 닫힘/이동/모바일 백그라운드 전환을 beforeunload 보다 안정적으로 잡는다.
const livePeers = new Set<Peer>();
function registerPeer(p: Peer): void {
  livePeers.add(p);
}
function unregisterPeer(p: Peer): void {
  livePeers.delete(p);
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const p of livePeers) {
      try {
        p.destroy();
      } catch {
        /* 이미 닫힌 peer 는 무시 */
      }
    }
    livePeers.clear();
  });
}

function generateRoomCode(): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    s += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return s;
}

/** 방 코드 → 실제 PeerJS ID (대문자 통일) */
function codeToPeerId(roomCode: string): string {
  return PEER_ID_PREFIX + roomCode.toUpperCase();
}

// ============================================
// 에러 타입
// ============================================

/**
 * 연결 시도 시 발생 가능한 에러 (discriminated union).
 * UI는 kind만 보고 한국어 메시지 매핑하면 됨.
 */
export type PeerConnectError =
  | { kind: 'room_not_found' }   // 해당 방 코드로 호스트가 없음
  | { kind: 'network' }           // 브로커 연결 실패
  | { kind: 'timeout' }           // 시간 초과
  | { kind: 'unknown'; detail: string };

// ============================================
// 호스트 ↔ 게스트 공통 타입
// ============================================

export interface JoinRequest {
  nickname: string;
  password?: string;
}

/**
 * 호스트가 입장 요청에 대해 내리는 결정.
 *
 * asSpectator=true 로 수락하면 peer.ts 는 그냥 "accepted conn"으로 등록만 하고
 * 실제 "플레이어 vs 관전자" 구분은 방 로직(RoomState.players[].role) 쪽에서 한다.
 * peer 계층은 전송만 담당 — 관전자도 다른 수락된 연결과 똑같이 broadcast 대상이다.
 */
export type JoinDecision =
  | { accept: true; roomState: RoomState; asSpectator?: boolean }
  | { accept: false; reason: JoinRejectedMsg['reason'] };

// ============================================
// HostSession — 방을 여는 쪽
// ============================================

/**
 * 호스트 세션.
 *
 * 다중 연결 지원 (Phase 1-A):
 *   - 내부는 Map<peerId, DataConnection>로 여러 게스트 관리
 *   - maxAccepted 프로퍼티로 수락할 게스트 수 제어 (기본 1 = 2인 게임 호환)
 *   - `send(msg)`는 모든 수락된 게스트에게 broadcast
 *   - `sendTo(peerId, msg)`로 특정 게스트에게만 전달
 *
 * 콜백 호환성:
 *   기존 `(msg) => {...}` / `(name) => {...}` 할당은 그대로 유효.
 *   TS가 callback 인자 축소를 허용하므로 peerId 같은 추가 인자는 무시해도 됨.
 */
export class HostSession {
  readonly roomId: string;
  private peer: Peer;
  /** peerId → 수락된 conn. 다중 게스트 지원 */
  private acceptedConns = new Map<string, DataConnection>();
  /**
   * 연결이 끊긴 게스트를 바로 제거하지 않고 유예하는 타이머(peerId → timeout id).
   * 일시적 끊김이면 같은 peerId 가 재연결해와 유예를 취소하고 매끄럽게 복구된다.
   * HOST_GRACE_MS 안에 재연결 없으면 그때 진짜 나감 처리.
   */
  private pendingDisconnects = new Map<string, number>();
  /** 강퇴/자발적 퇴장 표시 — 이 peer 의 다음 close 는 유예 없이 즉시 제거 */
  private leavingPeers = new Set<string>();
  /**
   * 수락할 최대 게스트 수. 기본 1 = 방장 포함 2인 게임.
   * 생성 후 외부(createRoom)가 게임 maxPlayers 기반으로 세팅.
   */
  maxAccepted = 1;

  // ----- 콜백 (방 로직이 할당) -----

  /** 게스트가 입장 요청. 반환값으로 수락/거절 결정. fromPeerId는 출처 식별용(Phase 1+) */
  onJoinRequest: ((req: JoinRequest, fromPeerId: string) => JoinDecision) | null = null;
  /** 게스트가 수락되어 준비 완료 */
  onGuestConnected: ((nickname: string, peerId: string) => void) | null = null;
  /** 수락된 게스트로부터 메시지 수신 (join_request는 제외 — 내부 처리됨) */
  onMessage: ((msg: NetworkMessage, fromPeerId: string) => void) | null = null;
  /** 게스트 연결 끊김 (유예 후에도 재연결 안 되면 호출 = 진짜 나감) */
  onGuestDisconnected: ((peerId: string) => void) | null = null;
  /**
   * 끊겼던 게스트가 유예 시간 안에 재연결함 — 현재 방 상태를 돌려주면
   * 호스트가 그 게스트에게 join_accepted 로 재전송해 상태를 맞춘다(플레이어 목록은 그대로).
   * 방 로직(대기실/게임/결과)이 현재 RoomState 를 반환하도록 구현. 없으면 상태 재전송만 생략.
   */
  onGuestReconnected: ((peerId: string) => RoomState | null | undefined) | null = null;

  // ----- Ping (연결 상태/지연 표시용) -----
  /** peerId → 편도 핑(ms). 측정 전이거나 응답 없는 경우 entry 없음 */
  private _pings = new Map<string, number>();
  /** 게스트별 마지막 ack 수신 시각 (performance.now) — 5초 이상 없으면 끊김 간주 */
  private _lastAckAt = new Map<string, number>();
  /** ping 변화 콜백 — gameScreen 이 UI 업데이트용으로 구독 */
  onPingChanged: ((pings: ReadonlyMap<string, number>) => void) | null = null;
  private pingIntervalId: number | null = null;

  private constructor(peer: Peer, roomId: string) {
    this.peer = peer;
    this.roomId = roomId;
    registerPeer(peer); // 창 닫힘 시 자동 정리 대상 등록
    this.peer.on('connection', (conn) => this.handleIncoming(conn));
    this.peer.on('error', (err) => {
      console.warn('[host] peer error', err);
    });
    // 2초마다 모든 게스트에게 ping 날림. HostSession 수명 내내 돌고 close() 에서 정리.
    this.pingIntervalId = window.setInterval(() => this.runPingSweep(), 2000);
  }

  /** 읽기 전용 ping 맵 (gameScreen 이 참조) */
  get pings(): ReadonlyMap<string, number> {
    return this._pings;
  }

  /** 내 PeerJS ID (방장 이양/target 메시지 주소용) */
  get myPeerId(): string {
    return this.peer.id;
  }

  /**
   * 호스트 생성. 짧은 방 코드를 랜덤 생성 후 PeerJS 브로커에 등록 시도.
   * 동일 ID가 이미 쓰이고 있으면(`unavailable-id`) 다른 코드로 재시도.
   */
  static async create(maxRetries = 6): Promise<HostSession> {
    let lastError: unknown = null;
    let transientTries = 0; // 일시적 오류 재시도 횟수 (코드충돌 재시도와 분리)

    for (let i = 0; i < maxRetries; i++) {
      const roomCode = generateRoomCode();
      // 자체 PeerServer + ICE(STUN/TURN) 설정 적용 — netConfig.ts 참고
      const peer = new Peer(codeToPeerId(roomCode), PEER_OPTIONS);

      try {
        await waitForPeerOpen(peer, CONNECT_TIMEOUT_MS);
        return new HostSession(peer, roomCode);
      } catch (err) {
        lastError = err;
        peer.destroy();
        const type = (err as { type?: string })?.type;
        if (type === 'unavailable-id') {
          continue; // 코드 충돌 → 다음 코드로 즉시 재시도 (서버 응답 빠름)
        }
        // 서버 다운 등 일시적 오류는 최대 2회만 재시도 → 최악 대기 ~40초 (전엔 ~3분)
        if (isTransient(err) && transientTries < 2) {
          transientTries += 1;
          await delay(600 * transientTries);
          continue;
        }
        throw mapPeerError(err);
      }
    }

    throw mapPeerError(lastError);
  }

  /**
   * 방장 이양 전용: 이미 열려있는 Peer(원래 게스트의 peer)를 받아 그 자리에서 호스트로 배선.
   * peer.id 는 그대로라 남은 게스트들이 이미 아는 그 peerId 로 재접속할 수 있다.
   * roomId 는 표시/디렉토리용(코드-라우팅은 안 되지만 기존 멤버 유지엔 문제없음).
   */
  static adoptPeer(peer: Peer, roomId: string): HostSession {
    return new HostSession(peer, roomId);
  }

  private handleIncoming(conn: DataConnection): void {
    const fromPeerId = conn.peer;

    // 이미 방에 있는(또는 유예 중인) peerId 가 다시 붙었다 = 재연결. 새 join 이 아니라 conn 교체.
    const isReconnect = this.acceptedConns.has(fromPeerId) || this.pendingDisconnects.has(fromPeerId);

    // 주의: 예전엔 여기서 "acceptedConns >= maxAccepted" 즉시 room_full 거절 방어가 있었지만,
    // 관전자 수락을 지원하려면 방 로직(onJoinRequest)이 완전한 결정권을 가져야 해서 제거됨.
    // waitingRoom 상태면 여전히 room_full 로 거절되고, gameScreen(=playing) 상태면 spectator로 수락 가능.

    conn.on('data', (raw) => {
      const msg = raw as NetworkMessage;

      // 자발적 퇴장 신호 — 다음 close 를 유예 없이 즉시 처리하도록 표시
      if (msg.type === 'leave') {
        this.leavingPeers.add(fromPeerId);
        return;
      }

      // 수락 전: join_request만 처리
      if (!this.acceptedConns.has(fromPeerId)) {
        if (msg.type !== 'join_request') {
          // 프로토콜 위반 — 조용히 무시
          return;
        }

        const decision: JoinDecision = this.onJoinRequest
          ? this.onJoinRequest({ nickname: msg.nickname, password: msg.password }, fromPeerId)
          : { accept: false, reason: 'room_full' };

        if (decision.accept) {
          this.acceptedConns.set(fromPeerId, conn);
          safeSend(conn, { type: 'join_accepted', roomState: decision.roomState });
          this.onGuestConnected?.(msg.nickname, fromPeerId);
        } else {
          safeSend(conn, { type: 'join_rejected', reason: decision.reason });
          setTimeout(() => conn.close(), 150);
        }
        return;
      }

      // ping_ack 는 peer.ts 가 직접 소비 (게임 로직에 노출 X)
      if (msg.type === 'ping_ack') {
        const rtt = performance.now() - msg.t;
        const oneWay = Math.max(0, Math.round(rtt / 2));
        this._pings.set(fromPeerId, oneWay);
        this._lastAckAt.set(fromPeerId, performance.now());
        // 측정된 ping 을 해당 게스트에게도 알림 (게스트 UI 표시용)
        safeSend(conn, { type: 'ping_report', ms: oneWay });
        this.onPingChanged?.(this._pings);
        return;
      }
      // ping_req 는 게스트→호스트 용이 아니라 오용. 무시.
      if (msg.type === 'ping_req') return;
      // 수락된 연결의 일반 메시지 → 방 로직으로 전달
      this.onMessage?.(msg, fromPeerId);
    });

    conn.on('close', () => {
      // 이 conn 이 더 이상 그 peer 의 현재 연결이 아니면(이미 재연결로 교체됨) 무시
      if (this.acceptedConns.get(fromPeerId) !== conn) return;

      // 진짜 나감 처리(방 로직에 알림 + 정리)
      const finalize = (): void => {
        this.pendingDisconnects.delete(fromPeerId);
        this.leavingPeers.delete(fromPeerId);
        if (this.acceptedConns.get(fromPeerId) === conn) {
          this.acceptedConns.delete(fromPeerId);
          this._pings.delete(fromPeerId);
          this._lastAckAt.delete(fromPeerId);
          this.onPingChanged?.(this._pings);
          this.onGuestDisconnected?.(fromPeerId);
        }
      };

      // 강퇴/자발적 퇴장은 즉시. 그 외(끊김)는 유예 — 그 안에 재연결하면 살아남는다.
      if (this.leavingPeers.has(fromPeerId)) {
        finalize();
      } else {
        const timer = window.setTimeout(finalize, HOST_GRACE_MS);
        this.pendingDisconnects.set(fromPeerId, timer);
      }
    });

    conn.on('error', (err) => {
      console.warn('[host] conn error', err);
    });

    // 재연결이면: 유예 취소 + conn 교체 + 현재 상태 재전송(플레이어 목록은 그대로 유지 → 매끄럽게 복구)
    if (isReconnect) {
      const timer = this.pendingDisconnects.get(fromPeerId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        this.pendingDisconnects.delete(fromPeerId);
      }
      // ★ 순서 주의 ★ 새 conn 을 먼저 등록한 뒤 옛 conn 을 닫는다.
      //   반대로 하면(옛 것 먼저 close) PeerJS 가 close 를 동기로 쏠 때 옛 close 핸들러가
      //   아직 acceptedConns==옛conn 을 보고 유예 타이머를 다시 심어 좀비 타이머가 생긴다.
      const old = this.acceptedConns.get(fromPeerId);
      this.acceptedConns.set(fromPeerId, conn);
      if (old && old !== conn) {
        try { old.close(); } catch { /* 이미 닫힘 */ }
      }
      // 현재 방 상태를 room_state 로 재전송해 대기실/결과 게스트의 상태를 맞춘다.
      //   (게임 중 게스트는 room_state 를 안 보고 게임 모듈의 상태 재전송으로 복구된다)
      const rs = this.onGuestReconnected?.(fromPeerId);
      if (rs) safeSend(conn, { type: 'room_state', roomState: rs });
    }
  }

  /** 모든 수락된 게스트에게 메시지 broadcast */
  send(msg: NetworkMessage): void {
    for (const conn of this.acceptedConns.values()) {
      if (conn.open) safeSend(conn, msg);
    }
  }

  /** 특정 peerId 게스트에게만 전송 */
  sendTo(peerId: string, msg: NetworkMessage): void {
    const conn = this.acceptedConns.get(peerId);
    if (conn?.open) safeSend(conn, msg);
  }

  /** 모든 게스트에게 ping_req broadcast. 5초 이상 ack 못 받은 게스트는 ping 맵에서 제거 → 끊김 신호 */
  private runPingSweep(): void {
    const now = performance.now();
    // 5초 이상 ack 없는 peer는 "측정 불가" 상태로 간주 → 맵에서 제거
    let removed = false;
    for (const [peerId, lastAt] of this._lastAckAt) {
      if (now - lastAt > 5000 && this._pings.has(peerId)) {
        this._pings.delete(peerId);
        removed = true;
      }
    }
    if (removed) this.onPingChanged?.(this._pings);

    // 새 ping 전송
    const reqMsg: NetworkMessage = { type: 'ping_req', t: now };
    for (const conn of this.acceptedConns.values()) {
      if (conn.open) safeSend(conn, reqMsg);
    }
  }

  /** 현재 수락된 게스트 peerId 목록 (방장 이양/참가자 UI용) */
  listGuestPeerIds(): string[] {
    return Array.from(this.acceptedConns.keys());
  }

  /**
   * 특정 게스트 강퇴 — 'kicked' 안내 전송 후 연결을 끊는다.
   * 끊기면 onGuestDisconnected 가 자연히 호출돼 방 상태에서 제거된다.
   */
  kick(peerId: string): void {
    const conn = this.acceptedConns.get(peerId);
    if (!conn?.open) return;
    this.leavingPeers.add(peerId); // 강퇴는 재연결 유예 없이 즉시 제거
    safeSend(conn, { type: 'kicked' });
    // 메시지 전달 여유를 두고 끊기 (즉시 close 하면 kicked 안내가 유실될 수 있음)
    setTimeout(() => conn.close(), 150);
  }

  /** 방 종료 — 모든 연결 끊고 브로커에서 해제 */
  close(): void {
    if (this.pingIntervalId !== null) {
      window.clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    for (const timer of this.pendingDisconnects.values()) {
      window.clearTimeout(timer);
    }
    this.pendingDisconnects.clear();
    this.leavingPeers.clear();
    for (const conn of this.acceptedConns.values()) {
      conn.close();
    }
    this.acceptedConns.clear();
    this._pings.clear();
    this._lastAckAt.clear();
    unregisterPeer(this.peer);
    this.peer.destroy();
  }
}

// ============================================
// GuestSession — 방에 접속하는 쪽
// ============================================

/**
 * 게스트 세션.
 *
 * 주의: connect() 성공은 "호스트에 TCP-레벨 연결 완료"일 뿐,
 * 방 입장 수락과는 별개. 방 로직이 직접 `join_request`를 보내고 응답을 기다려야 함.
 */
export class GuestSession {
  private peer: Peer;
  private conn: DataConnection;
  /** 재연결 시 다시 붙을 호스트 PeerJS ID */
  private hostPeerId: string;
  /** 마지막으로 보낸 join_request — 재연결(특히 호스트가 이미 날 지운 경우) 시 재전송용 */
  private lastJoinRequest: NetworkMessage | null = null;
  /** close() 로 내가 의도적으로 끊었는지 — 그러면 재연결 시도 안 함 */
  private closedIntentionally = false;
  /** 재연결 시도 중 플래그(중복 방지) */
  private reconnecting = false;

  onMessage: ((msg: NetworkMessage) => void) | null = null;
  /** 유예 재연결에도 끝내 실패 = 진짜 끊김 (호출부: "방장이 나갔어요") */
  onDisconnect: (() => void) | null = null;
  /** 연결이 끊겨 재연결을 시작함 (호출부: "재연결 중" 오버레이 표시) */
  onReconnecting: (() => void) | null = null;
  /** 재연결 성공 (호출부: 오버레이 숨김) */
  onReconnected: (() => void) | null = null;

  // ----- Ping (호스트가 보고해주는 내 편도 지연 ms) -----
  /** 내 편도 ping (ms). 호스트 ping_report 로 갱신. null = 아직 측정 안 됨 */
  private _myPing: number | null = null;
  /** 마지막 ping_report 수신 시각 (performance.now). 5초 이상 지나면 끊김 간주 */
  private _lastPingAt = 0;
  onPingChanged: ((ms: number | null) => void) | null = null;
  private staleCheckId: number | null = null;

  private constructor(peer: Peer, conn: DataConnection, hostPeerId: string) {
    this.peer = peer;
    this.conn = conn;
    this.hostPeerId = hostPeerId;
    registerPeer(peer); // 창 닫힘 시 자동 정리 대상 등록

    this.attachConn(conn);
    peer.on('error', (err) => {
      console.warn('[guest] peer error', err);
    });

    // 3초마다 "최근 ping 갱신 안 됐으면 null 로 무효화" 체크
    this.staleCheckId = window.setInterval(() => {
      if (this._myPing !== null && performance.now() - this._lastPingAt > 5000) {
        this._myPing = null;
        this.onPingChanged?.(null);
      }
    }, 3000);
  }

  /** 현재 conn 에 핸들러 배선. 최초 연결/재연결 모두 이걸 통해 붙는다. */
  private attachConn(conn: DataConnection): void {
    // 재연결이면 옛 conn 의 리스너를 떼어내 stale 이벤트(중복 재연결/유령 데이터) 방지
    if (this.conn && this.conn !== conn) {
      this.conn.off('data');
      this.conn.off('close');
      this.conn.off('error');
    }
    this.conn = conn;
    conn.on('data', (raw) => {
      const msg = raw as NetworkMessage;
      // ping_req 받으면 즉시 ack 응답 (peer.ts 내부 자동)
      if (msg.type === 'ping_req') {
        safeSend(conn, { type: 'ping_ack', t: msg.t });
        return;
      }
      // ping_report — 내 편도 지연 (호스트가 계산해서 보내줌)
      if (msg.type === 'ping_report') {
        this._myPing = msg.ms;
        this._lastPingAt = performance.now();
        this.onPingChanged?.(this._myPing);
        return;
      }
      this.onMessage?.(msg);
    });
    conn.on('close', () => {
      // 내가 일부러 끊은 게 아니면 = 일시적 끊김일 수 있음 → 바로 포기 말고 재연결 시도
      if (this.closedIntentionally) return;
      void this.attemptReconnect();
    });
    conn.on('error', (err) => {
      console.warn('[guest] conn error', err);
    });
  }

  /**
   * 연결이 끊겼을 때 유예 시간(GUEST_RECONNECT_WINDOW_MS) 동안 재연결을 반복 시도.
   * 성공하면 onReconnected, 끝내 실패하면 onDisconnect(진짜 끊김).
   * 호스트도 같은 시간 유예를 두므로, 그 안에 붙으면 방에서 안 빠지고 매끄럽게 복구된다.
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting || this.closedIntentionally) return;
    this.reconnecting = true;
    this.onReconnecting?.();

    const deadline = performance.now() + GUEST_RECONNECT_WINDOW_MS;
    let wait = 500;
    while (performance.now() < deadline && !this.closedIntentionally) {
      try {
        if (this.peer.destroyed) break; // 복구 불가 — 포기
        // 브로커(시그널링) 연결부터 살리고
        await this.ensureBrokerConnected(6000);
        // 호스트에 새 데이터 연결
        const conn = this.peer.connect(this.hostPeerId, { reliable: true });
        await waitForConnOpen(this.peer, conn, 6000);
        // 성공 — 새 conn 배선. 호스트가 유예 중이면 join_accepted 로 상태를 돌려주고,
        // 호스트가 이미 날 지웠으면 join_request 재전송으로 새로 입장된다.
        this.attachConn(conn);
        if (this.lastJoinRequest) safeSend(conn, this.lastJoinRequest);
        this.reconnecting = false;
        this.onReconnected?.();
        return;
      } catch {
        await delay(wait);
        wait = Math.min(Math.round(wait * 1.5), 3000);
      }
    }

    this.reconnecting = false;
    if (!this.closedIntentionally) this.onDisconnect?.();
  }

  /** 브로커 연결이 끊겨 있으면 reconnect() 후 다시 붙을 때까지 대기(폴링). */
  private async ensureBrokerConnected(timeoutMs: number): Promise<void> {
    if (!this.peer.disconnected || this.peer.destroyed) return;
    try { this.peer.reconnect(); } catch { /* 이미 진행 중/불가 */ }
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (this.peer.destroyed) throw new Error('peer destroyed');
      if (!this.peer.disconnected) return;
      await delay(200);
    }
    throw new Error('broker reconnect timeout');
  }

  /** 현재 내 편도 ping. null = 아직 측정 전이거나 끊김 */
  get myPing(): number | null {
    return this._myPing;
  }

  /** 내 PeerJS ID — 호스트가 참가자 목록에 포함시킬 때 알아내는 용도 */
  get myPeerId(): string {
    return this.peer.id;
  }

  /**
   * 방 코드로 호스트에 연결.
   * 실패 시 PeerConnectError를 throw.
   */
  static async connect(roomCode: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<GuestSession> {
    const hostPeerId = codeToPeerId(roomCode);
    const maxAttempts = 3;
    let lastErr: unknown = null;

    // 일시적 실패(서버 콜드스타트/순간 끊김/ICE 실패)면 backoff 후 재시도 →
    //   "가끔 안 들어와짐" 완화. 방 없음(room_not_found)은 재시도해도 소용없어 즉시 포기.
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 게스트는 랜덤 id — 옵션만 넘긴다 (자체 PeerServer + ICE). netConfig.ts 참고
      const peer = new Peer(PEER_OPTIONS);
      try {
        // 1) 내 peer 가 브로커에 붙고 → 2) 호스트에 데이터 연결(reliable) → 3) 열릴 때까지 대기
        await waitForPeerOpen(peer, timeoutMs);
        const conn = peer.connect(hostPeerId, { reliable: true });
        await waitForConnOpen(peer, conn, timeoutMs);
        return new GuestSession(peer, conn, hostPeerId);
      } catch (err) {
        peer.destroy();
        lastErr = err;
        const mapped = mapPeerError(err);
        if (mapped.kind === 'room_not_found') throw mapped; // 영구 실패 — 즉시 포기
        if (!isTransient(err) || attempt === maxAttempts - 1) throw mapped;
        await delay(600 * (attempt + 1)); // 0.6s → 1.2s backoff 후 재시도
      }
    }
    throw mapPeerError(lastErr);
  }

  send(msg: NetworkMessage): void {
    // 재연결 시 재입장에 쓰려고 마지막 join_request 를 기억해 둔다
    if (msg.type === 'join_request') this.lastJoinRequest = msg;
    if (this.conn.open) {
      safeSend(this.conn, msg);
    }
  }

  /**
   * 방장 이양: 내가 새 방장이 됨. 내 기존 peer(남들이 아는 peerId)를 그대로 호스트로 승격.
   * peer 는 destroy 하지 않고 HostSession 으로 넘긴다(이후 이 GuestSession 객체는 버려짐).
   */
  promoteToHost(roomId: string): HostSession {
    this.closedIntentionally = true;       // 게스트 재연결 루프 중지
    this.reconnecting = false;
    if (this.staleCheckId !== null) { window.clearInterval(this.staleCheckId); this.staleCheckId = null; }
    try { this.conn.off('data'); this.conn.off('close'); this.conn.off('error'); } catch { /* 죽은 conn */ }
    try { this.conn.close(); } catch { /* 이미 닫힘 */ }
    return HostSession.adoptPeer(this.peer, roomId);
  }

  /**
   * 방장 이양: 재연결 대상을 새 방장(raw PeerJS id)으로 바꾸고 즉시 재시도.
   * 새 방장이 아직 승격 중이어도 attemptReconnect 가 backoff 로 계속 시도해 따라붙는다.
   */
  reconnectToNewHost(newHostPeerId: string): void {
    this.hostPeerId = newHostPeerId;
    this.closedIntentionally = false;
    this.reconnecting = false;
    void this.attemptReconnect();
  }

  close(): void {
    this.closedIntentionally = true; // 이후 conn close 이벤트에서 재연결 시도 안 함
    if (this.staleCheckId !== null) {
      window.clearInterval(this.staleCheckId);
      this.staleCheckId = null;
    }
    const teardown = (): void => {
      try { this.conn.close(); } catch { /* 이미 닫힘 */ }
      unregisterPeer(this.peer);
      try { this.peer.destroy(); } catch { /* 이미 파괴됨 */ }
    };
    // 호스트가 '일시적 끊김'이 아니라 '진짜 나감'으로 즉시 처리하도록 leave 를 알림.
    // 단, 보내자마자 peer.destroy() 하면 datachannel 이 동기로 뜯겨 leave 가 유실되므로
    // kick()/join-reject 와 동일하게 150ms 여유를 주고 정리한다(안 그러면 유령으로 12s 남음).
    if (this.conn.open) {
      safeSend(this.conn, { type: 'leave' });
      setTimeout(teardown, 150);
    } else {
      teardown();
    }
  }
}

// ============================================
// 내부 유틸
// ============================================

// 자체 PeerServer(Render 무료 티어)가 유휴 후 콜드스타트하면 30~60초 걸릴 수 있어
// 타임아웃을 넉넉히(30초) 준다. (근본 해결은 keep-alive 핑으로 서버를 안 재우는 것)
function waitForPeerOpen(peer: Peer, timeoutMs = 30_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.off('open', onOpen);
      peer.off('error', onError);
      reject({ type: 'timeout' });
    }, timeoutMs);

    const onOpen = (): void => {
      clearTimeout(timer);
      peer.off('error', onError);
      resolve();
    };
    const onError = (err: unknown): void => {
      clearTimeout(timer);
      peer.off('open', onOpen);
      reject(err);
    };

    peer.once('open', onOpen);
    peer.once('error', onError);
  });
}

function waitForConnOpen(peer: Peer, conn: DataConnection, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.off('open', onOpen);
      peer.off('error', onError);
      reject({ type: 'timeout' });
    }, timeoutMs);

    const onOpen = (): void => {
      clearTimeout(timer);
      peer.off('error', onError);
      resolve();
    };
    const onError = (err: unknown): void => {
      clearTimeout(timer);
      conn.off('open', onOpen);
      reject(err);
    };

    conn.once('open', onOpen);
    peer.once('error', onError);
  });
}

function safeSend(conn: DataConnection, msg: NetworkMessage): void {
  try {
    conn.send(msg);
  } catch (err) {
    console.warn('[peer] send failed', err);
  }
}

/** ms 만큼 쉬기 (재시도 backoff 용) */
/** 연결 시도 1회당 대기 상한(ms). 짧게 잡고 재시도해서 "연결 중" 무한 대기 방지.
 *  (서버는 keep-warm 핑으로 깨어있으므로 보통 1~2초 내 열림) */
const CONNECT_TIMEOUT_MS = 18_000;

/**
 * 게스트: 연결이 끊긴 뒤 이 시간 동안 재연결을 반복 시도. 넘으면 진짜 끊김 처리.
 * ★ 호스트 유예(HOST_GRACE_MS)보다 반드시 짧게 ★ — 그래야 게스트가 "재연결 중"인 동안은
 *   호스트가 아직 방에 자리를 남겨두고 있어 매끄럽게 복구된다. 게스트가 먼저 포기하므로,
 *   유예가 만료된 뒤 뒤늦게 재연결해 게임 중 관전자로 강등되는(좀비) 상황이 안 생긴다.
 */
const GUEST_RECONNECT_WINDOW_MS = 9_000;
/** 호스트: 게스트 conn 이 끊겨도 이 시간 동안은 방에 남겨둠(재연결 대비). 넘으면 나감 처리. */
const HOST_GRACE_MS = 12_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * "다시 시도하면 될 수도 있는" 일시적 오류인지.
 *   - 타임아웃/네트워크/소켓/서버오류 = 서버 콜드스타트·순간 끊김 등 → 재시도 가치 있음
 *   - peer-unavailable(방 없음)·unavailable-id(코드 충돌) 등은 재시도 대상 아님(호출부가 따로 처리)
 */
function isTransient(err: unknown): boolean {
  const type = (err as { type?: string })?.type ?? '';
  return type === 'timeout' || type === 'network' || type === 'disconnected'
    || type === 'socket-error' || type === 'socket-closed' || type === 'server-error';
}

/** PeerJS의 에러 객체를 우리 앱용 타입으로 매핑 */
function mapPeerError(err: unknown): PeerConnectError {
  const type = (err as { type?: string })?.type ?? '';
  switch (type) {
    case 'peer-unavailable':
      return { kind: 'room_not_found' };
    case 'network':
    case 'disconnected':
    case 'socket-error':
    case 'socket-closed':
    case 'server-error':
      return { kind: 'network' };
    case 'timeout':
      return { kind: 'timeout' };
    default:
      return { kind: 'unknown', detail: String((err as Error)?.message ?? err) };
  }
}
