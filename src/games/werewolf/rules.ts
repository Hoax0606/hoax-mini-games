/**
 * 한밤의 늑대인간 — 규칙 & 순수 로직 (호스트 authoritative)
 *
 * 이 파일은 "게임 규칙 계약"이다. 상태 변경/네트워크는 index.ts, 그리기는 render.ts.
 * 여기엔 부수효과 없는 순수 함수와 상수만 둔다 (Math.random 은 호스트 index.ts 에서 주입).
 *
 * 핵심 개념 3가지 (이게 이 게임의 전부):
 *  1) 카드는 [플레이어 수 + 3장]. 3장은 가운데(center)에 엎어둔다.
 *  2) 밤에 역할들이 "정해진 순서대로" 능력을 쓰며 카드가 서로 뒤바뀐다.
 *     - 밤 행동은 "처음 받은 역할(origRole)" 기준으로 한다. (카드가 바뀌어도 행동은 원래 역할대로)
 *  3) 낮 투표로 처형한 사람의 "최종 카드(curCard)" 로 승패를 가린다.
 *     - 즉 밤에 늑대 카드를 받았다가 강도한테 뺏기면, 그 사람은 이제 시민 팀이다.
 */

// ============================================
// 공개 상태 (호스트가 ww:sync 로 전원에게 broadcast — 비밀은 안 담는다)
// ============================================

export type Phase = 'deal' | 'night' | 'day' | 'vote' | 'result';

/** 좌석에 앉은 플레이어 (닉네임/식별자만) */
export interface WwPlayer {
  peerId: string;
  nickname: string;
}

/** 인게임 채팅 한 줄 (낮 토론용) */
export interface ChatLine {
  peerId: string;
  nickname: string;
  text: string;
}

/** result 페이즈에서만 채워지는 공개 결과 */
export interface RevealData {
  /** 각 플레이어의 최종 카드 (승패 판정 기준) */
  finalRoles: Record<string, Role>;
  /** 각 플레이어가 처음 받은 카드 (밤새 어떻게 바뀌었는지 보여주려고) */
  origRoles: Record<string, Role>;
  /** 가운데 3장 최종 */
  center: Role[];
  /** 투표 내역 peerId → 지목한 peerId */
  votes: Record<string, string>;
  /** 처형된 peerId 목록 */
  executed: string[];
  winningTeam: Team;
}

/**
 * 전원이 공유하는 공개 상태. 비밀(내 역할/밤에 본 것)은 여기 없다 —
 * ww:role / ww:nightInfo 로 각 peer 에게만 따로 보낸다.
 */
export interface PublicState {
  phase: Phase;
  /** 좌석 순서 (호스트 먼저) */
  players: WwPlayer[];
  /** deal 페이즈: 카드 확인을 마친 사람 수 (진행 표시용) */
  readyCount: number;
  /**
   * night 페이즈: 지금 행동 중인 역할.
   * 원작에서 사회자가 "예언자, 눈 뜨세요" 하고 소리내어 부르는 것과 같아 공개해도 됨
   * (단, "누가" 그 역할인지는 절대 공개 안 함 — 그건 각자 origRole 로만 앎).
   */
  nightRole: Role | null;
  /** night 진행바용: 현재 스텝(1-base) / 전체 스텝 수 */
  nightStep: number;
  nightTotal: number;
  /** 낮 토론 채팅 로그 (최근 것만 유지) */
  chatLog: ChatLine[];
  /** result 페이즈에서만 non-null */
  reveal: RevealData | null;
}

// ============================================
// 역할 · 팀
// ============================================

/** 이번 버전(3~5인 핵심)에서 쓰는 역할들 */
export type Role =
  | 'wolf'         // 늑대인간
  | 'seer'         // 예언자
  | 'robber'       // 강도
  | 'troublemaker' // 말썽쟁이
  | 'villager'     // 마을사람
  | 'drunk'        // 주정뱅이
  | 'insomniac';   // 불면증환자

export type Team = 'wolf' | 'village';

