/**
 * 미션 난이도 사다리
 *
 * 원작의 미션 50개는 디자이너가 쓴 창작물이라 그대로 옮기지 않는다.
 * 대신 원작이 난이도를 올릴 때 쓰는 레버 네 가지만 가져와 공식으로 만든다.
 *
 *   1. 임무 개수      1개 → 5개 이상
 *   2. 순서 제약      없음 → 화살표(일부만) → 숫자(전부, 엄격)
 *   3. 통신 제한      자유 → 앞 N트릭 차단 → 데드존(위치 표시 없음) → 전면 금지
 *   4. (※ 사령관 특수 배정 같은 건 넣지 않았다 — 레버 셋으로 이미 충분히 가파르다)
 *
 * 50을 넘겨도 공식이 계속 돌아간다. 다 깨도 끝나지 않게 하려는 것.
 */

export type OrderMode = 'none' | 'arrow' | 'strict';

export interface MissionSpec {
  n: number;
  /** 이 미션에서 나눠 가질 임무 개수 */
  taskCount: number;
  orderMode: OrderMode;
  /** 순서 토큰이 붙는 임무 수. orderMode 가 none 이면 0 */
  orderedCount: number;
  /** 앞 N 트릭 동안 통신 금지 (0이면 제한 없음) */
  commBlockTricks: number;
  /** 통신은 되는데 위치(위/가운데/아래) 표시를 못 한다 */
  deadZone: boolean;
  /** 통신 자체가 금지 */
  commBanned: boolean;
}

/** 임무를 너무 많이 깔면 3인 13트릭으로는 물리적으로 못 깬다 */
const MAX_TASKS = 7;

/**
 * 임무 개수 — 구간마다 완만하게 올린다.
 * 1~2 → 2~3 → 3~4 → 4~5 → 5+ 로, 한 구간에서 천천히 늘어나야
 * "조금 어려워졌네" 가 느껴진다. 계단이 가파르면 그냥 벽이 된다.
 */
function taskCountFor(n: number): number {
  let t: number;
  if (n <= 2) t = 1;
  else if (n <= 5) t = 2;
  else if (n <= 15) t = 2 + Math.floor((n - 6) / 5);        // 2, 2, 3
  else if (n <= 30) t = 3 + Math.floor((n - 16) / 8);       // 3, 3, 4
  else if (n <= 45) t = 4 + Math.floor((n - 31) / 8);       // 4, 4, 5
  else t = 5 + Math.floor((n - 46) / 10);                   // 5 부터 계속
  return Math.min(MAX_TASKS, Math.max(1, t));
}

function orderFor(n: number, taskCount: number): { mode: OrderMode; count: number } {
  if (n <= 5) return { mode: 'none', count: 0 };
  if (n <= 15) {
    // 화살표 — 일부 임무만 순서가 걸린다. 나머지는 아무 때나
    return { mode: 'arrow', count: Math.min(2, taskCount) };
  }
  // 숫자 토큰 — 전부 순서가 걸린다. 여기서부터 체감이 확 달라진다
  return { mode: 'strict', count: taskCount };
}

function commFor(n: number): { block: number; dead: boolean; ban: boolean } {
  if (n >= 46) return { block: 0, dead: false, ban: true };
  if (n >= 31) return { block: 0, dead: true, ban: false };
  if (n >= 16) return { block: 1 + Math.floor((n - 16) / 8), dead: false, ban: false }; // 1~2트릭
  return { block: 0, dead: false, ban: false };
}

export function missionFor(n: number): MissionSpec {
  const mission = Math.max(1, Math.floor(n));
  const taskCount = taskCountFor(mission);
  const order = orderFor(mission, taskCount);
  const comm = commFor(mission);
  return {
    n: mission,
    taskCount,
    orderMode: order.mode,
    orderedCount: order.count,
    commBlockTricks: comm.block,
    deadZone: comm.dead,
    commBanned: comm.ban,
  };
}

/** 미션 화면에 띄울 조건 요약 — 한 줄로 */
export function missionSummary(m: MissionSpec): string {
  const bits: string[] = [`임무 ${m.taskCount}개`];
  if (m.orderMode === 'arrow') bits.push(`${m.orderedCount}개는 순서대로`);
  if (m.orderMode === 'strict') bits.push('번호 순서대로');
  if (m.commBanned) bits.push('통신 금지');
  else if (m.deadZone) bits.push('통신은 되지만 위치 표시 없음');
  else if (m.commBlockTricks > 0) bits.push(`${m.commBlockTricks}트릭 동안 통신 금지`);
  return bits.join(' · ');
}
