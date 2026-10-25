"use client";

import { useEffect } from "react";
import { sfx } from "@/lib/audio";
import type { Action, GameState } from "@/lib/game/state";

/** キー操作で見るイベントの項目 */
export type KeyInput = Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;

/**
 * キーで行うこと。run は送る入力か、"hint"（ヒントを開く）。
 * prevent はブラウザの既定の動作（スクロールなど）を止めるか。sound は入力のあとに鳴らす音
 */
export type KeyCommand = { run: Action | "hint"; prevent: boolean; sound?: "select" | "tap" };

const MOVES: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
  w: [-1, 0],
  s: [1, 0],
  a: [0, -1],
  d: [0, 1],
};

/** キーを盤面の操作に変える。操作でなければ null。paused は一時停止中か（Space で再開する） */
export function keyCommand(e: KeyInput, paused: boolean): KeyCommand | null {
  if (e.metaKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  // Shift を先に見る（Ctrl+Shift+Z を元に戻すにしない）
  if ((key === "z" && e.shiftKey) || (e.ctrlKey && key === "y"))
    return { run: { type: "redo" }, prevent: true };
  if (e.ctrlKey && key === "z") return { run: { type: "undo" }, prevent: true };
  if (e.ctrlKey) return null;
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? /^Numpad([1-9])$/.exec(e.code)?.[1];
  if (digit) {
    return {
      run: { type: "input", digit: Number(digit), asNote: e.shiftKey ? true : undefined },
      prevent: true,
    };
  }
  const mv = MOVES[e.key];
  if (mv) return { run: { type: "move", dr: mv[0], dc: mv[1] }, prevent: true, sound: "select" };
  switch (e.key) {
    case "Backspace":
    case "Delete":
    case "0":
      return { run: { type: "erase" }, prevent: true };
    case "n":
    case "N":
      return { run: { type: "toggleNotes" }, prevent: false, sound: "tap" };
    case "c":
    case "C":
      return { run: { type: "toggleColors" }, prevent: false, sound: "tap" };
    case "z":
    case "u":
      return { run: { type: "undo" }, prevent: false };
    case "h":
      return { run: "hint", prevent: false };
    case " ":
      return { run: { type: paused ? "resume" : "pause" }, prevent: true };
    case "Escape":
      return { run: { type: "select", cell: null }, prevent: false };
  }
  return null;
}

/**
 * 矢印キーの移動に、フォーカスしているマス（focused、無ければ null）を起点として添える。
 * 起点は選んでいるマスが無いときだけ使う（選択を外した後に、フォーカスしているマスから動かす）
 */
export function withFocusedCell(run: Action, focused: number | null): Action {
  return run.type === "move" && focused !== null ? { ...run, from: focused } : run;
}

/** 設定などのシート（aria-modal のダイアログ）を開いているか */
const modalOpen = () => document.querySelector('[role="dialog"][aria-modal="true"]') !== null;

/**
 * 盤面のキーボード操作。window の keydown を keyCommand で入力に変えて dispatch に送る。
 * H キーは onHint を呼ぶ。シートを開いている間は盤面を操作しない。
 * enabled が false の間（正解した練習の盤面など）は、既定の動作だけ止めて、入力も音も出さない。
 * accepts が false を返すキー（盤面の入力で使わないメモ・色など）は、操作にしない（既定の動作も止めず、音も出さない）
 */
export function useGameKeys({
  dispatch,
  game,
  onHint,
  enabled = true,
  accepts,
}: {
  dispatch: (action: Action) => void;
  game: GameState;
  onHint: () => void;
  enabled?: boolean;
  accepts?: (run: KeyCommand["run"]) => boolean;
}) {
  const paused = game.status === "paused";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      if (modalOpen()) return;
      // フォーカス中のボタンは Space/Enter で押せるようにし、一時停止に回さない
      if ((e.key === " " || e.key === "Enter") && target?.closest("button")) return;
      const cmd = keyCommand(e, paused);
      if (!cmd || (accepts && !accepts(cmd.run))) return;
      if (cmd.prevent) e.preventDefault();
      if (!enabled) return;
      if (cmd.run === "hint") onHint();
      else {
        const cell = target?.closest<HTMLElement>(".board [data-i]");
        dispatch(withFocusedCell(cmd.run, cell ? Number(cell.dataset.i) : null));
      }
      if (cmd.sound) sfx[cmd.sound]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, paused, onHint, enabled, accepts]);
}
