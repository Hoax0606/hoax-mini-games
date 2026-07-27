/**
 * 레지스탕스: 아발론 (The Resistance: Avalon) — 규칙 & 순수 로직 (호스트 authoritative)
 *
 * 이 파일은 "게임 규칙 계약"이다. 상태 변경/네트워크는 index.ts, 그리기는 render.ts.
 * 여기엔 부수효과 없는 순수 함수와 상수만 둔다 (Math.random 은 호스트 index.ts 에서 주입).
 *
 * 핵심 개념 (정식 규칙 기준):
 *  1) 선(아서 진영) vs 악(모드레드 하수인). 5~10인. 인원수 → 고정 카드 구성(SETUPS).
 *  2) 5라운드 퀘스트. 각 라운드: 리더가 원정대원 선발 → 전원 공개 찬반투표 → 과반 승인 시 원정.
 *     - 승인 실패(거부 다수)면 리더가 시계방향으로 넘어감. 한 라운드에서 5연속 거부 = 악 승리.
 *  3) 원정 진행 시 원정대원만 성공/실패 카드 비밀 제출. 선은 성공만, 악은 선택.
 *     실패 1장(7인+ 4라운드는 2장) 이상이면 원정 실패.
 *  4) 3원정 성공 → 선 유리, 이때 암살자가 멀린을 지목. 맞으면 악 역전승, 틀리면 선 승리.
 *     3원정 실패 → 즉시 악 승리.
 *  5) 밤 정보는 역할별로 다르다 (멀린은 악을 봄, 퍼시발은 멀린 후보를 봄, 악끼리 서로 앎 등) —
 *     비밀이라 av:info 로 각 peer 에게만 따로 보낸다 (공개 상태엔 안 담음).
 */

// ============================================
// 페이즈 · 기본 타입
// ============================================

export type Phase = 'deal' | 'team' | 'vote' | 'quest' | 'assassin' | 'result';

/** 좌석에 앉은 플레이어 (닉네임/식별자만) */
export interface AvPlayer {
  peerId: string;
  nickname: string;
}

/** 인게임 채팅 한 줄 (원정대 토론용) */
export interface ChatLine {
  peerId: string;
  nickname: string;
  text: string;
}

/** 원정대원이 내는 카드 / 원정 결과 */
export type QuestCard = 'success' | 'fail';
/** 찬반 투표 */
export type Vote = 'approve' | 'reject';

// ============================================
// 역할 · 팀
// ============================================

export type Role =
  | 'merlin'    // 멀린 — 악을 봄(모드레드 제외). 들키면 암살당함
  | 'percival'  // 퍼시발 — 멀린 후보 2명을 봄(멀린/모르가나, 구분 불가)
  | 'loyal'     // 아서의 충직한 신하 — 능력 없음
  | 'assassin'  // 암살자 — 선 3승 시 멀린 지목 기회
  | 'morgana'   // 모르가나 — 퍼시발에게 멀린처럼 보임
  | 'mordred'   // 모드레드 — 멀린에게 안 보임
  | 'oberon'    // 오베론 — 악인데 다른 악을 모름(다른 악도 오베론 모름). 멀린은 봄
  | 'minion';   // 모드레드의 하수인 — 능력 없는 악

/** 승패 진영 */
export type Team = 'good' | 'evil';

export interface RoleMeta {
  /** 한국어 이름 */
  name: string;
  team: Team;
  /** 능력 한 줄 설명 (역할 카드/도움말에 노출) */
  ability: string;
}

