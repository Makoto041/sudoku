import { parseTextSize, parseTheme, type TextSize, type Theme } from "./display";
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
  /** テーマ。開いたときは <head> のスクリプトもこの値を読む（display.ts） */
  theme: Theme;
  /** 文字サイズ。テーマと同じく <head> のスクリプトも読む */
  textSize: TextSize;
  /**
   * プレイ中の時計・スコア・盤面に浮かべる得点と、ホームの途中の経過時間を出さない。出さないだけで、時間と点数の計算・
   * 今日の一問の送信・記録・実績は変わらず、クリアの結果にはタイムと点数を出す
   */
  hideClock: boolean;
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
  theme: "auto",
  textSize: "normal",
  hideClock: false,
};

export function loadSettings(): Settings {
  const settings = { ...DEFAULT_SETTINGS, ...(load<Partial<Settings>>(KEYS.settings) ?? {}) };
  // テーマと文字サイズは <html> の属性にするので、決まった値だけを通す（ほかは既定にする）
  return { ...settings, theme: parseTheme(settings.theme), textSize: parseTextSize(settings.textSize) };
}

export function saveSettings(settings: Settings) {
  save(KEYS.settings, settings);
}
