# Hoax Minigames — Claude Code 작업 지침

Claude Code가 프로젝트 열 때 자동 로드하는 상시 컨텍스트.
**세부 진행 상황 / 다음 작업 / 피드백 히스토리는 `HANDOFF.md` 참고.**

---

## 프로젝트 요약

친구끼리 즐기는 웹 P2P 미니게임 모음집.
- **스택**: Vite + TypeScript + Canvas + PeerJS(WebRTC) + GitHub Pages
- **분위기**: 산리오풍 파스텔 (오리지널 느낌, 실제 IP는 안 씀), 한국어 UI, PC 전용
- **아키텍처**: 서버리스 P2P, 호스트가 허브(star topology)

## 개발자 (Henry Oh)

- 한국인, **한국어로 대화**, 존댓말 없이 편하게
- 본업 COBOL→Java 마이그레이션, Swift/JS 경험 있음
- **TypeScript는 낯섦** → 타입 관련 코드는 친절히 설명, `any` 남용 금지
- 이 프로젝트는 개인 사이드 프로젝트 (재미 중심)

## 협업 원칙 (반드시 지킬 것)

1. **한국어 대화**. 친근하고 간결하게.
2. **파일 단위 리뷰** — 큰 변경은 한 파일씩 작성 후 확인. 한 번에 여러 파일 몰아서 쓰지 말 것.
3. **의존성 추가 전 먼저 물어보기**. PeerJS 외엔 최소화.
4. **큰 리팩토링은 Plan A/B 제시 후 선택 받기** (예: "범위 줄이려면 A, 확실히 하려면 B").
5. **주석은 한국어**. 복잡한 로직(물리/SRS 회전/네트워크 동기화)은 "왜 이렇게 짰는지" 명시. 단순 코드는 주석 X.
6. **CSS는 `src/ui/theme.css` 변수 활용**. 하드코딩 색 금지 (단, Canvas 렌더는 불가피).
7. **모든 UI 텍스트는 한국어**. i18n 신경 안 씀.

## 코드 스타일

- 에러 처리/검증은 경계(user input, external API)에만. 내부 코드는 신뢰.
- 기능/리팩토링 범위 최소화. YAGNI. 추상화는 세 번째 반복부터.
- 되돌릴 수 없는 작업(push, reset, 파일 삭제)은 반드시 사용자 확인.
- **Stale IDE diagnostics 흔함** — Edit 여러 개 순차 적용 중간에 경고 자주 뜨는데, 최종 빌드 성공하면 무시 ("stale" 이라 설명하고 Grep으로 실제 상태 확인).

## 디자인 규약

### 팔레트 (theme.css CSS 변수 사용)

**주색 = 청록, 포인트 = 노랑.** 핑크는 2026-11-17 에 전면 제거됨 — 다시 쓰지 말 것.

| 램프 | 변수 | 역할 |
|---|---|---|
| 청록 | `--teal-50` ~ `--teal-500` | 주색. 버튼·링크·테두리·배경 |
| 노랑 | `--yellow-100` ~ `--yellow-500` | 포인트. `--yellow-500` 은 **노랑 배경 위 글자용**(연노랑은 글자색으로 못 씀) |
| 민트 | `--mint-{100,200,300,500}` | 성공/준비완료 전용. `--mint-500` 은 밝은 배경 위 글자용 |
| 라벤더 | `--lavender-{100,200,300}` | 보조 (2등/무승부/시민역할 등 게임별 의미색) |
| 하늘 | `--sky-{100,200,300}` | 보조 |

시맨틱 변수 — **직접 램프를 쓰기 전에 이쪽부터 찾을 것**:
- `--accent` / `--accent-hover` / `--accent-soft` — 청록 (기본 액션)
- `--highlight` / `--highlight-soft` / `--highlight-ink` — 노랑 (**"지금 여기" 상태 전용**: 선택됨/내 차례/내 메시지)
- `--warn` / `--warn-soft`, `--danger` / `--danger-soft` — 경고·위험 (예전엔 핑크가 이 역할까지 겸했음)
- `--bg-main` / `--bg-card` / `--bg-subtle` / `--bg-inset`, `--border` / `--border-soft`

**노랑은 아껴 쓸 것.** 여기저기 뿌리면 청록이 죽는다. 현재 쓰는 곳: 로고 그라데이션 · 배경 글로우 · 선택된 게임 카드 · 포트리스 무기 선택 · 라이어게임 현재 차례 · 내 채팅 버블 · 테트리스 결과 내 행.

⚠️ **`index.html` 부트 스플래시는 theme.css 로딩 전이라 CSS 변수를 못 쓴다.** `--teal-50`/`--teal-100`/`--yellow-100`/`--text-muted` 값을 직접 박아놨으니, 이 변수들을 바꾸면 `index.html` 도 같이 고칠 것 (안 그러면 앱 뜨는 순간 배경색이 튄다).