/** 역할 메타 정의 — UI 이름/팀/설명의 단일 출처 */
export const ROLE_META: Record<Role, RoleMeta> = {
  merlin: {
    name: '멀린',
    team: 'good',
    ability: '악한 자들을 모두 알아요 (단 모드레드는 못 봐요). 정체를 들키면 암살당해요.',
  },
  percival: {
    name: '퍼시발',
    team: 'good',
    ability: '멀린을 알아봐요. 단 모르가나도 멀린처럼 보여서 둘 중 누가 진짜인지 몰라요.',
  },
  loyal: {
    name: '충직한 신하',
    team: 'good',
    ability: '특별한 능력은 없어요. 토론과 추리로 원정을 성공시켜요.',
  },
  assassin: {
    name: '암살자',
    team: 'evil',
    ability: '선이 3원정을 성공하면, 멀린이라 생각하는 사람을 지목해요. 맞으면 악의 역전승!',
  },
  morgana: {
    name: '모르가나',
    team: 'evil',
    ability: '퍼시발에게 멀린처럼 보여요. 가짜 멀린 행세로 선을 혼란시켜요.',
  },
  mordred: {
    name: '모드레드',
    team: 'evil',
    ability: '멀린에게 보이지 않아요. 선은 당신의 정체를 알 수 없어요.',
  },
  oberon: {
    name: '오베론',
    team: 'evil',
    ability: '악이지만 다른 악을 몰라요 (다른 악도 당신을 몰라요). 단 멀린에게는 보여요.',
  },
  minion: {
    name: '하수인',
    team: 'evil',
    ability: '모드레드의 하수인. 능력은 없지만 다른 악을 알아요.',
  },
};

/** 역할 → 팀 */
export function teamOf(role: Role): Team {
  return ROLE_META[role].team;
}

// ============================================
// 인원수별 카드 구성 · 원정대 인원표 (정식)
// ============================================
//
// 선/악 비율(정식): 5→3/2, 6→4/2, 7→4/3, 8→5/3, 9→6/3, 10→6/4.
// 특수역할 조합은 통용 구성 사용 (멀린·퍼시발·모르가나·암살자는 항상 포함,
// 오베론은 7·10인, 모드레드는 8·9·10인에 추가). 나머지 자리는 신하/하수인으로 채움.

const SETUPS: Record<number, Role[]> = {
  //  선(good)                              악(evil)
  5:  ['merlin', 'percival', 'loyal',                    'morgana', 'assassin'],
  6:  ['merlin', 'percival', 'loyal', 'loyal',           'morgana', 'assassin'],
  7:  ['merlin', 'percival', 'loyal', 'loyal',           'morgana', 'assassin', 'oberon'],
  8:  ['merlin', 'percival', 'loyal', 'loyal', 'loyal',  'morgana', 'assassin', 'mordred'],
  9:  ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'morgana', 'assassin', 'mordred'],
  10: ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'morgana', 'assassin', 'mordred', 'oberon'],
};

/** 각 인원수 원정대 인원 (라운드 1~5) */
const MISSION_TABLE: Record<number, number[]> = {
  5:  [2, 3, 2, 3, 3],
  6:  [2, 3, 4, 3, 4],
  7:  [2, 3, 3, 4, 4],
  8:  [3, 4, 4, 5, 5],
  9:  [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;
/** 총 라운드(퀘스트) 수 */
export const QUEST_COUNT = 5;
/** 승리에 필요한 원정 성공/실패 수 */
export const WINS_NEEDED = 3;
/** 한 라운드에서 이만큼 연속 거부되면 악 승리 */
export const MAX_REJECTS = 5;

/** 인원수 클램프 (방어적) */
function clampCount(playerCount: number): number {
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, playerCount));
}

/** 플레이어 수에 맞는 카드 구성 (길이 = playerCount) */
export function setupFor(playerCount: number): Role[] {
  return [...SETUPS[clampCount(playerCount)]!];
}

/** roundIdx(0~4) 원정대 인원 */
export function teamSizeFor(playerCount: number, roundIdx: number): number {
  return MISSION_TABLE[clampCount(playerCount)]![roundIdx]!;
}

/**
 * roundIdx 원정 실패에 필요한 실패 카드 수.
 * 정식: 7인 이상에서 4번째 원정(roundIdx===3)만 실패 2장 필요. 그 외 전부 1장.
 */
export function failsRequiredFor(playerCount: number, roundIdx: number): number {
  return playerCount >= 7 && roundIdx === 3 ? 2 : 1;
}

