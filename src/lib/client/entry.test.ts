import { describe, expect, it } from "vitest";
import { announcementOf } from "@/lib/game/a11y";
import { isShownWrong, isWrong, reduce, type Action, type GameState } from "@/lib/game/state";
import { findConflicts, isValidSolution, parseGrid, serializeGrid } from "@/lib/sudoku/core";
import { countSolutionsWithin, solve } from "@/lib/sudoku/solver";
import {
  ENTRY_ISSUE_TEXT,
  checkEntry,
  entryAction,
  entryMessage,
  givensOf,
  newEntry,
  quickIssue,
  type EntryCheck,
} from "./entry";
import { MAX_NODES } from "./sharedPuzzle";
import { storageKeyFor } from "./useGame";

// シングルだけで解ける問題（ヒント 30 個）
const CLASSIC = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
// ヒント 17 個で解が 1 つの問題
const SEVENTEEN = "000000010400000000020000000000050407008000300001090000300400200050100000000806000";
// 手筋のレベル 6（鬼・極）の問題
const LEVEL6 = "100006004060000000200000078000800000074000100500302040800000009001000020000760001";
/** 確かめ終わるまでに何百万回も置く盤面（sharedPuzzle.test.ts と同じ） */
const EXHAUSTING = [
  "000006000059000008200008000045000000003000000006003054000325006000000000000000000",
  "000000002010000000000010000690500100070000000000001030035020010700000000100000670",
  "306000500700000002000100000007000050000000924000080000001000000005300001000026000",
];

const at = (s: string, i: number, ch: string) => s.slice(0, i) + ch + s.slice(i + 1);

/** 入力の画面と同じく、受け付ける操作だけを送る */
function send(s: GameState, action: Action) {
  const a = entryAction(action);
  return a ? reduce(s, a) : ([s, []] as const);
}

/** マスを選んで数字を入れる */
function put(s: GameState, cell: number, digit: number): GameState {
  return send(send(s, { type: "select", cell })[0], { type: "input", digit })[0];
}

/** 盤面の文字列（0 は空き）を入れる */
function enter(p: string): GameState {
  let s = newEntry();
  [...p].forEach((ch, i) => {
    if (ch !== "0") s = put(s, i, Number(ch));
  });
  return s;
}

const issue = (r: EntryCheck) => (r.ok ? null : r.issue);

describe("盤面の入力", () => {
  it("マスを選んで数字を入れる・消す。同じ数字をもう一度入れても消える。どのマスも書き換えられる", () => {
    let s = put(newEntry(), 10, 4);
    expect(s.values[10]).toBe(4);
    s = put(s, 10, 7);
    expect(s.values[10]).toBe(7);
    s = send(s, { type: "erase" })[0];
    expect(s.values[10]).toBe(0);
    s = put(put(s, 10, 3), 10, 3);
    expect(s.values[10]).toBe(0);
    // 戻す・進む
    s = put(s, 0, 9);
    s = send(s, { type: "undo" })[0];
    expect(s.values[0]).toBe(0);
    s = send(s, { type: "redo" })[0];
    expect(s.values[0]).toBe(9);
  });

  it("Shift+数字もメモにせず数字として入れ、消すは色に効かせない", () => {
    let s = send(newEntry(), { type: "select", cell: 5 })[0];
    s = send(s, { type: "input", digit: 6, asNote: true })[0];
    expect(s.values[5]).toBe(6);
    expect(s.notes[5]).toBe(0);
    expect(entryAction({ type: "erase", colors: true })).toEqual({ type: "erase", colors: false });
  });

  it("選ぶ・動く・数字・消す・戻す・進むのほか（メモ・色・複数選択・ヒント・一時停止など）は受け付けない", () => {
    const accepted: Action[] = [
      { type: "select", cell: 3 },
      { type: "select", cell: null },
      { type: "move", dr: 1, dc: 0, from: 40 },
      { type: "undo" },
      { type: "redo" },
    ];
    for (const a of accepted) expect(entryAction(a), a.type).toEqual(a);
    const rejected: Action[] = [
      { type: "toggleNotes" },
      { type: "toggleColors" },
      { type: "toggleSelection", cell: 1 },
      { type: "extendSelection", cell: 1 },
      { type: "autoNotes" },
      { type: "setNotes", notes: Array(81).fill(0) },
      { type: "hint" },
      { type: "hintUsed" },
      { type: "rewind" },
      { type: "pause" },
      { type: "resume" },
      { type: "tick", ms: 1000 },
    ];
    for (const a of rejected) expect(entryAction(a), a.type).toBeNull();
  });

  it("保存しない。81 マス埋めても解き終えにしない", () => {
    expect(storageKeyFor(newEntry())).toBeNull();
    const full = serializeGrid(solve(parseGrid(CLASSIC))!);
    const s = enter(full);
    expect(s.values).toEqual(parseGrid(full));
    expect(s.status).toBe("playing");
    // 埋めた後も書き換えられる
    const other = (Number(full[0]) % 9) + 1;
    expect(put(s, 0, other).values[0]).toBe(other);
  });

  it("ヒントの数は入れた数字の数", () => {
    expect(givensOf(newEntry().values)).toBe(0);
    expect(givensOf(enter(CLASSIC).values)).toBe(30);
    expect(givensOf(enter(SEVENTEEN).values)).toBe(17);
  });

  it("同じ行・列・ブロックの同じ数字は、その場で両方のマスを間違いとして示し、読み上げでも間違いと知らせる", () => {
    let s = enter(CLASSIC);
    expect(findConflicts(s.values).size).toBe(0);
    // 1 行目の 3 マス目に、同じ行の 5（1 マス目）を入れる
    s = send(s, { type: "select", cell: 2 })[0];
    const [next, effects] = send(s, { type: "input", digit: 5 });
    expect([...findConflicts(next.values)].sort((a, b) => a - b)).toEqual([0, 2]);
    for (const i of [0, 2]) {
      expect(isShownWrong({ conflict: true, wrong: isWrong(next, i) }, true)).toBe(true);
    }
    expect(announcementOf([...effects], next, true)).toBe("1行3列に 5 間違い");
    expect(quickIssue(next.values)).toBe("conflict");
    // 消せば矛盾は無くなる
    expect(quickIssue(send(next, { type: "erase" })[0].values)).toBeNull();
  });
});

