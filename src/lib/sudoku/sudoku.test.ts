import { describe, expect, it } from "vitest";
import { DIFFICULTIES, findConflicts, isValidSolution, parseGrid, serializeGrid } from "./core";
import { PROFILES, generateDaily, generateExtreme, generatePuzzle, jstDateKey } from "./generator";
import { candidatesOf, findAllSteps, findNextStep, gradePuzzle, searchEffort, solveLogically } from "./logic";
import { countSolutions, solve } from "./solver";

// 極は作るのに時間がかかるので、まとめて回すテストからは外し、下で個別に確かめる
const BANDED = DIFFICULTIES.filter((d) => d !== "extreme");

// よく知られた問題（シングルだけで解ける）
const CLASSIC = parseGrid(
  "530070000600195000098000060800060003400803001700020006060000280000419005000080079",
);

describe("solver", () => {
  it("一意解の問題を解く", () => {
    const solution = solve(CLASSIC)!;
    expect(isValidSolution(CLASSIC, solution)).toBe(true);
    expect(countSolutions(CLASSIC)).toBe(1);
  });

  it("空の盤面は複数解", () => {
    expect(countSolutions(Array(81).fill(0))).toBe(2);
  });

  it("矛盾した盤面は解なし", () => {
    const broken = CLASSIC.slice();
    broken[2] = 5; // 同じ行に 5 が 2 つ
    expect(countSolutions(broken)).toBe(0);
  });
});

describe("validation", () => {
  const solution = solve(CLASSIC)!;

  it("ヒントと食い違う解答は不正", () => {
    const tampered = solution.slice();
    const i = CLASSIC.findIndex((v) => v !== 0);
    tampered[i] = (tampered[i] % 9) + 1;
    expect(isValidSolution(CLASSIC, tampered)).toBe(false);
  });

  it("空きマスや範囲外の値は不正", () => {
    const blank = solution.slice();
    blank[2] = 0;
    expect(isValidSolution(CLASSIC, blank)).toBe(false);
    const outOfRange = solution.slice();
    outOfRange[2] = 10;
    expect(isValidSolution(CLASSIC, outOfRange)).toBe(false);
  });

  it("重複を見つける", () => {
    const grid = CLASSIC.slice();
    grid[2] = 5;
    const conflicts = findConflicts(grid);
    expect(conflicts.has(0)).toBe(true);
    expect(conflicts.has(2)).toBe(true);
    expect(findConflicts(CLASSIC).size).toBe(0);
  });

  it("文字列との相互変換", () => {
    expect(serializeGrid(CLASSIC)).toHaveLength(81);
    expect(parseGrid(serializeGrid(CLASSIC))).toEqual(CLASSIC);
    expect(() => parseGrid("123")).toThrow();
  });
});

describe("logic grader", () => {
  it("シングルで解ける問題はレベル 1", () => {
    expect(gradePuzzle(CLASSIC)).toBe(1);
  });

  it.each(BANDED)("%s: 手筋は正解を消さず、置いた数字はすべて正しい", (difficulty) => {
    for (let k = 0; k < 6; k++) {
      const p = generatePuzzle(`logic-${k}`, difficulty);
      const s = solveLogically(p.puzzle);
      for (let i = 0; i < 81; i++) {
        if (s.grid[i]) expect(s.grid[i]).toBe(p.solution[i]);
        else expect(s.cands[i] & (1 << p.solution[i])).not.toBe(0);
      }
      if (s.level < 6) expect(s.grid).toEqual(p.solution);
    }
  });

  it("findAllSteps の先頭は findNextStep の手で、どの手も解と食い違わない（手筋で解き進めた各局面）", () => {
    for (const difficulty of ["hard", "expert"] as const) {
      for (let k = 0; k < 3; k++) {
        const { puzzle, solution } = generatePuzzle(`all-steps-${k}`, difficulty);
        const grid = puzzle.slice();
        const cands = candidatesOf(grid);
        for (;;) {
          const next = findNextStep(grid, cands);
          const all = findAllSteps(grid, cands);
          expect(all[0] ?? null).toEqual(next);
          for (const step of all) {
            if (step.placement) expect(step.placement.digit).toBe(solution[step.placement.cell]);
            for (const e of step.eliminations) expect(e.digit).not.toBe(solution[e.cell]);
          }
          if (!next) break;
          if (next.placement) {
            const { cell, digit } = next.placement;
            grid[cell] = digit;
            cands[cell] = 0;
          }
          for (const e of next.eliminations) cands[e.cell] &= ~(1 << e.digit);
        }
        if (gradePuzzle(puzzle) < 6) expect(grid).toEqual(solution);
      }
    }
  });
});

