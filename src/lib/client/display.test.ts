import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  applyDisplay,
  DISPLAY_SCRIPT,
  FIXED_THEME_COLORS,
  TEXT_SIZES,
  THEME_COLOR_ID,
  THEME_COLORS,
  THEMES,
  type Display,
} from "./display";
import { KEYS } from "./storage";

type FakeElement = {
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
  remove: () => void;
};

/**
 * スクリプトと applyDisplay が使う分だけの document。<head> には、端末の設定に合わせた theme-color
 * （layout.tsx の viewport）が最初から入っている
 */
function fakeDocument() {
  const head: FakeElement[] = [];
  const element = (attrs: Record<string, string> = {}): FakeElement => {
    const map = new Map(Object.entries(attrs));
    const el: FakeElement = {
      setAttribute: (k, v) => void map.set(k, String(v)),
      getAttribute: (k) => map.get(k) ?? null,
      removeAttribute: (k) => void map.delete(k),
      remove: () => {
        const i = head.indexOf(el);
        if (i >= 0) head.splice(i, 1);
      },
    };
    return el;
  };
  for (const scheme of ["light", "dark"] as const)
    head.push(
      element({
        name: "theme-color",
        media: `(prefers-color-scheme: ${scheme})`,
        content: THEME_COLORS[scheme],
      }),
    );
  const root = element({ lang: "ja" });
  const doc = {
    documentElement: root,
    head: { prepend: (el: FakeElement) => void head.unshift(el) },
    createElement: () => element(),
    getElementById: (id: string) => head.find((el) => el.getAttribute("id") === id) ?? null,
  };
  /** 見た目に効くもの: <html> の属性と、ブラウザが使う theme-color（先頭の、media の無いもの） */
  const state = () => ({
    theme: root.getAttribute("data-theme"),
    textSize: root.getAttribute("data-text-size"),
    fixedColor: head[0].getAttribute("media") === null ? head[0].getAttribute("content") : null,
    metas: head.length,
  });
  return { doc, state };
}

/** <head> のスクリプトを、保存データ raw（null なら無し）で動かす */
function runScript(raw: string | null, storage?: unknown) {
  const { doc, state } = fakeDocument();
  const localStorage = storage ?? { getItem: (k: string) => (k === KEYS.settings ? raw : null) };
  runInNewContext(DISPLAY_SCRIPT, { document: doc, localStorage });
  return state();
}

const NOTHING = { theme: null, textSize: null, fixedColor: null, metas: 2 };

const expected = ({ theme, textSize }: Display) => ({
  theme: theme === "auto" ? null : theme,
  textSize: textSize === "normal" ? null : textSize,
  fixedColor: theme === "auto" ? null : FIXED_THEME_COLORS[theme],
  metas: theme === "auto" ? 2 : 3,
});

describe("表示の設定を <html> に付ける", () => {
  it("<head> のスクリプトは保存したテーマ・文字サイズを付け、applyDisplay と同じ結果になる", () => {
    for (const theme of THEMES) {
      for (const textSize of TEXT_SIZES) {
        const raw = JSON.stringify({ sound: true, theme, textSize });
        const fromScript = runScript(raw);
        expect(fromScript, raw).toEqual(expected({ theme, textSize }));
        const { doc, state } = fakeDocument();
        applyDisplay({ theme, textSize }, doc as unknown as Document);
        expect(state(), raw).toEqual(fromScript);
      }
    }
  });

  it("保存が無い・壊れている・決まった値でないときは、何も付けない", () => {
    for (const raw of [
      null,
      "",
      "{",
      "null",
      "5",
      '"dark"',
      "[]",
      JSON.stringify({ theme: "Dark", textSize: "huge" }),
      JSON.stringify({ theme: "constructor", textSize: "__proto__" }),
      JSON.stringify({ theme: ["dark"], textSize: { large: true } }),
      JSON.stringify({ theme: "auto", textSize: "normal" }),
    ]) {
      expect(runScript(raw), String(raw)).toEqual(NOTHING);
    }
  });

  it("localStorage が使えない（例外・無い）ときも例外を出さず、何も付けない", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(runScript(null, throwing)).toEqual(NOTHING);
    // 読むだけで例外になる環境
    const { doc, state } = fakeDocument();
    const context = { document: doc };
    Object.defineProperty(context, "localStorage", {
      get() {
        throw new Error("SecurityError");
      },
    });
    expect(() => runInNewContext(DISPLAY_SCRIPT, context)).not.toThrow();
    expect(state()).toEqual(NOTHING);
  });

  it("applyDisplay は、テーマを替えても theme-color を 1 つだけ使い、自動に戻すと属性ごと外す", () => {
    const { doc, state } = fakeDocument();
    const d = doc as unknown as Document;
    applyDisplay({ theme: "dark", textSize: "xlarge" }, d);
    applyDisplay({ theme: "light", textSize: "large" }, d);
    expect(state()).toEqual(expected({ theme: "light", textSize: "large" }));
    expect(doc.getElementById(THEME_COLOR_ID)?.getAttribute("content")).toBe(FIXED_THEME_COLORS.light);
    applyDisplay({ theme: "auto", textSize: "normal" }, d);
    expect(state()).toEqual(NOTHING);
    expect(doc.getElementById(THEME_COLOR_ID)).toBeNull();
  });

  it("選んだテーマの theme-color は、端末の設定に合わせたものと同じ色で、文字列は違う（hydration で取り違えない）", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(FIXED_THEME_COLORS[theme]).not.toBe(THEME_COLORS[theme]);
      expect(FIXED_THEME_COLORS[theme].toLowerCase()).toBe(THEME_COLORS[theme]);
    }
  });
});

describe("globals.css のテーマ", () => {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  /** selector の直後のブロック（入れ子の無いもの）の中身 */
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };
  const tokens = (body: string) => body.match(/--[\w-]+:[^;]+;/g) ?? [];

  it("ダークの値は、自動で端末がダークのときとダークを選んだときで同じ。ライトを選んだときは端末のダークを使わない", () => {
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {');
    const auto = tokens(block(':root:not([data-theme="light"])'));
    expect(auto.length).toBeGreaterThan(20);
    expect(tokens(block(':root[data-theme="dark"]'))).toEqual(auto);
    expect(css.match(/prefers-color-scheme: dark/g)).toHaveLength(1);
  });

  it("theme-color の色は背景（--bg）と同じ", () => {
    expect(tokens(block(":root"))).toContain(`--bg: ${THEME_COLORS.light};`);
    expect(tokens(block(':root[data-theme="dark"]'))).toContain(`--bg: ${THEME_COLORS.dark};`);
  });

  it("文字サイズの属性ごとに倍率がある", () => {
    for (const size of TEXT_SIZES.filter((s) => s !== "normal"))
      expect(tokens(block(`:root[data-text-size="${size}"]`))).toHaveLength(1);
  });
});
