# Hoax Minigames — 진행 상황 & 다음 작업 인계

다른 머신(집)에서 이 프로젝트를 이어서 작업할 때 읽는 문서.
**Claude Code 첫 프롬프트로 "HANDOFF.md 정독하고 이어서 진행해줘" 라고 시작하면 됨.**

---

## 🚀 빠른 시작 (다른 머신에서)

```bash
git clone https://github.com/Hoax0606/hoax-mini-games.git
cd hoax-mini-games
npm install
npm run dev       # http://localhost:5173
```

에디터에서 Claude Code 열고:

> HANDOFF.md + CLAUDE.md 둘 다 정독하고, 중단한 지점(Phase 2 관전 모드 구현)부터 이어서 진행해줘.

---

## 📌 현재 위치 (중단 지점)

**Phase 1, Phase 4 구현 완료 → Phase 2 진행 예정.**

| Phase | 내용 | 상태 |
|---|---|---|
| 1 | 플랫폼 4인화 (peer/waitingRoom/gameScreen 다중 플레이어) | ✅ 완료 |
| 2 | **관전 모드 (spectator role, 게임 중 입장)** | ⏳ **다음 작업** |
| 3 | 방장 이양 (peerId broadcast + 새 방장 재연결) | ⏸️ 보류 |
| 4 | 배틀 테트리스 구현 | ✅ 완료 (플레이테스트 대기) |
| 5 | 결과 화면 다인용 리팩토링 (4인 랭킹 표시) | ⏸️ 보류 |

---

## 🎮 프로젝트 개요

**한 줄**: 친구끼리 즐기는 웹 P2P 미니게임 모음집.
- **스택**: Vite + TypeScript + Canvas + PeerJS (WebRTC, 서버리스 P2P) + GitHub Pages
- **분위기**: 산리오풍 파스텔. 한국어 UI. PC 전용.
- **현재 게임**: 에어하키(2인), 배틀 테트리스(2~4인)
- **배포 URL**: https://hoax0606.github.io/hoax-mini-games/

---

## 🧱 아키텍처

### 파일 구조
```
src/
├── main.ts                      # 엔트리 + 글로벌 버튼 사운드 훅
├── core/
│   ├── peer.ts                  # PeerJS 래퍼 (HostSession 다중 conn, GuestSession)
│   ├── screen.ts                # 화면 라우터
│   ├── storage.ts               # localStorage 래퍼
│   └── sound.ts                 # Web Audio SFX 합성
├── games/
│   ├── types.ts                 # GameContext, Player, NetworkMessage
│   ├── registry.ts              # 등록된 게임 목록
│   ├── air-hockey/              # 2인 완료
│   │   ├── physics.ts           #   물리 시뮬레이션 (호스트 authoritative)
│   │   ├── render.ts            #   Canvas (필드/말렛/퍽/파티클)
│   │   ├── netSync.ts           #   ah:state / ah:input / ah:end
│   │   ├── index.ts             #   GameModule 조립
│   │   └── thumbnail.svg
│   └── battle-tetris/           # 2-4인 완료
│       ├── pieces.ts            #   7 테트로미노 + SRS kick + 7-bag
│       ├── field.ts             #   10×20 + 충돌/라인클리어/가비지
│       ├── engine.ts            #   상태머신 (중력/락/공격 산출)
│       ├── render.ts            #   Canvas (자기 필드 + HOLD + NEXT + 상대 미니뷰)
│       ├── netSync.ts           #   bt:state / bt:garbage / bt:topped / bt:end
│       ├── index.ts             #   GameModule 조립 (승리 판정 호스트)
│       └── thumbnail.svg
├── screens/
│   ├── menu.ts, nickname.ts, settings.ts
│   ├── gameList.ts              # 게임 선택 (카드 그리드 + 인원수 뱃지)
│   ├── lobby.ts                 # 방 만들기 / 방 참여
│   ├── createRoom.ts            # 방 설정 + HostSession 생성 + maxAccepted 세팅
│   ├── joinRoom.ts              # 방 코드 입력 + GuestSession 연결
│   ├── waitingRoom.ts           # 호스트/게스트 factory 2종, N슬롯 동적
│   ├── gameScreen.ts            # 게임 실행 컨테이너 (호스트/게스트 factory)
│   └── resultScreen.ts          # 결과 화면 (호스트/게스트 factory)
├── ui/theme.css                 # 팔레트 CSS 변수 + 컴포넌트 스타일
└── .github/workflows/deploy.yml # GitHub Pages 자동 배포
```

