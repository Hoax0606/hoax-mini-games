/**
 * 스토리텔링(이어그리기) 규칙 / 데이터 모델.
 *
 * 갈틱폰 방식:
 *   - N명 = N권의 책(이야기). 각 책은 소유자의 제시어로 시작.
 *   - 매 턴 전원이 "동시에" 그린다(쉬는 사람 0명). 시간이 끝나면 책이 옆으로 한 칸 회전.
 *   - 다음 턴엔 넘겨받은 책의 "직전 컷만 옅게" 보며 이어 그린다.
 *   - totalTurns 만큼 반복 → 책마다 여러 컷이 쌓여 이야기 완성 → 슬라이드쇼 감상. 승패 없음.
 *
 * stroke 타입도 여기 둔다(컷이 stroke 를 담으므로). netSync 는 이걸 import 만 함(단방향).
 */

import { PROMPTS } from './prompts';

// ── 그림 stroke 모델 (draw-quiz 개선판과 동일 구조) ──
export interface StrokePoint { x: number; y: number; }
/** 도구 — pen / marker(형광) / eraser / fill(채우기) */
export type DrawTool = 'pen' | 'marker' | 'eraser' | 'fill';
/** 도형 — free(자유선) / rect / ellipse / line. fill·eraser 는 항상 free */
export type ShapeKind = 'free' | 'rect' | 'ellipse' | 'line';
export interface StrokeData {
  points: StrokePoint[];
  color: string;
  width: number;
  tool: DrawTool;
  shape?: ShapeKind;
}

// ── 이야기 구조 ──
export interface StoryCut {
  drawerPeerId: string;
  drawerNickname: string;
  strokes: StrokeData[];
}
export interface StoryBook {
  ownerPeerId: string;
  ownerNickname: string;
  /** 이 책의 시작 제시어 (턴 0 그린 사람이 본 것) */
  prompt: string;
  /** cuts[turn] — 완료된 컷들. 길이 = 지금까지 진행된 턴 수 */
  cuts: StoryCut[];
}
export type StoryPhase = 'drawing' | 'reveal' | 'ended';
export interface StoryPlayer { peerId: string; nickname: string; }

export interface StoryDrawGame {
  /** 좌석 순서(호스트 먼저). 인덱스 = seat 번호 */
  seats: StoryPlayer[];
  /** books[b] — 소유자 = seats[b] */
  books: StoryBook[];
  /** 현재 턴 0 .. totalTurns-1 */
  turn: number;
  totalTurns: number;
  phase: StoryPhase;
  /** 컷당 그리기 제한시간(ms) */
  durationMs: number;
  /** 현재 턴 시작 시각(호스트 시계). 각 클라는 수신 시각 기준으로 로컬 카운트다운 */
  turnStartedAt: number;
}

/** 이야기 길이 모드 → 총 턴 수. 짧게=1바퀴(N), 길게=2바퀴(2N)이되 8턴 상한(다인원 폭주 방지). */
export function decideTotalTurns(n: number, mode: 'short' | 'long'): number {
  // 다인원에서 그리기 단계가 너무 길어지지 않게 상한. 짧게=최대 6턴 / 길게=최대 8턴.
  if (mode === 'long') return Math.min(2 * n, 8);
  return Math.min(Math.max(1, n), 6);
}

/**
 * 좌석 seat 가 턴 turn 에 그리는 책 인덱스.
 * 매 턴 책이 좌석 기준 한 칸씩 회전 → 책 b 는 t=0 seat b, t=1 seat b+1 … 이 그린다.
 * 따라서 seat 관점에선 (seat - turn) 위치의 책을 받는다.
 */
export function bookForSeat(seat: number, turn: number, n: number): number {
  return (((seat - turn) % n) + n) % n;
}

/**
 * 이번 턴 seat 에게 보여줄 것 — 턴 0 이면 제시어, 그 뒤엔 직전 컷(유령).
 * (호스트가 다음 턴으로 넘길 때 각 좌석에 이 정보를 담아 보냄)
 */
export function assignmentFor(
  game: StoryDrawGame,
  seat: number,
): { bookIndex: number; prompt?: string; ghost?: StrokeData[] } {
  const b = bookForSeat(seat, game.turn, game.seats.length);
  if (game.turn === 0) return { bookIndex: b, prompt: game.books[b]?.prompt ?? '' };
  const prevCut = game.books[b]?.cuts[game.turn - 1];
  return { bookIndex: b, ghost: prevCut ? prevCut.strokes : [] };
}

/** 게임 초기화 — 각 책에 서로 다른 제시어 하나씩 (호스트가 만들어 sync 하므로 랜덤 OK). */
export function createInitialGame(
  players: StoryPlayer[],
  totalTurns: number,
  durationMs: number,
): StoryDrawGame {
  // Fisher-Yates 로 제시어 풀 셔플 후 앞에서부터 배정 (중복 없이 서로 다른 제시어)
  const pool = [...PROMPTS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const books: StoryBook[] = players.map((p, i) => ({
    ownerPeerId: p.peerId,
    ownerNickname: p.nickname,
    prompt: pool[i % pool.length]!,
    cuts: [],
  }));
  return {
    seats: players.slice(),
    books,
    turn: 0,
    totalTurns,
    phase: 'drawing',
    durationMs,
    turnStartedAt: 0,
  };
}
