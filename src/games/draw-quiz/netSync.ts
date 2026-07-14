/**
 * 그림 퀴즈 네트워크 프로토콜
 *
 * 동기화 전략 — **호스트 authoritative 라운드 진행 + 그림 스트로크 broadcast**:
 *   - 호스트가 라운드 상태(누가 출제자/제시어/타이머/점수) 단독 관리
 *   - 출제자는 그리는 stroke 를 dq:stroke 로 broadcast → 모두 같은 그림 렌더
 *   - 추측은 기존 플랫폼 채팅(chat) 으로 — 단, 게임 모듈이 가로채 정답 판정.
 *     (정답이면 채팅에 단어 노출 안 하려고 dq:guess 별도 메시지로 처리)
 *
 * 메시지:
 *   dq:hello       게스트/관전자 → 호스트. 합류 동기화 요청
 *   dq:sync        호스트 → target. 현재 라운드 상태 + 지금까지 그려진 stroke 전부
 *   dq:round_start 호스트 → 전체. 새 라운드 — 출제자 peerId + (출제자에게만) 후보 단어
 *   dq:word_chosen 출제자 → 호스트. 후보 중 고른 단어 인덱스
 *   dq:round_begin 호스트 → 전체. 출제자가 단어 골라 그리기 시작 (제시어 글자수만 공개)
 *   dq:stroke      출제자 → 전체. 그림 한 획 (점들의 배열 + 색/굵기/지우개 여부)
 *   dq:clear       출제자 → 전체. 캔버스 전체 지우기
 *   dq:guess       게스트 → 호스트. 정답 추측 (단어). 호스트가 판정
 *   dq:correct     호스트 → 전체. 누가 정답 맞혔는지 + 갱신된 점수 (단어는 노출 안 함)
 *   dq:round_end   호스트 → 전체. 라운드 종료 — 정답 공개 + 라운드 점수
 *   dq:end         호스트 → 각 peer. 최종 결과 (per-peer GameResult)
 */

import type { GameMessage, GameResult } from '../types';
import type { DrawQuizGame, StrokePoint } from './rules';

const T_HELLO = 'dq:hello';
const T_SYNC = 'dq:sync';
const T_ROUND_START = 'dq:round_start';
const T_WORD_CHOSEN = 'dq:word_chosen';
const T_ROUND_BEGIN = 'dq:round_begin';
const T_STROKE = 'dq:stroke';
const T_CLEAR = 'dq:clear';
const T_GUESS = 'dq:guess';
const T_CORRECT = 'dq:correct';
const T_ROUND_END = 'dq:round_end';
const T_END = 'dq:end';

// --- hello / sync ---

export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return { peerId: p.peerId };
}

export interface SyncPayload {
  game: DrawQuizGame;
  /** 현재 라운드에서 지금까지 그려진 모든 stroke (합류자 화면 복원용) */
  strokes: StrokeData[];
}
export function encodeSync(p: SyncPayload): GameMessage {
  return { type: T_SYNC, payload: p };
}
export function decodeSync(msg: GameMessage): SyncPayload | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<SyncPayload> | null;
  if (!p || !p.game || !Array.isArray(p.strokes)) return null;
  return { game: p.game as DrawQuizGame, strokes: p.strokes as StrokeData[] };
}

// --- round_start (호스트 → 전체): 새 라운드 ---

export interface RoundStartPayload {
  round: number;
  drawerPeerId: string;
  drawerNickname: string;
  /** 출제자에게만 의미 있는 후보 단어들. 비출제자에겐 빈 배열로 보냄. */
  candidates: string[];
  turnStartedAt: number;
}
export function encodeRoundStart(p: RoundStartPayload): GameMessage {
  return { type: T_ROUND_START, payload: p };
}
export function decodeRoundStart(msg: GameMessage): RoundStartPayload | null {
  if (msg.type !== T_ROUND_START) return null;
  const p = msg.payload as Partial<RoundStartPayload> | null;
  if (!p || typeof p.drawerPeerId !== 'string') return null;
  return {
    round: typeof p.round === 'number' ? p.round : 0,
    drawerPeerId: p.drawerPeerId,
    drawerNickname: typeof p.drawerNickname === 'string' ? p.drawerNickname : '',
    candidates: Array.isArray(p.candidates) ? p.candidates : [],
    turnStartedAt: typeof p.turnStartedAt === 'number' ? p.turnStartedAt : 0,
  };
}

// --- word_chosen (출제자 → 호스트) ---

export function encodeWordChosen(index: number): GameMessage {
  return { type: T_WORD_CHOSEN, payload: { index } };
}
export function decodeWordChosen(msg: GameMessage): { index: number } | null {
  if (msg.type !== T_WORD_CHOSEN) return null;
  const p = msg.payload as { index?: unknown } | null;
  if (!p || typeof p.index !== 'number') return null;
  return { index: p.index };
}

// --- round_begin (호스트 → 전체): 그리기 시작 ---

export interface RoundBeginPayload {
  /** 제시어 글자 수 (비출제자 힌트용 — 단어 자체는 안 보냄) */
  wordLength: number;
  /** 라운드 제한 시간 (ms) */
  durationMs: number;
  turnStartedAt: number;
}
export function encodeRoundBegin(p: RoundBeginPayload): GameMessage {
  return { type: T_ROUND_BEGIN, payload: p };
}
export function decodeRoundBegin(msg: GameMessage): RoundBeginPayload | null {
  if (msg.type !== T_ROUND_BEGIN) return null;
  const p = msg.payload as Partial<RoundBeginPayload> | null;
  if (!p) return null;
  return {
    wordLength: typeof p.wordLength === 'number' ? p.wordLength : 0,
    durationMs: typeof p.durationMs === 'number' ? p.durationMs : 60000,
    turnStartedAt: typeof p.turnStartedAt === 'number' ? p.turnStartedAt : 0,
  };
}

