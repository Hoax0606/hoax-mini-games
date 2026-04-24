/**
 * localStorage 래퍼
 * 닉네임, 설정 + 게임별 전적/통계 저장
 */

export interface Settings {
  masterVolume: number;  // 0 ~ 100
  bgmEnabled: boolean;
  sfxEnabled: boolean;
}

/**
 * 게임별 누적 통계.
 * - winner: 'me' 면 wins++, 'opponent' 면 losses++, null 면 draws++
 * - 관전자는 기록하지 않음 (resultScreen 쪽에서 스킵)
 * - best: 게임별 자유 스키마 최고기록. 키별로 "높을수록 좋음/낮을수록 좋음" 비교는 호출자가 결정.
 */
export interface GameStats {
  plays: number;
  wins: number;
  losses: number;
  draws: number;
  lastPlayedAt: number;         // epoch ms
  /** 게임별 커스텀 최고기록 (예: 반응속도 bestMs, 사과 bestScore) */
  best?: Record<string, number>;
}

const KEYS = {
  nickname: 'hoax:nickname',
  settings: 'hoax:settings',
  stats: 'hoax:stats',
} as const;

const DEFAULT_SETTINGS: Settings = {
  masterVolume: 70,
  bgmEnabled: true,
  sfxEnabled: true,
};

export const storage = {
  // 닉네임
  getNickname(): string {
    return localStorage.getItem(KEYS.nickname) ?? '';
  },
  setNickname(name: string): void {
    localStorage.setItem(KEYS.nickname, name.trim());
  },
  hasNickname(): boolean {
    return this.getNickname().length > 0;
  },

  // 설정
  getSettings(): Settings {
    const raw = localStorage.getItem(KEYS.settings);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  setSettings(settings: Partial<Settings>): Settings {
    const next = { ...this.getSettings(), ...settings };
    localStorage.setItem(KEYS.settings, JSON.stringify(next));
    return next;
  },

  // ============================================
  // 통계
  // ============================================

  /** 전체 게임별 누적 통계 */
  getStats(): Record<string, GameStats> {
    const raw = localStorage.getItem(KEYS.stats);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, GameStats>;
    } catch {
      return {};
    }
  },

  /** 특정 게임 하나만 조회 (없으면 빈 값) */
  getGameStats(gameId: string): GameStats {
    const all = this.getStats();
    return all[gameId] ?? { plays: 0, wins: 0, losses: 0, draws: 0, lastPlayedAt: 0, best: {} };
  },

  /**
   * 한 판 결과 기록.
   * @param gameId 레지스트리 id
   * @param winner 'me' / 'opponent' / null (무승부)
   * @param bestEntries 이번 판의 기록 후보. 기존값과 비교해 best 업데이트 (higher=true면 더 큰 값이 best).
   */
  recordGameResult(
    gameId: string,
    winner: 'me' | 'opponent' | null,
    bestEntries: Array<{ key: string; value: number; higherIsBetter: boolean }> = [],
  ): void {
    const all = this.getStats();
    const cur: GameStats = all[gameId] ?? {
      plays: 0, wins: 0, losses: 0, draws: 0, lastPlayedAt: 0, best: {},
    };
    cur.plays++;
    if (winner === 'me') cur.wins++;
    else if (winner === 'opponent') cur.losses++;
    else cur.draws++;
    cur.lastPlayedAt = Date.now();

    cur.best = cur.best ?? {};
    for (const entry of bestEntries) {
      const prev = cur.best[entry.key];
      if (prev === undefined) {
        cur.best[entry.key] = entry.value;
      } else if (entry.higherIsBetter ? entry.value > prev : entry.value < prev) {
        cur.best[entry.key] = entry.value;
      }
    }

    all[gameId] = cur;
    localStorage.setItem(KEYS.stats, JSON.stringify(all));
  },

  /** 모든 통계 초기화 */
  clearStats(): void {
    localStorage.removeItem(KEYS.stats);
  },
};
