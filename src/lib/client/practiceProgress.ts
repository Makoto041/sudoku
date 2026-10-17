import type { PracticeItem, PracticeKey } from "@/lib/sudoku/practice";
import { KEYS, isPlainObject, load, save } from "./storage";

/** 手筋の練習の進み具合：項目ごとに解いた局面の id。端末内だけに保存し、引き継ぎには含めない */
export type PracticeProgress = Partial<Record<PracticeKey, string[]>>;

/** 1 項目で読む id の数の上限（壊れた保存データで大きな配列を読まないように） */
const MAX_IDS = 100;

/**
 * 進み具合を読む。保存データは信用せず、今の局面にある項目と id だけを残す（重複も捨てる）。
 * 読めない・壊れているときは空
 */
export function loadPracticeProgress(items: readonly PracticeItem[]): PracticeProgress {
  const raw = load<unknown>(KEYS.practice);
  const out: PracticeProgress = {};
  if (!isPlainObject(raw)) return out;
  for (const item of items) {
    const list = raw[item.key];
    if (!Array.isArray(list)) continue;
    const ids = new Set(item.positions.map((p) => p.id));
    const kept = [...new Set(list.slice(0, MAX_IDS))].filter(
      (id): id is string => typeof id === "string" && ids.has(id),
    );
    if (kept.length) out[item.key] = kept;
  }
  return out;
}

/** 局面を解いたことを記録する。今の局面に無い項目と id は、このとき保存データから消える */
export function markPracticeSolved(items: readonly PracticeItem[], key: PracticeKey, id: string) {
  const progress = loadPracticeProgress(items);
  const solved = progress[key] ?? [];
  if (solved.includes(id) || !items.some((i) => i.key === key && i.positions.some((p) => p.id === id)))
    return;
  save(KEYS.practice, { ...progress, [key]: [...solved, id] });
}

/** 項目を開いたときの局面：まだ解いていない最初の局面。すべて解いていれば最初の局面 */
export function firstUnsolved(item: PracticeItem, progress: PracticeProgress): number {
  const solved = progress[item.key] ?? [];
  const index = item.positions.findIndex((p) => !solved.includes(p.id));
  return index === -1 ? 0 : index;
}
