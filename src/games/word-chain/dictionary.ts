/**
 * 끝말잇기 사전 — 표준국어대사전 기반 한국어 명사 196,172개 (2~5글자).
 *
 * 단어 데이터는 dictionary-data.ts (자동 생성, ~1.9MB) 에 개행 구분 단일 문자열로 들어있고,
 * 여기서 split 후 Set 으로 만들어 O(1) 검증한다.
 *
 * 출처: han-dle/pd-korean-noun-list-for-wordles (표준국어대사전 명사 추출, CC0 1.0 Universal)
 *       + 국립국어원 학습용 어휘 + 기존 자체 단어. dictionary-data.ts 헤더 참고.
 *
 * 끝말잇기 chunk 는 lazy load 라 게임 진입 시에만 이 데이터를 받는다 (gzip ~수백 KB).
 */

import { NOUNS_RAW } from './dictionary-data';

/** O(1) 조회용 Set — 모듈 로드 시 1회 생성 (19만 항목, 수십 ms) */
const WORD_SET: ReadonlySet<string> = new Set(NOUNS_RAW.split('\n'));

/** 사전 등록 여부 */
export function isInDictionary(word: string): boolean {
  return WORD_SET.has(word);
}

/**
 * 게임 시작 시드 단어 — 체인이 잘 이어지도록 흔하고 끝 글자가 평이한 단어 위주.
 * 사전 전체에서 무작위로 뽑으면 너무 어려운 한자어가 시작어가 될 수 있어 별도 풀 유지.
 *
 * @param seedOverride 결정론적 선택용 (호스트가 모든 클라이언트와 동일 시드 시작에 사용).
 *                    생략 시 Math.random().
 */
export function getRandomSeedWord(seedOverride?: number): string {
  const SEED_POOL: readonly string[] = [
    '사과', '학교', '나무', '바나나', '하늘', '가족', '친구', '바다',
    '구름', '강아지', '고양이', '소나무', '아침', '저녁', '도시', '마을',
    '거리', '공원', '나라', '이야기', '노래', '생각', '마음', '봄날',
    '아기', '어린이', '의사', '교사', '학생', '신발',
  ];
  if (seedOverride !== undefined) {
    return SEED_POOL[seedOverride % SEED_POOL.length]!;
  }
  return SEED_POOL[Math.floor(Math.random() * SEED_POOL.length)]!;
}
