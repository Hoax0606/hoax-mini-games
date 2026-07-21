/**
 * 한밤의 늑대인간 (One Night Ultimate Werewolf) — 규칙 & 순수 로직 (호스트 authoritative)
 *
 * 이 파일은 "게임 규칙 계약"이다. 상태 변경/네트워크는 index.ts, 그리기는 render.ts.
 * 여기엔 부수효과 없는 순수 함수와 상수만 둔다 (Math.random 은 호스트 index.ts 에서 주입).
 *
 * 핵심 개념 (정식 규칙 기준):
 *  1) 카드는 항상 [플레이어 수 + 3장]. 남는 3장은 가운데(center)에 엎어둔다.
 *  2) 밤에 역할들이 "정해진 순서대로"(도플갱어→늑대→하수인→메이슨→예언자→강도→말썽쟁이→주정뱅이→수면증)
 *     능력을 쓰며 카드가 서로 뒤바뀐다.
 *     - 밤 행동 자격은 "처음 받은 역할(origRole)" 기준. 카드가 바뀌어도 지나간 밤 행동은 다시 안 함.
 *  3) 낮 투표로 처형한 사람의 "최종 카드(curCard)" 로 승패를 가린다.
 *  4) 사냥꾼 처형 시 그가 투표한 사람도 함께 처형 → 그 뒤 승패 판정.
 *  5) 탄넬러(제3세력)는 자신이 처형되면 단독 승(최우선 판정).
 */

// ============================================
// 공개 상태 (호스트가 ww:sync 로 전원에게 broadcast — 비밀은 안 담는다)
// ============================================

export type Phase = 'setup' | 'deal' | 'night' | 'day' | 'vote' | 'result';

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

/** result 페이즈에서만 채워지는 공개 결과 (정식: 처음/최종/가운데/밤로그/교환/투표/승리팀·플레이어) */
export interface RevealData {
  /** 각 플레이어의 최종 카드 (승패 판정 기준) */
  finalRoles: Record<string, Role>;
  /** 각 플레이어가 처음 받은 카드 */
  origRoles: Record<string, Role>;
  /** 가운데 3장 최종 */
  center: Role[];
  /** 투표 내역 peerId → 지목한 peerId */
  votes: Record<string, string>;
  /** 처형된 peerId 목록 (사냥꾼 연쇄 포함) */
  executed: string[];
  /** 이긴 팀 ('none' = 아무도 승리 못 함: 늑대 없는데 무고한 사람 처형 등) */
  winningTeam: Team | 'none';
  /** 이긴 플레이어 peerId 목록 (탄넬러 단독승/시민 전원/늑대+하수인 등) */
  winners: string[];
  /** 밤에 일어난 일 로그 (사회자 시점, 전원 공개) */
  nightLog: string[];
  /** 카드 교환 로그 */
  swapLog: string[];
}

/**
 * 전원이 공유하는 공개 상태. 비밀(내 역할/밤에 본 것)은 여기 없다 —
 * ww:role / ww:nightInfo 로 각 peer 에게만 따로 보낸다.
 */
