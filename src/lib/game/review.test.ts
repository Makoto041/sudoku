import { describe, expect, it } from "vitest";
import { firstMistakeLines, validFirstMistake } from "./review";

const MISTAKE = { move: 14, cell: 2 * 9 + 4, digit: 7, answer: 4, technique: "naked-single" };

describe("最初の誤りの表示", () => {
  it("何手目・マス・置いた数字・正解の 1 行と、その時点でシングルで置けたときの手筋の行", () => {
    expect(firstMistakeLines(MISTAKE)).toEqual({
      main: "14手目 3行5列 7（正解 4）",
      technique: "その時点で確定できた手筋: ネイキッドシングル",
    });
    expect(firstMistakeLines({ ...MISTAKE, technique: "hidden-single" })?.technique).toBe(
      "その時点で確定できた手筋: ヒドゥンシングル",
    );
    expect(
      firstMistakeLines({ ...MISTAKE, move: 1, cell: 80, digit: 9, answer: 1, technique: null }),
    ).toEqual({
      main: "1手目 9行9列 9（正解 1）",
      technique: null,
    });
  });

  it("文に感嘆符と「数独」を使わない", () => {
    for (const technique of ["naked-single", "hidden-single", null]) {
      const lines = firstMistakeLines({ ...MISTAKE, technique })!;
      for (const text of [lines.main, lines.technique ?? ""]) expect(text).not.toMatch(/[!！]|数独/);
    }
  });

  it("記録が無ければ（ミスなし・古い保存データ）何も出さない", () => {
    expect(firstMistakeLines(undefined)).toBeNull();
    expect(firstMistakeLines(null)).toBeNull();
  });

  it("形の違う保存データは出さない。手筋だけが知らないものなら、手筋の行を出さない", () => {
    for (const bad of [
      "14手目",
      [14, 22, 7, 4],
      {},
      { ...MISTAKE, move: 0 },
      { ...MISTAKE, move: 1.5 },
      { ...MISTAKE, move: "14" },
      { ...MISTAKE, cell: -1 },
      { ...MISTAKE, cell: 81 },
      { ...MISTAKE, digit: 0 },
      { ...MISTAKE, answer: 10 },
      { ...MISTAKE, digit: 4 },
      { ...MISTAKE, answer: undefined },
    ]) {
      expect(validFirstMistake(bad), JSON.stringify(bad)).toBeNull();
      expect(firstMistakeLines(bad)).toBeNull();
    }
    for (const technique of ["unknown", "toString", "__proto__", 1, undefined]) {
      expect(validFirstMistake({ ...MISTAKE, technique })).toEqual({ ...MISTAKE, technique: null });
      expect(firstMistakeLines({ ...MISTAKE, technique })).toEqual({
        main: "14手目 3行5列 7（正解 4）",
        technique: null,
      });
    }
  });
});
