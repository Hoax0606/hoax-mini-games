/**
 * 땅따먹기(paper.io식) 순수 격자 로직.
 *
 * 격자 GW×GH. territory[cell] = 소유자 인덱스(0..n-1) 또는 -1(빈칸).
 * 플레이어는 자기 영토 밖으로 나가면 "꼬리"를 남기고, 자기 영토로 돌아오면 꼬리+둘러싼 영역을 캡처.
 * 누군가 머리가 어떤 꼬리 칸에 닿으면 그 꼬리 주인이 죽는다(자기 꼬리 밟아도 죽음). 벽 충돌도 죽음.
 * 죽으면 잠시 후 빈 곳에 3×3 로 리스폰(이전 영토는 사라짐). 시간 종료 시 영토 넓은 순 승.
 *
 * 여기는 DOM/네트워크 의존 없는 순수 함수만. 런타임 상태(머리/꼬리/생존)는 index.ts 가 든다.
 */

export const GW = 40;
export const GH = 20;

/** 방향: 0=상 1=우 2=하 3=좌 */
export const DIRS: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export function opposite(dir: number): number { return (dir + 2) % 4; }

export function idx(x: number, y: number): number { return y * GW + x; }
export function inBounds(x: number, y: number): boolean { return x >= 0 && x < GW && y >= 0 && y < GH; }

/** 플레이어 색 (영토=옅게, 머리·꼬리=진하게). 최대 6인. */
export const PLAYER_COLORS: Array<{ terr: string; solid: string }> = [
  { terr: '#ffc2cd', solid: '#ff5a6e' }, // 빨
  { terr: '#bcd8ff', solid: '#4a86e8' }, // 파
  { terr: '#bff0cb', solid: '#3fbf68' }, // 초
  { terr: '#ffe6a8', solid: '#f2b213' }, // 노
  { terr: '#e0cbff', solid: '#9b62e8' }, // 보라
  { terr: '#ffd6b0', solid: '#ff8a3d' }, // 주황
];

export function newTerritory(): number[] {
  return new Array<number>(GW * GH).fill(-1);
}

/** (cx,cy) 중심 반경 r 정사각형을 owner 로 설정 (리스폰/시작 블록) */
export function claimBlock(terr: number[], owner: number, cx: number, cy: number, r: number): void {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (inBounds(x, y)) terr[idx(x, y)] = owner;
    }
  }
}

/** owner 의 영토 칸 수 */
export function countTerritory(terr: number[], owner: number): number {
  let n = 0;
  for (let i = 0; i < terr.length; i++) if (terr[i] === owner) n++;
  return n;
}

/** owner 소유 칸 전부 비우기 (죽었을 때) */
export function clearOwner(terr: number[], owner: number): void {
  for (let i = 0; i < terr.length; i++) if (terr[i] === owner) terr[i] = -1;
}

/**
 * 캡처: 꼬리 칸들을 이미 owner 로 합쳐 넣은 territory 에서, owner 영토로 "둘러싸인" 영역을 채운다.
 *   1) 격자 테두리에서 owner 아닌 칸을 타고 BFS → "바깥" 표시
 *   2) 바깥이 아니면서 owner 가 아닌 칸 = 갇힌 칸 → owner 로 캡처(빈칸·남의 영토 모두 흡수)
 * @returns 새로 캡처한 칸 수
 */
export function floodCapture(terr: number[], owner: number): number {
  const n = GW * GH;
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  // 테두리 칸 중 owner 아닌 것 시드
  for (let x = 0; x < GW; x++) {
    for (const y of [0, GH - 1]) {
      const c = idx(x, y);
      if (terr[c] !== owner && !outside[c]) { outside[c] = 1; stack.push(c); }
    }
  }
  for (let y = 0; y < GH; y++) {
    for (const x of [0, GW - 1]) {
      const c = idx(x, y);
      if (terr[c] !== owner && !outside[c]) { outside[c] = 1; stack.push(c); }
    }
  }
  // BFS (owner 칸은 벽이라 못 지나감)
  while (stack.length) {
    const c = stack.pop()!;
    const cx = c % GW, cy = (c / GW) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(nx, ny)) continue;
      const nc = idx(nx, ny);
      if (outside[nc] || terr[nc] === owner) continue;
      outside[nc] = 1;
      stack.push(nc);
    }
  }
  // 바깥 아니고 owner 아니면 갇힘 → 캡처
  let gained = 0;
  for (let c = 0; c < n; c++) {
    if (!outside[c] && terr[c] !== owner) { terr[c] = owner; gained++; }
  }
  return gained;
}

/**
 * 리스폰 자리 찾기 — 3×3 이 전부 빈칸인 곳을 랜덤 시도, 없으면 가장 덜 겹치는 곳.
 * @returns 중심 (x,y)
 */
export function findRespawn(terr: number[]): { x: number; y: number } {
  const margin = 2;
  let best = { x: (GW / 2) | 0, y: (GH / 2) | 0 };
  let bestOwned = Infinity;
  for (let attempt = 0; attempt < 60; attempt++) {
    const cx = margin + Math.floor(Math.random() * (GW - margin * 2));
    const cy = margin + Math.floor(Math.random() * (GH - margin * 2));
    let owned = 0;
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (inBounds(x, y) && terr[idx(x, y)] !== -1) owned++;
      }
    }
    if (owned === 0) return { x: cx, y: cy };
    if (owned < bestOwned) { bestOwned = owned; best = { x: cx, y: cy }; }
  }
  return best;
}
