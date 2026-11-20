/**
 * 지하철 타자 — 순수 규칙 모듈 (DOM·네트워크 없음)
 *
 * 노선 하나를 골라 역 이름을 순서대로 쳐서 종점까지 완주하는 레이스.
 * 기록은 완주 시간 · 타수(KPM) · 오타 수.
 *
 * ⚠️ 꼬들과 정반대로 **한글 IME 를 그대로 쓴다.**
 *    꼬들은 ㅐ 같은 걸 막으려고 물리 키를 직접 받았지만,
 *    여기선 `동대문역사문화공원` 을 빠르게 쳐야 하므로 평소 타자 그대로가 맞다.
 */

import { LINES } from './stations';
import { LINES_JA } from './stationsJa';

/** 수도권(한국) / 도쿄(일본) */
export type Region = 'kr' | 'jp';

/** 두 나라 노선을 같은 모양으로 다루기 위한 공통 형태 */
interface AnyLine {
  name: string;
  loop: boolean;
  stations: string[];
  /** 일본만 있다. 한자 역명 위에 후리가나로 띄운다 */
  kana?: string[];
}

function linesOf(region: Region): AnyLine[] {
  return region === 'jp' ? LINES_JA : LINES;
}

/** 운행 방향 — 배열 정방향이 하행, 역방향이 상행 */
export type Direction = 'down' | 'up';

/**
 * 방 옵션 값은 `지역:노선|방향` 한 덩어리다 (예: `jp:山手線|down`).
 * 지역을 고르면 노선 목록이, 노선을 고르면 행선지가 바뀌어야 하는데
 * 방 옵션이 그런 의존 관계를 못 만들어서 셋을 합쳐 하나의 목록으로 보여준다.
 */
export interface Route {
  region: Region;
  lineName: string;
  dir: Direction;
}

export function parseRoute(raw: string | undefined): Route {
  const s = raw ?? '';
  const colon = s.indexOf(':');
  // 지역 접두사가 없으면 예전 형식(`2호선|down`) → 수도권으로 본다
  const region: Region = s.slice(0, colon) === 'jp' ? 'jp' : 'kr';
  const rest = colon >= 0 ? s.slice(colon + 1) : s;
  const [name, d] = rest.split('|');
  const names = linesOf(region).map((l) => l.name);
  return {
    region,
    lineName: name && names.includes(name) ? name : (linesOf(region)[0]?.name ?? '2호선'),
    dir: d === 'up' ? 'up' : 'down',
  };
}

/** 고를 수 있는 모든 운행 — 레지스트리 옵션과 화면 표기의 단일 출처 */
export function allRoutes(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const region of ['kr', 'jp'] as const) {
    const tag = region === 'kr' ? '수도권' : '도쿄';
    const unit = region === 'kr' ? '역' : '駅';
    for (const l of linesOf(region)) {
      for (const dir of ['down', 'up'] as const) {
        out.push({
          value: `${region}:${l.name}|${dir}`,
          label: `[${tag}] ${l.name} ${destLabel(region, l.name, dir)} (${l.stations.length}${unit})`,
        });
      }
    }
  }
  return out;
}

function lineOf(region: Region, lineName: string): AnyLine {
  const ls = linesOf(region);
  return ls.find((l) => l.name === lineName) ?? ls[0]!;
}

/**
 * 이번에 달릴 역 목록 — 기점에서 종점까지 **전 구간**.
 * 실제 열차처럼 행선지가 정해지는 거라 중간에 끊지 않는다.
 */
export function buildCourse(region: Region, lineName: string, dir: Direction): string[] {
  const st = lineOf(region, lineName).stations;
  return dir === 'up' ? st.slice().reverse() : st.slice();
}

/** 역 이름의 읽는 법. 일본 노선만 값이 있고, 한국은 전부 빈 문자열 */
export function buildKana(region: Region, lineName: string, dir: Direction): string[] {
  const line = lineOf(region, lineName);
  const k = line.kana ?? line.stations.map(() => '');
  return dir === 'up' ? k.slice().reverse() : k.slice();
}

