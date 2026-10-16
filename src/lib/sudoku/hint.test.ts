import { describe, expect, it } from "vitest";
import { generatePuzzle } from "./generator";
import { findHint, notesAfterHint, unitName } from "./hint";

/** ヒントだけを使って解き進める。置く数字はいつも正解で、消す候補に正解は無い */
function solveWithHints(seed: string, difficulty: Parameters<typeof generatePuzzle>[1]) {
  const p = generatePuzzle(seed, difficulty);
  const values = p.puzzle.slice();
  let notes = Array(81).fill(0);
  const seen = new Set<string>();
  for (let steps = 0; steps < 2000; steps++) {
    const h = findHint(p.puzzle, values, notes, p.solution);
    if (!h) break;
    seen.add(h.kind === "place" || h.kind === "eliminate" ? h.technique : h.kind);
    expect(h.title.length).toBeGreaterThan(0);
    expect(h.text.length).toBeGreaterThan(0);
    if (h.kind === "place" || h.kind === "guess") {
      expect(h.digit).toBe(p.solution[h.cell]);
      values[h.cell] = h.digit;
      notes[h.cell] = 0;
      for (let i = 0; i < 81; i++) if (notes[i]) notes = notesAfterHint(values, notes, []);
    } else if (h.kind === "eliminate") {
      expect(h.eliminations.length).toBeGreaterThan(0);
      for (const e of h.eliminations) expect(e.digit).not.toBe(p.solution[e.cell]);
      notes = notesAfterHint(values, notes, h.eliminations);
    } else {
      throw new Error("wrong hint on a clean board");
    }
  }
  return { solved: values.every((v, i) => v === p.solution[i]), seen };
}

describe("手筋ヒント", () => {
  it.each(["easy", "medium", "hard", "expert", "master"] as const)(
    "%s: ヒントだけで最後まで解け、正解と食い違わない",
    (difficulty) => {
      for (const seed of ["h1", "h2"]) {
        const { solved } = solveWithHints(seed, difficulty);
        expect(solved).toBe(true);
      }
    },
  );

  it("難しい問題では、シングル以外の手筋のヒントも出る", () => {
    const all = new Set<string>();
    for (const seed of ["t1", "t2", "t3"]) for (const t of solveWithHints(seed, "expert").seen) all.add(t);
    expect([...all].some((t) => !["naked-single", "hidden-single", "guess"].includes(t))).toBe(true);
  });

  it("間違った数字があれば、まずそれを指す", () => {
    const p = generatePuzzle("hw", "easy");
    const values = p.puzzle.slice();
    const cell = p.puzzle.indexOf(0);
    values[cell] = (p.solution[cell] % 9) + 1;
    const h = findHint(p.puzzle, values, Array(81).fill(0), p.solution);
    expect(h).toMatchObject({ kind: "wrong", cell });
  });

  it("解き終えた盤面ではヒントは無い", () => {
    const p = generatePuzzle("hd", "easy");
    expect(findHint(p.puzzle, p.solution, Array(81).fill(0), p.solution)).toBeNull();
  });

  it("ユニットの呼び名", () => {
    expect(unitName(0)).toBe("1行目");
    expect(unitName(13)).toBe("5列目");
    expect(unitName(22)).toBe("中央のブロック");
  });
});
