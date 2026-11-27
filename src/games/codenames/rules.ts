/**
 * 코드네임 — 순수 규칙 모듈 (DOM·네트워크 없음)
 *
 * 5×5 로 깔린 단어 25장에 색이 숨어 있다. 빨강 9 / 파랑 8 / 중립 7 / 암살자 1.
 * 스파이마스터만 색 배치를 보고 `단어 + 숫자` 로 힌트를 준다.
 * 팀원은 최대 숫자+1 장까지 찍는다 — 자기 팀 색이면 계속, 아니면 턴이 넘어간다.
 * **암살자를 찍으면 그 팀이 바로 진다.**
 *
 * 선공 팀이 한 장 더 갖는다(9장). 그래서 먼저 다 찾으면 이긴다.
 */

import { CATEGORIES } from '../liar-game/words';

export type Team = 'red' | 'blue';
/** 카드에 숨은 색. neutral = 행인, assassin = 암살자 */
export type CardColor = Team | 'neutral' | 'assassin';

export interface Card {
  word: string;
  color: CardColor;
  revealed: boolean;
}

export const BOARD_SIZE = 25;
export const COLS = 5;
/** 선공 팀 카드 수 (후공은 하나 적다) */
export const FIRST_COUNT = 9;
export const SECOND_COUNT = 8;
export const NEUTRAL_COUNT = 7;

/**
 * 코드네임에 쓸 단어 풀.
 *
 * 라이어 게임 단어장을 재활용하되 **이 게임에 맞는 분류만** 골랐다.
 * 감정·공룡처럼 길거나 추상적인 건 뺐다 — 격자에 다섯 글자가 들어가면 읽기 힘들고,
 * '뿌듯함' 같은 말은 "이것과 저것을 묶는 한 단어"를 떠올리기가 어렵다.
 */
const POOL_CATEGORIES = new Set([
  '과일', '채소', '음료', '한식', '분식', '면요리', '빵', '디저트',
  '반려동물', '야생동물', '바다생물', '새', '곤충',
  '직업', '신체부위', '옷', '학용품', '주방도구', '악기', '가전', '전자기기', '탈것', '공구',
  '날씨', '꽃', '나무', '우주천체', '색깔',
  '장소', '한국도시', '세계도시', '나라', '랜드마크', '놀이', '구기종목', '겨울스포츠',
]);

/** 격자에 들어갈 만한 길이 — 다섯 글자를 넘어가면 칸이 깨진다 */
const MAX_WORD_LEN = 5;

export function wordPool(): string[] {
  const out = new Set<string>();
  for (const c of CATEGORIES) {
    if (!POOL_CATEGORIES.has(c.name)) continue;
    for (const w of c.words) {
      if (w.length <= MAX_WORD_LEN) out.add(w);
    }
  }
  return [...out];
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 판 깔기. 선공 팀은 매판 무작위 — 늘 빨강이 먼저면 한쪽이 계속 유리하다 */
export function buildBoard(): { cards: Card[]; first: Team } {
  const first: Team = Math.random() < 0.5 ? 'red' : 'blue';
  const second: Team = first === 'red' ? 'blue' : 'red';

  const colors: CardColor[] = [
    ...Array<CardColor>(FIRST_COUNT).fill(first),
    ...Array<CardColor>(SECOND_COUNT).fill(second),
    ...Array<CardColor>(NEUTRAL_COUNT).fill('neutral'),
    'assassin',
  ];
  const words = shuffle(wordPool()).slice(0, BOARD_SIZE);
  const mixed = shuffle(colors);
  const cards: Card[] = words.map((word, i) => ({
    word,
    color: mixed[i] ?? 'neutral',
    revealed: false,
  }));
  return { cards, first };
}

/** 그 팀이 아직 못 찾은 카드 수 */
export function remaining(cards: Card[], team: Team): number {
  return cards.filter((c) => c.color === team && !c.revealed).length;
}

/**
 * 힌트 검사. 규칙상 **판에 있는 단어는 못 쓴다**.
 * 포함 관계도 막는다 — '사과' 가 판에 있으면 '사과나무' 도 안 된다.
 * 나머지(합성어·외국어·발음 장난)는 사람이 판단한다. 원작도 심판은 사람이다.
 */
export function validateHint(raw: string, cards: Card[]): string | null {
  const word = raw.trim();
  if (!word) return '힌트를 입력해주세요';
  if (word.length > 12) return '힌트가 너무 길어요';
  if (/\s/.test(word)) return '힌트는 한 단어로 해주세요';
  const norm = (s: string): string => s.replace(/\s+/g, '');
  const w = norm(word);
  for (const c of cards) {
    const bw = norm(c.word);
    if (w === bw || w.includes(bw) || bw.includes(w)) {
      return `판에 있는 '${c.word}' 는 힌트로 쓸 수 없어요`;
    }
  }
  return null;
}

/** 찍은 결과 */
export type GuessResult = 'hit' | 'neutral' | 'opponent' | 'assassin';

export function guessResult(color: CardColor, team: Team): GuessResult {
  if (color === 'assassin') return 'assassin';
  if (color === 'neutral') return 'neutral';
  return color === team ? 'hit' : 'opponent';
}

export const TEAM_LABEL: Record<Team, string> = { red: '빨강', blue: '파랑' };

export function otherTeam(team: Team): Team {
  return team === 'red' ? 'blue' : 'red';
}
