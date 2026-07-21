/**
 * 블루마블(부루마블) — 규칙 / 보드 데이터 / 순수 계산 함수.
 *
 * 이 파일은 "순수"하다: 네트워크·DOM·랜덤 없음. 상태를 받아 계산하거나 새 상태로 바꾸는 함수만.
 *   - 랜덤(주사위·황금열쇠 뽑기)은 호스트가 index.ts 에서 굴려서 결과를 넣어준다(호스트 authoritative).
 *   - 그래야 호스트가 정한 결과를 게스트가 그대로 반영해 상태가 어긋나지 않음.
 *
 * 보드: 40칸, 시계방향(0=출발). 목업(bluemarble-mockup)과 동일 구성.
 */

// ── 도시 색 그룹 (같은 색끼리 한 변에 연속) ──
export type GroupColor = 'tan' | 'sky' | 'pink' | 'orange' | 'red' | 'yellow' | 'green' | 'rose' | 'teal' | 'navy';

/** 칸 종류. city=도시(건물 지음), island=섬(인수불가·개수 통행료), special/corner=이벤트 칸 */
export type TileType = 'city' | 'island' | 'special' | 'corner';

export interface CityTile { type: 'city'; name: string; group: GroupColor; price: number; }
/** spot: island=섬(파랑, 보유 개수 기반) / beach=해변(붉은, 방문 횟수 기반) */
export interface IslandTile { type: 'island'; name: string; price: number; spot: 'island' | 'beach'; }
/** special.kind: goldkey=황금열쇠 / tax=세금 / concert=콘서트홀 */
export interface SpecialTile { type: 'special'; name: string; kind: 'goldkey' | 'tax' | 'concert' | 'bonus'; taxAmount?: number; }
/** corner.kind: start=출발 / desert=무인도 / welfare=사회복지기금 / space=우주여행 */
export interface CornerTile { type: 'corner'; name: string; kind: 'start' | 'desert' | 'welfare' | 'space'; }
export type Tile = CityTile | IslandTile | SpecialTile | CornerTile;

// ── 상수 ──
export const BOARD_SIZE = 32;
/** 출발 통과/도착 시 받는 월급 */
export const SALARY = 200000;
/** 시작 자금 (300만원) */
export const START_MONEY = 3000000;
/** 무인도에 갇히는 최대 턴 수 */
export const DESERT_TURNS = 3;
/** 무인도 탈출 비용 (돈 내고 즉시 탈출) */
export const DESERT_ESCAPE = 300000;
/** 세계여행 비용 */
export const TRAVEL_COST = 400000;
/** 오락실(보너스 게임) 기본(최소) 판돈 */
export const BONUS_STAKE = 100000;

// ── 건물 종류 (각각 따로 지음) ──
export type BuildKind = 'villa' | 'house2' | 'apt' | 'landmark';
export interface BuildMeta {
  kind: BuildKind;
  name: string;
  /** 건설비 = 도시가격 × costMul */
  costMul: number;
  /** 통행료 기여 = 도시가격 × tollMul (지은 것 합산) */
  tollMul: number;
  /** 해금에 필요한 바퀴 수 */
  lap: number;
}
export const BUILD_TYPES: BuildMeta[] = [
  { kind: 'villa', name: '별장', costMul: 0.5, tollMul: 0.3, lap: 0 },
  { kind: 'house2', name: '빌딩', costMul: 0.7, tollMul: 0.5, lap: 1 },
  { kind: 'apt', name: '호텔', costMul: 1.0, tollMul: 0.8, lap: 2 },
  { kind: 'landmark', name: '랜드마크', costMul: 1.5, tollMul: 2.0, lap: 3 },
];
/** 땅만 있을 때 통행료 배수 (건물 없음) */
export const BASE_TOLL_MUL = 0.1;
export function buildMeta(kind: BuildKind): BuildMeta {
  return BUILD_TYPES.find((b) => b.kind === kind)!;
}
/** 랜드마크 건설 전제: 별장·2층집·아파트 모두 있어야 */
export function hasAllHouses(builds: BuildKind[]): boolean {
  return builds.includes('villa') && builds.includes('house2') && builds.includes('apt');
}