// ============================================
// 카드 배분 & 밤 지식
// ============================================

/** 배열 제자리 셔플 (Fisher-Yates). rng 는 [0,1) 난수 함수 (호스트가 Math.random 주입) */
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * 좌석(peerId 순서)에 역할을 나눠준다.
 * @param seats 플레이어 peerId 배열
 * @param deck  setupFor 결과 (인원수 카드 구성). 내부에서 셔플.
 * @param rng   난수 함수
 * @returns peerId → Role
 */
export function dealRoles(
  seats: string[],
  deck: Role[],
  rng: () => number,
): Record<string, Role> {
  const shuffled = shuffle([...deck], rng);
  const roles: Record<string, Role> = {};
  seats.forEach((peerId, i) => {
    roles[peerId] = shuffled[i]!;
  });
  return roles;
}

/**
 * 각 플레이어가 밤에 얻는 지식 (역할별로 다름). 비밀이라 av:info 로 개별 전송.
 *  - none:            아무것도 모름 (충직한 신하)
 *  - alone:           고립 — 아무도 못 봄 (오베론)
 *  - evilTeam:        같은 악 목록 (오베론 제외, 자신 제외) — 악들끼리
 *  - merlinView:      악 목록 (모드레드 제외, 오베론 포함) — 멀린
 *  - merlinCandidates: 멀린 후보 2명 (진짜 멀린 + 모르가나, 셔플) — 퍼시발
 */
export type Knowledge =
  | { kind: 'none' }
  | { kind: 'alone' }
  | { kind: 'evilTeam'; peerIds: string[] }
  | { kind: 'merlinView'; peerIds: string[] }
  | { kind: 'merlinCandidates'; peerIds: string[] };

/**
 * 역할 배분표로부터 각 플레이어의 밤 지식을 계산.
 * @param roles peerId → Role
 * @param rng   퍼시발 후보 순서 셔플용
 */
export function computeKnowledge(
  roles: Record<string, Role>,
  rng: () => number,
): Record<string, Knowledge> {
  const entries = Object.entries(roles) as [string, Role][];
  const evilAll = entries.filter(([, r]) => teamOf(r) === 'evil').map(([p]) => p);
  // 악끼리 서로 보이는 목록 = 악 전체에서 오베론 제외
  const evilVisible = entries
    .filter(([, r]) => teamOf(r) === 'evil' && r !== 'oberon')
    .map(([p]) => p);
  const merlinPeer = entries.find(([, r]) => r === 'merlin')?.[0] ?? null;
  const morganaPeer = entries.find(([, r]) => r === 'morgana')?.[0] ?? null;

  const result: Record<string, Knowledge> = {};
  for (const [peerId, role] of entries) {
    switch (role) {
      case 'merlin':
        // 악 전부 보되 모드레드는 안 보임 (오베론은 보임)
        result[peerId] = {
          kind: 'merlinView',
          peerIds: entries.filter(([, r]) => teamOf(r) === 'evil' && r !== 'mordred').map(([p]) => p),
        };
        break;
      case 'percival': {
        // 멀린 + 모르가나 후보 (순서 셔플 → 누가 진짜인지 모름)
        const cands = [merlinPeer, morganaPeer].filter((p): p is string => p !== null);
        result[peerId] = { kind: 'merlinCandidates', peerIds: shuffle(cands, rng) };
        break;
      }
      case 'oberon':
        result[peerId] = { kind: 'alone' };
        break;
      case 'assassin':
      case 'morgana':
      case 'mordred':
      case 'minion':
        // 같은 악 (오베론 제외, 자신 제외)
        result[peerId] = { kind: 'evilTeam', peerIds: evilVisible.filter((p) => p !== peerId) };
        break;
      case 'loyal':
      default:
        result[peerId] = { kind: 'none' };
        break;
    }
  }
  // evilAll 은 위에서 안 쓰지만, 향후 확장(악 전용 정보) 대비 파생만 해둠 — 미사용 경고 방지
  void evilAll;
  return result;
}

