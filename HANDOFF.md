# Hoax Minigames — 진행 상황 & 다음 작업 인계

다른 머신(집)에서 이 프로젝트를 이어서 작업할 때 읽는 문서.
**Claude Code 첫 프롬프트로 "HANDOFF.md 정독하고 이어서 진행해줘" 라고 시작하면 됨.**

마지막 업데이트: **2026-04-24** (사과 게임 + 게임별 BGM 추가)

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

**다음 작업 (2026-04-25 예정)**:
- 🅐 **Phase 3 방장 이양** — 방장 나가면 남은 사람 중 하나가 새 방장 돼서 게임 이어가기
- 🅑 **새 게임: 오목** — 2인 턴제 보드 게임. 19×19 격자, 5목 완성 승

---

## 🎮 프로젝트 개요

**한 줄**: 친구끼리 즐기는 웹 P2P 미니게임 모음집.
- **스택**: Vite + TypeScript + Canvas + PeerJS (WebRTC, 서버리스 P2P) + GitHub Pages
- **분위기**: 산리오풍 파스텔. 한국어 UI. PC 전용.
- **현재 게임 (3종)**:
  - 에어하키 (2인, 호스트 authoritative 물리)
  - 배틀 테트리스 (2~4인, 로컬 시뮬레이션)
  - 사과 게임 (1~4인, 숫자 사과 합 10 터트리기, 2분)
- **배포 URL**: https://hoax0606.github.io/hoax-mini-games/

---

## 🧱 아키텍처

### 파일 구조
```
src/
├── main.ts                      # 엔트리 + 글로벌 버튼 사운드 훅
├── core/
│   ├── peer.ts                  # PeerJS 래퍼 (HostSession 다중 conn, GuestSession)
│   │                            #   JoinDecision.asSpectator 로 관전자 수락 표현
│   ├── screen.ts                # 화면 라우터
│   ├── storage.ts               # localStorage 래퍼
│   ├── sound.ts                 # Web Audio SFX 합성 (에어하키 5종 + 테트리스 8종)
│   │                            #   startBgm/stopBgm 래퍼로 bgm.ts 위임
│   └── bgm.ts                   # 게임별 BGM 시퀀서 (멜로디+베이스 루프, chiptune 스타일)
├── games/
│   ├── types.ts                 # GameContext, Player(role), NetworkMessage
│   ├── registry.ts              # 등록된 게임 목록
│   ├── air-hockey/              # 2인 호스트 authoritative
│   ├── battle-tetris/           # 2-4인 로컬 시뮬레이션
│   └── apple-game/              # 1-4인 독립 보드 + 점수 경쟁
│       ├── rng.ts               #   Mulberry32 PRNG (seed 공유로 동일 보드)
│       ├── board.ts             #   17×10 + 드래그 영역 합 10 판정
│       ├── render.ts            #   Canvas (보드 + 좌측 타이머/점수 + 우측 플레이어)
│       ├── netSync.ts           #   ag:hello / ag:seed / ag:score / ag:end
│       └── index.ts             #   마우스 드래그 + 타이머 + 호스트 랭킹 판정
├── screens/
│   ├── menu.ts, nickname.ts, settings.ts, gameList.ts, lobby.ts
│   ├── createRoom.ts, joinRoom.ts
│   ├── waitingRoom.ts           # 호스트/게스트 factory
│   ├── gameScreen.ts            # 호스트/게스트, onJoinRequest로 관전자 수락
│   └── resultScreen.ts          # 테트리스/사과 전용 결과 분기 + 기본 2인 점수판
├── ui/theme.css                 # 팔레트 + 컴포넌트 스타일
└── .github/workflows/deploy.yml # GitHub Pages 자동 배포
```

### 메시지 프로토콜

**NetworkMessage** (플랫폼 레벨):
- `join_request` / `join_accepted` / `join_rejected`
- `room_state` / `player_joined` / `player_left`
- `game_start` / `game_end` — game_end 는 **관전자 결과 화면 이동 경로**
- `game_msg` — 게임별 메시지 wrapper. `target?: string`, `from?: string`

**GameMessage** (게임 내부):
- 에어하키: `ah:state` / `ah:input` / `ah:end`
- 테트리스: `bt:state` (10Hz) / `bt:garbage` / `bt:topped` / `bt:end`
- 사과 게임: `ag:hello` (게스트 → 호스트 seed 요청) / `ag:seed` / `ag:score` / `ag:end`

### 역할 (GameContext.role + isSpectator)
- `role: 'host'` — 방장. 승리 판정자.
- `role: 'guest'` + `isSpectator: false` — 일반 플레이어.
- `role: 'guest'` + `isSpectator: true` — 관전자. 입력/브로드캐스트 없음, 렌더만.

### 핵심 설계 원칙

1. **에어하키** = 호스트 authoritative 물리, 60Hz state broadcast.
2. **배틀 테트리스** = 로컬 시뮬레이션, 10Hz 스냅샷. 호스트는 승리 판정만.
3. **사과 게임** = 독립 보드(같은 seed로 동일 배치) + 게임 중 상대 점수 비공개. 타이머 만료 시점에만 점수 공유, 호스트 1초 grace period 후 랭킹 집계.
4. **게임 모듈 확장성**: `src/games/<id>/` + `GameModule` + registry. 플랫폼 수정 X.
5. **관전자 결과 화면 이동**: 플레이어는 게임 내부 end 메시지, 관전자는 플랫폼 `game_end` broadcast.

---

## 🎵 BGM (bgm.ts)

각 게임이 자기 BGM 재생 — chiptune 스타일 짧은 루프(8마디), 멜로디+베이스 2트랙.
- `sound.startBgm('air-hockey' | 'battle-tetris' | 'apple-game')`
- `sound.stopBgm()` — 게임 모듈 destroy 에서 호출
- `storage.bgmEnabled=false` 면 no-op
- BGM 은 SFX 보다 작게 (마스터 게인 × 0.35)
- 끊김 없는 루프 (한 루프 끝 50ms 전에 다음 루프 스케줄)

**각 BGM 특징**:
- 에어하키: C 메이저 · 130 BPM · square 파형 · 경쾌
- 배틀 테트리스: A 마이너 · 110 BPM · triangle · 긴장감
- 사과 게임: F 메이저 · 95 BPM · triangle · 밝고 느긋

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
  - 기본(에어하키): 2인 점수판
- **내 기준 stats 만 추적** — 다른 플레이어 stats 집계 안 함 (관전자 rankings 에 "나" 없으면 `isSpectator` 자동 인식).

### 사운드 (SFX)
- `sound.ts` Web Audio 합성. `SfxId` 타입에 게임별 SFX 추가.
- 테트리스 8종: rotate/lock/harddrop/hold/clear/tetris/garbage/topout.
- 사과 게임은 기존 SFX 재활용: 성공 `tetris_clear`, 종료 `tetris_topout`.
- **자주 울리는 액션(좌우 이동, 소프트드롭) 사운드 X** — 시끄러움 방지.

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
- **테트리스 관전 뷰 v2 (2×2 격자) 미구현** — 현재 "관전 중" 오버레이만.
- **에어하키 관전자 비주얼** — 점수판 대신 "관전 중" 배지만.
- **사과 게임 솔버블 보장 X** — 단순 랜덤이라 운 나쁘면 덜 풀림.
- **사과 게임 관전자 뷰** — 보드 영역 전체 "관전 중" 오버레이. 어떤 플레이어 보드 보여주기 같은 개선 여지 있음.
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