### 메시지 프로토콜

**NetworkMessage** (플랫폼 레벨) — peer.ts가 송수신:
- `join_request` / `join_accepted` / `join_rejected`
- `room_state` / `player_joined` / `player_left` (broadcast)
- `game_start` / `game_end`
- `game_msg` — 게임별 메시지 wrapper. `target?: string`, `from?: string` 필드로 relay 지원

**GameMessage** (게임 내부) — 각 게임이 정의:
- 에어하키: `ah:state` (호스트→게스트 authoritative) / `ah:input` (게스트→호스트) / `ah:end`
- 테트리스: `bt:state` (10Hz broadcast) / `bt:garbage` (target 지정) / `bt:topped` / `bt:end`

### 역할 (GameContext.role)
- `'host'` — 방장. 테트리스에선 승리 판정자.
- `'guest'` — 일반 참가자.
- `'spectator'` — **미구현 (Phase 2)**. Player.role에는 타입 있지만 실제 분기 아직 X.

### 핵심 설계 원칙

1. **에어하키** = 호스트 authoritative (퍽 물리는 호스트가 계산, 게스트는 상태 수신). 60Hz state broadcast.
2. **배틀 테트리스** = 로컬 시뮬레이션 (각자 자기 필드 계산). 10Hz state snapshot만 broadcast (상대 미니뷰용). 호스트는 승리 판정만.
3. **게임 모듈 확장성**: 새 게임 추가하려면 `src/games/<game-id>/` 만들고 `GameModule` 구현 + registry 등록. 플랫폼 코드 수정 X.

---

## 🎨 디자인 규약 (일관성 최우선)

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

**하드코딩 색 금지, CSS 변수 우선.** Canvas 렌더는 어쩔 수 없이 hex 하드코드하되 같은 팔레트 범주 따를 것.

### 캐릭터 색 (현재 확정)
- **호스트 말렛**: 민트 `#6ed9b3` / stroke `#2e8a70` / deep `#1f6a55` / knob top `#d4f9ea`
- **게스트 말렛**: 노랑 `#ffd454` / stroke `#c49a1f` / deep `#8e6f10` / knob top `#fff3c5`
- **퍽**: 윗면 `#ff6b9e` / 옆면 `#c93d73` / 테두리 `#a82a5c`

### SVG 썸네일 규약 (새 게임 추가 시 필수)
에어하키/테트리스 썸네일이 레퍼런스. 다음 동일:
- `viewBox="0 0 320 200"`, 배경 `rx="22"`
- 배경 그라데이션: `#ffe4ee → #e0fff4` (대각선)
- 배경 데코 (고정 패턴):
  ```svg
  <circle cx="30" cy="30" r="3" fill="#ffc9dd"/>
  <circle cx="290" cy="40" r="2.5" fill="#b8f5e0"/>
  <circle cx="290" cy="170" r="3" fill="#d9c7ff"/>
  <circle cx="30" cy="170" r="2.2" fill="#ffeec2"/>
  ```
- 별 path 데코 2개
- 중앙에 주요 일러스트 + 주변에 작은 보조 일러스트 비스듬히 (rotate -10 ~ +10도)