/**
 * 32칸 보드 (9×9, 한 변 8칸 = 모서리 포함). index 0=출발, 반시계(모두의마블 월드맵 배치).
 * 색 그룹은 기존 팔레트 재사용: 하단 초록(green/teal) · 좌측 파랑(sky/navy)
 * · 상단 핑크(pink/rose) · 우측 주황·빨강(orange/red).
 * 모서리: 출발/무인도/올림픽(=welfare)/세계여행(=space) — 기존 코너 메커니즘 유지.
 * 보너스 게임은 기존 황금열쇠(goldkey) 메커니즘 재사용.
 */
export const BOARD: Tile[] = [
  { type: 'corner', kind: 'start', name: '출발' },
  // 1라인 (하단) — 대지 5~8만
  { type: 'city', group: 'green', name: '방콕', price: 50000 },
  { type: 'special', kind: 'bonus', name: '보너스 게임' },
  { type: 'city', group: 'green', name: '베이징', price: 60000 },
  { type: 'island', name: '독도', price: 80000, spot: 'island' },
  { type: 'city', group: 'teal', name: '타이베이', price: 65000 },
  { type: 'city', group: 'teal', name: '두바이', price: 72000 },
  { type: 'city', group: 'teal', name: '카이로', price: 80000 },
  { type: 'corner', kind: 'desert', name: '무인도' },
  // 2라인 (좌측) — 대지 10~15만
  { type: 'island', name: '발리', price: 110000, spot: 'beach' },
  { type: 'city', group: 'sky', name: '도쿄', price: 100000 },
  { type: 'city', group: 'sky', name: '시드니', price: 115000 },
  { type: 'special', kind: 'goldkey', name: '황금열쇠' },
  { type: 'city', group: 'navy', name: '퀘벡', price: 130000 },
  { type: 'island', name: '하와이', price: 140000, spot: 'island' },
  { type: 'city', group: 'navy', name: '상파울루', price: 150000 },
  { type: 'corner', kind: 'welfare', name: '올림픽' },
  // 3라인 (상단) — 대지 18~25만
  { type: 'city', group: 'pink', name: '프라하', price: 180000 },
  { type: 'island', name: '푸켓', price: 210000, spot: 'island' },
  { type: 'city', group: 'pink', name: '베를린', price: 200000 },
  { type: 'special', kind: 'goldkey', name: '황금열쇠' },
  { type: 'city', group: 'rose', name: '모스크바', price: 215000 },
  { type: 'city', group: 'rose', name: '제네바', price: 235000 },
  { type: 'city', group: 'rose', name: '로마', price: 250000 },
  { type: 'corner', kind: 'space', name: '세계여행' },
  // 4라인 (우측) — 대지 30~40만
  { type: 'island', name: '타히티', price: 350000, spot: 'beach' },
  { type: 'city', group: 'orange', name: '런던', price: 300000 },
  { type: 'city', group: 'orange', name: '파리', price: 330000 },
  { type: 'special', kind: 'goldkey', name: '황금열쇠' },
  { type: 'city', group: 'red', name: '뉴욕', price: 370000 },
  { type: 'special', kind: 'tax', name: '국세청', taxAmount: 300000 },
  { type: 'city', group: 'red', name: '서울', price: 400000 },
];

/** 섬 칸 인덱스 목록 (개수별 통행료 계산용) */
export const ISLAND_TILES = BOARD.map((t, i) => (t.type === 'island' ? i : -1)).filter((i) => i >= 0);

/** 그룹(색) → 그 색 도시 index 목록 (컬러 독점 판정용) */
export const GROUP_TILES: Partial<Record<GroupColor, number[]>> = (() => {
  const m: Partial<Record<GroupColor, number[]>> = {};
  BOARD.forEach((t, i) => { if (t.type === 'city') (m[t.group] ??= []).push(i); });
  return m;
})();
export const CITY_GROUPS = Object.keys(GROUP_TILES) as GroupColor[];

