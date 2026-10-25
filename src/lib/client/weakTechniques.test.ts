import { describe, expect, it, vi } from "vitest";
import type { Hint } from "@/lib/sudoku/hint";
import type { TechniqueId } from "@/lib/sudoku/logic";
import { installMemoryStorage } from "./memoryStorage";
import { KEYS } from "./storage";
import { loadStats } from "./stats";
import { loadWeakCounts, recordHintTechnique, topWeakTechniques } from "./weakTechniques";

const { store, memory } = installMemoryStorage();

const place = (technique: TechniqueId, cell: number): Hint => ({
  kind: "place",
  technique,
  title: "",
  text: "",
  focus: [cell],
  pattern: [],
  targets: [cell],
  cell,
  digit: 1,
});

const eliminate = (technique: TechniqueId, targets: number[]): Hint => ({
  kind: "eliminate",
  technique,
  title: "",
  text: "",
  focus: targets,
  pattern: [],
  targets,
  eliminations: targets.map((cell) => ({ cell, digit: 1 })),
});

const FREE = { mode: "free", id: "seed-a" } as const;

describe("ヒントを使った手筋の記録", () => {
  it("手筋のヒント（置く・消す）を手筋ごとに数え、この保存先だけに書く（記録 sudoku:stats には足さない）", () => {
    expect(recordHintTechnique(FREE, place("hidden-single", 10))).toBe(true);
    expect(recordHintTechnique(FREE, place("hidden-single", 11))).toBe(true);
    expect(recordHintTechnique(FREE, eliminate("x-wing", [3, 30]))).toBe(true);
    expect(loadWeakCounts()).toEqual({ "hidden-single": 2, "x-wing": 1 });
    expect([...store.keys()]).toEqual([KEYS.weak]);
    expect(loadStats()).toEqual({});
  });

  it("手筋の無いヒント（違う数字・手筋で進めない）と、ヒントの使えない今日の一問は数えない", () => {
    const wrong: Hint = { kind: "wrong", cell: 5, title: "", text: "", focus: [5], targets: [5] };
    const guess: Hint = { kind: "guess", cell: 5, digit: 3, title: "", text: "", focus: [5], targets: [5] };
    expect(recordHintTechnique(FREE, wrong)).toBe(false);
    expect(recordHintTechnique(FREE, guess)).toBe(false);
    expect(recordHintTechnique({ mode: "daily", id: "2026-10-25" }, place("naked-single", 1))).toBe(false);
    expect(loadWeakCounts()).toEqual({});
    expect(store.has(KEYS.weak)).toBe(false);
  });

  it("同じプレイで同じ手筋・同じマスのヒントは 1 回だけ数える（開き直し・同じヒントの再表示）", () => {
    recordHintTechnique(FREE, place("naked-single", 4));
    expect(recordHintTechnique(FREE, place("naked-single", 4))).toBe(false);
    // 消すマスの並びが違っても同じヒント
    recordHintTechnique(FREE, eliminate("pointing", [7, 2]));
    expect(recordHintTechnique(FREE, eliminate("pointing", [2, 7]))).toBe(false);
    // 同じマスでも手筋が違えば、同じ手筋でもマスが違えば数える
    expect(recordHintTechnique(FREE, place("hidden-single", 4))).toBe(true);
    expect(recordHintTechnique(FREE, eliminate("pointing", [2, 8]))).toBe(true);
    expect(loadWeakCounts()).toEqual({ "naked-single": 1, pointing: 2, "hidden-single": 1 });
  });

  it("別のプレイ（新しい問題・別の局面）なら同じヒントも数え直す。ほかのモードを挟んでもフリープレイの分は覚えている", () => {
    recordHintTechnique(FREE, place("naked-single", 4));
    // 練習を挟んでも、同じ問題の同じヒントは数えない
    expect(recordHintTechnique({ mode: "practice", id: "p1" }, place("naked-single", 4))).toBe(true);
    expect(recordHintTechnique(FREE, place("naked-single", 4))).toBe(false);
    // 新しい問題・別の局面では数える
    expect(recordHintTechnique({ mode: "free", id: "seed-b" }, place("naked-single", 4))).toBe(true);
    expect(recordHintTechnique({ mode: "practice", id: "p2" }, place("naked-single", 4))).toBe(true);
    // 覚えているのはモードごとに直近の 1 プレイだけ
    expect(recordHintTechnique(FREE, place("naked-single", 4))).toBe(true);
    expect(loadWeakCounts()).toEqual({ "naked-single": 5 });
  });

  it("開き直し（保存データからの読み直し）でも二重に数えない", () => {
    recordHintTechnique(FREE, place("naked-single", 4));
    const saved = store.get(KEYS.weak)!;
    store.clear();
    store.set(KEYS.weak, saved);
    expect(recordHintTechnique(FREE, place("naked-single", 4))).toBe(false);
  });

  it("壊れた・形の違う・古い保存データは空として読み、記録し直すと捨てた分は消える", () => {
    for (const raw of ["{", "null", "[]", '"x"', "42", JSON.stringify({ "naked-single": 3 })]) {
      store.set(KEYS.weak, raw);
      expect(loadWeakCounts(), raw).toEqual({});
      expect(topWeakTechniques(loadWeakCounts()), raw).toEqual([]);
    }
    // 知らない手筋・0 以下・整数でない・文字列・大きすぎる回数は捨てる
    store.set(
      KEYS.weak,
      JSON.stringify({
        counts: {
          "naked-single": 2,
          "hidden-single": 0,
          pointing: -1,
          claiming: 1.5,
          "x-wing": "3",
          swordfish: Number.MAX_SAFE_INTEGER + 2,
          chain: 4,
        },
        seen: { free: { id: FREE.id, keys: "x" }, practice: { id: 1, keys: [] } },
      }),
    );
    expect(loadWeakCounts()).toEqual({ "naked-single": 2 });
    // 覚えていたプレイの形が違えば、同じヒントでも数える
    expect(recordHintTechnique(FREE, place("naked-single", 4))).toBe(true);
    expect(JSON.parse(store.get(KEYS.weak)!)).toEqual({
      counts: { "naked-single": 3 },
      seen: { free: { id: FREE.id, keys: ["naked-single:4"] } },
    });
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
      expect(loadWeakCounts()).toEqual({});
      expect(() => recordHintTechnique(FREE, place("naked-single", 4))).not.toThrow();
    } finally {
      vi.stubGlobal("localStorage", memory);
    }
  });
});

