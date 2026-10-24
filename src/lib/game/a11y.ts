import { colOf, digitsOf, rowOf } from "@/lib/sudoku/core";
import type { Hint } from "@/lib/sudoku/hint";
import { isShownWrong, type Effect, type GameState } from "./state";

/** マスの呼び名（例: 3行5列） */
export const cellName = (i: number) => `${rowOf(i) + 1}行${colOf(i) + 1}列`;

/** 読み上げに使うマスの中身。value・notes・color は画面に出しているもの（一時停止中は 0） */
export type CellView = {
  value: number;
  /** 最初から入っている数字か */
  given: boolean;
  /** 間違いとして赤く出しているか */
  wrong: boolean;
  notes: number;
  /** 色の番号（0 は色なし） */
  color: number;
};

/**
 * マスの読み上げ名。位置・状態・中身の順で、中身（数字か「空き」）と色を最後に置く
 * （例: 3行5列 最初から 7、3行5列 間違い 4、3行5列 メモ1・3 空き、3行5列 7 色2）
 */
export function cellLabel(i: number, v: CellView): string {
  const parts = [cellName(i)];
  if (v.value) {
    if (v.given) parts.push("最初から");
    else if (v.wrong) parts.push("間違い");
    parts.push(String(v.value));
  } else {
    const notes = digitsOf(v.notes);
    if (notes.length) parts.push(`メモ${notes.join("・")}`);
    parts.push("空き");
  }
  if (v.color) parts.push(`色${v.color}`);
  return parts.join(" ");
}

/**
 * 入力の結果の知らせ。知らせることが無ければ null（選ぶだけ・何も変わらなかったとき）。
 * s は入力の後の状態。間違いは盤面と同じく、重複はいつも、解答と違う数字は showMistakes のときだけ知らせる。
 * 行き詰まりは盤面の下の警告（role="alert"）が知らせるので、ここでは扱わない
 */
export function announcementOf(
  effects: readonly Effect[],
  s: GameState,
  showMistakes: boolean,
): string | null {
  const parts: string[] = [];
  for (const e of effects) {
    switch (e.kind) {
      case "place":
        parts.push(`${cellName(e.cell)}に ${e.digit}${isShownWrong(e, showMistakes) ? " 間違い" : ""}`);
        break;
      case "hint":
        parts.push(`${cellName(e.cell)}に ${e.digit}`);
        break;
      case "note":
        // cell が -1 なのは、選んだ複数のマスにまとめて付け外ししたとき
        parts.push(`${e.cell >= 0 ? `${cellName(e.cell)} ` : ""}メモ${e.digit} ${e.on ? "追加" : "削除"}`);
        break;
      case "color":
        parts.push(`色${e.color} ${e.on ? "追加" : "削除"}`);
        break;
      case "erase":
        // cell が -1 なのは、複数のマスのメモか、選んだマスの色を消したとき
        parts.push(e.cell >= 0 ? `${cellName(e.cell)} 消去` : s.colorMode ? "色を消去" : "メモを消去");
        break;
      case "undo":
      case "redo": {
        const verb = e.kind === "undo" ? "戻す" : "進む";
        // cell が -1 なのは、メモや色をまとめて変えた手
        parts.push(e.cell >= 0 ? `${verb} ${cellName(e.cell)} ${s.values[e.cell] || "空き"}` : verb);
        break;
      }
      case "rewind":
        parts.push(`戻す ${e.steps}手`);
        break;
      case "notes":
        parts.push(e.filled ? "メモを更新" : "メモを消去");
        break;
      case "solved":
        parts.push("クリア");
        break;
      case "blocked":
        break;
    }
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * 手筋ヒントの知らせ。開いたときは手筋の名前（説明から見せるヒントは名前と説明）、
 * 「もっと見る」で説明に進んだときは説明だけ。prev は直前に見せていた段（開いたときは null）。
 * 説明の「このマス」は盤面で照らすマスなので、説明には置ける・消せるマス（targets）の名前を添える
 */
export function hintAnnouncement(hint: Hint, stage: 1 | 2, prev: 1 | 2 | null): string {
  if (stage === 1) return `ヒント ${hint.title}`;
  const targets = hint.targets.length ? ` 対象 ${hint.targets.map(cellName).join("・")}` : "";
  const body = `${hint.text}${targets}`;
  return prev === 1 ? body : `ヒント ${hint.title} ${body}`;
}
