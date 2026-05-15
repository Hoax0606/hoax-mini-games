/**
 * 공개방 디렉토리 — Firebase Realtime Database 기반.
 *
 * 역할:
 *   서버리스 P2P 환경에서 "지금 열려있는 공개방 목록" 이라는 글로벌 상태를 공유.
 *   호스트는 방 만들 때 publish, 게스트는 listPublic 으로 보고 입장.
 *   PeerJS 의 실제 연결은 그대로 P2P 라 Firebase 는 "이름표 등록판" 역할만 한다.
 *
 * 안전 장치:
 *   - firebase.config.ts 가 비어있으면 모든 함수가 no-op (공개방 비활성).
 *     비공개방(코드 입력) 흐름은 영향 X.
 *   - 호스트 탭이 닫히면 onDisconnect 가 entry 를 자동 제거 (좀비 방 방지).
 *   - subscribe 콜백은 호출 시점에 즉시 빈 배열 1번 emit 으로 안전 시작.
 */

import {
  getDatabase,
  ref,
  set,
  update,
  remove,
  onValue,
  onDisconnect,
  type Database,
  type DataSnapshot,
} from 'firebase/database';
import { FIREBASE_CONFIG, firebaseApp } from './firebase.config';

let db: Database | null = null;

export function isRoomDirectoryEnabled(): boolean {
  return !!FIREBASE_CONFIG.apiKey && !!FIREBASE_CONFIG.databaseURL;
}

function ensureInit(): boolean {
  if (!isRoomDirectoryEnabled()) return false;
  if (!db) {
    try {
      // firebase.config.ts 에서 이미 initializeApp 된 app 을 재사용
      db = getDatabase(firebaseApp);
    } catch (err) {
      console.error('[roomDirectory] getDatabase failed', err);
      return false;
    }
  }
  return !!db;
}

export interface PublicRoomEntry {
  roomId: string;
  hostNickname: string;
  gameId: string;
  /** 사람이 읽는 게임 이름 (목록에 표시) */
  gameName: string;
  playerCount: number;
  maxPlayers: number;
  status: 'waiting' | 'playing';
  /** Date.now() — 정렬용. 오래된 방은 아래로. */
  createdAt: number;
}

/**
 * 새 공개방 등록. 호스트의 탭이 닫히면 자동 제거되도록 onDisconnect 도 같이 등록한다.
 */
export async function publishRoom(entry: PublicRoomEntry): Promise<void> {
  if (!ensureInit() || !db) return;
  const r = ref(db, `publicRooms/${entry.roomId}`);
  await set(r, entry);
  // 비정상 종료(브라우저 닫기, 새로고침, 네트워크 끊김) 대비 자동 제거
  onDisconnect(r).remove().catch(() => {});
}

/** 인원/상태 변경 — set 대신 부분 update */
export async function updatePublicRoom(
  roomId: string,
  partial: Partial<PublicRoomEntry>,
): Promise<void> {
  if (!ensureInit() || !db) return;
  await update(ref(db, `publicRooms/${roomId}`), partial);
}

export async function unpublishRoom(roomId: string): Promise<void> {
  if (!ensureInit() || !db) return;
  await remove(ref(db, `publicRooms/${roomId}`));
}

/**
 * 공개방 목록 실시간 구독. 매 변화마다 콜백에 최신 배열 전달.
 * 반환값: 구독 해제 함수.
 */
export function subscribePublicRooms(
  callback: (rooms: PublicRoomEntry[]) => void,
): () => void {
  if (!ensureInit() || !db) {
    callback([]);
    return () => {};
  }
  const roomsRef = ref(db, 'publicRooms');
  const handler = (snap: DataSnapshot): void => {
    const val = snap.val();
    if (!val || typeof val !== 'object') {
      callback([]);
      return;
    }
    const rooms = Object.values(val as Record<string, unknown>)
      .filter((v): v is PublicRoomEntry => isValidEntry(v))
      // 최근 만든 방이 위로
      .sort((a, b) => b.createdAt - a.createdAt);
    callback(rooms);
  };
  // onValue 가 unsubscribe 함수를 반환 (firebase v9+ modular SDK)
  return onValue(roomsRef, handler);
}

function isValidEntry(v: unknown): v is PublicRoomEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['roomId'] === 'string' &&
    typeof o['hostNickname'] === 'string' &&
    typeof o['gameId'] === 'string' &&
    typeof o['gameName'] === 'string' &&
    typeof o['playerCount'] === 'number' &&
    typeof o['maxPlayers'] === 'number' &&
    (o['status'] === 'waiting' || o['status'] === 'playing') &&
    typeof o['createdAt'] === 'number'
  );
}
