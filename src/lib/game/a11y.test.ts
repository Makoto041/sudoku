import { describe, expect, it } from "vitest";
import { PEERS } from "@/lib/sudoku/core";
import { generatePuzzle } from "@/lib/sudoku/generator";
import type { Hint } from "@/lib/sudoku/hint";
import { announcementOf, cellLabel, cellName, hintAnnouncement, type CellView } from "./a11y";
import { newGame, reduce, type Action, type Effect, type GameState } from "./state";

const view = (v: Partial<CellView>): CellView => ({
  value: 0,
  given: false,
  wrong: false,
  notes: 0,
  color: 0,
  ...v,
});
const bits = (...ds: number[]) => ds.reduce((m, d) => m | (1 << d), 0);

describe("マスの読み上げ名", () => {
  it("位置は行・列の順で 1 から数える", () => {
    expect(cellName(0)).toBe("1行1列");
    expect(cellName(22)).toBe("3行5列");
    expect(cellName(80)).toBe("9行9列");
  });

  it("最初から入っている数字・入れた数字・間違い・メモ・空きを分け、中身を最後に、色をその後に置く", () => {
    expect(cellLabel(22, view({ value: 7, given: true }))).toBe("3行5列 最初から 7");
    expect(cellLabel(22, view({ value: 7 }))).toBe("3行5列 7");
    expect(cellLabel(22, view({ value: 4, wrong: true }))).toBe("3行5列 間違い 4");
    expect(cellLabel(22, view({ notes: bits(3, 1) }))).toBe("3行5列 メモ1・3 空き");
    expect(cellLabel(22, view({}))).toBe("3行5列 空き");
    expect(cellLabel(22, view({ value: 7, given: true, color: 5 }))).toBe("3行5列 最初から 7 色5");
    expect(cellLabel(22, view({ value: 4, wrong: true, color: 2 }))).toBe("3行5列 間違い 4 色2");
    expect(cellLabel(22, view({ notes: bits(9), color: 3 }))).toBe("3行5列 メモ9 空き 色3");
    expect(cellLabel(22, view({ color: 3 }))).toBe("3行5列 空き 色3");
  });

  it("数字のあるマスはメモを読まず、数字の無いマス（一時停止で隠した最初の数字も）は最初から・間違いを付けない", () => {
    expect(cellLabel(0, view({ value: 6, notes: bits(1, 2) }))).toBe("1行1列 6");
    expect(cellLabel(0, view({ value: 6, given: true, wrong: true }))).toBe("1行1列 最初から 6");
    expect(cellLabel(0, view({ given: true }))).toBe("1行1列 空き");
    expect(cellLabel(0, view({ wrong: true }))).toBe("1行1列 空き");
  });

  it("末尾はいつも数字か「空き」（色があればその後に色）", () => {
    for (const value of [0, 1, 9])
      for (const given of [false, true])
        for (const wrong of [false, true])
          for (const notes of [0, bits(1), bits(2, 5, 8)])
            for (const color of [0, 1, 9]) {
              const label = cellLabel(40, { value, given, wrong, notes, color });
              expect(label).toMatch(color ? new RegExp(`( \\d| 空き) 色${color}$`) : /( \d| 空き)$/);
              expect(label.startsWith("5行5列 ")).toBe(true);
            }
  });
});

function freeGame(): GameState {
  const p = generatePuzzle("a11y-test", "easy");
  return newGame({ mode: "free", difficulty: "easy", seed: "x", puzzle: p.puzzle, solution: p.solution });
}

function run(s: GameState, ...actions: Action[]): { s: GameState; effects: Effect[] } {
  let effects: Effect[] = [];
  for (const a of actions) [s, effects] = reduce(s, a);
  return { s, effects };
}

const say = (r: { s: GameState; effects: Effect[] }, showMistakes = true) =>
  announcementOf(r.effects, r.s, showMistakes);

