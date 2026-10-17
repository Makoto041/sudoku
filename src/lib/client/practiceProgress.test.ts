import { describe, expect, it, vi } from "vitest";
import { practiceItems } from "@/lib/sudoku/practice";
import { PRACTICE_POSITIONS } from "@/lib/sudoku/practice-data";
import { installMemoryStorage } from "./memoryStorage";
import { firstUnsolved, loadPracticeProgress, markPracticeSolved } from "./practiceProgress";
import { KEYS } from "./storage";

const { store, memory } = installMemoryStorage();

const items = practiceItems(PRACTICE_POSITIONS);
const [a, b] = items;
const idsOf = (item: (typeof items)[number]) => item.positions.map((p) => p.id);

describe("練習の進み具合", () => {
  it("解いた局面を項目ごとに記録し、同じ局面は 1 回だけ数える。練習の保存先だけに書く", () => {
    expect(loadPracticeProgress(items)).toEqual({});
    markPracticeSolved(items, a.key, idsOf(a)[1]);
    markPracticeSolved(items, a.key, idsOf(a)[1]);
    markPracticeSolved(items, b.key, idsOf(b)[0]);
    expect(loadPracticeProgress(items)).toEqual({ [a.key]: [idsOf(a)[1]], [b.key]: [idsOf(b)[0]] });
    expect([...store.keys()]).toEqual([KEYS.practice]);
  });

  it("知らない項目・id、別の項目の id、文字列でない値、重複は捨てる", () => {
    store.set(
      KEYS.practice,
      JSON.stringify({
        [a.key]: [idsOf(a)[0], idsOf(a)[0], "unknown", 3, null, idsOf(b)[0]],
        [b.key]: "not-an-array",
        claiming: [idsOf(a)[1]],
      }),
    );
    expect(loadPracticeProgress(items)).toEqual({ [a.key]: [idsOf(a)[0]] });
    // 記録し直すと、捨てたものは保存データからも消える
    markPracticeSolved(items, a.key, idsOf(a)[2]);
    expect(JSON.parse(store.get(KEYS.practice)!)).toEqual({ [a.key]: [idsOf(a)[0], idsOf(a)[2]] });
  });

  it("壊れた保存データや、オブジェクトでない値は空として読む", () => {
    for (const raw of ["{", "null", "[]", '"x"', "42", JSON.stringify([[a.key, idsOf(a)]])]) {
      store.set(KEYS.practice, raw);
      expect(loadPracticeProgress(items), raw).toEqual({});
    }
  });

  it("長すぎる配列は先頭の上限までしか見ない", () => {
    store.set(KEYS.practice, JSON.stringify({ [a.key]: [...Array(100).fill("x"), idsOf(a)[0]] }));
    expect(loadPracticeProgress(items)).toEqual({});
  });

  it("localStorage が使えなくても、空として読めて記録で落ちない", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    try {
      expect(loadPracticeProgress(items)).toEqual({});
      expect(() => markPracticeSolved(items, a.key, idsOf(a)[0])).not.toThrow();
    } finally {
      vi.stubGlobal("localStorage", memory);
    }
  });

  it("知らない id は記録しない", () => {
    markPracticeSolved(items, a.key, "unknown");
    markPracticeSolved(items, a.key, idsOf(b)[0]);
    expect(store.has(KEYS.practice)).toBe(false);
  });

  it("項目を開くと、まだ解いていない最初の局面から。すべて解いていれば最初から", () => {
    expect(firstUnsolved(a, {})).toBe(0);
    expect(firstUnsolved(a, { [a.key]: [idsOf(a)[0], idsOf(a)[2]] })).toBe(1);
    expect(firstUnsolved(a, { [a.key]: idsOf(a) })).toBe(0);
  });
});
