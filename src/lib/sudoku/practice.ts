import { parseGrid, type Grid } from "./core";
import { TECHNIQUE_NAME } from "./hint";
import { candidatesOf, findNextStep, type NextStep, type TechniqueId } from "./logic";

/**
 * 手筋の練習の項目（易しい順。findNextStep が試す順と同じ）。
 * ポインティングとクレーミングは表示名が同じ（ロックドキャンディデート）なので "pointing" にまとめる
 */
export const PRACTICE_KEYS = [
  "naked-single",
  "hidden-single",
  "pointing",
  "naked-pair",
  "hidden-pair",
  "naked-triple",
  "x-wing",
  "hidden-triple",
  "naked-quad",
  "xy-wing",
  "xyz-wing",
  "swordfish",
] as const satisfies readonly TechniqueId[];

export type PracticeKey = (typeof PRACTICE_KEYS)[number];

export const practiceKeyOf = (t: TechniqueId): PracticeKey => (t === "claiming" ? "pointing" : t);

/** 手筋の内訳（techniqueProfile の counts）を、練習の項目の名前と順でまとめる。0 回の手筋は出さない */
export function techniqueRows(
  counts: Partial<Record<TechniqueId, number>>,
): { key: PracticeKey; name: string; count: number }[] {
  const sum = new Map<PracticeKey, number>();
  for (const [t, n] of Object.entries(counts) as [TechniqueId, number][]) {
    const key = practiceKeyOf(t);
    sum.set(key, (sum.get(key) ?? 0) + n);
  }
  return PRACTICE_KEYS.flatMap((key) => {
    const count = sum.get(key) ?? 0;
    return count > 0 ? [{ key, name: TECHNIQUE_NAME[key], count }] : [];
  });
}

/** 同梱する局面（practice-data.ts）の 1 件。盤面は 81 文字（0 は空き） */
export type RawPosition = {
  id: string;
  technique: TechniqueId;
  values: string;
  solution: string;
  /** 候補をすべて書いた状態から取り除いておく候補 [マス, 数字] */
  removed: [number, number][];
};

/**
 * 練習の局面。values の数字はすべて最初から入っている数字として扱う。
 * メモの始めは、候補をすべて書いた状態から removed を除いたもの（startNotes）
 */
export type PracticePosition = Omit<RawPosition, "values" | "solution"> & { values: Grid; solution: Grid };

export type PracticeItem = { key: PracticeKey; name: string; positions: PracticePosition[] };

/** 局面を項目ごとにまとめる。局面の無い項目は出さない */
export function practiceItems(raw: readonly RawPosition[]): PracticeItem[] {
  return PRACTICE_KEYS.map((key) => ({
    key,
    name: TECHNIQUE_NAME[key],
    positions: raw
      .filter((p) => practiceKeyOf(p.technique) === key)
      .map((p) => ({ ...p, values: parseGrid(p.values), solution: parseGrid(p.solution) })),
  })).filter((item) => item.positions.length > 0);
}

/** 局面のデータを読む。最初の読み込みに含めないよう、開くときに別に読む */
export async function loadPractice(): Promise<PracticeItem[]> {
  const { PRACTICE_POSITIONS } = await import("./practice-data");
  return practiceItems(PRACTICE_POSITIONS);
}

/** 始めのメモ：候補をすべて書いた状態から removed を除いたもの */
export function startNotes(p: Pick<PracticePosition, "values" | "removed">): number[] {
  const notes = candidatesOf(p.values);
  for (const [cell, digit] of p.removed) notes[cell] &= ~(1 << digit);
  return notes;
}

/** 局面の答え：始めの盤面とメモで findNextStep が見つける手（同梱の局面はテストで確かめてある） */
export function answerOf(p: PracticePosition): NextStep {
  return findNextStep(p.values, startNotes(p))!;
}

export type PracticeCheck = {
  correct: boolean;
  /** 違う数字を置いたマス */
  wrong: number[];
  /** 正解の数字をメモから消したマス */
  lost: number[];
};

/**
 * 答え合わせ。置く手筋は狙いのマスに正しい数字を置けば、消す手筋は消すべき候補をすべて消せば正解。
 * 余計な候補を消していても、正解の数字を消していなければ正解にする。
 * メモが空のマスは（ヒントと同じく）メモが無いものとして扱い、正解を消したことにはしない
 */
export function checkPractice(
  p: PracticePosition,
  answer: NextStep,
  values: Grid,
  notes: number[],
): PracticeCheck {
  const wrong: number[] = [];
  const lost: number[] = [];
  for (let i = 0; i < 81; i++) {
    if (p.values[i]) continue;
    if (values[i] && values[i] !== p.solution[i]) wrong.push(i);
    if (!values[i] && notes[i] && !(notes[i] & (1 << p.solution[i]))) lost.push(i);
  }
  // 数字を置いたマスは、その数字以外の候補を消したものとする（違う数字は wrong で弾く）
  const gone = ({ cell, digit }: { cell: number; digit: number }) =>
    values[cell] ? values[cell] !== digit : notes[cell] !== 0 && !(notes[cell] & (1 << digit));
  const done = answer.placement
    ? values[answer.placement.cell] === answer.placement.digit
    : answer.eliminations.every(gone);
  return { correct: done && wrong.length === 0 && lost.length === 0, wrong, lost };
}