/** 각 변(라인)의 도시 index 목록. 0=하단·1=좌·2=상·3=우 (라인 독점 판정용) */
export const SIDE_CITIES: number[][] = (() => {
  const sides: number[][] = [[], [], [], []];
  BOARD.forEach((t, i) => {
    if (t.type !== 'city') return;
    sides[i <= 8 ? 0 : i <= 16 ? 1 : i <= 24 ? 2 : 3]!.push(i);
  });
  return sides;
})();

/** 그 색 도시를 전부 소유했는지 (컬러 독점) */
export function ownsGroup(state: BMState, peer: string, group: GroupColor): boolean {
  const tiles = GROUP_TILES[group];
  return !!tiles && tiles.length > 0 && tiles.every((i) => state.owner[i] === peer);
}
/** 이 도시의 컬러 독점 통행료 배수 (독점이면 2, 아니면 1) */
export function colorMonopolyMul(state: BMState, tile: number, owner: string): number {
  const t = BOARD[tile];
  return t.type === 'city' && ownsGroup(state, owner, t.group) ? 2 : 1;
}
/** 완성한 컬러 독점 개수 */
export function fullGroupsOwned(state: BMState, peer: string): number {
  return CITY_GROUPS.filter((g) => ownsGroup(state, peer, g)).length;
}
/** 한 변의 도시를 전부 소유했는지 (라인 독점) */
export function ownsAnyLine(state: BMState, peer: string): boolean {
  return SIDE_CITIES.some((cs) => cs.length > 0 && cs.every((i) => state.owner[i] === peer));
}
/** 모든 관광지(섬) 소유 여부 (관광지 독점) */
export function ownsAllIslands(state: BMState, peer: string): boolean {
  return ISLAND_TILES.length > 0 && ISLAND_TILES.every((i) => state.owner[i] === peer);
}
/** 독점 즉시승 판정 → 사유(트리플/라인/관광지) 또는 null */
export function monopolyWin(state: BMState, peer: string): string | null {
  if (fullGroupsOwned(state, peer) >= 3) return '트리플 독점';
  if (ownsAnyLine(state, peer)) return '라인 독점';
  if (ownsAllIslands(state, peer)) return '관광지 독점';
  return null;
}

// ── 황금열쇠 / 포춘카드 ──
export type CardEffect =
  | 'money'        // money>0 받음 / <0 냄
  | 'birthday'     // 나 뺀 모두가 나에게 money씩
  | 'proptax'      // 보유 현금의 10% 납부
  | 'go'           // 출발로 이동(+월급)
  | 'jail'         // 무인도 유배(3턴)
  | 'back3'        // 뒤로 3칸
  | 'topcity'      // 최고가 도시로 강제 이동
  | 'olympicGrant' // (보관) 내 도시 올림픽 개최
  | 'tollExempt'   // (보관) 다음 통행료 1회 면제
  | 'jailFree'     // (보관) 무인도 즉시 탈출
  | 'travel'       // (보관) 세계여행 대기
  | 'swap'         // [공격] 내 도시 ↔ 상대 도시 소유권 교환
  | 'quake'        // [공격] 상대 도시 건물 한 단계 파괴
  | 'blackout';    // [공격] 상대 도시 통행료 3턴간 0
