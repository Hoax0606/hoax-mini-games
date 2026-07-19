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
export interface IslandTile { type: 'island'; name: string; price: number; }
/** special.kind: goldkey=황금열쇠 / tax=세금 / concert=콘서트홀 */
export interface SpecialTile { type: 'special'; name: string; kind: 'goldkey' | 'tax' | 'concert'; taxAmount?: number; }
/** corner.kind: start=출발 / desert=무인도 / welfare=사회복지기금 / space=우주여행 */
export interface CornerTile { type: 'corner'; name: string; kind: 'start' | 'desert' | 'welfare' | 'space'; }
export type Tile = CityTile | IslandTile | SpecialTile | CornerTile;

// ── 상수 ──
export const BOARD_SIZE = 32;
/** 출발 통과/도착 시 받는 월급 */
export const SALARY = 200;
/** 시작 자금 */
export const START_MONEY = 2000;
/** 무인도에 갇히는 최대 턴 수 */
export const DESERT_TURNS = 3;
/** 무인도 탈출 비용 (돈 내고 즉시 탈출) */
export const DESERT_ESCAPE = 300;

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
  { kind: 'house2', name: '2층집', costMul: 0.7, tollMul: 0.5, lap: 1 },
  { kind: 'apt', name: '아파트', costMul: 1.0, tollMul: 0.8, lap: 2 },
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
  // 하단 (초록)
  { type: 'city', group: 'green', name: '홍콩', price: 80 },
  { type: 'special', kind: 'goldkey', name: '보너스 게임' },
  { type: 'city', group: 'green', name: '베이징', price: 100 },
  { type: 'island', name: '독도', price: 130 },
  { type: 'city', group: 'teal', name: '타이베이', price: 120 },
  { type: 'city', group: 'teal', name: '두바이', price: 140 },
  { type: 'city', group: 'teal', name: '카이로', price: 160 },
  { type: 'corner', kind: 'desert', name: '무인도' },
  // 좌측 (파랑)
  { type: 'island', name: '라하바나', price: 170 },
  { type: 'city', group: 'sky', name: '시드니', price: 180 },
  { type: 'special', kind: 'goldkey', name: '황금열쇠' },
  { type: 'city', group: 'sky', name: '밴쿠버', price: 200 },
  { type: 'island', name: '하와이', price: 210 },
  { type: 'city', group: 'navy', name: '상파울로', price: 220 },
  { type: 'city', group: 'navy', name: '오클랜드', price: 240 },
  { type: 'corner', kind: 'welfare', name: '올림픽' },
  // 상단 (핑크·보라)
  { type: 'city', group: 'pink', name: '프라하', price: 260 },
  { type: 'city', group: 'pink', name: '부다페스트', price: 280 },
  { type: 'city', group: 'pink', name: '베를린', price: 300 },
  { type: 'special', kind: 'goldkey', name: '황금열쇠' },
  { type: 'city', group: 'rose', name: '모스크바', price: 320 },
  { type: 'city', group: 'rose', name: '제네바', price: 340 },
  { type: 'city', group: 'rose', name: '로마', price: 360 },
  { type: 'corner', kind: 'space', name: '세계여행' },
  // 우측 (주황·빨강)
  { type: 'island', name: '타이티', price: 300 },
  { type: 'city', group: 'orange', name: '런던', price: 380 },
  { type: 'city', group: 'orange', name: '파리', price: 400 },
  { type: 'special', kind: 'goldkey', name: '황금열쇠' },
  { type: 'city', group: 'red', name: '뉴욕', price: 450 },
  { type: 'city', group: 'red', name: '서울', price: 500 },
  { type: 'special', kind: 'tax', name: '국세청', taxAmount: 200 },
];

/** 섬 칸 인덱스 목록 (개수별 통행료 계산용) */
export const ISLAND_TILES = BOARD.map((t, i) => (t.type === 'island' ? i : -1)).filter((i) => i >= 0);

