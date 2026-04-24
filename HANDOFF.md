# Hoax Minigames — 진행 상황 & 다음 작업 인계

다른 머신(집)에서 이 프로젝트를 이어서 작업할 때 읽는 문서.
**Claude Code 첫 프롬프트로 "HANDOFF.md 정독하고 이어서 진행해줘" 라고 시작하면 됨.**

마지막 업데이트: **2026-04-25** (다트 UI 전면 리디자인 + 전체 한글 UI 정돈)

---

## 🚀 빠른 시작 (다른 머신에서)

```bash
git clone https://github.com/Hoax0606/hoax-mini-games.git
cd hoax-mini-games
npm install
npm run dev       # http://localhost:5173
```

에디터에서 Claude Code 열고:

> HANDOFF.md + CLAUDE.md 둘 다 정독하고 이어서 진행해줘.

---

## 📌 현재 위치

| Phase | 내용 | 상태 |
|---|---|---|
| 1 | 플랫폼 N인화 | ✅ 완료 |
| 2 | 관전 모드 | ✅ 완료 (2026-04-23) |
| 3 | **방장 이양** | ⏳ **다음 작업** |
| 4 | 배틀 테트리스 | ✅ 완료 |
| 5 | 결과 화면 다인용 | ✅ 테트리스/사과 전용으로 완료. 범용화는 보류 |

**다음 작업**:
- 🅐 **Phase 3 방장 이양** — 방장 나가면 남은 사람 중 하나가 새 방장 돼서 게임 이어가기. 여전히 미구현.
- 🅑 **다트 네트워크 동기화** — `src/games/darts/index.ts` 주석에 "Phase C"로 남겨둠. 현재 같은 기기 로컬 턴제만 동작. `dt:` 메시지로 투척/턴 동기화 필요.
- (선택) 오목/반응속도/다트 플레이테스트 피드백 반영

---

## 🎮 프로젝트 개요

**한 줄**: 친구끼리 즐기는 웹 P2P 미니게임 모음집.
- **스택**: Vite + TypeScript + Canvas + PeerJS (WebRTC, 서버리스 P2P) + GitHub Pages
- **분위기**: 산리오풍 파스텔. 한국어 UI. PC 전용.
- **현재 게임 (6종)**:
  - 에어하키 (2인, 호스트 authoritative 물리)
  - 배틀 테트리스 (2~4인, 로컬 시뮬레이션)
  - 사과 게임 (1~4인, 숫자 사과 합 10 터트리기, 2분)
  - 오목 (2인, 15×15 또는 19×19, 30초 턴, 호스트 authoritative)
  - 반응속도 (1~4인, 5라운드 평균 ms 경쟁)
  - 다트 (1~4인, 6모드 — 301/201/101 Normal·Hard / Count-up / Low Count-up / Cricket) ⚠️ **현재 로컬 턴제만. 네트워크 동기화 미완성**
- **배포 URL**: https://hoax0606.github.io/hoax-mini-games/

---

## 🧱 아키텍처