describe("ヒントを使った手筋の上位", () => {
  it("回数の多い順に 3 件。同じ回数なら練習の項目の順。ポインティングとクレーミングはまとめる", () => {
    const rows = topWeakTechniques({
      "naked-single": 1,
      "hidden-single": 2,
      claiming: 2,
      pointing: 1,
      "x-wing": 2,
      swordfish: 5,
    });
    expect(rows).toEqual([
      { key: "swordfish", name: "ソードフィッシュ", count: 5 },
      { key: "pointing", name: "ロックドキャンディデート", count: 3 },
      { key: "hidden-single", name: "ヒドゥンシングル", count: 2 },
    ]);
  });

  it("3 件に満たなければある分だけ、0 件なら空", () => {
    expect(topWeakTechniques({ "xy-wing": 1 })).toEqual([{ key: "xy-wing", name: "XY-Wing", count: 1 }]);
    expect(topWeakTechniques({})).toEqual([]);
  });

  it("記録した回数から上位を出す", () => {
    recordHintTechnique(FREE, eliminate("naked-pair", [1, 2]));
    recordHintTechnique(FREE, eliminate("naked-pair", [3]));
    recordHintTechnique({ mode: "practice", id: "p1" }, eliminate("x-wing", [9]));
    expect(topWeakTechniques(loadWeakCounts())).toEqual([
      { key: "naked-pair", name: "ネイキッドペア", count: 2 },
      { key: "x-wing", name: "X-Wing", count: 1 },
    ]);
  });
});