describe("入力した盤面を確かめる", () => {
  it("解が 1 つの盤面は始められる。難易度は手筋の判定で、シードと解答は共有された盤面と同じ", () => {
    const r = checkEntry(enter(CLASSIC).values);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(serializeGrid(r.puzzle.puzzle)).toBe(CLASSIC);
    expect(r.puzzle.solution).toEqual(solve(parseGrid(CLASSIC)));
    expect(isValidSolution(r.puzzle.puzzle, r.puzzle.solution)).toBe(true);
    expect(r.puzzle.difficulty).toBe("easy");
    expect(r.puzzle.seed).toBe(`shared:${CLASSIC}`);
    // レベル 6 は鬼（極は d で分けるもので、入力した盤面には付かない）
    const six = checkEntry(parseGrid(LEVEL6));
    expect(six.ok && six.puzzle.difficulty).toBe("master");
  });

  it("ヒントは 17〜80 個。16 個以下は少なすぎ、81 個は空きマスが無い", () => {
    expect(issue(checkEntry(newEntry().values))).toBe("few");
    expect(checkEntry(parseGrid(SEVENTEEN)).ok).toBe(true);
    const sixteen = at(SEVENTEEN, SEVENTEEN.indexOf("1"), "0");
    expect(quickIssue(parseGrid(sixteen))).toBe("few");
    expect(issue(checkEntry(parseGrid(sixteen)))).toBe("few");
    const full = serializeGrid(solve(parseGrid(CLASSIC))!);
    expect(issue(checkEntry(parseGrid(full)))).toBe("full");
    expect(checkEntry(parseGrid(at(full, 40, "0"))).ok).toBe(true);
  });

  it("重複・解が無い・解が 2 つ以上・確かめきれない盤面は、それぞれの理由で始められない", () => {
    expect(issue(checkEntry(parseGrid(at(CLASSIC, 2, "5"))))).toBe("conflict");
    // 1 マス目の 5 を 1 にすると、重複は無いが解が無い
    expect(quickIssue(parseGrid(at(CLASSIC, 0, "1")))).toBeNull();
    expect(issue(checkEntry(parseGrid(at(CLASSIC, 0, "1"))))).toBe("no-solution");
    // 最初の 2 つのヒントを消すと解が 2 つ以上
    expect(issue(checkEntry(parseGrid(`00${CLASSIC.slice(2)}`)))).toBe("multiple");
    // 「確かめきれない」は、置く回数の上限で打ち切ったときだけ（解の数を数え切れば、解が無い・2 つ以上になる）
    for (const p of EXHAUSTING) {
      expect(countSolutionsWithin(parseGrid(p), 2, MAX_NODES), p).toBeNull();
      expect(issue(checkEntry(parseGrid(p))), p).toBe("too-hard");
    }
  });

  it("理由の欄の文は、確かめている途中（null）の間は前の文を残し、文が変わったときだけ入れ替える", () => {
    const empty = { text: "", issue: false };
    const few = entryMessage({ ok: false, issue: "few" }, empty);
    expect(few).toEqual({ text: "ヒントが少なすぎます（17 個以上）", issue: true });
    const ok = checkEntry(parseGrid(CLASSIC));
    const easy = entryMessage(ok, few);
    expect(easy).toEqual({ text: "難易度 かんたん", issue: false });
    // 入力して確かめ直す間は、同じものを返す（欄を空にしない）
    expect(entryMessage(null, easy)).toBe(easy);
    // 確かめ直して同じ文なら、前のものを返す（読み上げ直さない）
    expect(entryMessage(ok, easy)).toBe(easy);
    expect(entryMessage({ ok: false, issue: "multiple" }, easy)).toEqual({
      text: "解が 1 つに決まりません",
      issue: true,
    });
  });

  it("理由の文言は短い事実", () => {
    expect(ENTRY_ISSUE_TEXT).toEqual({
      few: "ヒントが少なすぎます（17 個以上）",
      full: "空きマスがありません",
      conflict: "矛盾があります",
      "no-solution": "解がありません",
      multiple: "解が 1 つに決まりません",
      "too-hard": "解が 1 つか確かめきれません",
    });
  });
});