export interface RoleMeta {
  /** 한국어 이름 */
  name: string;
  /** 소속 팀 (승패는 "최종 카드"의 팀으로 판정) */
  team: Team;
  /**
   * 밤 행동 순서. 작을수록 먼저. 밤 행동이 없는 역할(마을사람)은 null.
   * 규칙서 순서: 늑대(2) → 예언자(5) → 강도(6) → 말썽쟁이(7) → 주정뱅이(8) → 불면증(9).
   * (도플갱어1·하수인3·비밀결사4 등은 이번 버전 미포함 — 확장 시 사이 번호 활용)
   */
  nightOrder: number | null;
  /** 능력 한 줄 설명 (역할 카드/도움말에 노출) */
  ability: string;
}

/** 역할 메타 정의 — UI 이름/팀/순서/설명의 단일 출처 */
export const ROLE_META: Record<Role, RoleMeta> = {
  wolf: {
    name: '늑대인간',
    team: 'wolf',
    nightOrder: 2,
    ability: '서로의 정체를 확인해요. 혼자라면 가운데 카드 1장을 봐요.',
  },
  seer: {
    name: '예언자',
    team: 'village',
    nightOrder: 5,
    ability: '다른 사람 카드 1장, 또는 가운데 카드 2장을 확인해요.',
  },
  robber: {
    name: '강도',
    team: 'village',
    nightOrder: 6,
    ability: '다른 사람과 카드를 맞바꾸고, 바뀐 내 카드를 확인해요.',
  },
  troublemaker: {
    name: '말썽쟁이',
    team: 'village',
    nightOrder: 7,
    ability: '나를 뺀 두 사람의 카드를 서로 맞바꿔요 (내용은 못 봐요).',
  },
  drunk: {
    name: '주정뱅이',
    team: 'village',
    nightOrder: 8,
    ability: '가운데 카드 1장과 내 카드를 맞바꿔요 (내용은 못 봐요).',
  },
  insomniac: {
    name: '불면증환자',
    team: 'village',
    nightOrder: 9,
    ability: '밤의 맨 마지막에, 지금 내 카드가 뭔지 확인해요.',
  },
  villager: {
    name: '마을사람',
    team: 'village',
    nightOrder: null,
    ability: '특별한 능력은 없어요. 토론과 추리로 승부해요.',
  },
};

/** 역할 → 팀 (승패 판정용) */
export function teamOf(role: Role): Team {
  return ROLE_META[role].team;
}

/**
 * 밤 행동이 있는 역할을 순서대로 나열 (nightOrder 오름차순).
 * "실제로 그 역할을 가진 플레이어가 있는지"는 여기서 안 따진다 — index.ts 밤 엔진이 거른다.
 */
export const NIGHT_ROLE_ORDER: Role[] = (Object.keys(ROLE_META) as Role[])
  .filter((r) => ROLE_META[r].nightOrder !== null)
  .sort((a, b) => (ROLE_META[a].nightOrder! - ROLE_META[b].nightOrder!));

/**
 * 밤 진행 스텝 = "이 세팅에 들어있는 밤-행동 역할" 을 순서대로.
 * 카드가 가운데(center)에만 있어 아무도 그 역할을 안 가졌더라도 스텝은 진행한다
 * (원작에서 사회자가 모든 역할을 부르는 것과 동일 — 어떤 역할이 가운데에 있는지 숨기려고).
 * 이 목록은 세팅(=인원수)으로 정해지므로 전원이 알아도 되는 공개 정보라 sync/UI 에 써도 안전.
 */
export function nightStepsForSetup(setup: Role[]): Role[] {
  const present = new Set(setup);
  return NIGHT_ROLE_ORDER.filter((r) => present.has(r));
}

// ============================================
// 인원수별 카드 세팅 (항상 플레이어 수 + 3장)
// ============================================
//
// 규칙서의 "4인=7장" 표기와 나열 카드(8장)가 어긋나서, N+3 공식에 맞게 재조정.
// 역할 도입 순서(4인에 주정뱅이, 5인에 불면증)는 규칙서 의도대로 유지.

const SETUPS: Record<number, Role[]> = {
  3: ['wolf', 'wolf', 'seer', 'robber', 'troublemaker', 'villager'],
  4: ['wolf', 'wolf', 'seer', 'robber', 'troublemaker', 'villager', 'drunk'],
  5: ['wolf', 'wolf', 'seer', 'robber', 'troublemaker', 'villager', 'drunk', 'insomniac'],
};

