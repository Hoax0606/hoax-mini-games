# Hoax Minigames — 전용 PeerServer

PeerJS 무료 공용 서버가 불안정해서 "연결 중"에서 멈추던 문제를 해결하려고
직접 띄우는 **시그널링 서버**. 게임 데이터는 여기를 거치지 않고 P2P로 직접 오가므로
부하가 거의 없어 무료 티어로 충분하다.

---

## 로컬 실행 (테스트)

```bash
cd peerserver
npm install
npm start        # → :9000/hoaxmg 에서 대기
```

로컬 테스트 시 클라이언트가 이 서버를 보게 하려면 프로젝트 루트에 `.env` 파일:

```
VITE_PEER_HOST=localhost
```

그리고 `src/core/netConfig.ts` 의 port/secure 를 로컬용으로 임시 조정하거나,
그냥 배포 후 실제 주소로만 테스트해도 된다. (로컬은 secure=false, port=9000 필요)

---

## 배포 (Render 무료 티어 예시)

1. https://render.com 가입 → **New → Web Service**
2. 이 GitHub 저장소 연결
3. 설정:
   - **Root Directory**: `peerserver`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. 배포되면 주소가 나옴 (예: `hoax-peerserver.onrender.com`)
5. `src/core/netConfig.ts` 의 `DEFAULT_PEER_HOST` 를 그 주소로 변경
   (또는 GitHub Actions 빌드에 `VITE_PEER_HOST` 환경변수 주입)
6. 프론트 재배포 (master push)

### 주의: 무료 티어 콜드 스타트
Render 무료 웹서비스는 15분 미사용 시 잠들었다가 첫 요청에 ~30초 깨어남.
→ 하루 첫 접속만 느리고, 그 뒤론 정상. 이게 거슬리면:
- Railway/Fly.io 등 다른 무료 티어, 또는
- UptimeRobit 같은 걸로 5분마다 핑 쏴서 깨워두기.

---

## 다른 플랫폼 (Railway / Fly.io)
동일하게 `peerserver` 디렉토리를 루트로 지정하고 `npm start` 만 돌리면 됨.
플랫폼이 `PORT` 환경변수를 주입하므로 index.js 가 알아서 그 포트로 바인딩한다.
