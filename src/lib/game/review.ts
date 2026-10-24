import { TECHNIQUE_NAME } from "@/lib/sudoku/hint";
import type { TechniqueId } from "@/lib/sudoku/logic";
import { cellName } from "./a11y";
import type { FirstMistake } from "./state";

const isInt = (x: unknown, min: number, max: number): x is number =>
  Number.isInteger(x) && (x as number) >= min && (x as number) <= max;

const isTechnique = (x: unknown): x is TechniqueId =>
  typeof x === "string" && Object.prototype.hasOwnProperty.call(TECHNIQUE_NAME, x);

/**
 * 保存データの最初の誤りを確かめる。形の違うものは null（書き換えられた・壊れた保存データでも結果を出す）。
 * 手筋だけが知らないものなら、手筋の行を出さないだけにする
 */
export function validFirstMistake(x: unknown): FirstMistake | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const m = x as Record<string, unknown>;
  if (!isInt(m.move, 1, Number.MAX_SAFE_INTEGER) || !isInt(m.cell, 0, 80)) return null;
  if (!isInt(m.digit, 1, 9) || !isInt(m.answer, 1, 9) || m.digit === m.answer) return null;
  return {
    move: m.move,
    cell: m.cell,
    digit: m.digit,
    answer: m.answer,
    technique: isTechnique(m.technique) ? m.technique : null,
  };
}

/**
 * クリアの結果に出す最初の誤り。無ければ（ミスが無い・古い保存データ）null。
 * main は「14手目 3行5列 7（正解 4）」、technique はその時点でシングルで置けたときの手筋の行（無ければ null）
 */
export function firstMistakeLines(x: unknown): { main: string; technique: string | null } | null {
  const m = validFirstMistake(x);
  if (!m) return null;
  return {
    main: `${m.move}手目 ${cellName(m.cell)} ${m.digit}（正解 ${m.answer}）`,
    technique: m.technique ? `その時点で確定できた手筋: ${TECHNIQUE_NAME[m.technique]}` : null,
  };
}
