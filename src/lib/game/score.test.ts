import { describe, expect, it } from "vitest";
import { UNITS } from "@/lib/sudoku/core";
import { generatePuzzle } from "@/lib/sudoku/generator";
import {
  BASE_POINTS,
  applyPlacement,
  comboMultiplier,
  emptyScore,
  scoreMoves,
  speedMultiplier,
  type MoveLog,
} from "./score";

const p = generatePuzzle("score-test", "medium");
const base = BASE_POINTS.medium;
const empties = p.puzzle.flatMap((v, i) => (v ? [] : [i]));

describe("倍率", () => {
  it("速さは 0 秒で 2 倍、20 秒以上で 1 倍", () => {
    expect(speedMultiplier(0)).toBe(2);
    expect(speedMultiplier(10_000)).toBe(1.5);
    expect(speedMultiplier(20_000)).toBe(1);
    expect(speedMultiplier(60_000)).toBe(1);
    expect(speedMultiplier(-5)).toBe(2);
  });

  it("コンボは 1 手ごとに +5%、最大 +50%", () => {
    expect(comboMultiplier(1)).toBe(1);
    expect(comboMultiplier(3)).toBeCloseTo(1.1);
    expect(comboMultiplier(11)).toBeCloseTo(1.5);
    expect(comboMultiplier(40)).toBeCloseTo(1.5);
  });
});

describe("1 手ごとの得点", () => {
  it("正解は基本点 × 速さ × コンボ、続けるとコンボが伸びる", () => {
    let st = emptyScore(p.puzzle);
    const [a, b] = empties;
    let d;
    [st, d] = applyPlacement(st, { cell: a, digit: p.solution[a], t: 0 }, p.solution, "medium");
    expect(d).toMatchObject({ kind: "correct", points: base * 2 });
    [st, d] = applyPlacement(st, { cell: b, digit: p.solution[b], t: 10_000 }, p.solution, "medium");
    // 1.5 倍 × コンボ 1.05 = 118.125 → 5 点単位で 120
    expect(d).toMatchObject({ kind: "correct", points: 120 });
    expect(st.points).toBe(base * 2 + 120);
    expect(st.streak).toBe(2);
  });

  it("間違えると減点してコンボが切れ、0 より下がらない", () => {
    const [a, b] = empties;
    const wrongAt = (c: number) => (p.solution[c] % 9) + 1;
    let st = emptyScore(p.puzzle);
    let d;
    [st, d] = applyPlacement(st, { cell: a, digit: wrongAt(a), t: 1000 }, p.solution, "medium");
    expect(d).toMatchObject({ kind: "wrong", points: 0 });
    expect(st.points).toBe(0);
    [st] = applyPlacement(st, { cell: a, digit: p.solution[a], t: 2000 }, p.solution, "medium");
    const before = st.points;
    [st, d] = applyPlacement(st, { cell: b, digit: wrongAt(b), t: 3000 }, p.solution, "medium");
    expect(d).toMatchObject({ kind: "wrong", points: -base });
    expect(st.points).toBe(before - base);
    expect(st.streak).toBe(0);
  });

  it("同じマスで得点するのは 1 回だけ", () => {
    let st = emptyScore(p.puzzle);
    const [a] = empties;
    [st] = applyPlacement(st, { cell: a, digit: p.solution[a], t: 0 }, p.solution, "medium");
    const [st2, d] = applyPlacement(st, { cell: a, digit: p.solution[a], t: 100 }, p.solution, "medium");
    expect(d.kind).toBe("repeat");
    expect(st2.points).toBe(st.points);
  });

  it("ユニットのすべてのマスで得点するとボーナス", () => {
    const unit = UNITS.findIndex((u) => u.some((i) => !p.puzzle[i]));
    const cells = UNITS[unit].filter((i) => !p.puzzle[i]);
    let st = emptyScore(p.puzzle);
    let last;
    for (const c of cells)
      [st, last] = applyPlacement(st, { cell: c, digit: p.solution[c], t: 0 }, p.solution, "medium");
    expect(last).toMatchObject({ kind: "correct" });
    expect(last!.bonus).toBeGreaterThanOrEqual(base * 3);
    expect(last!.units).toContain(unit);
  });

  it("ヒントのマスは 0 点でコンボが切れる", () => {
    let st = emptyScore(p.puzzle);
    const [a, b] = empties;
    [st] = applyPlacement(st, { cell: a, digit: p.solution[a], t: 0 }, p.solution, "medium");
    const [st2, d] = applyPlacement(
      st,
      { cell: b, digit: p.solution[b], t: 100, viaHint: true },
      p.solution,
      "medium",
    );
    expect(d).toMatchObject({ kind: "hint", points: 0 });
    expect(st2.streak).toBe(0);
    expect(st2.scored[b]).toBe("1");
  });
});

describe("記録からの計算（サーバー用）", () => {
  it("1 手ずつ計算した結果と一致し、時刻は並べ直して範囲に収める", () => {
    const moves: MoveLog = empties.map((c, k) => [k * 3000, c, p.solution[c]]);
    let st = emptyScore(p.puzzle);
    for (const [t, cell, digit] of moves) [st] = applyPlacement(st, { cell, digit, t }, p.solution, "medium");
    expect(scoreMoves(p.puzzle, p.solution, "medium", moves, 10_000_000)).toEqual(st);
    // 順番を入れ替えても同じ、範囲外の時刻は丸める
    const shuffled = [...moves].reverse();
    expect(scoreMoves(p.puzzle, p.solution, "medium", shuffled, 10_000_000).points).toBe(st.points);
    const late: MoveLog = moves.map(([t, c, d]) => [t + 1e9, c, d]);
    expect(scoreMoves(p.puzzle, p.solution, "medium", late, 5000).points).toBeGreaterThan(0);
  });

  it("ヒントのマス（最初からある数字）への記録は無視する", () => {
    const given = p.puzzle.findIndex((v) => v !== 0);
    const st = scoreMoves(p.puzzle, p.solution, "medium", [[0, given, 1]], 1000);
    expect(st.points).toBe(0);
  });
});
