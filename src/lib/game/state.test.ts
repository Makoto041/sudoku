import { describe, expect, it } from "vitest";
import { generatePuzzle } from "@/lib/sudoku/generator";
import { elapsedOf, formatTime, newGame, reduce, type Action, type GameState } from "./state";

function freeGame() {
  const p = generatePuzzle("state-test", "easy");
  return {
    p,
    s: newGame({ mode: "free", difficulty: "easy", seed: "x", puzzle: p.puzzle, solution: p.solution }),
  };
}

function run(s: GameState, ...actions: Action[]) {
  let effects: ReturnType<typeof reduce>[1] = [];
  for (const a of actions) [s, effects] = reduce(s, a);
  return { s, effects };
}

describe("game reducer", () => {
  it("正しい数字を置くと周りのメモが消え、元に戻すと復元する", () => {
    const { p, s: s0 } = freeGame();
    const cell = p.puzzle.indexOf(0);
    const digit = p.solution[cell];
    const peer = p.puzzle.findIndex(
      (v, i) => v === 0 && i !== cell && Math.floor(i / 9) === Math.floor(cell / 9),
    );
    let { s } = run(s0, { type: "select", cell: peer }, { type: "input", digit, asNote: true });
    expect(s.notes[peer]).toBe(1 << digit);
    const placed = run(s, { type: "select", cell }, { type: "input", digit });
    expect(placed.s.values[cell]).toBe(digit);
    expect(placed.s.notes[peer]).toBe(0);
    expect(placed.effects[0]).toMatchObject({ kind: "place", wrong: false });
    s = run(placed.s, { type: "undo" }).s;
    expect(s.values[cell]).toBe(0);
    expect(s.notes[peer]).toBe(1 << digit);
  });

  it("間違いはミスとして数え、ヒントは正解を置く", () => {
    const { p, s: s0 } = freeGame();
    const cell = p.puzzle.indexOf(0);
    const wrongDigit = (p.solution[cell] % 9) + 1;
    const { s, effects } = run(s0, { type: "select", cell }, { type: "input", digit: wrongDigit });
    expect(effects[0]).toMatchObject({ kind: "place", wrong: true });
    expect(s.mistakes).toBe(1);
    const hinted = run(s, { type: "hint" }).s;
    expect(hinted.values[cell]).toBe(p.solution[cell]);
    expect(hinted.hints).toBe(1);
  });

  it("ヒントのマスは変更できない", () => {
    const { p, s: s0 } = freeGame();
    const given = p.puzzle.findIndex((v) => v !== 0);
    const { s, effects } = run(s0, { type: "select", cell: given }, { type: "input", digit: 1 });
    expect(s.values[given]).toBe(p.puzzle[given]);
    expect(effects[0].kind).toBe("blocked");
  });

  it("すべて埋めると solved になり、以降の入力は無視する", () => {
    const { p, s: s0 } = freeGame();
    let s = s0;
    let last: ReturnType<typeof reduce>[1] = [];
    for (let i = 0; i < 81; i++) {
      if (p.puzzle[i]) continue;
      [s, last] = reduce(s, { type: "select", cell: i });
      [s, last] = reduce(s, { type: "input", digit: p.solution[i] });
    }
    expect(s.status).toBe("solved");
    expect(last.some((e) => e.kind === "solved")).toBe(true);
    expect(run(s, { type: "undo" }).s).toBe(s);
  });

  it("日次は解答なしで重複を間違いとみなし、ヒントは使えない", () => {
    const p = generatePuzzle("daily-test", "easy");
    const s0 = newGame({
      mode: "daily",
      difficulty: "easy",
      seed: "2026-10-15",
      puzzle: p.puzzle,
      solution: null,
      daily: { sessionId: "s", date: "2026-10-15", startedAt: 1000, clockOffset: 0 },
    });
    const cell = p.puzzle.indexOf(0);
    const rowDigit = p.puzzle.find((v, i) => v && Math.floor(i / 9) === Math.floor(cell / 9))!;
    const { s, effects } = run(s0, { type: "select", cell }, { type: "input", digit: rowDigit });
    expect(effects[0]).toMatchObject({ kind: "place", wrong: true });
    expect(run(s, { type: "hint" }).effects[0].kind).toBe("blocked");
    expect(elapsedOf(s, 61_000)).toBe(60_000);
    expect(run(s, { type: "pause" }).s.status).toBe("playing");
  });

  it("時間の表示", () => {
    expect(formatTime(65_000)).toBe("01:05");
    expect(formatTime(3_725_000)).toBe("1:02:05");
  });
});
