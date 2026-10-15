import { KEYS, load, save } from "./storage";

export type Settings = {
  sound: boolean;
  haptics: boolean;
  /** フリープレイで間違いをすぐ赤く表示する */
  showMistakes: boolean;
  /** 同じ数字を強調する */
  highlightSame: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  haptics: true,
  showMistakes: true,
  highlightSame: true,
};

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...(load<Partial<Settings>>(KEYS.settings) ?? {}) };
}

export function saveSettings(settings: Settings) {
  save(KEYS.settings, settings);
}
