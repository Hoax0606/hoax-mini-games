/**
 * 양세찬 게임 (콜 마이 네임) — 순수 규칙 모듈 (DOM·네트워크 없음)
 *
 * 각자 이마에 단어가 하나씩 붙는다. **자기 것만 못 본다.**
 * 돌아가며 스무고개처럼 물어보고(질문·대답은 채팅으로), 자기 차례에 정답을 말한다.
 * 거짓말은 금지지만 애매하게 답하는 건 허용 — 그게 이 게임의 맛이라 규칙으로 막지 않는다.
 *
 * 진행(차례·정답 판정·순위)만 여기서 관리하고 대화는 채팅에 맡긴다.
 */

import { CATEGORIES } from '../liar-game/words';

/**
 * 주제 묶음.
 *
 * 라이어 게임 단어장을 그대로 쓰되 **이 게임에 맞는 주제만** 골랐다.
 * 감정·색깔·도형 같은 건 "내가 ○○야?" 로 좁혀갈 수가 없어서 뺐다.
 */
export const THEMES: { key: string; label: string; cats: string[] }[] = [
  {
    key: 'food', label: '음식',
    cats: ['한식', '분식', '면요리', '패스트푸드', '세계요리', '디저트', '빵',
      '아이스크림맛', '과일', '채소', '음료', '커피메뉴'],
  },
  {
    key: 'animal', label: '동물',
    cats: ['반려동물', '야생동물', '바다생물', '새', '곤충', '파충류양서류', '공룡'],
  },
  {
    key: 'thing', label: '사물',
    cats: ['옷', '학용품', '주방도구', '악기', '가전', '전자기기', '탈것', '공구'],
  },
  {
    key: 'place', label: '장소·나라',
    cats: ['장소', '한국도시', '세계도시', '나라', '랜드마크'],
  },
  {
    key: 'job', label: '직업·스포츠',
    cats: ['직업', '운동선수종목', '구기종목', '겨울스포츠', '격투기', '놀이'],
  },
];

/** 방 옵션에서 고를 수 있는 '랜덤' — 실제 주제가 아니라 "시작할 때 하나 뽑아라" 는 표시 */
export const RANDOM_THEME = 'random';

export function parseTheme(raw: string | undefined): string {
  if (raw === RANDOM_THEME) return RANDOM_THEME;
  return THEMES.some((t) => t.key === raw) ? (raw as string) : RANDOM_THEME;
}

/**
 * 고른 주제를 실제 주제 하나로 확정한다.
 * '랜덤' 이면 여기서 뽑는다 — **호스트가 시작할 때 딱 한 번만** 부를 것.
 * 게스트가 따로 부르면 서로 다른 주제를 뽑아버린다 (확정된 주제는 sync 로 내려간다).
 */
export function resolveTheme(themeKey: string): { key: string; label: string } {
  const found = THEMES.find((t) => t.key === themeKey);
  if (found) return { key: found.key, label: found.label };
  const t = THEMES[Math.floor(Math.random() * THEMES.length)]!;
  return { key: t.key, label: t.label };
}

/** 그 주제의 단어 풀 */
export function wordPool(themeKey: string): string[] {
  const theme = THEMES.find((t) => t.key === themeKey) ?? THEMES[0]!;
  const want = new Set(theme.cats);
  const out: string[] = [];
  for (const c of CATEGORIES) {
    if (want.has(c.name)) out.push(...c.words);
  }
  // 같은 단어가 여러 주제에 겹쳐 들어있다 (냉면: 한식·면요리) — 중복 제거
  return [...new Set(out)];
}

/** 인원수만큼 서로 다른 단어를 뽑는다 */
export function pickWords(themeKey: string, count: number): string[] {
  const pool = wordPool(themeKey).slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

/**
 * 정답 비교.
 * 띄어쓰기와 앞뒤 공백만 무시한다. '카페 라떼' 를 '카페라떼' 로 쳐도 맞게.
 * 그 이상(유사어·오타 보정)은 손대지 않는다 — 애매하게 맞히면 오히려 분쟁이 생긴다.
 */
export function isCorrect(guess: string, answer: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, '').trim();
  return norm(guess) === norm(answer) && norm(guess).length > 0;
}

/**
 * 화면 아래 대화 한 줄.
 *   ask = 차례인 사람의 질문 · ans = 나머지 사람들의 대답 · sys = 진행 알림
 *
 * 대답을 양식(예/아니오)으로 가두지 않은 건 일부러다.
 * "글쎄…", "반반?" 처럼 **애매하게 답하는 게 이 게임의 묘미**라서,
 * 빠른 버튼은 거들기만 하고 결국은 자유 입력이 본체다.
 */
export interface FeedEntry {
  kind: 'sys' | 'ask' | 'ans';
  /** 말한 사람 닉네임. sys 면 빈 문자열 */
  who: string;
  text: string;
}

/** 한 줄 길이 제한 — 너무 길면 화면이 무너진다 */
export const FEED_TEXT_MAX = 60;

export function clipFeedText(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, FEED_TEXT_MAX);
}

export interface PlayerState {
  peerId: string;
  nickname: string;
  /** 이마에 붙은 단어. 본인에게 보낼 때만 빈 문자열로 가린다 */
  word: string;
  solved: boolean;
  /** 맞힌 순서 (1등부터). 아직이면 0 */
  rank: number;
  /** 정답을 말해본 횟수 */
  tries: number;
}

/** 다음 차례 — 아직 못 맞힌 사람 중에서 순서대로. 전원 맞혔으면 null */
export function nextTurn(players: readonly PlayerState[], currentIdx: number): number | null {
  const n = players.length;
  if (n === 0) return null;
  for (let step = 1; step <= n; step++) {
    const i = (currentIdx + step) % n;
    if (!players[i]!.solved) return i;
  }
  return null;
}

/** 끝났나 — 전원이 맞혔으면 */
export function isOver(players: readonly PlayerState[]): boolean {
  return players.length > 0 && players.every((p) => p.solved);
}

/**
 * 최종 순위. 맞힌 사람이 먼저(맞힌 순서대로), 못 맞힌 사람은 뒤로.
 * 둘 다 못 맞혔으면 시도가 적은 쪽이 위 — 찍기만 반복한 사람보다 아낀 사람을 위로.
 */
export function rankSort(a: PlayerState, b: PlayerState): number {
  if (a.solved !== b.solved) return a.solved ? -1 : 1;
  if (a.solved && b.solved) return a.rank - b.rank;
  return a.tries - b.tries;
}
