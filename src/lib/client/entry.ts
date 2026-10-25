import { newGame, type Action, type GameState } from "@/lib/game/state";
import { findConflicts } from "@/lib/sudoku/core";
import { MIN_GIVENS, checkPuzzle, type SharedError, type SharedPuzzle } from "./sharedPuzzle";

/** 入力した盤面を始められない理由 */
export type EntryIssue = "few" | "full" | "conflict" | "no-solution" | "multiple" | "too-hard";

/** 理由の文言（入力の画面に出す） */
export const ENTRY_ISSUE_TEXT: Record<EntryIssue, string> = {
  few: `ヒントが少なすぎます（${MIN_GIVENS} 個以上）`,
  full: "空きマスがありません",
  conflict: "矛盾があります",
  "no-solution": "解がありません",
  multiple: "解が 1 つに決まりません",
  "too-hard": "解が 1 つか確かめきれません",
};

export type EntryCheck = { ok: true; puzzle: SharedPuzzle } | { ok: false; issue: EntryIssue };

/**
 * 入力の盤面。Board・useGame・useGameKeys をそのまま使うため GameState の形にする。
 * 練習と同じく保存せず（途中のフリープレイ sudoku:free を書き換えない）、埋まっても解き終えにしない。
 * 最初の配置は空で、入れた数字は values に入る（どのマスも書き換えられる）。解答は無いので、
 * 盤面は同じ行・列・ブロックの重複を間違いとして示す
 */
export const newEntry = (): GameState =>
  newGame({ mode: "practice", difficulty: "easy", seed: "entry", puzzle: Array(81).fill(0), solution: null });

/**
 * 入力で受け付ける操作に直す。受け付けないものは null。
 * 選ぶ・動く・数字・消す・戻す・進むだけ（メモ・色・複数選択・ヒント・一時停止は使わない）。
 * Shift+数字もメモにせず数字として入れ、消すは色に効かせない
 */
export function entryAction(action: Action): Action | null {
  switch (action.type) {
    case "select":
    case "move":
    case "undo":
    case "redo":
      return action;
    case "input":
      return { type: "input", digit: action.digit, asNote: false };
    case "erase":
      return { type: "erase", colors: false };
    default:
      return null;
  }
}

/** ヒントの数（入れた数字の数） */
export const givensOf = (values: readonly number[]) => values.filter((v) => v !== 0).length;

/** 入力のたびに確かめる軽い検査（ヒントの数・重複）。通れば null */
export function quickIssue(values: readonly number[]): EntryIssue | null {
  const n = givensOf(values);
  if (n < MIN_GIVENS) return "few";
  // 81 個だと解き終えられない（共有された盤面と同じ）
  if (n === 81) return "full";
  if (findConflicts(values).size > 0) return "conflict";
  return null;
}

const ISSUE_OF: Record<Exclude<SharedError, "format" | "givens">, EntryIssue> = {
  conflict: "conflict",
  "no-solution": "no-solution",
  multiple: "multiple",
  "too-hard": "too-hard",
};

/**
 * 入力した盤面を始められるか。共有された盤面と同じ検査（checkPuzzle）で、解が 1 つか（置く回数は MAX_NODES まで）と
 * 難易度（手筋の判定のまま。レベル 6 は鬼）まで確かめる。重いので、入力が止まってから呼ぶ
 */
export function checkEntry(values: readonly number[]): EntryCheck {
  const quick = quickIssue(values);
  if (quick) return { ok: false, issue: quick };
  const r = checkPuzzle(values, null);
  if (r.ok) return r;
  // 形と数は quickIssue で確かめ済み
  return { ok: false, issue: r.reason === "format" || r.reason === "givens" ? "few" : ISSUE_OF[r.reason] };
}
