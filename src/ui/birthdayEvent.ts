/**
 * 깜짝 생일 축하 이벤트 — 폭죽 + 메시지 오버레이.
 *
 * 특정 닉네임(예: "수경")으로 시작한 사람에게만 메인 화면 진입 시 1회 띄운다.
 * 화면 전체에 fixed 캔버스로 폭죽을 터뜨리고, 중앙에 축하 카드.
 *
 * 네트워크 무관 — 닉네임 입력은 방 입장 전이라 P2P 연결이 없다. 그 사람 본인 화면에만.
 */

import { escapeHtml } from './escape';
import { storage } from '../core/storage';
import { sound } from '../core/sound';

/** 폭죽 색 — 산리오풍 파스텔 팔레트 */
const COLORS = ['#ff6b9e', '#86e8c4', '#b89aff', '#ffd454', '#86c9ff', '#ff82ac', '#ffb12e'];

/**
 * 생일 축하 노래 ("Happy Birthday to You" 멜로디 — 멜로디는 퍼블릭 도메인) 합성 재생.
 * bgm.ts 와 같은 oscillator 방식. 설정에서 BGM 이 꺼져 있으면 재생 안 함.
 * 반환값: 정지 함수 (팝업 닫힐 때 호출).
 */
function playBirthdaySong(): () => void {
  const settings = storage.getSettings();
  if (!settings.bgmEnabled) return () => {};

  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return () => {};

  const ctx = new AC();
  void ctx.resume(); // 시작 버튼 클릭(user gesture) 직후라 보통 바로 활성화됨
  const master = ctx.createGain();
  master.gain.value = (settings.masterVolume / 100) * 0.32;
  master.connect(ctx.destination);

  // 음이름 → 주파수 (C 장조, 멜로디가 G5 까지 올라감)
  const G4 = 392.0, A4 = 440.0, B4 = 493.88, C5 = 523.25,
        D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99;

  // [주파수, 박자] — 3/4 박. "생일 축하합니다" 4마디.
  const melody: Array<[number, number]> = [
    [G4, 0.75], [G4, 0.25], [A4, 1], [G4, 1], [C5, 1], [B4, 2],
    [G4, 0.75], [G4, 0.25], [A4, 1], [G4, 1], [D5, 1], [C5, 2],
    [G4, 0.75], [G4, 0.25], [G5, 1], [E5, 1], [C5, 1], [B4, 1], [A4, 2],
    [F5, 0.75], [F5, 0.25], [E5, 1], [C5, 1], [D5, 1], [C5, 2],
  ];

  const beatSec = 0.42; // 한 박 길이 (≈ 약간 경쾌한 템포)
  let t = ctx.currentTime + 0.08;
  const oscs: OscillatorNode[] = [];

  for (const [freq, beats] of melody) {
    const dur = beats * beatSec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const attack = 0.02;
    const release = Math.min(0.12, dur * 0.3);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.85, t + attack);
    gain.gain.setValueAtTime(0.85, Math.max(t + attack, t + dur - release));
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    oscs.push(osc);
    t += dur;
  }

  return () => {
    for (const o of oscs) {
      try { o.stop(); } catch { /* 이미 끝남 */ }
    }
    void ctx.close().catch(() => {});
  };
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;   // 1 → 0
  size: number;
}

/** 위에서 쏟아지는 색종이 조각 — 사각형이 회전하며 낙하 */
interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  rotVel: number;
  w: number;
  h: number;
  color: string;
}

/**
 * 생일 축하 오버레이를 띄운다.
 * @param opts.title   큰 축하 문구
 * @param opts.sender  보낸 사람 서명
 * @param opts.onClose 닫힐 때(고마워/바깥 클릭) 호출 — 원래 배경음악 복귀 등에 사용
 */