export interface PublicState {
  phase: Phase;
  /** 좌석 순서 (호스트 먼저) */
  players: WwPlayer[];
  /** 이번 게임 카드 구성(공개 정보 — 도움말/역할표에 노출). 누가 무슨 역할인지는 비밀. */
  setup: Role[];
  /** deal 페이즈: 카드 확인을 마친 사람 수 (진행 표시용) */
  readyCount: number;
  /** night 페이즈: 지금 행동 중인 역할 (원작 사회자가 부르는 것과 동일, 공개해도 됨). */
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

/** 정식 기본판 역할 (+ 프로모 도플갱어). 도플갱어는 최종 단계에서 구현 예정. */
export type Role =
  | 'doppelganger' // 도플갱어 (프로모) — 남 직업 복사 후 즉시 행동
  | 'wolf'         // 늑대인간
  | 'minion'       // 하수인
  | 'mason'        // 메이슨
  | 'seer'         // 예언자
  | 'robber'       // 강도
  | 'troublemaker' // 말썽쟁이
  | 'drunk'        // 주정뱅이
  | 'insomniac'    // 수면증 환자
  | 'hunter'       // 사냥꾼 (밤 행동 없음, 처형 시 지목자 연쇄 처형)
  | 'tanner'       // 탄넬러 (제3세력, 처형되면 단독 승)
  | 'villager';    // 마을 주민

/** 승패 진영. tanner 는 제3세력(단독). */
export type Team = 'wolf' | 'village' | 'tanner';

export interface RoleMeta {
  /** 한국어 이름 */
  name: string;
  /** 소속 팀 (승패는 "최종 카드"의 팀으로 판정. 도플갱어는 복사한 역할을 따르며 런타임 처리) */
  team: Team;
  /** 밤 행동 순서. 작을수록 먼저. 밤 행동이 없으면 null. */
  nightOrder: number | null;
  /** 능력 한 줄 설명 (역할 카드/도움말에 노출) */
  ability: string;
}

/** 역할 메타 정의 — UI 이름/팀/순서/설명의 단일 출처. 밤 순서는 정식 규칙 그대로. */
export const ROLE_META: Record<Role, RoleMeta> = {
  doppelganger: {
    name: '도플갱어',
    team: 'village', // 실제 팀은 복사한 역할을 따름(런타임). 기본 표기용 placeholder.
    nightOrder: 1,
    ability: '다른 사람의 직업을 복사해 그 역할이 돼요. 능력이 있으면 즉시 써요.',
  },
  wolf: {
    name: '늑대인간',
    team: 'wolf',
    nightOrder: 2,
    ability: '서로의 정체를 확인해요. 혼자라면 가운데 카드 1장을 봐요.',
  },
  minion: {
    name: '하수인',
    team: 'wolf',
    nightOrder: 3,
    ability: '늑대가 누구인지 확인해요. 늑대는 하수인을 몰라요. 늑대팀 승리 시 함께 승리.',
  },
  mason: {
    name: '메이슨',
    team: 'village',
    nightOrder: 4,
    ability: '다른 메이슨을 서로 확인해요. 혼자면 아무도 안 보여요.',
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
    name: '수면증 환자',
    team: 'village',
    nightOrder: 9,
    ability: '밤의 맨 마지막에, 지금 내 카드가 뭔지 확인해요.',
  },
  hunter: {
    name: '사냥꾼',
    team: 'village',
    nightOrder: null,
    ability: '내가 처형되면, 내가 투표한 사람도 함께 처형돼요.',
  },
  tanner: {
    name: '탄넬러',
    team: 'tanner',
    nightOrder: null,
    ability: '능력은 없어요. 내가 처형되면 나 혼자 승리해요!',
  },
  villager: {
    name: '마을 주민',
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
 * 카드가 가운데에만 있어 아무도 그 역할을 안 가졌어도 스텝은 진행(원작에서 사회자가 모든 역할을 부름).
 * 세팅(공개 정보)으로 정해지므로 sync/UI 에 써도 안전.
 */
export function nightStepsForSetup(setup: Role[]): Role[] {
  const present = new Set(setup);
  return NIGHT_ROLE_ORDER.filter((r) => present.has(r));
}

// ============================================
// 인원수별 카드 세팅 — "일반 모드" 공식 조합 (항상 플레이어 수 + 3장)
// ============================================
//
// 원문서의 카드수 표기가 N+3 과 어긋나는 곳(예: 5인)은 N+3 에 맞춰 마을주민으로 보정.
// 역할 도입 순서(6인 하수인, 7인 사냥꾼, 9인 도플갱어)는 원문서 의도대로 유지.
// ※ 도플갱어(dg)는 최종 단계 구현 예정 → 9·10인 공식조합에서 임시로 마을주민으로 대체(아래 주석).

const SETUPS: Record<number, Role[]> = {
  // 3인(6장) — 공식: 늑대 1마리
  3: ['wolf', 'seer', 'robber', 'troublemaker', 'tanner', 'villager'],
  // 4인(7장)
  4: ['wolf', 'wolf', 'seer', 'robber', 'troublemaker', 'tanner', 'villager'],
  // 5인(8장) — +수면증
  5: ['wolf', 'wolf', 'seer', 'robber', 'troublemaker', 'insomniac', 'tanner', 'villager'],
  // 6인(9장) — +하수인
  6: ['wolf', 'wolf', 'minion', 'seer', 'robber', 'troublemaker', 'insomniac', 'tanner', 'villager'],
  // 7인(10장) — +사냥꾼
  7: ['wolf', 'wolf', 'minion', 'seer', 'robber', 'troublemaker', 'insomniac', 'hunter', 'tanner', 'villager'],
  // 8인(11장) — +마을주민
  8: ['wolf', 'wolf', 'minion', 'seer', 'robber', 'troublemaker', 'insomniac', 'hunter', 'tanner', 'villager', 'villager'],
  // 9인(12장) — +도플갱어
  9: ['wolf', 'wolf', 'minion', 'seer', 'robber', 'troublemaker', 'insomniac', 'hunter', 'tanner', 'doppelganger', 'villager', 'villager'],
  // 10인(13장) — +마을주민
  10: ['wolf', 'wolf', 'minion', 'seer', 'robber', 'troublemaker', 'insomniac', 'hunter', 'tanner', 'doppelganger', 'villager', 'villager', 'villager'],
};

/** 지원 인원 범위 */
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
/** 가운데에 엎어두는 카드 수 (항상 3) */
export const CENTER_COUNT = 3;

/**
 * 일반 모드: 플레이어 수에 맞는 공식 카드 구성 반환 (길이 = playerCount + 3).
 * 범위 밖이면 가장 가까운 값으로 클램프 (방어적).
 */
export function setupFor(playerCount: number): Role[] {
  const n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, playerCount));
  return [...SETUPS[n]!];
}

// ============================================
// 자유(랜덤) 모드 세팅 검증
// ============================================
//
// 규칙: 카드 수 = 플레이어 수 + 3. 늑대만 여러 장 허용, 나머지 역할은 각 1장.
// 공식 조합이 아니면 "비권장", 승패 불가 구성이면 "경고"(무시하고 시작 가능).

export interface SetupCheck {
  /** 시작 가능 여부(카드 수만 맞으면 true — 경고는 무시 가능) */
  ok: boolean;
  /** 카드 수/중복 규칙 위반 등 시작 불가 사유 (있으면 시작 막음) */
  errors: string[];
  /** 무시하고 시작 가능한 경고 (승패 불가 등) */
  warnings: string[];
}

/** 늑대만 다중 허용. 그 외 역할이 2장 이상이면 위반. */
export function validateFreeSetup(setup: Role[], playerCount: number): SetupCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const need = playerCount + CENTER_COUNT;
  if (setup.length !== need) {
    errors.push(`카드가 ${setup.length}장 — ${playerCount}인은 ${need}장이어야 해요 (인원+3).`);
  }
  const counts = new Map<Role, number>();
  for (const r of setup) counts.set(r, (counts.get(r) ?? 0) + 1);
  for (const [r, c] of counts) {
    // 늑대·(도플갱어 구현 후엔 예외 추가 가능)만 다중 허용
    if (c > 1 && r !== 'wolf') {
      errors.push(`${ROLE_META[r].name}는 1장만 넣을 수 있어요 (늑대만 여러 장 가능).`);
    }
  }
  // 승패 불가 경고: 늑대도 없고 탄넬러도 없으면 아무도 못 이기는 판이 될 수 있음
  const hasWolf = counts.has('wolf');
  const hasTanner = counts.has('tanner');
  if (!hasWolf && !hasTanner) {
    warnings.push('늑대도 탄넬러도 없어요 — 승부가 안 날 수 있어요.');
  }
  return { ok: errors.length === 0, errors, warnings };
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

/** 배열 제자리 셔플 (Fisher-Yates). rng 는 [0,1) 난수 함수 (호스트가 Math.random 주입) */
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
 * @param deck  이미 정해진 카드 목록(일반=setupFor, 자유=사용자 선택). 내부에서 셔플.
 * @param rng   난수 함수
 */
export function dealCards(seats: string[], deck: Role[], rng: () => number): SecretDeal {
  const shuffled = shuffle([...deck], rng);
  const origRole: Record<string, Role> = {};
  const curCard: Record<string, Role> = {};
  seats.forEach((peerId, i) => {
    origRole[peerId] = shuffled[i]!;
    curCard[peerId] = shuffled[i]!;
  });
  const center = shuffled.slice(seats.length); // 나머지 3장
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
  if (max <= 1) return { executed: [], counts };
  const executed = seats.filter((s) => counts[s] === max);
  return { executed, counts };
}

/**
 * 사냥꾼 연쇄 처형.
 * 최종 카드가 사냥꾼인 사람이 처형되면, 그가 투표한 대상도 함께 처형된다. 연쇄(사냥꾼→사냥꾼)도 처리.
 * @returns 최종 처형자 목록(중복 제거)
 */
export function resolveHunterDeaths(
  baseExecuted: string[],
  votes: Record<string, string>,
  finalRoles: Record<string, Role>,
): string[] {
  const dead = new Set(baseExecuted);
  const queue = [...baseExecuted];
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (finalRoles[p] !== 'hunter') continue;
    const target = votes[p];
    if (target && !dead.has(target)) {
      dead.add(target);
      queue.push(target); // 대상이 또 사냥꾼이면 연쇄
    }
  }
  return [...dead];
}

