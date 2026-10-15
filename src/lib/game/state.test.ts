import { describe, expect, it } from "vitest";
import { findConflicts, parseGrid } from "@/lib/sudoku/core";
import { generatePuzzle } from "@/lib/sudoku/generator";
import { countSolutions } from "@/lib/sudoku/solver";
import { elapsedOf, formatTime, newGame, reduce, stuckCells, type Action, type GameState } from "./state";

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

describe("行き詰まり", () => {
  // 2026-10-16 のエキスパート（旧生成コード）と、重複は無いが解けなくなった実際の盤面
  const PUZZLE = parseGrid(
    "000009000030020010709000506600003070003702600050400008901000307080040020000100000",
  );
  const STUCK = parseGrid(
    "164579283835624719729831546618953472403782695257406138941268357586347921372195864",
  );

  function play(values: number[]) {
    let s = newGame({
      mode: "daily",
      difficulty: "expert",
      seed: "2026-10-16",
      puzzle: PUZZLE,
      solution: null,
      daily: { sessionId: "s", date: "2026-10-16", startedAt: 0, clockOffset: 0 },
    });
    for (let i = 0; i < 81; i++) {
      if (PUZZLE[i] || !values[i]) continue;
      [s] = reduce(s, { type: "select", cell: i });
      [s] = reduce(s, { type: "input", digit: values[i] });
    }
    return s;
  }

  it("入る数字が無いマスを見つける", () => {
    const s = play(STUCK);
    expect(findConflicts(s.values).size).toBe(0);
    expect(stuckCells(s).sort((a, b) => a - b)).toEqual([37, 49]);
  });

  it("間違える前まで戻すと、解ける盤面に戻る", () => {
    const s = play(STUCK);
    const [back, effects] = reduce(s, { type: "rewind" });
    expect(effects[0]).toMatchObject({ kind: "rewind" });
    expect(back.history.length).toBeLessThan(s.history.length);
    expect(countSolutions(back.values, 1)).toBe(1);
    expect(stuckCells(back)).toEqual([]);
    // 解ける盤面では何もしない
    expect(reduce(back, { type: "rewind" })[1][0].kind).toBe("blocked");
  });

  it("行き詰まっていなければ何も返さない", () => {
    expect(stuckCells(play(Array(81).fill(0)))).toEqual([]);
  });
});
