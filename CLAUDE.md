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
- 핑크 `--pink-50` ~ `--pink-500`
- 민트 `--mint-{100,200,300}`
- 라벤더 `--lavender-{100,200,300}`
- 크림 `--cream-{100,200}`
- 하늘색 `--sky-{100,200,300}`

### 캐릭터 색 (Canvas 하드코드)
- **호스트 말렛**: 민트 `#6ed9b3` / stroke `#2e8a70` / deep `#1f6a55`
- **게스트 말렛**: 노랑 `#ffd454` / stroke `#c49a1f` / deep `#8e6f10`
- **퍽**: 윗면 `#ff6b9e` / 옆면 `#c93d73` / stroke `#a82a5c`

### 썸네일 SVG 규약 (새 게임 추가 시 필수)
`src/games/air-hockey/thumbnail.svg`, `src/games/battle-tetris/thumbnail.svg`가 레퍼런스.
- `viewBox="0 0 320 200"`, 배경 `rx="22"`
- 배경 그라데이션: `#ffe4ee → #e0fff4`
- 점 데코 4개 (네 모서리 근처, 옅은 팔레트 색)
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
