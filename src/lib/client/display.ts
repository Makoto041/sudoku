import { KEYS } from "./storage";

/**
 * 表示の設定（テーマ・文字サイズ）。設定（KEYS.settings）の theme・textSize に保存し、<html> の属性で効かせる
 * （data-theme・data-text-size。色と大きさは globals.css）。既定（自動・標準）では属性を付けない。
 * 端末ごとの設定で、引き継ぎ・アカウントの同期には含めない
 */

/** テーマ。auto は端末の設定（prefers-color-scheme）に従う */
export const THEMES = ["auto", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** 文字サイズ。倍率は globals.css の --text-scale（標準 1・大 1.15・特大 1.3） */
export const TEXT_SIZES = ["normal", "large", "xlarge"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export type Display = { theme: Theme; textSize: TextSize };

/** ブラウザの枠などの色（theme-color）。globals.css の --bg と同じにする */
export const THEME_COLORS = { light: "#f5f4f0", dark: "#0f0f11" } as const;

/**
 * テーマを選んだときに <head> の先頭に置く theme-color の meta の id。
 * 最初に当てはまる theme-color が使われるので、端末の設定に合わせたもの（layout.tsx の viewport）より先に置く
 */
export const THEME_COLOR_ID = "theme-color-fixed";

/**
 * テーマを選んだときの theme-color。React は hydration のときに <meta> を name と content で探し（media は見ない）、
 * 先に見つかったものを使うので、端末の設定に合わせた theme-color と同じ文字列だと、それと取り違える。
 * 大文字にして別の文字列にする（色は同じ）
 */
export const FIXED_THEME_COLORS = {
  light: THEME_COLORS.light.toUpperCase(),
  dark: THEME_COLORS.dark.toUpperCase(),
};

const oneOf = <T extends string>(list: readonly T[], x: unknown, fallback: T): T =>
  (list as readonly unknown[]).includes(x) ? (x as T) : fallback;

/** 保存した値を読む。決まった値でなければ既定（自動・標準）にする */
export const parseTheme = (x: unknown): Theme => oneOf(THEMES, x, "auto");
export const parseTextSize = (x: unknown): TextSize => oneOf(TEXT_SIZES, x, "normal");

/** 設定を変えたときに <html> の属性と theme-color を合わせる。開いたときは DISPLAY_SCRIPT が同じことをする */
export function applyDisplay({ theme, textSize }: Display, doc: Document = document) {
  const root = doc.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  if (textSize === "normal") root.removeAttribute("data-text-size");
  else root.setAttribute("data-text-size", textSize);
  doc.getElementById(THEME_COLOR_ID)?.remove();
  if (theme === "auto") return;
  const meta = doc.createElement("meta");
  meta.setAttribute("id", THEME_COLOR_ID);
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", FIXED_THEME_COLORS[theme]);
  doc.head.prepend(meta);
}

/**
 * <head> に置くスクリプト。最初の描画の前に、保存した表示の設定を applyDisplay と同じように付ける
 * （React が動くまで既定の色・大きさで出てから切り替わる、ということをなくす）。
 * localStorage が使えない・値が壊れている・決まった値でないときは何も付けない（自動・標準）。例外は外に出さない。
 * インラインの <script> は CSP の 'unsafe-inline' で許している（src/lib/security-headers.ts）
 */
export const DISPLAY_SCRIPT = `(function () {
  try {
    var s = JSON.parse(localStorage.getItem(${JSON.stringify(KEYS.settings)})) || {};
    var root = document.documentElement;
    if (${JSON.stringify(THEMES.filter((t) => t !== "auto"))}.indexOf(s.theme) >= 0) {
      root.setAttribute("data-theme", s.theme);
      var meta = document.createElement("meta");
      meta.setAttribute("id", ${JSON.stringify(THEME_COLOR_ID)});
      meta.setAttribute("name", "theme-color");
      meta.setAttribute("content", ${JSON.stringify(FIXED_THEME_COLORS)}[s.theme]);
      document.head.prepend(meta);
    }
    if (${JSON.stringify(TEXT_SIZES.filter((t) => t !== "normal"))}.indexOf(s.textSize) >= 0) {
      root.setAttribute("data-text-size", s.textSize);
    }
  } catch (e) {}
})();`;