describe("generator", () => {
  it.each(BANDED)("%s: 解が 1 つでヒント数が範囲内", (difficulty) => {
    for (const seed of ["a", "b", "c"]) {
      const p = generatePuzzle(seed, difficulty);
      expect(countSolutions(p.puzzle)).toBe(1);
      expect(isValidSolution(p.puzzle, p.solution)).toBe(true);
      expect(p.puzzle.filter((v) => v !== 0)).toHaveLength(p.givens);
      expect(p.givens).toBeLessThanOrEqual(PROFILES[difficulty].maxGivens + 1);
    }
  });

  it("同じシードなら同じ問題、違うシードなら違う問題", () => {
    const a = generatePuzzle("same", "hard");
    const b = generatePuzzle("same", "hard");
    const c = generatePuzzle("other", "hard");
    expect(serializeGrid(a.puzzle)).toBe(serializeGrid(b.puzzle));
    expect(serializeGrid(a.puzzle)).not.toBe(serializeGrid(c.puzzle));
  });

  it("難易度が上がるほど必要な手筋が難しくなる", () => {
    for (const date of ["2026-10-15", "2026-10-16", "2026-10-24"]) {
      const levels = BANDED.map((d) => generateDaily(date, d).level);
      for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]);
    }
  });

  it.each(BANDED)("%s: 手筋レベルが難易度の範囲に入る", (difficulty) => {
    const { minLevel, maxLevel } = PROFILES[difficulty];
    for (let k = 0; k < 8; k++) {
      const { level } = generatePuzzle(`band-${k}`, difficulty);
      expect(level).toBeGreaterThanOrEqual(minLevel);
      expect(level).toBeLessThanOrEqual(maxLevel);
    }
  });

  it("日付は JST で切り替わる", () => {
    expect(jstDateKey(new Date("2026-10-15T14:59:59Z"))).toBe("2026-10-15");
    expect(jstDateKey(new Date("2026-10-15T15:00:00Z"))).toBe("2026-10-16");
  });
});

describe("極", () => {
  it("解が 1 つで、手筋では解けず、候補を増やすほど手数が増える（減らない）", () => {
    const few = generateExtreme("kiwami-test", 4);
    const more = generateExtreme("kiwami-test", 16);
    for (const p of [few, more]) {
      expect(p.difficulty).toBe("extreme");
      expect(countSolutions(p.puzzle)).toBe(1);
      expect(isValidSolution(p.puzzle, p.solution)).toBe(true);
      expect(p.level).toBe(6);
      expect(p.effort).toEqual(searchEffort(p.puzzle));
    }
    expect(more.effort!.nodes).toBeGreaterThanOrEqual(few.effort!.nodes);
    // 同じシードなら同じ問題
    expect(serializeGrid(generateExtreme("kiwami-test", 4).puzzle)).toBe(serializeGrid(few.puzzle));
  });

  it("仮定の手数は、易しい問題では少なく、解の検証にもなる", () => {
    expect(searchEffort(CLASSIC).nodes).toBe(0);
    expect(searchEffort(Array(81).fill(0), 50).nodes).toBeGreaterThan(0);
  });
});