export interface GoldCard {
  id: number;
  title: string;
  desc: string;
  /** UI 아이콘 키 (render 에서 SVG 매핑) */
  icon: string;
  effect: CardEffect;
  /** money 계열 금액 (birthday=1인당) */
  money?: number;
  /** 뽑기 가중치 (클수록 자주) */
  weight: number;
  /** 즉시 사용 불가 → 자동 보관 */
  keep?: boolean;
}
export const CARDS: GoldCard[] = [
  { id: 0, title: '은행 이자', desc: '은행에서 ₩150,000 받기', icon: 'coin', effect: 'money', money: 150000, weight: 13 },
  { id: 1, title: '보너스 마블', desc: '보너스 ₩250,000 받기', icon: 'coin', effect: 'money', money: 250000, weight: 8 },
  { id: 2, title: '복권 당첨', desc: '대박! ₩1,500,000 획득', icon: 'ticket', effect: 'money', money: 1500000, weight: 2 },
  { id: 3, title: '생일 축하', desc: '다른 모두에게 각 ₩100,000 받기', icon: 'cake', effect: 'birthday', money: 100000, weight: 6 },
  { id: 4, title: '병원비', desc: '₩120,000 납부', icon: 'cross', effect: 'money', money: -120000, weight: 9 },
  { id: 5, title: '속도위반 벌금', desc: '₩80,000 납부', icon: 'siren', effect: 'money', money: -80000, weight: 9 },
  { id: 6, title: '재산세', desc: '보유 현금의 10% 납부', icon: 'coin', effect: 'proptax', weight: 6 },
  { id: 7, title: '출발로 이동', desc: '출발로 이동하고 월급 받기', icon: 'flag', effect: 'go', weight: 6 },
  { id: 8, title: '무인도 유배', desc: '무인도로! 3턴 갇힘', icon: 'island', effect: 'jail', weight: 4 },
  { id: 9, title: '뒤로 3칸', desc: '뒤로 3칸 이동', icon: 'flag', effect: 'back3', weight: 5 },
  { id: 10, title: '최고가 도시로', desc: '가장 비싼 도시로 강제 이동', icon: 'flag', effect: 'topcity', weight: 3 },
  { id: 11, title: '올림픽 개최', desc: '내 도시 한 곳에 올림픽 개최(통행료 배수↑)', icon: 'rings', effect: 'olympicGrant', weight: 5 },
  { id: 12, title: '통행료 면제권', desc: '다음 통행료 1회 면제', icon: 'ticket', effect: 'tollExempt', keep: true, weight: 6 },
  { id: 13, title: '무인도 탈출권', desc: '무인도 즉시 탈출', icon: 'island', effect: 'jailFree', keep: true, weight: 4 },
  { id: 14, title: '세계여행', desc: '원하는 칸으로 즉시 이동', icon: 'rocket', effect: 'travel', weight: 4 },
  { id: 15, title: '도시 교환', desc: '내 도시 ↔ 상대 도시 맞바꾸기', icon: 'swap', effect: 'swap', weight: 3 },
  { id: 16, title: '지진', desc: '상대 도시 건물 1단계 파괴', icon: 'quake', effect: 'quake', weight: 3 },
  { id: 17, title: '정전', desc: '상대 도시 통행료 3턴간 0', icon: 'blackout', effect: 'blackout', weight: 3 },
];
/** 가중치 뽑기 (rng: 0~1) → 카드 id */
export function drawCardId(rng: number): number {
  const total = CARDS.reduce((s, c) => s + c.weight, 0);
  let x = rng * total;
  for (const c of CARDS) { if ((x -= c.weight) < 0) return c.id; }
  return CARDS[0]!.id;
}
/** 가장 비싼 도시 칸 index */
export const TOP_CITY_TILE = BOARD.reduce((best, t, i) => (t.type === 'city' && t.price > ((BOARD[best] as CityTile | undefined)?.price ?? -1) ? i : best), -1);
/** 무인도 칸 index */
export const DESERT_TILE = BOARD.findIndex((t) => t.type === 'corner' && t.kind === 'desert');
/** 세계여행 칸 index */
export const SPACE_TILE = BOARD.findIndex((t) => t.type === 'corner' && t.kind === 'space');

// ============================================
// 상태
// ============================================