### Canvas 렌더 규약
- **devicePixelRatio 대응** (선명도). resize 시 `canvas.width = rect.width * dpr`
- **셀 렌더**: fill + 1px stroke + 상단 내부 흰색 반투명 하이라이트 (size ≥ 12 때만)
- **폰트**: `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`
- **논리 좌표계** 쓰고 ResizeObserver로 리사이즈 대응

---

## ⚠️ 과거 피드백 히스토리 (같은 실수 반복 방지)

### 디자인 관련 — Henry가 반복 강조한 것
1. **"젤리 느낌"** → 절대 금지. 말렛/퍽에 방사 그라데이션 + 반투명 광택 겹치면 젤리 됨. **솔리드 단색 + 얇은 옆면 오프셋**으로 단단한 원반 표현.
2. **귀 제거** → 말렛에 있던 고양이귀/곰귀 제거 요청받음. 현재는 단순 원반 + 중앙 손잡이.
3. **"퍽 밝게"** → 와인색/어두운 핑크 피하고 밝은 핫핑크.
4. **"산리오풍인데 과하게 귀여울 필요 X"** → 얼굴/표정/볼터치는 안 씀 (이전 시도했다 빼라 했음).
5. **"디자인 일관성"** → 새 일러스트는 기존 썸네일과 같은 톤 강제. 팔레트 재사용.

### 게임플레이 관련
- **퍽은 치기 전까지 정지** → 에어하키 start에서 nudge 제거됨. `serving` phase도 통째로 제거.
- **카운트다운 없음** → "3, 2, 1, GO!" 오버레이도 제거됨.
- **골 직후 화면 멈춤 방지** → `gameEnded` 후에도 loop 유지해서 파티클 fade-out 지속.
- **말렛 중앙선 넘는 버그** 수정 완료 → 게스트 로컬 예측에서도 `constrainToMyHalf()` 적용.

### UX 관련
- **메인 메뉴 정렬** → `.menu-list`에 `margin: 0 auto`. block 요소라 `text-align: center` 안 먹음.
- **결과 화면 전환** → 게임 종료 후 1200ms → 900ms로 단축 (지루함 제거).
- **대기실 시작 조건** → `players.length >= minPlayers` (꼭 꽉 찰 필요 X).

---

## 🧑‍🤝‍🧑 협업 스타일 (Henry 선호)

1. **한국어 대화**, 존댓말 없이 친근하게.
2. **파일 단위 리뷰** — 큰 변경은 한 파일씩 작성 후 멈춰서 확인. 몰아서 쓰지 말 것.
3. **의존성 추가 전 먼저 물어보기**. PeerJS 외엔 최소화.
4. **큰 리팩토링은 Plan A/B 제시 후 선택 받기**.
5. **주석은 한국어**. 복잡한 로직(물리/SRS/네트워크 동기화)은 "왜 이렇게 짰는지" 강조.
6. **TypeScript는 낯설어함** — `any` 남용 금지, 인터페이스 이름/용도 명확히, 타입 관련 코드는 친절히 설명.
7. **Stale IDE diagnostics 흔함** — Edit 여러 개 순차 적용 중간에 경고 자주 뜨는데, 최종 빌드 성공하면 무시. Grep으로 확인 후 "stale이야"로 정리.

---

## 🎯 다음 작업 상세 — Phase 2: 관전 모드

### 요구사항 (Henry 승인됨)
- 게임 **진행 중인 방에 입장 시** 자동 spectator로 수락
- 관전자는 **게임 화면 보기만** 가능, 입력/공격 불가
- 대기실에서 관전자 구역 별도 표시 (플레이어 구역과 구분)
- 게임 종료되면 관전자도 결과 화면 진입