// ============================================
// 승패 판정 (최종 카드 기준)
// ============================================

export interface WinResult {
  winningTeam: Team | 'none';
  /** 이긴 플레이어 peerId 목록 */
  winners: string[];
  /** 처형자 중 늑대가 있었는지 (표시용) */
  wolfExecuted: boolean;
}

/**
 * 승패 판정 (정식 규칙). executed 는 사냥꾼 연쇄까지 반영된 최종 처형자 목록.
 *
 * 우선순위:
 *  1) 처형자 중 탄넬러가 있으면 → 탄넬러 단독 승 (그 탄넬러들만 승리).
 *  2) 늑대가 처형됐으면 → 시민팀 승.
 *  3) 아무도 안 죽었는데 악한 진영(늑대/하수인)이 아예 없으면 → 시민팀 승.
 *  4) 최종 늑대가 1명 이상 살아있으면(또는 무처형+악한진영 존재) → 늑대팀 승(하수인 포함).
 *  5) 늑대가 없는데 무고한 사람만 처형 → 아무도 승리 못 함('none').
 */
export function computeWin(
  finalRoles: Record<string, Role>,
  executed: string[],
): WinResult {
  const entries = Object.entries(finalRoles) as [string, Role][];
  const wolfExecuted = executed.some((p) => finalRoles[p] === 'wolf');
  const villageWinners = () => entries.filter(([, r]) => teamOf(r) === 'village').map(([p]) => p);
  const wolfWinners = () => entries.filter(([, r]) => teamOf(r) === 'wolf').map(([p]) => p); // 늑대+하수인

  // 1) 탄넬러 최우선
  const tanners = executed.filter((p) => finalRoles[p] === 'tanner');
  if (tanners.length > 0) {
    return { winningTeam: 'tanner', winners: tanners, wolfExecuted };
  }

  const anyWolf = entries.some(([, r]) => r === 'wolf');
  const anyEvil = entries.some(([, r]) => teamOf(r) === 'wolf'); // 늑대 or 하수인

  if (executed.length === 0) {
    // 아무도 처형 안 됨
    if (!anyEvil) return { winningTeam: 'village', winners: villageWinners(), wolfExecuted };
    return { winningTeam: 'wolf', winners: wolfWinners(), wolfExecuted }; // 악한 진영 생존
  }
  // 처형자 있음
  if (wolfExecuted) return { winningTeam: 'village', winners: villageWinners(), wolfExecuted };
  if (anyWolf) return { winningTeam: 'wolf', winners: wolfWinners(), wolfExecuted }; // 늑대 생존
  // 늑대 없는데 (무고한) 처형 발생 → 아무도 승리 못 함
  return { winningTeam: 'none', winners: [], wolfExecuted };
}
