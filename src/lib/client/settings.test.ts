import { describe, expect, it, vi } from "vitest";
import { installMemoryStorage } from "./memoryStorage";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";
import { KEYS } from "./storage";

const { store, memory } = installMemoryStorage();

describe("設定", () => {
  it("保存が無ければ既定（テーマは自動・文字サイズは標準）", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.theme).toBe("auto");
    expect(DEFAULT_SETTINGS.textSize).toBe("normal");
  });

  it("保存したテーマと文字サイズを読み戻す。設定の保存先だけに書く", () => {
    for (const [theme, textSize] of [
      ["light", "large"],
      ["dark", "xlarge"],
      ["auto", "normal"],
    ] as const) {
      saveSettings({ ...DEFAULT_SETTINGS, sound: false, theme, textSize });
      expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, sound: false, theme, textSize });
    }
    expect([...store.keys()]).toEqual([KEYS.settings]);
  });

  it("前の版の保存データ（テーマ・文字サイズが無い）は、ほかの項目を残して既定のテーマと文字サイズにする", () => {
    store.set(KEYS.settings, JSON.stringify({ sound: false, confirmHint: true }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, sound: false, confirmHint: true });
  });

  it("テーマ・文字サイズが決まった値でなければ、ほかの項目を残して既定にする", () => {
    for (const [theme, textSize] of [
      ["Dark", "XLARGE"],
      ["", ""],
      [null, null],
      [1, 2],
      [true, false],
      [["dark"], ["large"]],
      [{}, {}],
      ["constructor", "__proto__"],
      ["dark ", "large;"],
    ]) {
      store.set(KEYS.settings, JSON.stringify({ haptics: false, theme, textSize }));
      expect(loadSettings(), JSON.stringify([theme, textSize])).toEqual({
        ...DEFAULT_SETTINGS,
        haptics: false,
      });
    }
  });

  it("片方だけ正しい値なら、その値は使う", () => {
    store.set(KEYS.settings, JSON.stringify({ theme: "dark", textSize: "huge" }));
    expect(loadSettings()).toMatchObject({ theme: "dark", textSize: "normal" });
    store.set(KEYS.settings, JSON.stringify({ theme: "sepia", textSize: "xlarge" }));
    expect(loadSettings()).toMatchObject({ theme: "auto", textSize: "xlarge" });
  });

  it("壊れた保存データでは既定にする", () => {
    for (const raw of ["{", "null", "1", '"dark"']) {
      store.set(KEYS.settings, raw);
      expect(loadSettings(), raw).toMatchObject({ theme: "auto", textSize: "normal" });
    }
  });

  it("localStorage が使えなくても、既定を返し、保存で落ちない", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    try {
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
      expect(() => saveSettings({ ...DEFAULT_SETTINGS, theme: "dark", textSize: "xlarge" })).not.toThrow();
    } finally {
      vi.stubGlobal("localStorage", memory);
    }
  });
});