export function showBirthdayEvent(opts: { title: string; sender: string; onClose?: () => void }): void {
  // 중복 방지 — 이미 떠 있으면 무시
  if (document.querySelector('.birthday-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'birthday-overlay';
  overlay.innerHTML = `
    <canvas class="birthday-canvas"></canvas>
    <div class="birthday-card">
      <div class="birthday-emoji">🎉🎂🎉</div>
      <div class="birthday-title">${escapeHtml(opts.title)}</div>
      <div class="birthday-sender">${escapeHtml(opts.sender)}</div>
      <button class="btn btn-primary" id="birthday-close" type="button">고마워! 🥳</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector<HTMLCanvasElement>('.birthday-canvas')!;
  const ctx = canvas.getContext('2d');
  if (!ctx) { overlay.remove(); return; }

  let dpr = window.devicePixelRatio || 1;
  const resize = (): void => {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  };
  resize();
  window.addEventListener('resize', resize);

  // 생일 노래 동안 다른 BGM(이전 게임 잔재 등)이 겹치지 않게 멈춤.
  sound.stopBgm();

  const particles: Particle[] = [];
  const confetti: Confetti[] = [];

  /** 화면 상단 가로 전체에서 색종이 한 줌 생성 */
  const spawnConfetti = (n: number): void => {
    for (let i = 0; i < n; i++) {
      confetti.push({
        x: Math.random() * window.innerWidth,
        y: -20 - Math.random() * 60,
        vx: (Math.random() - 0.5) * 1.4,
        vy: 1.5 + Math.random() * 2.5,
        rot: Math.random() * Math.PI * 2,
        rotVel: (Math.random() - 0.5) * 0.3,
        w: 7 + Math.random() * 7,
        h: 10 + Math.random() * 8,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      });
    }
  };

  /** 한 발 터뜨리기 — (cx, cy) 중심에서 사방으로 입자 발사.
   *  큼직하게: 입자 수 ↑ + 속도 ↑(=반경 ↑) + 크기 ↑. 이중 링으로 더 풍성하게. */
  const burst = (cx: number, cy: number): void => {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)]!;
    // 안쪽/바깥 두 겹 링 — 폭죽이 크고 꽉 차 보이게.
    // (입자 수는 성능 위해 절제 — 글로우 없이 크기/색으로 화려함 확보)
    const rings = [
      { count: 26 + Math.floor(Math.random() * 12), speedMin: 5, speedMax: 11 },
      { count: 16 + Math.floor(Math.random() * 8), speedMin: 2.5, speedMax: 6 },
    ];
    for (const ring of rings) {
      // 바깥 링은 다른 색 살짝 섞어 화려하게
      const ringColor = ring === rings[0] ? color : COLORS[Math.floor(Math.random() * COLORS.length)]!;
      for (let i = 0; i < ring.count; i++) {
        const angle = (Math.PI * 2 * i) / ring.count + Math.random() * 0.25;
        const speed = ring.speedMin + Math.random() * (ring.speedMax - ring.speedMin);
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color: ringColor,
          life: 1,
          size: 3.5 + Math.random() * 4,
        });
      }
    }
  };

  // 시작 시 몇 발 + 이후 주기적으로 자동 발사
  let elapsed = 0;
  let lastBurstAt = 0;
  let lastFrame = 0;
  let rafId = 0;
  let stopped = false;

  const loop = (t: number): void => {
    if (stopped) return;
    rafId = requestAnimationFrame(loop);
    if (lastFrame === 0) lastFrame = t;
    const dt = Math.min(50, t - lastFrame);
    lastFrame = t;
    elapsed += dt;

    // 0.32초마다 새 폭죽 — 한 번에 1~2발씩 (화면 곳곳에서 펑펑)
    if (elapsed - lastBurstAt > 320) {
      lastBurstAt = elapsed;
      const shots = 1 + Math.floor(Math.random() * 2);
      for (let s = 0; s < shots; s++) {
        const cx = window.innerWidth * (0.12 + Math.random() * 0.76);
        const cy = window.innerHeight * (0.1 + Math.random() * 0.55);
        burst(cx, cy);
      }
    }
    // 색종이 꾸준히 쏟아짐 (화면당 일정 수 유지)
    if (confetti.length < 110) spawnConfetti(4);

    // 폭죽 입자 총량 상한 — 누적 폭주 방지 (오래된 것부터 제거)
    if (particles.length > 420) particles.splice(0, particles.length - 420);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    // 1) 색종이 — 폭죽보다 먼저 그려 뒤에 깔리게
    for (let i = confetti.length - 1; i >= 0; i--) {
      const c = confetti[i]!;
      c.vy += 0.02;
      c.x += c.vx * (dt / 16);
      c.y += c.vy * (dt / 16);
      c.rot += c.rotVel * (dt / 16);
      if (c.y > window.innerHeight + 30) { confetti.splice(i, 1); continue; }
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }

    // 2) 폭죽 입자 — lighter 합성으로 겹칠 때 밝게 (shadowBlur 글로우는 렉 주범이라 제거).
    ctx.globalCompositeOperation = 'lighter';
    const gravity = 0.05;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.vy += gravity;
      p.x += p.vx * (dt / 16);
      p.y += p.vy * (dt / 16);
      // 적당히 빠르게 사라지게 — 누적 줄여 부드럽게
      p.life -= 0.018 * (dt / 16);
      if (p.life <= 0) { particles.splice(i, 1); continue; }

      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  };

  // 시작 폭죽 — 한꺼번에 큼직하게 5발 + 색종이 한 줌
  burst(window.innerWidth * 0.25, window.innerHeight * 0.32);
  burst(window.innerWidth * 0.75, window.innerHeight * 0.3);
  burst(window.innerWidth * 0.5, window.innerHeight * 0.18);
  burst(window.innerWidth * 0.4, window.innerHeight * 0.45);
  burst(window.innerWidth * 0.62, window.innerHeight * 0.5);
  spawnConfetti(60);
  rafId = requestAnimationFrame(loop);

  // 🎵 생일 축하 노래 재생
  const stopSong = playBirthdaySong();

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    stopped = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', resize);
    stopSong();                 // 생일 노래 즉시 중지
    opts.onClose?.();           // 원래 배경음악(메뉴 BGM) 복귀
    overlay.classList.add('is-closing');
    window.setTimeout(() => overlay.remove(), 300);
  };

  overlay.querySelector<HTMLButtonElement>('#birthday-close')!.addEventListener('click', close);
  // 카드 바깥(폭죽 영역) 클릭해도 닫힘
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}
