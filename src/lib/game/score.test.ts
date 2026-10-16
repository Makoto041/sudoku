import { describe, expect, it } from "vitest";
import { UNITS } from "@/lib/sudoku/core";
import { generatePuzzle } from "@/lib/sudoku/generator";
import {
  BASE_POINTS,
  applyPlacement,
  comboMultiplier,
  emptyScore,
  scoreMoves,
  timeBonus,
  PAR_MS,
  type MoveLog,
} from "./score";

const p = generatePuzzle("score-test", "medium");
const base = BASE_POINTS.medium;
const empties = p.puzzle.flatMap((v, i) => (v ? [] : [i]));

describe("倍率と時間ボーナス", () => {
  it("コンボは 1 手ごとに +5%、最大 +50%", () => {
    expect(comboMultiplier(1)).toBe(1);
    expect(comboMultiplier(3)).toBeCloseTo(1.1);
    expect(comboMultiplier(11)).toBeCloseTo(1.5);
    expect(comboMultiplier(40)).toBeCloseTo(1.5);
  });

  it("時間ボーナスは 0 秒で基本点 × 空きマス × 2、基準時間で 0", () => {
    const n = empties.length;
    expect(timeBonus("medium", p.puzzle, 0)).toBe(base * n * 2);
    expect(timeBonus("medium", p.puzzle, PAR_MS.medium / 2)).toBe(Math.round((base * n) / 5) * 5);
    expect(timeBonus("medium", p.puzzle, PAR_MS.medium)).toBe(0);
    expect(timeBonus("medium", p.puzzle, PAR_MS.medium * 3)).toBe(0);
  });
});

describe("溜め打ち", () => {
  it("合計時間が同じなら、メモで解いておいて最後にまとめて置いても点数は変わらない", () => {
    const total = 600_000;
    const steady: MoveLog = empties.map((c, k) => [
      Math.round(((k + 1) * total) / empties.length),
      c,
      p.solution[c],
    ]);
    const burst: MoveLog = empties.map((c, k) => [total - (empties.length - 1 - k) * 300, c, p.solution[c]]);
    expect(scoreMoves(p.puzzle, p.solution, "medium", burst, total).points).toBe(
      scoreMoves(p.puzzle, p.solution, "medium", steady, total).points,
    );
  });
});

describe("1 手ごとの得点", () => {
  it("正解は基本点 × コンボ、続けるとコンボが伸びる", () => {
    let st = emptyScore(p.puzzle);
    const [a, b] = empties;
    let d;
    [st, d] = applyPlacement(st, { cell: a, digit: p.solution[a], t: 200 }, p.solution, "medium");
    expect(d).toMatchObject({ kind: "correct", points: base });
    [st, d] = applyPlacement(st, { cell: b, digit: p.solution[b], t: 10_200 }, p.solution, "medium");
    // コンボ 1.05 → 78.75 → 5 点単位で 80
    expect(d).toMatchObject({ kind: "correct", points: 80 });
    expect(st.points).toBe(base + 80);
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
    // 実際の経過時間を大きく超えた時刻の手は数えない（間隔を 0 に縮めてボーナスを稼げない）
    const late: MoveLog = moves.map(([t, c, d]) => [t + 1e9, c, d]);
    expect(scoreMoves(p.puzzle, p.solution, "medium", late, 5000).points).toBe(0);
  });

  it("ヒントのマス（最初からある数字）への記録は無視する", () => {
    const given = p.puzzle.findIndex((v) => v !== 0);
    const st = scoreMoves(p.puzzle, p.solution, "medium", [[0, given, 1]], 1000);
    expect(st.points).toBe(0);
  });
});