describe("入力の結果の知らせ", () => {
  const s0 = freeGame();
  const empties = s0.puzzle.flatMap((v, i) => (v ? [] : [i]));
  const [a, b] = empties;
  const solution = s0.solution!;
  const given = s0.puzzle.findIndex((v) => v !== 0);

  it("選ぶだけ・何も変わらない入力は知らせない", () => {
    expect(say(run(s0, { type: "select", cell: a }))).toBe(null);
    expect(say(run(s0, { type: "move", dr: 0, dc: 1 }))).toBe(null);
    // 最初から入っているマスには置けない
    expect(say(run(s0, { type: "select", cell: given }, { type: "input", digit: 1 }))).toBe(null);
  });

  it("置いた数字。間違いは盤面と同じく、重複はいつも、解答と違うだけなら「間違いをすぐ表示」のときに知らせる", () => {
    const ok = run(s0, { type: "select", cell: a }, { type: "input", digit: solution[a] });
    expect(say(ok)).toBe(`${cellName(a)}に ${solution[a]}`);

    // 周りに無い（重複しない）間違い
    let quiet: { cell: number; digit: number } | null = null;
    // 周りにある（重複する）数字
    let loud: { cell: number; digit: number } | null = null;
    for (const cell of empties) {
      for (let d = 1; d <= 9; d++) {
        if (d === solution[cell]) continue;
        const clash = PEERS[cell].some((p) => s0.values[p] === d);
        if (clash) loud ??= { cell, digit: d };
        else quiet ??= { cell, digit: d };
      }
    }
    expect(quiet && loud).toBeTruthy();
    const wrong = run(s0, { type: "select", cell: quiet!.cell }, { type: "input", digit: quiet!.digit });
    expect(say(wrong)).toBe(`${cellName(quiet!.cell)}に ${quiet!.digit} 間違い`);
    expect(say(wrong, false)).toBe(`${cellName(quiet!.cell)}に ${quiet!.digit}`);
    const clash = run(s0, { type: "select", cell: loud!.cell }, { type: "input", digit: loud!.digit });
    expect(say(clash, false)).toBe(`${cellName(loud!.cell)}に ${loud!.digit} 間違い`);
  });

  it("メモの付け外し。複数のマスではマスの名前を付けない", () => {
    const on = run(s0, { type: "select", cell: a }, { type: "input", digit: 3, asNote: true });
    expect(say(on)).toBe(`${cellName(a)} メモ3 追加`);
    expect(say(run(on.s, { type: "input", digit: 3, asNote: true }))).toBe(`${cellName(a)} メモ3 削除`);
    const multi = run(
      s0,
      { type: "select", cell: a },
      { type: "toggleSelection", cell: b },
      { type: "input", digit: 4 },
    );
    expect(say(multi)).toBe("メモ4 追加");
    expect(say(run(multi.s, { type: "input", digit: 4 }))).toBe("メモ4 削除");
    // 複数のマスの消すはメモだけを消す
    expect(say(run(multi.s, { type: "erase" }))).toBe("メモを消去");
  });

  it("消す・戻す・進む。戻す・進むは、そのマスの今の中身を添える", () => {
    const placed = run(s0, { type: "select", cell: a }, { type: "input", digit: solution[a] });
    expect(say(run(placed.s, { type: "erase" }))).toBe(`${cellName(a)} 消去`);
    const undone = run(placed.s, { type: "undo" });
    expect(say(undone)).toBe(`戻す ${cellName(a)} 空き`);
    expect(say(run(undone.s, { type: "redo" }))).toBe(`進む ${cellName(a)} ${solution[a]}`);
    // まとめて変えたメモを戻したときは、マスを言わない
    const auto = run(s0, { type: "autoNotes" });
    expect(say(auto)).toBe("メモを更新");
    expect(say(run(auto.s, { type: "autoNotes" }))).toBe("メモを消去");
    expect(say(run(auto.s, { type: "undo" }))).toBe("戻す");
    expect(say(run(auto.s, { type: "undo" }, { type: "redo" }))).toBe("進む");
  });

  it("色の付け外しと、色だけを消す", () => {
    const painted = run(
      s0,
      { type: "select", cell: given },
      { type: "toggleColors" },
      { type: "input", digit: 3 },
    );
    expect(say(painted)).toBe("色3 追加");
    expect(say(run(painted.s, { type: "input", digit: 3 }))).toBe("色3 削除");
    expect(say(run(painted.s, { type: "erase" }))).toBe("色を消去");
  });

  it("ヒントで置いた数字と、解き終えたこと", () => {
    expect(say(run(s0, { type: "hint", cell: a }))).toBe(`${cellName(a)}に ${solution[a]}`);
    // 残り 1 マスの盤面
    const last = newGame({
      mode: "free",
      difficulty: "easy",
      seed: "x",
      puzzle: solution.map((v, i) => (i === a ? 0 : v)),
      solution,
    });
    const solved = run(last, { type: "select", cell: a }, { type: "input", digit: solution[a] });
    expect(say(solved)).toBe(`${cellName(a)}に ${solution[a]} クリア`);
  });

  it("間違える前まで戻した手の数", () => {
    expect(announcementOf([{ kind: "rewind", steps: 3 }], s0, true)).toBe("戻す 3手");
  });
});

describe("ヒントの知らせ", () => {
  const place: Hint = {
    kind: "place",
    technique: "naked-single",
    title: "ネイキッドシングル",
    text: "このマスに入る数字は 7 だけです",
    focus: [18, 19, 20],
    pattern: [],
    targets: [22],
    cell: 22,
    digit: 7,
  };

  it("開いたときは手筋の名前、説明に進んだら説明と対象のマス", () => {
    expect(hintAnnouncement(place, 1, null)).toBe("ヒント ネイキッドシングル");
    expect(hintAnnouncement(place, 2, 1)).toBe("このマスに入る数字は 7 だけです 対象 3行5列");
  });

  it("説明から見せるヒントは、開いたときに名前と説明を続けて知らせる", () => {
    const wrong: Hint = {
      kind: "wrong",
      cell: 0,
      title: "違う数字があります",
      text: "このマスの数字が違います",
      focus: [0],
      targets: [0],
    };
    expect(hintAnnouncement(wrong, 2, null)).toBe(
      "ヒント 違う数字があります このマスの数字が違います 対象 1行1列",
    );
    expect(hintAnnouncement({ ...place, targets: [22, 23] }, 2, 1)).toBe(
      "このマスに入る数字は 7 だけです 対象 3行5列・3行6列",
    );
  });
});
