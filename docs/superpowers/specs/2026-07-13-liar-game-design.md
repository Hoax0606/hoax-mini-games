# 라이어 게임 설계 스펙

작성일: 2026-07-13
대상: `src/games/liar-game/` (신규 게임 모듈)

## 개요

3~8인 텍스트 기반 사회 추리 게임. 매 라운드 랜덤 1명이 "라이어". 시민들은 공통
제시어를 알고, 라이어는 모른다(또는 가짜 단어를 받는다). 순서대로 제시어를 설명하며
라이어가 누군지 눈치로 찾는다. 호스트 authoritative. draw-quiz 라운드 구조 참고.
**고정 5라운드 누적 점수**로 최종 승자 결정.

## 모드 (방 옵션 `mode`)

- **일반(`normal`)**: 라이어는 `🤥 라이어 · 주제: 음식`만 본다(제시어 모름, 자기가 라이어인 건 앎). 시민은 `제시어: 김치`.
- **바보(`fool`)**: 라이어에게 **같은 주제의 가짜 제시어**(예: 라면)를 준다. 라이어도 자기가 시민인 줄 안다. 단어가 달라 설명이 어긋나며 들통난다.

## 제시어 풀 (`words.ts`)

```ts
interface Category { name: string; words: string[]; }
export const CATEGORIES: Category[] // 음식/동물/직업/장소/스포츠/과일/탈것/영화장르 등 ~15개, 각 ~12단어
```
- 라운드마다 카테고리 1개 선택 → 그 안에서 시민 제시어 1개 + (바보용) 다른 단어 1개 뽑음.
- 호스트가 뽑아 `lg:role`/`lg:sync` 로 배분(난수 동기화 불필요 — 호스트 단독 결정).

## 상태 모델 (`rules.ts`)

```ts
type Phase = 'hint' | 'vote' | 'guess' | 'result' | 'ended';
interface Hint { peerId: string; text: string; }
interface LiarGame {
  round: number;              // 1..5
  totalRounds: number;        // 5
  phase: Phase;
  category: string;
  order: string[];            // 힌트 순서 (peerId)
  hintPass: number;           // 1..2 (몇 바퀴째)
  hintIndex: number;          // order 내 현재 차례
  hints: Hint[];
  votes: Record<string, string>;   // voter → target
  liarPeerId: string;         // 이번 라운드 라이어 (호스트/reveal 후에만 전원 알기)
  accusedPeerId: string | null;
  liarGuess: string | null;
  liarWon: boolean | null;
  scores: Record<string, number>;
  players: { peerId: string; nickname: string }[];
}
```
- **비밀 정보**(내 역할/제시어)는 게임 state 에 안 담고 `lg:role` 로 각 peer 에 개별 전송. `liarPeerId` 는 reveal 전까지 게스트에 안 보냄(호스트만 보관, sync 시 마스킹).

## 라운드 흐름 (호스트 진행)

1. **역할 배정**: 랜덤 라이어 1명, 카테고리/제시어/가짜 선택. 각 peer 에 `lg:role`
   (일반: 시민=제시어, 라이어=주제만 / 바보: 시민=진짜, 라이어=가짜). `phase='hint'`.
2. **힌트**: `order` 순서로 한 명씩 `lg:hint(text)` → 호스트 검증
   (제시어(진짜) 부분문자열 포함 금지, 길이 ≤20, 빈칸 거절) → 통과 시 broadcast + 다음 차례.
   2바퀴(`hintPass` 1→2) 완료 시 `phase='vote'`.
3. **투표**: 전원 `lg:vote(target)` 비밀 제출. 호스트가 전원 집계.
   최다득표자 = `accusedPeerId`. **동점/과반미달 → accused=null → 라이어 승**.
4. **판정**:
   - `accused === liarPeerId` → `phase='guess'`: 라이어가 `lg:guess(word)` 제출 →
     호스트가 진짜 제시어와 비교. 맞으면 `liarWon=true`(역전), 틀리면 `false`.
   - `accused !== liar` (오인/동점) → `liarWon=true`.
5. **결과**: 점수 반영 → `lg:reveal`(liarPeerId, votes, guess, liarWon, scores) broadcast.
   결과 오버레이. 다음 라운드 or (round==5) `lg:end`.

## 점수

- 라이어 승(`liarWon`): 라이어 **+2**.
- 시민 승(`!liarWon`): 라이어에게 투표한 시민 **각 +1**.
- 5라운드 후 누적 최고점 승(공동 가능).

## 타임아웃 (호스트, 무한 정지 방지)

- 힌트 턴 45초: 초과 시 빈/자동 힌트("…")로 넘김.
- 투표 30초: 미투표자는 기권(집계 제외).
- 추측 30초: 초과 시 오답 처리.

## 네트워크 프로토콜 (`netSync.ts`, `lg:` prefix)

- `lg:hello` 게스트→호스트 (합류)
- `lg:sync` 호스트→target (전체 state, **liarPeerId 마스킹**)
- `lg:role` 호스트→각 peer (per-peer 비밀: 역할 + 내 단어/주제)
- `lg:hint` 플레이어→호스트, 호스트→broadcast (검증 통과분)
- `lg:vote` 플레이어→호스트 (target)
- `lg:guess` 라이어→호스트 (추측 단어)
- `lg:reveal` 호스트→전체 (라운드 결과 공개)
- `lg:end` 호스트→각 peer (최종 GameResult)

## UI (`render.ts` + `index.ts` HTML)

- **Canvas**: 상단 주제 카드 + 페이즈 배너("설명 2바퀴째 · OO 차례"/"투표"/"결과").
  중앙 내 역할/제시어 카드(개인, `lg:role` 로 받은 것). 힌트 히스토리(플레이어별 말풍선).
  우측/하단 플레이어 목록 + 누적 점수 + 현재 차례 강조.
- **HTML**(canvas 외부, draw-quiz 방식):
  - 힌트 입력창(내 차례 + hint phase).
  - 투표: 플레이어 버튼 목록에서 지목(vote phase).
  - 추측 입력(내가 라이어 + 지목당함 + guess phase).
- 관전자: 입력 없이 보기만(제시어/역할 카드 숨김, 라이어도 미표시).

## 파일

```
src/games/liar-game/
  words.ts     카테고리 풀 + 라운드 뽑기
  rules.ts     상태/페이즈 전이/투표집계/점수/힌트검증
  netSync.ts   lg:* encode/decode
  render.ts    canvas 렌더
  index.ts     GameModule 조립 + HTML 입력 UI + 호스트 진행/타임아웃
  thumbnail.svg
```
+ `registry.ts` 엔트리 추가 (id `liar-game`, 3~8인, 옵션: mode 일반/바보).

## 구현 단계 (파일 단위)

1. words.ts (카테고리 풀)
2. rules.ts (순수 로직 + 검증 + 점수)
3. netSync.ts (프로토콜)
4. render.ts (canvas)
5. index.ts (조립 + UI + 호스트 진행)
6. thumbnail.svg + registry 등록

## 비목표

- 음성/실시간 타이핑 중계 (엔터 시 한 줄 전송).
- 방장 이양, 라이어 여러 명, 팀전.
- 커스텀 제시어 입력.