/**
 * 행선지 이름. 실제 열차 표기를 따른다.
 *   한국  보통 노선은 종착역 + '행' (오금행), 순환선(2호선)은 내선/외선순환
 *   일본  보통 노선은 종착역 + '行き' (浅草行き), 순환선(山手線)은 内回り/外回り
 */
export function destLabel(region: Region, lineName: string, dir: Direction): string {
  const line = lineOf(region, lineName);
  if (line.loop) {
    if (region === 'jp') return dir === 'down' ? '内回り' : '外回り';
    return dir === 'down' ? '내선순환' : '외선순환';
  }
  const course = buildCourse(region, lineName, dir);
  const last = course[course.length - 1] ?? '';
  return region === 'jp' ? `${last}行き` : `${last}행`;
}

/** 출발역 — 화면 안내용 */
export function originLabel(region: Region, lineName: string, dir: Direction): string {
  return buildCourse(region, lineName, dir)[0] ?? '';
}

// ============================================
// 입력 판정
// ============================================

const CHO_LIST = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

/** 글자의 초성. 완성형이면 계산하고, 조합 중인 낱자(ㅂ)면 그 자신 */
function choseong(ch: string): string {
  const c = ch.codePointAt(0)!;
  if (c >= 0xac00 && c <= 0xd7a3) return CHO_LIST[Math.floor((c - 0xac00) / 588)]!;
  return ch;
}

/**
 * 지금 친 글자가 목표 역 이름으로 가는 길 위에 있나.
 *
 * 한글 IME 는 조합 중에도 input 에 값이 들어온다 — `동대문` 을 치는 중에
 * `동대ㅁ` → `동대므` → `동대문` 처럼 마지막 글자가 계속 변한다.
 * 그래서 마지막 글자는 **초성만 맞으면** 아직 조합 중인 걸로 보고 통과시킨다.
 *
 * 예전엔 마지막 글자를 통째로 봐줬는데, 그러면 한 글자만 친 상태에서
 * 앞부분이 빈 문자열이라 **무엇을 쳐도 통과해서 오타가 영영 안 잡혔다.**
 */
export function isOnTrack(typed: string, target: string): boolean {
  if (target.startsWith(typed)) return true;
  if (typed.length === 0) return true;
  const head = typed.slice(0, -1);
  if (!target.startsWith(head)) return false;
  const want = target[head.length];
  return want !== undefined && choseong(typed[typed.length - 1]!) === choseong(want);
}

export function isComplete(typed: string, target: string): boolean {
  return typed === target;
}

// ============================================
// 기록
// ============================================

export interface Record {
  /** 지금 몇 번째 역까지 통과했나 (0 = 아직 첫 역) */
  index: number;
  /** 친 글자 수 — 타수 계산용 */
  chars: number;
  mistakes: number;
  /** 완주했으면 걸린 ms, 아니면 null */
  timeMs: number | null;
}

export function emptyRecord(): Record {
  return { index: 0, chars: 0, mistakes: 0, timeMs: null };
}

/** 분당 타수 (KPM) — 완주 전이면 지금까지 경과로 계산 */
export function kpm(chars: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.round((chars / elapsedMs) * 60_000);
}

/**
 * 순위 정렬 — 완주한 사람이 먼저, 그다음 빠른 순.
 * 못 끝냈으면 더 멀리 간 사람이 위, 거기서도 같으면 오타가 적은 쪽.
 */
export function rankSort<T extends Record>(a: T, b: T): number {
  const ad = a.timeMs !== null;
  const bd = b.timeMs !== null;
  if (ad !== bd) return ad ? -1 : 1;
  if (ad && bd) return a.timeMs! - b.timeMs!;
  if (a.index !== b.index) return b.index - a.index;
  return a.mistakes - b.mistakes;
}
