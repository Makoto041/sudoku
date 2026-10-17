import { describe, expect, it } from "vitest";
import { newGame, reduce, type Mode } from "@/lib/game/state";
import { generatePuzzle } from "@/lib/sudoku/generator";
import { installMemoryStorage } from "./memoryStorage";
import { KEYS } from "./storage";
import { saveGame, storageKeyFor } from "./useGame";

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