### 캐릭터 색 (Canvas 하드코드)
- **1P/호스트**: 민트 `#6ed9b3` / stroke `#2e8a70` / deep `#1f6a55`
- **2P/게스트**: 노랑 `#ffd454` / stroke `#c49a1f` / deep `#8e6f10`
- 3P 라벤더 `#b89aff`/`#7a5fc7` · 4P 하늘 `#5b9cff`/`#3f78c9` · 5P 주황 `#ff9f43`/`#cf7417`
- **퍽**: 윗면 `#ff6b9e` / 옆면 `#c93d73` / stroke `#a82a5c`
  - 사이트에서 유일하게 남은 핑크. "밝은 핫핑크 퍽" 은 Henry 가 과거에 정한 것이라 유지 중.

> 2인 게임의 대결색은 **민트 vs 노랑**으로 통일됨 (예전엔 민트 vs 핑크였음). 알까기·포트리스 플레이어 배열도 같은 순서.

### 썸네일 SVG 규약 (새 게임 추가 시 필수)
`src/games/air-hockey/thumbnail.svg`, `src/games/battle-tetris/thumbnail.svg`가 레퍼런스.
- `viewBox="0 0 320 200"`, 배경 `rx="22"`
- 배경 그라데이션: `#ddf2ef → #fff8e1` (청록 → 연노랑)
- 점 데코 4개 (네 모서리 근처, 옅은 팔레트 색 — `#c5e8e1` / `#ffeeb8` / `#8ccfc6`)
- 드롭섀도 `flood-color="#3a6b63"`
- 별 path 데코 2개
- 중앙에 주요 일러스트 + 주변에 작은 보조 일러스트 비스듬히

### Canvas 렌더 규약
- devicePixelRatio 대응 (resize 시 `canvas.width = rect.width * dpr`)
- 셀: fill + 1px stroke + 상단 내부 흰색 반투명 하이라이트 (큰 셀만)
- 폰트: `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`
- 논리 좌표계 쓰고 `ResizeObserver`로 리사이즈 대응

## 금기 사항 (과거 피드백 기반)

| 금기 | 대체 |
|---|---|
| 말렛/퍽에 방사 그라데이션 + 반투명 광택 = "젤리 느낌" | **솔리드 단색 + 얇은 옆면 오프셋**으로 단단한 원반 |
| 캐릭터 귀(고양이/곰) | 제거됨. 단순 원반 + 중앙 손잡이 |
| 얼굴/표정/볼터치 | "과하게 귀엽지 X" 방침 — 쓰지 않음 |
| 어두운 와인색 퍽 | 밝은 핫핑크 `#ff6b9e` |
| 하드코딩 색상 | theme.css CSS 변수 |
| 핑크 (`#ff5a92`, `#ff82ac`, `#ff6b9e` 등) | 청록 `--teal-*` / 노랑 `--yellow-*`. 경고였다면 `--warn`·`--danger` |
| 경고·오류를 핑크로 표시 | `--warn`(주황) / `--danger`(빨강) — 의미가 드러나게 |
| 에어하키 카운트다운 (3/2/1/GO) | 제거됨. 퍽은 치기 전까지 정지 |

## 주요 아키텍처 포인트

### peer.ts
- `HostSession.maxAccepted`가 게임 `maxPlayers-1`로 세팅됨 (createRoom에서)
- `send(msg)` = 모든 게스트 broadcast, `sendTo(peerId, msg)` = 특정 대상
- 콜백 시그니처에 `fromPeerId` 확장됨 (기존 `(msg) => {}` 호출도 여전히 유효)

### types.ts
- `Player` 인터페이스: `peerId`, `nickname`, `isHost`, `role: 'player'|'spectator'`
- `RoomState.players[]` 주 데이터. `hostNickname`/`guestNickname`은 호환용 유지.
- `GameContext`에 `players`, `myPlayerId`, `isSpectator`, `sendToPeer(msg, {target?})`

### 게임 추가 절차
1. `src/games/<game-id>/` 폴더 생성 + `thumbnail.svg` + `GameModule` 구현
2. `src/games/registry.ts`에 엔트리 추가 (meta + lazy load)
3. 끝. 플랫폼 코드(로비/대기실/게임 화면) 수정 X.

## 참고 파일

- `HANDOFF.md` — 최신 진행 상황, 다음 작업 상세, 과거 피드백 전문
- `src/ui/theme.css` — 팔레트/컴포넌트 스타일 정의
- `src/games/air-hockey/` — 완성된 2인 호스트-authoritative 게임 참고
- `src/games/battle-tetris/` — 완성된 N인 로컬-시뮬레이션 게임 참고
- `.github/workflows/deploy.yml` — GitHub Pages 자동 배포

## 배포

- main/master push → GitHub Actions 자동 배포
- https://hoax0606.github.io/hoax-mini-games/