export interface BMPlayer {
  peerId: string;
  nickname: string;
  money: number;
  /** 파산(탈락) 여부 */
  bankrupt: boolean;
  /** 무인도 남은 대기 턴 (0이면 자유) */
  desertLeft: number;
  /** 완주한 바퀴 수 (출발 통과 시 +1). 각 건물 해금(BuildMeta.lap)에 사용 */
  laps: number;
  /** 세계여행권 대기 — true면 다음 턴에 원하는 칸으로 이동 */
  travelReady: boolean;
  /** 통행료 면제권 사용 — true면 다음 통행료 1회 면제 */
  tollExempt: boolean;
}

/** 현재 턴 플레이어가 "결정"해야 하는 상황 (구매/건설/인수/카드). 없으면 null */
export type Pending =
  | { kind: 'buy'; tile: number }
  | { kind: 'build'; tile: number }                 // 내 도시 도착 → 건설 메뉴(원하는 건물 선택)
  | { kind: 'acquire'; tile: number; cost: number }
  | { kind: 'card'; card: number }
  | { kind: 'info'; tile: number; text: string }   // 잠깐 안내(돈 부족 등) 후 자동으로 턴 넘김
  | { kind: 'event'; tile: number; text: string; amount: number }  // 세금 등 — 모두에게 창, 밟은 사람만 확인해 닫음
  | { kind: 'cardSwapMine' }                        // 도시 교환: 내 도시 선택
  | { kind: 'cardSwapTheirs'; mine: number }        // 도시 교환: 바꿀 상대 도시 선택
  | { kind: 'cardQuake' }                           // 지진: 부술 상대 도시 선택
  | { kind: 'cardBlackout' }                        // 정전: 마비시킬 상대 도시 선택
  | { kind: 'olympic'; free?: boolean }             // 올림픽 도착(또는 카드=free) → 내 도시 하나에 개최
  | { kind: 'travel' }                              // 세계여행 → 원하는 칸 선택해 이동
  | { kind: 'startBuild' }                          // 출발 정확히 멈춤 → 내 도시 하나 추가 건설
  | { kind: 'bonusOffer' }                          // 오락실: 할지/판돈(100·200·300) 선택
  | { kind: 'bonus'; stake: number; round: number; pot: number }  // 오락실 2지선다
  | null;

export interface BMState {
  /** 좌석 순서 (peerId). 파산해도 배열엔 남고 bankrupt 플래그로 스킵 */
  order: string[];
  players: Record<string, BMPlayer>;
  /** peerId → 현재 칸 */
  pos: Record<string, number>;
  /** 칸 index → 소유자 peerId */
  owner: Record<number, string>;
  /** 칸 index → 지어진 건물 목록. 도시만(섬은 소유만, 건물 없음) */
  builds: Record<number, BuildKind[]>;
  /** peerId → 보관 중인 카드 id 목록 */
  held: Record<string, number[]>;
  /** order 내 현재 차례 인덱스 */
  turnIdx: number;
  /** 마지막 주사위 [a,b]. 없으면 null */
  dice: [number, number] | null;
  /** 연속 더블 횟수 (3번이면 무인도) */
  doubles: number;
  /** 현재 결정 대기 (구매 등). 있으면 그 턴 플레이어가 처리해야 함 */
  pending: Pending;
  /** 사회복지기금 적립액 (세금이 여기 쌓이고, 사회복지기금 칸 도착 시 수령) */
  fund: number;
  /** 도시 index → 올림픽 개최 배수(2~5). 올림픽 칸 도착 후 내 도시에 개최하면 누적 */
  olympic: Record<number, number>;
  /** 해변 관광지 index → 방문 횟수(1~3). 누가 밟든 +1 (통행료 배수) */
  beachVisits: Record<number, number>;
  /** 정전(디버프) 도시 index → 남은 턴 수. >0이면 통행료 0 */
  blackout: Record<number, number>;
  phase: 'playing' | 'ended';
  /** 승자 peerId (phase==='ended') */
  winnerPeerId: string | null;
  /** UI 안내 문구 */
  log: string;
  /** 타격감/획득 연출용 (seq가 바뀌면 렌더러가 1회 재생). kind: toll=통행료, gain=획득, bankrupt=파산. from=낸사람, to=받는사람 */
  fx: { seq: number; amount: number; mul: number; kind: 'toll' | 'gain' | 'bankrupt'; from?: string; to?: string; nick?: string } | null;
  /** 세계여행 비행기 애니 (seq 바뀌면 from→to 비행 재생) */
  travelFx: { seq: number; by: string; from: number; to: number } | null;
  /** 카드 연출 (seq 바뀌면 1회 재생). fly=말 이동, quake=건물 파괴, swap=도시 교환, toast=안내 */
  cardFx: { seq: number; kind: 'fly' | 'quake' | 'swap' | 'toast'; by?: string; from?: number; to?: number; tile?: number; tile2?: number; text?: string } | null;
}

