import { KEYS, load, save } from "./storage";

export type Settings = {
  sound: boolean;
  haptics: boolean;
  /** フリープレイで間違いをすぐ赤く表示する */
  showMistakes: boolean;
  /** 同じ数字を強調する */
  highlightSame: boolean;
  /** 選んだマスの行・列・ブロックを強調する */
  highlightPeers: boolean;
  /** 数字ボタンに残りの個数を出し、使い切った数字を薄くする */
  showRemaining: boolean;
  /** 数字を置いたとき、同じ行・列・ブロックのメモからその数字を消す */
  autoClearNotes: boolean;
  /** 行・列・ブロックが揃ったときと、解き終えたときに盤面を光らせる（音と点数は変わらない） */
  unitFx: boolean;
  /** ヒントを開く前に確認する（ヒントを使うとコンボが切れる） */
  confirmHint: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  haptics: true,
  showMistakes: true,
  highlightSame: true,
  highlightPeers: true,
  showRemaining: true,
  autoClearNotes: true,
  unitFx: true,
  confirmHint: false,
};

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...(load<Partial<Settings>>(KEYS.settings) ?? {}) };
}

export function saveSettings(settings: Settings) {
  save(KEYS.settings, settings);
}
