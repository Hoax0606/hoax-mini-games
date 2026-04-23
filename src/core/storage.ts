/**
 * localStorage 래퍼
 * 닉네임, 설정 등 사용자 데이터 저장
 */

export interface Settings {
  masterVolume: number;  // 0 ~ 100
  bgmEnabled: boolean;
  sfxEnabled: boolean;
}

const KEYS = {
  nickname: 'hoax:nickname',
  settings: 'hoax:settings',
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
};