// ============================================
// 투표 · 원정 집계
// ============================================

/**
 * 찬반 투표 집계. 승인 > 거부면 원정 승인. 동수면 거부(정식: 과반 필요).
 * @param votes peerId → 'approve'|'reject' (전원)
 */
export function tallyVote(votes: Record<string, Vote>): Vote {
  let approve = 0;
  let reject = 0;
  for (const v of Object.values(votes)) {
    if (v === 'approve') approve++;
    else reject++;
  }
  return approve > reject ? 'approve' : 'reject';
}

/**
 * 원정 결과 판정. 실패 카드가 failsRequired 장 이상이면 실패.
 * @param cards          원정대원이 낸 카드들
 * @param failsRequired  이 원정을 실패시키는 데 필요한 실패 장수 (1 또는 2)
 */
export function resolveQuest(cards: QuestCard[], failsRequired: number): { result: QuestCard; fails: number } {
  const fails = cards.filter((c) => c === 'fail').length;
  return { result: fails >= failsRequired ? 'fail' : 'success', fails };
}

/** 성공/실패 원정 수 집계 */
export function countQuests(results: (QuestCard | null)[]): { success: number; fail: number } {
  let success = 0;
  let fail = 0;
  for (const r of results) {
    if (r === 'success') success++;
    else if (r === 'fail') fail++;
  }
  return { success, fail };
}

// ============================================
// 공개 상태 · 결과
// ============================================

/** 게임 종료 사유 */
export type EndReason = 'quests' | 'reject5' | 'assassin';

/** result 페이즈 공개 결과 (전 역할·퀘스트트랙·암살결과 공개) */
export interface RevealData {
  /** peerId → 역할 (전체 공개) */
  roles: Record<string, Role>;
  /** 라운드별 성공/실패 (미진행 라운드는 null) */
  questResults: (QuestCard | null)[];
  winningSide: Team;
  reason: EndReason;
  /** 암살자가 지목한 대상 (reason==='assassin' 또는 선 3승 후 지목 시) */
  assassinTarget: string | null;
  /** 실제 멀린 peerId (암살 성패 표시용) */
  merlinPeer: string | null;
}

/**
 * 전원이 공유하는 공개 상태. 비밀(내 역할/밤 지식/누가 무슨 카드 냈는지)은 여기 없다.
 */
export interface PublicState {
  phase: Phase;
  /** 좌석 순서 (호스트 먼저) */
  players: AvPlayer[];
  /** 현재 리더 인덱스 (players 기준) */
  leaderIdx: number;
  /** 현재 라운드 (0~4) */
  roundIdx: number;
  /** 이번 라운드 원정대 인원 */
  teamSize: number;
  /** 이번 라운드 원정 실패에 필요한 실패 장수 (1 또는 2) */
  failsRequired: number;
  /** 이번 라운드 연속 거부 횟수 (0~5) */
  rejectCount: number;
  /** 현재 제안된/확정된 원정대 peerIds */
  proposedTeam: string[];
  /** 투표 집계 후 공개되는 전원 투표 내역 (vote 페이즈 결과 표시용). 그 외 null */
  votes: Record<string, Vote> | null;
  /** 직전 투표 결과 (표시용) */
  lastVoteResult: Vote | null;
  /** 라운드별 성공/실패 (길이 5, 미진행 null) */
  questResults: (QuestCard | null)[];
  /** 라운드별 실패 카드 수 (길이 5, 미진행 null) — 결과 공개용 */
  questFailCounts: (number | null)[];
  /** deal 페이즈: 역할 확인 완료 인원 */
  readyCount: number;
  /** quest 페이즈: 카드 제출 완료 인원 (누가/무엇인지는 비밀) */
  submitCount: number;
  /** 원정대 토론 채팅 로그 (최근 것만 유지) */
  chatLog: ChatLine[];
  /** result 페이즈에서만 non-null */
  reveal: RevealData | null;
}