// --- stroke (출제자 → 전체): 그림 한 획 ---

/** 브러시 스타일 — pen(둥근) / block(각진 사각) / marker(반투명 형광) */
export type BrushStyle = 'pen' | 'block' | 'marker';
/** 도형 — free(자유선, 기본) / rect / ellipse / line. free 외엔 points[0]=시작, 마지막=끝 */
export type ShapeKind = 'free' | 'rect' | 'ellipse' | 'line';

export interface StrokeData {
  points: StrokePoint[];
  color: string;
  width: number;
  /** true 면 지우개 (종이색으로 덧칠) */
  erase: boolean;
  /** 브러시 스타일 (기본 pen) */
  style?: BrushStyle;
  /** 도형 (기본 free) */
  shape?: ShapeKind;
}
export function encodeStroke(s: StrokeData): GameMessage {
  return { type: T_STROKE, payload: s };
}
export function decodeStroke(msg: GameMessage): StrokeData | null {
  if (msg.type !== T_STROKE) return null;
  const p = msg.payload as Partial<StrokeData> | null;
  if (!p || !Array.isArray(p.points)) return null;
  const style: BrushStyle = p.style === 'block' || p.style === 'marker' ? p.style : 'pen';
  const shape: ShapeKind =
    p.shape === 'rect' || p.shape === 'ellipse' || p.shape === 'line' ? p.shape : 'free';
  return {
    points: p.points as StrokePoint[],
    color: typeof p.color === 'string' ? p.color : '#1c1820',
    width: typeof p.width === 'number' ? p.width : 4,
    erase: p.erase === true,
    style,
    shape,
  };
}

// --- clear (출제자 → 전체) ---

export function encodeClear(): GameMessage {
  return { type: T_CLEAR, payload: {} };
}
export function isClear(msg: GameMessage): boolean {
  return msg.type === T_CLEAR;
}

// --- guess (게스트 → 호스트) ---
// GameContext 는 onPeerMessage 에 발신자 peerId 를 노출하지 않으므로,
// 추측 판정에 필요한 송신자 정보를 payload 에 직접 동봉한다.

export interface GuessPayload {
  word: string;
  peerId: string;
  nickname: string;
}
export function encodeGuess(p: GuessPayload): GameMessage {
  return { type: T_GUESS, payload: p };
}
export function decodeGuess(msg: GameMessage): GuessPayload | null {
  if (msg.type !== T_GUESS) return null;
  const p = msg.payload as Partial<GuessPayload> | null;
  if (!p || typeof p.word !== 'string' || typeof p.peerId !== 'string') return null;
  return { word: p.word, peerId: p.peerId, nickname: typeof p.nickname === 'string' ? p.nickname : '' };
}

// --- correct (호스트 → 전체): 정답자 + 점수 (단어는 비공개) ---

export interface CorrectPayload {
  peerId: string;
  nickname: string;
  /** 갱신된 전체 점수 맵 (peerId → score) */
  scores: Record<string, number>;
  /** 이 라운드에서 몇 번째 정답자인지 (1=가장 빠름) */
  rank: number;
}
export function encodeCorrect(p: CorrectPayload): GameMessage {
  return { type: T_CORRECT, payload: p };
}
export function decodeCorrect(msg: GameMessage): CorrectPayload | null {
  if (msg.type !== T_CORRECT) return null;
  const p = msg.payload as Partial<CorrectPayload> | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return {
    peerId: p.peerId,
    nickname: typeof p.nickname === 'string' ? p.nickname : '',
    scores: (p.scores ?? {}) as Record<string, number>,
    rank: typeof p.rank === 'number' ? p.rank : 1,
  };
}

// --- round_end (호스트 → 전체): 정답 공개 ---

export interface RoundEndPayload {
  word: string;
  scores: Record<string, number>;
  /** 다음 라운드 있으면 true. false 면 곧 dq:end */
  hasNext: boolean;
}
export function encodeRoundEnd(p: RoundEndPayload): GameMessage {
  return { type: T_ROUND_END, payload: p };
}
export function decodeRoundEnd(msg: GameMessage): RoundEndPayload | null {
  if (msg.type !== T_ROUND_END) return null;
  const p = msg.payload as Partial<RoundEndPayload> | null;
  if (!p || typeof p.word !== 'string') return null;
  return {
    word: p.word,
    scores: (p.scores ?? {}) as Record<string, number>,
    hasNext: p.hasNext === true,
  };
}

// --- end (호스트 → per-peer) ---

export function encodeEnd(result: GameResult): GameMessage {
  return { type: T_END, payload: result };
}
export function decodeEnd(msg: GameMessage): GameResult | null {
  if (msg.type !== T_END) return null;
  const p = msg.payload as Partial<GameResult> | null;
  if (!p) return null;
  const w = p.winner;
  if (w !== 'me' && w !== 'opponent' && w !== null) return null;
  return { winner: w, summary: (p.summary ?? {}) as Record<string, unknown> };
}