### 파일 구조
```
src/
├── main.ts                      # 엔트리 + 글로벌 버튼 사운드 훅 + ?room= URL 자동 입장
├── core/
│   ├── peer.ts                  # PeerJS 래퍼 (HostSession 다중 conn, GuestSession)
│   │                            #   JoinDecision.asSpectator, ping 측정(2s 주기 RTT)
│   ├── screen.ts                # 화면 라우터
│   ├── storage.ts               # localStorage 래퍼 (nickname/settings/GameStats)
│   ├── sound.ts                 # Web Audio SFX 합성 (에어하키 5종 + 테트리스 8종)
│   │                            #   startBgm/stopBgm 래퍼로 bgm.ts 위임
│   └── bgm.ts                   # 게임별 BGM 시퀀서 (5종: ah/bt/ag/gomoku/darts)
├── games/
│   ├── types.ts                 # GameContext, Player(role), NetworkMessage + ping/reaction
│   ├── registry.ts              # 등록된 게임 목록 (6종)
│   ├── air-hockey/              # 2인 호스트 authoritative
│   ├── battle-tetris/           # 2-4인 로컬 시뮬레이션
│   ├── apple-game/              # 1-4인 독립 보드 + 점수 경쟁 (17×10)
│   ├── gomoku/                  # 2인 턴제, 호스트 authoritative, 15/19, 30초 턴
│   │                            #   go:request_move / go:move / go:sync / go:hello / go:end
│   ├── reflex/                  # 1-4인 5라운드 반응속도. rx:round_done / rx:player_done / rx:end
│   └── darts/                   # 1-4인 6모드 다트 (⚠️ 로컬 턴제만, 네트워크 미완)
│       ├── rules.ts             #   순수 상태머신 (X01 Normal/Hard, Count-up, Low, Cricket)
│       ├── board.ts             #   과녁 좌표 → HitResult 판정
│       └── index.ts             #   플릭 투척 물리 + 턴 진행
├── screens/
│   ├── menu.ts, nickname.ts, settings.ts, gameList.ts, lobby.ts
│   ├── createRoom.ts, joinRoom.ts    # joinRoom: initialCode/autoJoin 지원 (URL 공유 입장)
│   ├── waitingRoom.ts           # 호스트/게스트 factory + "🔗 링크" 공유 + 리액션 바
│   ├── gameScreen.ts            # 관전자 수락 + ping 배지 + 리액션 바
│   ├── statsScreen.ts           # 게임별 누적 전적/최고기록 (localStorage)
│   └── resultScreen.ts          # 테트리스/사과/오목/반응속도/다트 전용 결과 분기
├── ui/
│   ├── theme.css                # 팔레트 + 컴포넌트 스타일
│   ├── reactions.ts             # 이모지 6종 버튼 + 하단 풍선 애니 (400ms throttle)
│   └── logo.png                 # 메인 로고 이미지
└── .github/workflows/deploy.yml # GitHub Pages 자동 배포
```

### 메시지 프로토콜

**NetworkMessage** (플랫폼 레벨):
- `join_request` / `join_accepted` / `join_rejected`
- `room_state` / `player_joined` / `player_left`
- `game_start` / `game_end` — game_end 는 **관전자 결과 화면 이동 경로**
- `game_msg` — 게임별 메시지 wrapper. `target?: string`, `from?: string`
- `ping_req` / `ping_ack` / `ping_report` — peer.ts 가 자동 처리 (2초 주기 RTT 측정). 게임 모듈은 신경 X.
- `reaction` — 이모지 반응 broadcast. 대기실/게임 화면에 풍선 뜸.

**GameMessage** (게임 내부):
- 에어하키: `ah:state` / `ah:input` / `ah:end`
- 테트리스: `bt:state` (10Hz) / `bt:garbage` / `bt:topped` / `bt:end`
- 사과 게임: `ag:hello` (게스트 → 호스트 seed 요청) / `ag:seed` / `ag:score` / `ag:end`
- 오목: `go:request_move` / `go:move` / `go:sync` / `go:hello` / `go:end`
- 반응속도: `rx:round_done` / `rx:player_done` / `rx:end`
- 다트: (아직 네트워크 메시지 없음 — 로컬만 동작)

### 역할 (GameContext.role + isSpectator)
- `role: 'host'` — 방장. 승리 판정자.
- `role: 'guest'` + `isSpectator: false` — 일반 플레이어.
- `role: 'guest'` + `isSpectator: true` — 관전자. 입력/브로드캐스트 없음, 렌더만.

### 핵심 설계 원칙

1. **에어하키** = 호스트 authoritative 물리, 60Hz state broadcast.
2. **배틀 테트리스** = 로컬 시뮬레이션, 10Hz 스냅샷. 호스트는 승리 판정만.
3. **사과 게임** = 독립 보드(같은 seed로 동일 배치) + 게임 중 상대 점수 비공개. 타이머 만료 시점에만 점수 공유, 호스트 1초 grace period 후 랭킹 집계.
4. **오목** = 호스트 authoritative. 게스트는 `go:request_move` 로 의사 전달 → 호스트 검증 후 `go:move` broadcast. 각 턴 30초, 타임아웃은 호스트가 판정.
5. **반응속도** = 각자 독립 5라운드. 라운드 종료 시점에만 broadcast. 호스트가 전원 완료 감지 → per-peer `rx:end`.
6. **다트** = 현재 로컬 turn-based 만. rules.ts 순수 상태머신 + 플릭 투척 물리. 멀티 동기화 (Phase C) 미완.
7. **게임 모듈 확장성**: `src/games/<id>/` + `GameModule` + registry. 플랫폼 수정 X.
8. **관전자 결과 화면 이동**: 플레이어는 게임 내부 end 메시지, 관전자는 플랫폼 `game_end` broadcast.

