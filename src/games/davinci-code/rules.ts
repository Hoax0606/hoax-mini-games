/**
 * 다빈치 코드 — 순수 규칙
 *
 * 네트워크도 화면도 모른다. 덱을 만들고, 자리를 계산하고, 승패를 판정하는 것만 한다.
 * 이 게임에서 제일 틀리기 쉬운 게 "정렬된 자리"와 "가려서 보내기"라, 연결 없이도
 * 그대로 불러볼 수 있게 떼어놨다.
 */

/** 타일 색. 같은 숫자면 검정이 왼쪽에 온다 */
export type TileColor = 'black' | 'white';

/** 조커는 숫자가 없다. 숫자 타일은 0~11 */
export const JOKER = -1;

export interface Tile {
  /** 0~11, 또는 조커면 JOKER(-1) */
  num: number;
  color: TileColor;
  /** 모두에게 공개됐는가 */
  revealed: boolean;
}

/** 남에게 보낼 때 쓰는 형태 — 닫힌 타일은 num 이 없다 */
export interface MaskedTile {
  num: number | null;
  color: TileColor;
  revealed: boolean;
}

export interface DvPlayer {
  peerId: string;
  nickname: string;
  /** 항상 정렬된 상태로 유지된다 */
  tiles: Tile[];
  /** 타일이 전부 공개돼 탈락했는가 */
  out: boolean;
}

/** 숫자 타일의 최대값 (0~11) */
export const MAX_NUM = 11;

/** 2인은 4장, 3~4인은 3장 — 원작 그대로 */
export function startHandSize(playerCount: number): number {
  return playerCount <= 2 ? 4 : 3;
}

/** 26장 전체 덱 (검정 0~11 + 조커, 흰색 0~11 + 조커) */
export function buildDeck(): Tile[] {
  const deck: Tile[] = [];
  for (const color of ['black', 'white'] as TileColor[]) {
    for (let n = 0; n <= MAX_NUM; n++) deck.push({ num: n, color, revealed: false });
    deck.push({ num: JOKER, color, revealed: false });
  }
  return deck;
}

/** Fisher-Yates. 호스트만 부른다(딜러가 한 명이어야 패가 안 갈린다) */
export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * 두 타일의 정렬 순서. 숫자 오름차순, 같으면 검정이 먼저.
 * 조커는 이 함수로 자리를 못 정한다 — 사람이 직접 고른다.
 */
export function compareTiles(a: Tile, b: Tile): number {
  if (a.num !== b.num) return a.num - b.num;
  return a.color === b.color ? 0 : a.color === 'black' ? -1 : 1;
}

/**
 * 숫자 타일이 들어갈 자리(인덱스).
 *
 * 조커가 섞여 있으면 조커는 비교 대상에서 빼야 한다 — 조커엔 숫자가 없어서
 * 끼워 넣을 기준이 안 된다. 조커를 건너뛰고 "양옆의 숫자 타일" 기준으로 자리를 잡는다.
 * 그래서 같은 손패라도 조커 위치에 따라 결과가 달라질 수 있는데, 그건 원래 그런 게임이다.
 */
export function insertIndexFor(tiles: Tile[], tile: Tile): number {
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]!;
    if (t.num === JOKER) continue;       // 조커는 기준이 못 된다
    if (compareTiles(tile, t) < 0) return i;
  }
  return tiles.length;
}

/** 조커를 넣을 수 있는 자리 수 (0 ~ tiles.length). 사람이 그 중 하나를 고른다 */
export function jokerSlotCount(tiles: Tile[]): number {
  return tiles.length + 1;
}

/** 타일을 i 번째에 끼워 넣은 새 배열 */
export function insertAt(tiles: Tile[], tile: Tile, index: number): Tile[] {
  const i = Math.max(0, Math.min(index, tiles.length));
  return [...tiles.slice(0, i), tile, ...tiles.slice(i)];
}

/** 추측이 맞았는가. 조커는 num 이 JOKER 인지로 비교한다(색은 이미 보이니 숫자만 맞히면 된다) */
export function isGuessRight(tile: Tile, guessNum: number): boolean {
  return tile.num === guessNum;
}

/** 닫힌 타일이 하나라도 남아있나 — 하나도 없으면 탈락 */
export function hasHidden(p: DvPlayer): boolean {
  return p.tiles.some((t) => !t.revealed);
}

/**
 * 받는 사람(viewerId) 기준으로 가린 플레이어 목록.
 *
 * 호스트 화면도 반드시 이걸 통과시킨다. 안 그러면 호스트만 남의 숫자가 보이는
 * 사고가 생기는데, 그건 코드를 읽기 전엔 아무도 눈치 못 챈다.
 *
 * 닫힌 타일도 **색은 남긴다**. 테이블에서도 뒷면 색은 보이고, 색 분포가 추리의
 * 핵심 단서다. 색까지 숨기면 게임이 성립하지 않는다.
 */
export function maskFor(
  players: DvPlayer[],
  viewerId: string,
): { peerId: string; nickname: string; out: boolean; tiles: MaskedTile[] }[] {
  return players.map((p) => ({
    peerId: p.peerId,
    nickname: p.nickname,
    out: p.out,
    tiles: p.tiles.map((t) => ({
      num: p.peerId === viewerId || t.revealed ? t.num : null,
      color: t.color,
      revealed: t.revealed,
    })),
  }));
}

/**
 * 아직 살아있는(닫힌 타일이 남은) 사람들.
 * 이탈자는 호스트가 players 에서 먼저 빼므로 여기선 신경 쓰지 않는다.
 */
export function alivePlayers(players: DvPlayer[]): DvPlayer[] {
  return players.filter((p) => !p.out);
}

/** 승자 — 살아남은 사람이 정확히 하나일 때만. 아니면 null(아직 진행 중) */
export function findWinner(players: DvPlayer[]): DvPlayer | null {
  const alive = alivePlayers(players);
  return alive.length === 1 ? alive[0]! : null;
}

/**
 * from 다음으로 턴을 받을 사람의 인덱스. 탈락자는 건너뛴다.
 * 살아있는 사람이 없으면 -1 (호출부에서 종료 처리).
 */
export function nextTurnIndex(players: DvPlayer[], from: number): number {
  const n = players.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (!players[i]!.out) return i;
  }
  return -1;
}

/** 방 옵션의 제한 시간(초). 0 이면 무제한 */
export function parseTurnLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 화면에 쓸 타일 글자. 조커는 J */
export function tileLabel(num: number | null): string {
  if (num === null) return '';
  return num === JOKER ? 'J' : String(num);
}
