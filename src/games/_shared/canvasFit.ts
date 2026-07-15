/**
 * 캔버스 균일 스케일 + 레터박스 공용 헬퍼.
 *
 * 여러 게임이 각자 `sx=width/W, sy=height/H` 로 비균일 스케일해서, 캔버스 비율이 설계 비율과
 * 다르면(채팅 열림·낮은 해상도·창 비율) 가로/세로로 찌부러지던 문제를 한 곳에서 해결.
 *
 * fitContain: 논리 크기 W×H 를 캔버스에 "비율 유지"로 최대한 크게 넣고(min 스케일) 남는
 *   여백은 배경색으로 채운다(레터박스). 반환한 view 로 입력 좌표를 역변환한다.
 *
 * 사용:
 *   render() 시작에서  this.view = fitContain(ctx, canvas, W, H, bg)
 *   이후 논리 좌표(0..W, 0..H)로 평소처럼 그리면 됨.
 *   입력에서  const {x,y} = fitScreenToLogical(this.view, e.clientX-rect.left, e.clientY-rect.top)
 */

export interface FitView {
  /** 논리→물리 배율 (CSS px 기준) */
  scale: number;
  /** 레터박스 좌측 여백 (CSS px) */
  offX: number;
  /** 레터박스 상단 여백 (CSS px) */
  offY: number;
}

/**
 * 캔버스를 클리어+배경칠 후, 논리 W×H 를 비율 유지로 담는 transform 을 건다.
 * @returns 입력 역변환용 view (scale/offX/offY, 모두 CSS px 기준)
 */
/** rect(CSS px) 크기로부터 레터박스 view 계산 (순수 함수 — 렌더/입력 어디서든 동일 결과) */
export function fitView(rectW: number, rectH: number, W: number, H: number): FitView {
  const scale = Math.min(rectW / W, rectH / H) || 1;
  return { scale, offX: (rectW - W * scale) / 2, offY: (rectH - H * scale) / 2 };
}

export function fitContain(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  W: number,
  H: number,
  bg: string,
): FitView {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const { scale, offX, offY } = fitView(rect.width, rect.height, W, H);

  // 전체 버퍼를 배경색으로 채워 레터박스 여백까지 칠함
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 논리 좌표계 (물리픽셀 = CSS × dpr), 레터박스 오프셋 적용
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offX * dpr, offY * dpr);
  return { scale, offX, offY };
}

/** 캔버스 내 좌표(px, dpr 미적용 CSS px) → 논리 좌표 역변환 */
export function fitScreenToLogical(view: FitView, xInCanvas: number, yInCanvas: number): { x: number; y: number } {
  return { x: (xInCanvas - view.offX) / view.scale, y: (yInCanvas - view.offY) / view.scale };
}