---

## 🎵 BGM (bgm.ts)

각 게임이 자기 BGM 재생 — chiptune 스타일 짧은 루프(8마디), 멜로디+베이스 2트랙.
- `sound.startBgm('air-hockey' | 'battle-tetris' | 'apple-game')`
- `sound.stopBgm()` — 게임 모듈 destroy 에서 호출
- `storage.bgmEnabled=false` 면 no-op
- BGM 은 SFX 보다 작게 (마스터 게인 × 0.35)
- 끊김 없는 루프 (한 루프 끝 50ms 전에 다음 루프 스케줄)

**각 BGM 특징**:
- 에어하키: C 메이저 · 140 BPM · square · 경쾌 (2026-04-24 훅 강화판)
- 배틀 테트리스: A 마이너 · 110 BPM · triangle · 긴장감
- 사과 게임: F 메이저 · 95 BPM · triangle · 밝고 느긋
- 오목: 자체 루프
- 다트: 자체 루프
- 반응속도: BGM 없음 (짧은 라운드라 생략)

---

## 🧩 플랫폼 확장 기능 (2026-04-24 회사컴 추가)

### Ping 측정 (peer.ts)
- HostSession 이 2초마다 모든 게스트에게 `ping_req` 전송
- 게스트 자동 `ping_ack` 회신 → 호스트가 RTT/2 를 편도 ms 로 기록
- 호스트가 `ping_report` 로 해당 게스트에 ms 통지 (게스트 UI 표시용)
- `HostSession.onPingChanged(ReadonlyMap<peerId, ms>)` 콜백
- gameScreen 헤더에 배지: ⏳(측정 중) / 🟢(<60ms) / 🟡(<150ms) / 🔴(그 이상) / ⚠️(끊김)

### 이모지 리액션 (src/ui/reactions.ts)
- 버튼 6종: 👍 😂 🔥 👏 😭 🫢
- 클릭 시 `reaction` 메시지 broadcast → 모든 화면에 풍선 애니 (2.4s fade)
- 400ms throttle 스팸 방지
- 대기실 / 게임 화면 / (결과 화면) 어디서든 재사용

### URL 공유 입장 (main.ts, waitingRoom.ts, joinRoom.ts)
- 대기실에 "🔗 링크" 버튼 → 현재 URL 에 `?room=XXXXX` 붙여 복사
- 친구가 링크로 접속 시 main.ts 가 감지 → `createJoinRoomScreen('', { initialCode, autoJoin: true })` 자동 진입
- 닉네임 없으면 닉네임 입력 후 자동으로 join
- 새로고침 시 재입장 루프 방지를 위해 URL 에서 `room` 파라미터 즉시 제거

### 통계 화면 (statsScreen.ts + storage.GameStats)
- localStorage 에 게임별 plays/wins/losses/draws/lastPlayedAt + custom best record
- `storage.recordGameResult(gameId, winner, bestEntries)` — 결과 화면에서 호출
- best 는 자유 스키마: `{ key, value, higherIsBetter }` 배열. 게임마다 의미 다름 (사과 bestScore, 반응속도 bestMs 등)
- **머신별 독립** — 집/회사 PC 에서 기록 따로 쌓임

---

## 🎨 디자인 규약

### 팔레트 (theme.css CSS 변수)
```css
--pink-50:  #fff5f8   --pink-300: #ffa8c7   --pink-500: #ff5a92
--pink-100: #ffe4ee   --pink-400: #ff82ac
--pink-200: #ffc9dd

--mint-100: #e0fff4   --mint-300: #86e8c4
--lavender-100: #f0e8ff   --lavender-300: #b89aff
--cream-100: #fff9e8   --cream-200: #ffeec2
--sky-100: #e0f2ff    --sky-300: #86c9ff
```

**하드코딩 색 금지, CSS 변수 우선.** Canvas 렌더는 hex 하드코드하되 같은 팔레트 범주.

