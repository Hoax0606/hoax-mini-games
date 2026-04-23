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

// ============================================
// 방 코드 생성
// ============================================

const ROOM_CODE_LEN = 5;
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32자 (헷갈리는 문자 제외)
const PEER_ID_PREFIX = 'hoaxmg-';

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

/** 호스트가 입장 요청에 대해 내리는 결정 */
export type JoinDecision =
  | { accept: true; roomState: RoomState }
  | { accept: false; reason: JoinRejectedMsg['reason'] };

// ============================================
// HostSession — 방을 여는 쪽
// ============================================

/**
 * 호스트 세션.
 * - create()로 생성하면 짧은 방 코드가 할당됨
 * - 게스트가 연결 요청하면 onJoinRequest 콜백으로 방 로직에 판단 위임
 * - 수락되면 이후 메시지는 onMessage로 전달됨
 *
 * 이 세션은 동시에 **게스트 한 명만** 수락한다. 이미 수락된 상태에서 오는
 * 다른 연결은 즉시 'room_full'로 거절하고 끊는다.
 */
export class HostSession {
  readonly roomId: string;
  private peer: Peer;
  private acceptedConn: DataConnection | null = null;

  // ----- 콜백 (방 로직이 할당) -----

  /** 게스트가 입장 요청. 반환값으로 수락/거절 결정 */
  onJoinRequest: ((req: JoinRequest) => JoinDecision) | null = null;
  /** 게스트가 수락되어 준비 완료 */
  onGuestConnected: ((nickname: string) => void) | null = null;
  /** 수락된 게스트로부터 메시지 수신 (join_request는 제외 — 내부 처리됨) */
  onMessage: ((msg: NetworkMessage) => void) | null = null;
  /** 게스트 연결 끊김 */
  onGuestDisconnected: (() => void) | null = null;

  private constructor(peer: Peer, roomId: string) {
    this.peer = peer;
    this.roomId = roomId;
    this.peer.on('connection', (conn) => this.handleIncoming(conn));
    this.peer.on('error', (err) => {
      console.warn('[host] peer error', err);
    });
  }

  /**
   * 호스트 생성. 짧은 방 코드를 랜덤 생성 후 PeerJS 브로커에 등록 시도.
   * 동일 ID가 이미 쓰이고 있으면(`unavailable-id`) 다른 코드로 재시도.
   */
  static async create(maxRetries = 6): Promise<HostSession> {
    let lastError: unknown = null;

    for (let i = 0; i < maxRetries; i++) {
      const roomCode = generateRoomCode();
      const peer = new Peer(codeToPeerId(roomCode));

      try {
        await waitForPeerOpen(peer);
        return new HostSession(peer, roomCode);
      } catch (err) {
        lastError = err;
        peer.destroy();
        const type = (err as { type?: string })?.type;
        if (type !== 'unavailable-id') {
          // 네트워크 등 다른 에러 — 즉시 포기
          throw mapPeerError(err);
        }
        // ID 충돌이면 다음 코드로 재시도
      }
    }

    throw mapPeerError(lastError);
  }

  private handleIncoming(conn: DataConnection): void {
    // 이미 게스트 수락된 상태 — 새 연결은 즉시 거절
    if (this.acceptedConn) {
      conn.on('open', () => {
        safeSend(conn, { type: 'join_rejected', reason: 'room_full' });
        setTimeout(() => conn.close(), 150);
      });
      return;
    }

    conn.on('data', (raw) => {
      const msg = raw as NetworkMessage;

      // 아직 수락 전 상태라면 join_request만 처리
      if (this.acceptedConn !== conn) {
        if (msg.type !== 'join_request') {
          // 프로토콜 위반 — 조용히 무시
          return;
        }

        const decision: JoinDecision = this.onJoinRequest
          ? this.onJoinRequest({ nickname: msg.nickname, password: msg.password })
          : { accept: false, reason: 'room_full' };

        if (decision.accept) {
          this.acceptedConn = conn;
          safeSend(conn, { type: 'join_accepted', roomState: decision.roomState });
          this.onGuestConnected?.(msg.nickname);
        } else {
          safeSend(conn, { type: 'join_rejected', reason: decision.reason });
          // 상대가 메시지를 받고 닫을 시간 여유
          setTimeout(() => conn.close(), 150);
        }
        return;
      }

      // 수락된 연결의 일반 메시지 → 방 로직으로 전달
      this.onMessage?.(msg);
    });

    conn.on('close', () => {
      if (this.acceptedConn === conn) {
        this.acceptedConn = null;
        this.onGuestDisconnected?.();
      }
    });

    conn.on('error', (err) => {
      console.warn('[host] conn error', err);
    });
  }

  /** 게스트에게 메시지 전송. 연결이 없거나 아직 안 열려 있으면 조용히 무시 */
  send(msg: NetworkMessage): void {
    if (this.acceptedConn?.open) {
      safeSend(this.acceptedConn, msg);
    }
  }

  /** 방 종료 — 연결 끊고 브로커에서 해제 */
  close(): void {
    this.acceptedConn?.close();
    this.acceptedConn = null;
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

  onMessage: ((msg: NetworkMessage) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  private constructor(peer: Peer, conn: DataConnection) {
    this.peer = peer;
    this.conn = conn;

    conn.on('data', (raw) => {
      this.onMessage?.(raw as NetworkMessage);
    });
    conn.on('close', () => {
      this.onDisconnect?.();
    });
    conn.on('error', (err) => {
      console.warn('[guest] conn error', err);
    });
    peer.on('error', (err) => {
      console.warn('[guest] peer error', err);
    });
  }

  /**
   * 방 코드로 호스트에 연결.
   * 실패 시 PeerConnectError를 throw.
   */
  static async connect(roomCode: string, timeoutMs = 10_000): Promise<GuestSession> {
    const hostPeerId = codeToPeerId(roomCode);
    const peer = new Peer();

    // 1) 내 peer 자체가 브로커에 붙을 때까지 대기
    try {
      await waitForPeerOpen(peer, timeoutMs);
    } catch (err) {
      peer.destroy();
      throw mapPeerError(err);
    }

    // 2) 호스트에 데이터 연결 생성 (reliable=true: 순서보장+재전송)
    const conn = peer.connect(hostPeerId, { reliable: true });

    // 3) 연결이 열릴 때까지 대기. 방이 없으면 peer 'error'로 peer-unavailable 이벤트가 옴.
    try {
      await waitForConnOpen(peer, conn, timeoutMs);
    } catch (err) {
      peer.destroy();
      throw mapPeerError(err);
    }

    return new GuestSession(peer, conn);
  }

  send(msg: NetworkMessage): void {
    if (this.conn.open) {
      safeSend(this.conn, msg);
    }
  }

  close(): void {
    this.conn.close();
    this.peer.destroy();
  }
}

// ============================================
// 내부 유틸
// ============================================

function waitForPeerOpen(peer: Peer, timeoutMs = 10_000): Promise<void> {
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