// ============================================
// 순수 계산 함수
// ============================================

/** 소유자가 가진 관광지 총 개수(섬+해변) */
export function islandCount(state: BMState, peerId: string): number {
  return ISLAND_TILES.filter((i) => state.owner[i] === peerId).length;
}
/** 소유자가 가진 "섬(파랑, 개수기반)" 개수 — 섬 통행료 배수용 */
export function seaIslandCount(state: BMState, peerId: string): number {
  return ISLAND_TILES.filter((i) => state.owner[i] === peerId && (BOARD[i] as IslandTile).spot === 'island').length;
}

/** 통행료 배수 한 줄 (UI 상세 표시용) */
export interface TollPart { label: string; mul: number; }
/** 통행료 상세: 기본액 + 배수 항목들 + 최종액 */
export interface TollInfo { base: number; parts: TollPart[]; total: number; }

/** 통행료 상세 계산 (모든 배수는 곱연산으로 중첩). 소유자 없거나 본인이면 0. */
export function tollBreakdown(state: BMState, tile: number, byPeerId: string): TollInfo {
  const t = BOARD[tile];
  const o = state.owner[tile];
  if (o === undefined || o === byPeerId) return { base: 0, parts: [], total: 0 };
  if ((state.blackout[tile] ?? 0) > 0) return { base: 0, parts: [{ label: '정전 — 통행료 0', mul: 0 }], total: 0 };
  const parts: TollPart[] = [];
  if (t.type === 'island') {
    const base = Math.round(t.price * 0.5);
    if (t.spot === 'island') {
      // 섬(파랑): 보유 섬 수에 따라 1개×1·2개×2·3개×4
      const n = seaIslandCount(state, o);
      const mul = Math.pow(2, Math.max(0, n - 1));
      if (mul > 1) parts.push({ label: `섬 ${n}개 ×${mul}`, mul });
      return { base, parts, total: Math.round(base * mul) };
    }
    // 해변(붉은): 방문 횟수에 따라 ×1~×3
    const v = Math.min(3, Math.max(1, state.beachVisits[tile] ?? 1));
    if (v > 1) parts.push({ label: `해변 방문 ×${v}`, mul: v });
    return { base, parts, total: Math.round(base * v) };
  }
  if (t.type === 'city') {
    const arr = state.builds[tile] ?? [];
    const base = Math.round(t.price * (BASE_TOLL_MUL + arr.reduce((s, k) => s + buildMeta(k).tollMul, 0)));
    let total = base;
    const cm = colorMonopolyMul(state, tile, o);
    if (cm > 1) { parts.push({ label: `컬러 독점 ×${cm}`, mul: cm }); total *= cm; }
    const oly = state.olympic[tile] ?? 1;
    if (oly > 1) { parts.push({ label: `올림픽 개최 ×${oly}`, mul: oly }); total *= oly; }
    return { base, parts, total: Math.round(total) };
  }
  return { base: 0, parts: [], total: 0 };
}

/** 그 칸을 밟았을 때 내야 하는 최종 통행료. */
export function tollFor(state: BMState, tile: number, byPeerId: string): number {
  return tollBreakdown(state, tile, byPeerId).total;
}