### 캐릭터 색 (현재 확정)
- **호스트 말렛**: 민트 `#6ed9b3` / stroke `#2e8a70` / deep `#1f6a55`
- **게스트 말렛**: 노랑 `#ffd454` / stroke `#c49a1f` / deep `#8e6f10`
- **퍽**: 윗면 `#ff6b9e` / 옆면 `#c93d73`
- **사과**: fill `#ff8a9f` / stroke `#c04058` / 꼭지 `#8b5a2b` / 잎 `#86e8c4`
- **다트판**: 외곽 링 **검정(`#1c1820`)** + 스파이더 같은 톤. 내부 Single(cream/lavender 교차) · Double/Triple(pink/mint) · Bull(mint+pink) 은 파스텔 유지.
- **다트**: 팁 `#1c1820` 검정 / 배럴 `#6e5872` 짙은 라벤더 / 샤프트 `#fdf6ec` 크림 / 플라이트 `#b89aff` 라벤더 + `#ff82ac` 핑크

### SVG 썸네일 규약 (새 게임 추가 시 필수)
- `viewBox="0 0 320 200"`, 배경 `rx="22"`
- 배경 그라데이션: `#ffe4ee → #e0fff4` (대각선)
- 배경 데코: 네 모서리 점 4개 (핑크/민트/라벤더/크림)
- 별 path 데코 2개
- 중앙 주요 일러스트 + 주변 작은 보조 일러스트 비스듬히

### Canvas 렌더 규약
- devicePixelRatio 대응 (resize 시 `canvas.width = rect.width * dpr`)
- 논리 좌표 800×400 고정, ResizeObserver 리사이즈 대응
- 폰트: `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`
- **커서**: 기본 `.game-canvas { cursor: none }` (에어하키용). 마우스 쓰는 게임은 `canvas.style.cursor = 'crosshair'` 로 inline override.

---

## ⚠️ 과거 피드백 히스토리 (같은 실수 반복 방지)

### 디자인 — Henry가 반복 강조
1. **"젤리 느낌"** 금지. 말렛/퍽에 방사 그라데이션+반투명 광택 금지. **솔리드 단색 + 얇은 옆면 오프셋**.
2. **귀 제거** — 단순 원반 + 손잡이.
3. **"퍽 밝게"** — 와인색 X, 밝은 핫핑크.
4. **"과하게 귀여울 필요 X"** — 얼굴/표정/볼터치 안 씀.
5. **디자인 일관성** — 새 일러스트는 기존 썸네일 톤 따름.

### 게임플레이
- **에어하키 퍽 start 전 정지** + 카운트다운 없음.
- **골 직후 화면 멈춤 방지** → `gameEnded` 후에도 loop 유지, 파티클 fade-out.
- **말렛 중앙선 넘는 버그 수정** → 게스트 로컬 예측에서도 `constrainToMyHalf()`.
- **테트리스 탑아웃 버그 수정 (2026-04-23)** → `spawnPosition` y=-1. `collides`의 `row<0 허용`과 조합.
- **테트리스 소프트드롭은 좌우 이동보다 빠르게** → `SOFT_DROP_INTERVAL_MS=25` 별도 상수.
- **사과 게임 스포일러 전면 제거 (2026-04-24)** → 드래그 박스의 합 숫자 표시 X, 합 상태별 색 힌트 X (10/초과/미만 색 분기 폐기). 단일 연분홍.
- **사과 게임 실시간 점수 비공개 (2026-04-24)** → 게임 중엔 상대 점수 공유 X. 타이머 만료 시점에만 자기 최종 점수 한 번 송신, 호스트는 1초 grace period 후 랭킹.
- **사과 게임 초기 seed race condition (2026-04-24)** → 게스트가 gameScreen 진입 후 game.load() 중에 호스트의 첫 seed broadcast 를 놓침. 해결: 게스트 start 끝에 `ag:hello` 송신 → 호스트가 해당 peerId 에 target 으로 seed 재전송.

### UX
- **메인 메뉴 정렬** → `.menu-list`에 `margin: 0 auto`.
- **결과 화면 전환** → 게임 종료 후 900ms (1200ms에서 단축).
- **대기실 시작 조건** → `players.length >= minPlayers`.
- **사과 게임 보드 방향** → **17×10** (가로가 긴 배치). Cell 30px, APPLE_RADIUS 12.
- **사과 모양** → 원형 몸통 + 갈색 꼭지(줄기) + 민트 대각 잎. 그냥 원 + 숫자면 "사과 안 같다" 피드백.
- **Cursor 기본 `none`** → 에어하키용. 사과 게임은 `crosshair` inline override, destroy 에서 원복.

