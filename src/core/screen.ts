/**
 * 화면 라우터
 * 모든 화면은 Screen 인터페이스를 구현해야 함
 */

export interface Screen {
  /** DOM 요소를 렌더링하고 반환 */
  render(): HTMLElement;
  /** 화면에서 벗어날 때 정리 (이벤트 리스너, 타이머 등) */
  dispose?(): void;
}

export type ScreenFactory = () => Screen;

class Router {
  private root!: HTMLElement;
  private current?: Screen;
  private history: ScreenFactory[] = [];

  mount(root: HTMLElement): void {
    this.root = root;
  }

  /** 새 화면으로 이동 (history에 쌓임) */
  push(factory: ScreenFactory): void {
    this.history.push(factory);
    this.renderCurrent();
  }

  /** 현재 화면을 교체 (history에 안 쌓임) */
  replace(factory: ScreenFactory): void {
    if (this.history.length === 0) {
      this.history.push(factory);
    } else {
      this.history[this.history.length - 1] = factory;
    }
    this.renderCurrent();
  }

  /** 이전 화면으로 돌아가기 */
  back(): void {
    if (this.history.length <= 1) return;
    this.history.pop();
    this.renderCurrent();
  }

  /** 히스토리 초기화 후 새 화면 */
  reset(factory: ScreenFactory): void {
    this.history = [factory];
    this.renderCurrent();
  }

  private renderCurrent(): void {
    // 이전 화면 정리
    this.current?.dispose?.();

    const factory = this.history[this.history.length - 1];
    if (!factory) return;

    this.current = factory();
    const el = this.current.render();

    // 교체
    this.root.innerHTML = '';
    this.root.appendChild(el);
  }
}

export const router = new Router();