### 구현 계획
1. **peer.ts의 `HostSession.handleIncoming`**: 현재 `acceptedConns.size >= maxAccepted`면 무조건 거절 → `room_full` 대신 **관전자로 수락** 옵션 추가. 근데 관전자 판단은 방 로직이 해야 하므로, `onJoinRequest` 반환 `JoinDecision`에 `role: 'spectator'` 추가:
   ```ts
   type JoinDecision =
     | { accept: true; roomState: RoomState; role?: 'player' | 'spectator' }
     | { accept: false; reason: ... };
   ```
   방 상태가 `'playing'`이면 maxAccepted 제한 풀고 spectator로 받음.

2. **waitingRoom의 `onJoinRequest`**: status가 `'playing'`일 수는 없으므로 여기선 변경 X. 하지만 **gameScreen의 onJoinRequest**가 필요해짐. 현재 gameScreen은 HostSession의 onJoinRequest를 null로 비워둠 → 덮어써야 함.
   - 게임 중 입장 → spectator로 수락 + 현재 RoomState(status='playing') 반환
   - 새 spectator에게는 지금까지의 필드 상태 sync 필요 (게임 별로 구현 필요)

3. **Player.role 활용**: spectator는 RoomState.players 배열에 넣되 role='spectator' 마킹. waitingRoom/gameScreen UI에서 구분 렌더.

4. **gameScreen**:
   - `ctx.isSpectator` (이미 types.ts에 있음) 반영
   - 관전자는 입력 핸들러 비활성
   - 헤더에 "관전 중 👀" 뱃지 표시

5. **각 게임 모듈**:
   - 에어하키: spectator일 때 가장 단순 (그냥 renderer만 돌리고 sendToPeer는 no-op)
   - 테트리스: 관전자는 own engine 없음, 상대들 미니뷰 대형으로 확장할지 고민

6. **게스트 joinRoom**: 거절 사유 분기 확장. `game_in_progress`는 현재 에러로 처리되는데 이제는 spectator로 자동 진입하도록.

### 고려 사항
- 에어하키 (호스트 authoritative)는 spectator도 `ah:state`만 받으면 그대로 렌더 가능. 쉬움.
- 테트리스 (로컬 시뮬레이션)는 spectator가 볼 "주 화면"이 없음. 옵션:
  - (A) 4인 모두의 필드를 2×2로 보여주기
  - (B) 리더 한 명 크게 보여주기
  - (C) 선택 가능
  - → 가장 간단한 (A) 추천

---

## 🐛 알려진 이슈 / 개선 여지

- **Phase 2 (관전) 미구현** — 게임 중 입장 시 현재 `game_in_progress` 거절됨
- **Phase 3 (방장 이양) 미구현** — 방장 나가면 즉시 방 종료 (게스트 "방장이 나갔어요" 알림 후 메뉴 복귀)
- **결과 화면 2인 기준** — 4인 테트리스 랭킹 표시 X. `result.summary.rankings`에 데이터는 있지만 UI 미구현
- **배틀 테트리스 플레이테스트 미진행** — 코드만 완성됨. 로직 버그 가능성 있으니 첫 실행 시 주의 관찰
- **Windows 라인엔딩** — git이 LF→CRLF 경고 발생하지만 무해

---

## ✅ 빌드 / 배포

- **로컬 테스트**: `npm run dev` → http://localhost:5173. 일반 창 + 시크릿 창 조합 (localStorage 분리). 4인은 창 4개.
- **빌드 확인**: `npm run build`. 성공 시 `dist/` 생성.
- **배포**: main/master push → GitHub Actions 자동 배포 → 1~2분 후 https://hoax0606.github.io/hoax-mini-games/ 반영
- **브라우저 캐시 주의**: 배포 직후 반영 안 보이면 Ctrl+Shift+R

---

## 📮 GitHub

- 저장소: https://github.com/Hoax0606/hoax-mini-games
- 기본 브랜치: `master`
- 배포 workflow: `.github/workflows/deploy.yml`

---

세부 디자인 원칙은 `CLAUDE.md`도 참고 (프로젝트 열면 Claude Code가 자동 로드).