### 결과 화면
- **게임별 분기** (`summary.gameId` 마커):
  - 테트리스: stats 그리드 7개(라인/공격/수신/시간/콤보/테트리스/피스) + 다인 랭킹
  - 사과 게임: 내 점수 큰 카드 + 최종 랭킹 (닉+점수)
  - 오목 / 반응속도 / 다트: 각자 전용 HTML (상세는 resultScreen.ts)
  - 기본(에어하키): 2인 점수판
- **내 기준 stats 만 추적** — 다른 플레이어 stats 집계 안 함 (관전자 rankings 에 "나" 없으면 `isSpectator` 자동 인식).
- **통계 누적** — 결과 화면 진입 시 `storage.recordGameResult` 호출. 관전자는 기록 X.

### 사운드 (SFX)
- `sound.ts` Web Audio 합성. `SfxId` 타입에 게임별 SFX 추가.
- 테트리스 8종: rotate/lock/harddrop/hold/clear/tetris/garbage/topout.
- 사과 게임은 기존 SFX 재활용: 성공 `tetris_clear`, 종료 `tetris_topout`.
- **자주 울리는 액션(좌우 이동, 소프트드롭) 사운드 X** — 시끄러움 방지.

### 다트 UI 리디자인 (2026-04-25)
- **다트 모양** — 기존 "로켓 같음" 피드백 → **4단 구조(팁 + 배럴 + 샤프트 + 플라이트)**. 배럴에 grip 라인 3개 + 좌측 광택. 플라이트는 곡선(quadraticCurveTo) 라벤더/핑크.
- **다트판 외곽은 검정이 맞다** — 한 번 파스텔 라벤더로 바꿨다가 "다트판 답지 않다" 피드백으로 검정 복원. Single/Double/Triple 내부는 파스텔(크림/라벤더, pink/mint) 유지, **외곽 링 + 스파이더 구분선만 `#1c1820` 차콜 검정**. 다트 팁도 검정.
- **3다트 슬롯 kind별 배지** — Triple `T`+핑크 border, Double `D`+민트 border, Inner Bull `BULL`+핑크 채움, Outer Bull 연분홍, Miss 회색 `MISS`, 빈 슬롯 점선 라벤더+`·`. roundRect 둥근 모서리.
- **우측 점수판 카드형** — "MODE / Round" 라벨 → **헤더 카드**(라벤더, `🎯 모드명 · Round N/M` 한 줄). 현재 플레이어 핑크 카드(사과 게임 "내 점수" 카드와 통일) + "다른 플레이어" row 카드. 점선 구분선 제거, 카드 gap 12px 로 시각 분리.
- **보드 위치** — Canvas 수직 중앙 `BOARD_CY=200`, 수평 좌측 영역(0~PANEL_X) 중앙 `BOARD_CX=220`. 상하/좌우 여유 각 ~50px / 70px 대칭.
- **pickup 안내 문구** — canvas 내부 긴 텍스트 "클릭 → 아래로 당겼다가…" 제거. canvas 바깥 HTML `<div class="darts-hint">` pill 로 분리. 관전자는 숨김. `.game-canvas-wrap` 을 flex column 으로 전환(다른 게임은 canvas 하나라 영향 X).
- **썸네일** — 단순화된 단일 크림 원 → **20 세그먼트 파이 분할**(크림/라벤더 교차, 18° arc path 20개). 외곽 순검정(`#000000`) + 꽂힌 다트 in-game 과 같은 4단 구조. 숫자 라벨은 넣지 않음.

### 한글 UI 정돈 (2026-04-25)
사용자용 한글 문자열 전수 검토 → 어색·사무적·문법 이상 15곳 수정.

