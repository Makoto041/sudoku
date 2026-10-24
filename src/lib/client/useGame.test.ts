import { describe, expect, it } from "vitest";
import { newGame, reduce, type Mode } from "@/lib/game/state";
import { generatePuzzle } from "@/lib/sudoku/generator";
import { installMemoryStorage } from "./memoryStorage";
import { KEYS } from "./storage";
import { followCell, saveGame, storageKeyFor } from "./useGame";

const { store } = installMemoryStorage();

function game(mode: Mode) {
  const p = generatePuzzle("save-test", "easy");
  const g = newGame({
    mode,
    difficulty: "easy",
    seed: "x",
    puzzle: p.puzzle,
    solution: p.solution,
    daily: mode === "daily" ? { sessionId: "s", date: "2026-10-17", startedAt: 0, clockOffset: 0 } : null,
  });
  // 1 マス選んで置いた状態にする（選択は保存しない）
  const cell = p.puzzle.indexOf(0);
  return reduce(reduce(g, { type: "select", cell })[0], { type: "input", digit: p.solution[cell] })[0];
}

describe("保存", () => {
  it("フリープレイと日次はそれぞれのキーに選択を落として保存する", () => {
    const free = game("free");
    const daily = game("daily");
    expect(storageKeyFor(free)).toBe(KEYS.free);
    expect(storageKeyFor(daily)).toBe(KEYS.daily("2026-10-17", "easy"));
    saveGame(free);
    saveGame(daily);
    expect([...store.keys()].sort()).toEqual([KEYS.daily("2026-10-17", "easy"), KEYS.free].sort());
    const saved = JSON.parse(store.get(KEYS.free)!);
    expect(saved).toMatchObject({ mode: "free", selected: null, values: free.values });
    expect(free.selected).not.toBe(null);
  });

  it("練習は保存しない", () => {
    const practice = game("practice");
    expect(storageKeyFor(practice)).toBe(null);
    saveGame(practice);
    expect(store.size).toBe(0);
  });
});

describe("フォーカスを付いて行かせるマス", () => {
  it("矢印キーで選んだときだけ選んだマス。戻す・ヒント・選ぶでは動かさない", () => {
    const g = game("free");
    const cell = g.selected!;
    const moved = reduce(g, { type: "move", dr: 0, dc: 1 })[0];
    expect(followCell({ type: "move", dr: 0, dc: 1 }, moved)).toBe(moved.selected);
    expect(moved.selected).not.toBe(cell);
    const undone = reduce(moved, { type: "undo" })[0];
    // 戻すと選択は戻したマスに動くが、フォーカスは動かさない
    expect(undone.selected).toBe(cell);
    expect(followCell({ type: "undo" }, undone)).toBe(null);
    expect(followCell({ type: "redo" }, reduce(undone, { type: "redo" })[0])).toBe(null);
    expect(followCell({ type: "hint" }, reduce(undone, { type: "hint" })[0])).toBe(null);
    expect(followCell({ type: "select", cell: 3 }, reduce(g, { type: "select", cell: 3 })[0])).toBe(null);
  });
});