// ── 황금열쇠 카드 ──
/** effect: money(+받음/-냄), moveTo(칸 이동), pass(이동 시 출발 통과 월급), keep(보관 가능) */
export interface GoldCard {
  id: number;
  title: string;
  /** UI 아이콘 키 (render 에서 SVG 매핑) */
  icon: string;
  money?: number;
  moveTo?: number;
  pass?: boolean;
  keep?: boolean;
}
export const CARDS: GoldCard[] = [
  { id: 0, title: '은행 이자', icon: 'coin', money: 150 },
  { id: 1, title: '생일 축하', icon: 'cake', money: 120 },
  { id: 2, title: '복권 당첨', icon: 'ticket', money: 300 },
  { id: 3, title: '병원비', icon: 'cross', money: -100 },
  { id: 4, title: '속도위반 벌금', icon: 'siren', money: -80 },
  { id: 5, title: '출발로 이동', icon: 'flag', moveTo: 0, pass: true },
  { id: 6, title: '통행료 면제권', icon: 'ticket', keep: true },
  { id: 7, title: '무인도 탈출권', icon: 'island', keep: true },
  { id: 8, title: '세계여행권', icon: 'rocket', moveTo: 24, keep: true },
];

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
}

/** 현재 턴 플레이어가 "결정"해야 하는 상황 (구매/건설/인수/카드). 없으면 null */
export type Pending =
  | { kind: 'buy'; tile: number }
  | { kind: 'build'; tile: number }                 // 내 도시 도착 → 건설 메뉴(원하는 건물 선택)
  | { kind: 'acquire'; tile: number; cost: number }
  | { kind: 'card'; card: number }
  | { kind: 'info'; tile: number; text: string }   // 잠깐 안내(돈 부족 등) 후 자동으로 턴 넘김
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
  phase: 'playing' | 'ended';
  /** 승자 peerId (phase==='ended') */
  winnerPeerId: string | null;
  /** UI 안내 문구 */
  log: string;
}

// ============================================
// 순수 계산 함수
// ============================================

/** 소유자가 가진 섬 개수 */
export function islandCount(state: BMState, peerId: string): number {
  return ISLAND_TILES.filter((i) => state.owner[i] === peerId).length;
}

/** 그 칸(도시/섬)을 밟았을 때 내야 하는 통행료. 소유자 없거나 본인 소유면 0. */
export function tollFor(state: BMState, tile: number, byPeerId: string): number {
  const t = BOARD[tile];
  const o = state.owner[tile];
  if (o === undefined || o === byPeerId) return 0;
  if (t.type === 'island') return Math.round(t.price * 0.5) * islandCount(state, o);
  if (t.type === 'city') {
    const arr = state.builds[tile] ?? [];
    const mul = BASE_TOLL_MUL + arr.reduce((s, k) => s + buildMeta(k).tollMul, 0);
    return Math.round(t.price * mul);
  }
  return 0;
}

/** 특정 건물 건설비 = 도시가격 × costMul */
export function buildCostOf(tile: number, kind: BuildKind): number {
  const t = BOARD[tile];
  if (t.type !== 'city') return 0;
  return Math.round(t.price * buildMeta(kind).costMul);
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

/** 남의 도시 인수 비용 = (땅값 + 지은 건물 건설비 합) × 2. 랜드마크 있으면 인수 불가 → -1 */
export function acquireCost(state: BMState, tile: number): number {
  const t = BOARD[tile];
  if (t.type !== 'city') return -1;
  const arr = state.builds[tile] ?? [];
  if (arr.includes('landmark')) return -1;
  const value = t.price + arr.reduce((v, k) => v + buildCostOf(tile, k), 0);
  return value * 2;
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
    pmap[p.peerId] = { peerId: p.peerId, nickname: p.nickname, money: START_MONEY, bankrupt: false, desertLeft: 0, laps: 0 };
    pos[p.peerId] = 0;
    held[p.peerId] = [];
  }
  return {
    order, players: pmap, pos, owner: {}, builds: {}, held,
    turnIdx: 0, dice: null, doubles: 0, pending: null, fund: 0,
    phase: 'playing', winnerPeerId: null, log: '',
  };
}