- **반응속도 (7건)**: `빨간 동안은 절대 누르지 마세요` → `빨간색일 때 누르면 실격이에요` (문법 정돈 + 이유 명시). `실격 처리` → `실격!`. `다음 라운드 자동 시작` → `다음 라운드 준비 중…`. `끝!` → `완료!`. `전부 실격` → `모두 실격`. `초록! 지금 빨리 클릭!` → `초록이에요! 지금 클릭!`. `잠깐… 다음 라운드 대기 중` → `다음 라운드 준비 중…`.
- **다트 (4건)**: `점수 원복` (사무 용어) → `턴 무효`. `총점 (낮을수록 ↑)` (의미 모호) → `총점 (낮을수록 유리)`. `전 타겟 close` → `모든 타겟 close`.
- **오목 (2건)**: `상대 시간초과` → `상대 시간 초과` (띄어쓰기 통일). `상대 포기` → `상대 기권` (바둑 용어).
- **사과 게임**: `우측 랭킹을 확인하세요` → `오른쪽 랭킹을 확인하세요` (한자어 → 고유어).
- **공통**: `게임을 나가시겠어요? 방에서 완전히 나가요.` → `게임을 나가면 방도 같이 나가요. 나가시겠어요?`. 줄임표 `...` → `…` (3곳: 패배/방 만드는 중/연결 중).

### 관전 모드 (Phase 2)
- **peer.ts**: `JoinDecision.asSpectator?`. `handleIncoming` 가득참 즉시 거절 방어 제거 — 방 로직이 결정.
- **수락 분기**: waitingRoom 상태면 `room_full`. gameScreen 상태면 spectator 수락.
- **Player.role='spectator'** + 헤더 "👀 관전 중" 배지.
- **ah:end 는 winner 뒤집힘** → 관전자는 ah:end 무시, 플랫폼 game_end 경로로.
- **테트리스 관전 뷰 v1**: 메인 영역에 "관전 중" 오버레이, 우측 미니뷰 최대 4명.
- **MVP 한계**: 게임 중 합류한 관전자만 최신 players. 기존 플레이어 ctx.players 미갱신.

---

## 🧑‍🤝‍🧑 협업 스타일 (Henry 선호)

1. **한국어 대화**, 존댓말 없이 친근하게.
2. **파일 단위 리뷰** — 큰 변경은 한 파일씩.
3. **의존성 추가 전 먼저 물어보기**. PeerJS 외엔 최소화.
4. **큰 리팩토링은 Plan A/B 제시 후 선택**.
5. **주석은 한국어**. 복잡한 로직(물리/SRS/네트워크 동기화)은 "왜 이렇게 짰는지" 강조.
6. **TypeScript 낯섦** — `any` 남용 금지, 친절히 설명.
7. **Stale IDE diagnostics 흔함** — Grep 으로 실제 상태 확인.

---

## 🐛 알려진 이슈 / 개선 여지

- **Phase 3 (방장 이양) 미구현** — 방장 나가면 방 종료.
- **다트 네트워크 동기화 미완성** — `src/games/darts/index.ts` 주석 "Phase C". 현재 같은 기기 로컬 턴제만 동작. 여러 기기에서 방 만들어 붙어도 각 기기가 독립 state 로 돌아가 엇갈림.
- **테트리스 관전 뷰 v2 (2×2 격자) 미구현** — 현재 "관전 중" 오버레이만.
- **에어하키 관전자 비주얼** — 점수판 대신 "관전 중" 배지만.
- **사과 게임 솔버블 보장 X** — 단순 랜덤이라 운 나쁘면 덜 풀림.
- **사과 게임 관전자 뷰** — 보드 영역 전체 "관전 중" 오버레이. 어떤 플레이어 보드 보여주기 같은 개선 여지 있음.
- **통계 화면 머신별 독립** — localStorage 기반이라 집/회사 PC 에서 기록 따로 쌓임. 의도된 동작.
- **Windows 라인엔딩** — git LF→CRLF 경고. 무해.

---

## ✅ 빌드 / 배포

- **로컬 테스트**: `npm run dev` → http://localhost:5173.
  - 일반 창 + 시크릿 창 + (필요 시) 다른 브라우저. 4인은 창 4개.
  - **Cursor Simple Browser 는 WebRTC iframe 제약으로 P2P 불안정** → 실제 브라우저 쓰기.
- **빌드 확인**: `npm run build` → `dist/` 생성.
- **배포**: main/master push → GitHub Actions 자동 배포 → 1~2분 후 반영.
- **브라우저 캐시 주의**: 배포 직후 Ctrl+Shift+R.

---

## 📮 GitHub

- 저장소: https://github.com/Hoax0606/hoax-mini-games
- 기본 브랜치: `master`
- 배포 workflow: `.github/workflows/deploy.yml`

---

세부 디자인 원칙은 `CLAUDE.md` 도 참고 (프로젝트 열면 Claude Code 자동 로드).