/** 지원 인원 범위 */
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 5;
/** 가운데에 엎어두는 카드 수 (항상 3) */
export const CENTER_COUNT = 3;

/**
 * 플레이어 수에 맞는 카드 구성 반환 (길이 = playerCount + 3).
 * 범위 밖이면 가장 가까운 값으로 클램프 (방어적).
 */
export function setupFor(playerCount: number): Role[] {
  const n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, playerCount));
  return [...SETUPS[n]!];
}

// ============================================
// 카드 배분
// ============================================

/**
 * 호스트가 보관하는 비밀 카드 상태.
 *  - origRole: 처음 받은 역할 (밤 행동 순서/자격 판정용, 절대 안 바뀜)
 *  - curCard:  현재 손에 든 카드 (강도/말썽쟁이/주정뱅이 교환으로 바뀜, 승패 판정용)
 *  - center:   가운데 3장 (현재 카드)
 */
export interface SecretDeal {
  origRole: Record<string, Role>;
  curCard: Record<string, Role>;
  center: Role[];
}

/** 배열을 제자리 셔플 (Fisher-Yates). rng 는 [0,1) 난수 함수 (호스트가 Math.random 주입) */
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * 좌석(peerId 순서)에 카드를 나눠주고 가운데 3장을 세팅.
 * @param seats 플레이어 peerId 배열 (order)
 * @param rng   난수 함수
 */
export function dealCards(seats: string[], rng: () => number): SecretDeal {
  const deck = shuffle(setupFor(seats.length), rng);
  const origRole: Record<string, Role> = {};
  const curCard: Record<string, Role> = {};
  seats.forEach((peerId, i) => {
    origRole[peerId] = deck[i]!;
    curCard[peerId] = deck[i]!;
  });
  const center = deck.slice(seats.length); // 나머지 3장
  return { origRole, curCard, center };
}

// ============================================
// 투표 집계 (공식 룰)
// ============================================

/**
 * 투표 집계.
 * 규칙: 각자 한 명 지목(자신 포함 가능) → 최다 득표자 처형(동표면 전원).
 *       단, 최다 득표가 1표 이하이면(= 표가 완전히 분산) 아무도 안 죽는다.
 * @param votes  peerId → 지목한 peerId
 * @param seats  전체 플레이어 peerId (0표인 사람도 카운트 대상)
 * @returns executed(처형된 peerId 목록), counts(득표 집계)
 */
export function tallyVotes(
  votes: Record<string, string>,
  seats: string[],
): { executed: string[]; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const s of seats) counts[s] = 0;
  for (const target of Object.values(votes)) {
    if (target in counts) counts[target]! += 1;
  }
  let max = 0;
  for (const s of seats) max = Math.max(max, counts[s]!);
  // 최다 득표가 1표 이하 = 아무도 안 죽음 (마을에 늑대가 없다고 판단한 셈)
  if (max <= 1) return { executed: [], counts };
  const executed = seats.filter((s) => counts[s] === max);
  return { executed, counts };
}

// ============================================
// 승패 판정 (최종 카드 기준)
// ============================================

export interface WinResult {
  /** 이긴 팀 */
  winningTeam: Team;
  /** 처형된 사람 중 늑대가 있었는지 (결과 표시용) */
  wolfExecuted: boolean;
}

/**
 * 승패 판정.
 * @param finalRoles  플레이어 peerId → 최종 카드(curCard)
 * @param executed    처형된 peerId 목록
 *
 * 규칙:
 *  - 처형자 중 늑대가 1명이라도 있으면 → 시민 팀 승.
 *  - 아무도 안 죽었으면 → 플레이어 중 늑대가 아예 없을 때만 시민 승 (있으면 늑대 승).
 *  - 그 외(시민만 죽음) → 늑대 팀 승.
 */
export function computeWin(finalRoles: Record<string, Role>, executed: string[]): WinResult {
  const wolfExecuted = executed.some((p) => finalRoles[p] === 'wolf');
  const anyWolfAmongPlayers = Object.values(finalRoles).some((r) => r === 'wolf');

  if (executed.length === 0) {
    return { winningTeam: anyWolfAmongPlayers ? 'wolf' : 'village', wolfExecuted: false };
  }
  return { winningTeam: wolfExecuted ? 'village' : 'wolf', wolfExecuted };
}