/** 라인(변)별 건물 건설비. 0=1라인(가장 쌈) … 3=4라인(가장 비쌈). 대지값과 별개 고정. */
export const LINE_BUILD: Record<BuildKind, number>[] = [
  { villa: 80000,  house2: 170000, apt: 270000,  landmark: 400000 },   // 1라인
  { villa: 180000, house2: 350000, apt: 450000,  landmark: 650000 },   // 2라인
  { villa: 350000, house2: 570000, apt: 750000,  landmark: 1000000 },  // 3라인
  { villa: 500000, house2: 780000, apt: 950000,  landmark: 1300000 },  // 4라인
];
/** 칸 index → 라인(0~3). 보드 배치(9×9, 반시계) 기준: 하단·좌·상·우 */
export function lineOf(tile: number): number {
  return tile <= 8 ? 0 : tile <= 16 ? 1 : tile <= 24 ? 2 : 3;
}
/** 특정 건물 건설비 = 라인별 고정 건설비 */
export function buildCostOf(tile: number, kind: BuildKind): number {
  if (BOARD[tile].type !== 'city') return 0;
  return LINE_BUILD[lineOf(tile)]![kind];
}

/** 이 플레이어가 이 도시에 이 건물을 "지금" 지을 수 있는지 (미보유·바퀴해금·랜드마크전제·돈) */
export function canBuild(state: BMState, tile: number, peerId: string, kind: BuildKind): boolean {
  const t = BOARD[tile];
  if (t.type !== 'city' || state.owner[tile] !== peerId) return false;
  const arr = state.builds[tile] ?? [];
  if (arr.includes(kind)) return false;
  const meta = buildMeta(kind);
  if (state.players[peerId]!.laps < meta.lap) return false;
  if (kind === 'landmark' && !hasAllHouses(arr)) return false;
  return state.players[peerId]!.money >= buildCostOf(tile, kind);
}

/** 남의 도시 인수 비용 = (땅값 + 지은 건물 건설비 합) × 배율. 랜드마크 있으면 인수 불가 → -1 */
const ACQUIRE_MUL = 1.5;
export function acquireCost(state: BMState, tile: number): number {
  const t = BOARD[tile];
  if (t.type !== 'city') return -1;
  const arr = state.builds[tile] ?? [];
  if (arr.includes('landmark')) return -1;
  const value = t.price + arr.reduce((v, k) => v + buildCostOf(tile, k), 0);
  return Math.round(value * ACQUIRE_MUL);
}

/** 파산 안 한 다음 차례 인덱스 (현재 turnIdx 다음부터 시계방향으로 찾음) */
export function nextTurnIdx(state: BMState): number {
  const n = state.order.length;
  for (let step = 1; step <= n; step++) {
    const idx = (state.turnIdx + step) % n;
    if (!state.players[state.order[idx]!]!.bankrupt) return idx;
  }
  return state.turnIdx;
}

/** 살아있는(파산 안 한) 플레이어 peerId 목록 */
export function alivePeers(state: BMState): string[] {
  return state.order.filter((p) => !state.players[p]!.bankrupt);
}

/** 초기 상태 생성. players = 좌석 순서대로. */
export function createInitialState(players: Array<{ peerId: string; nickname: string }>): BMState {
  const order = players.map((p) => p.peerId);
  const pmap: Record<string, BMPlayer> = {};
  const pos: Record<string, number> = {};
  const held: Record<string, number[]> = {};
  for (const p of players) {
    pmap[p.peerId] = { peerId: p.peerId, nickname: p.nickname, money: START_MONEY, bankrupt: false, desertLeft: 0, laps: 0, travelReady: false, tollExempt: false };
    pos[p.peerId] = 0;
    held[p.peerId] = [];
  }
  return {
    order, players: pmap, pos, owner: {}, builds: {}, held,
    turnIdx: 0, dice: null, doubles: 0, pending: null, fund: 0,
    olympic: {}, beachVisits: {}, blackout: {},
    phase: 'playing', winnerPeerId: null, log: '', fx: null, travelFx: null, cardFx: null,
  };
}
