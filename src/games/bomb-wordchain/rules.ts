/**
 * 폭탄 돌리기 끝말잇기 — 규칙(대부분 word-chain 재사용).
 *
 * word-chain 과 차이:
 *   - 턴당 제한시간 없음. 대신 게임 전체에 걸친 **숨겨진 폭탄 타이머**(30초~3분 랜덤, 호스트만 앎).
 *   - 틀린 단어/못 떠올림 = 탈락 없음(그냥 재입력). 압박은 오직 폭탄.
 *   - 폭탄 터질 때 차례(=폭탄 든 사람)인 1명이 패배, 나머지 전원 생존. 한 판 = 폭탄 1개.
 *   - 시작 플레이어는 랜덤(peer 집합 시드 → 전원 동일 계산, sync 불필요).
 *
 * 단어 검증/두음법칙/사전/시작단어/턴진행은 word-chain 의 순수 함수를 그대로 쓴다.
 */

import { seedFromPeers } from '../word-chain/rules';

/** 폭탄 최소/최대 지속시간(ms) — 30초 ~ 3분 */
export const BOMB_MIN_MS = 30_000;
export const BOMB_MAX_MS = 180_000;

/** 호스트만 호출 — 이번 판 폭탄 지속시간을 랜덤으로. 숨김값이라 sync 안 함. */
export function randomBombMs(): number {
  return BOMB_MIN_MS + Math.floor(Math.random() * (BOMB_MAX_MS - BOMB_MIN_MS + 1));
}

/**
 * 시작 플레이어 인덱스 — peer 집합 시드로 결정론적으로 뽑는다.
 * (호스트 sync 없이도 전원이 같은 시작 순번을 계산 → 폭탄 시간과 달리 이건 공개돼도 무방)
 */
export function startTurnFromPeers(peerIds: string[], playerCount: number): number {
  if (playerCount <= 0) return 0;
  return seedFromPeers(peerIds) % playerCount;
}
