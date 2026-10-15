import type { Difficulty } from "@/lib/sudoku/core";
import { KEYS, load, save } from "./storage";

type DifficultyStats = { played: number; bestMs: number | null; cleanBestMs: number | null };
type Stats = Partial<Record<Difficulty, DifficultyStats>>;

export type FreeClear = { bestMs: number | null; isBest: boolean; played: number };

/** フリープレイの自己ベスト（端末内のみ）。ヒントを使ったクリアはベストに数えない */
export function recordFreeClear(
  difficulty: Difficulty,
  ms: number,
  mistakes: number,
  hints: number,
): FreeClear {
  const stats = load<Stats>(KEYS.stats) ?? {};
  const cur = stats[difficulty] ?? { played: 0, bestMs: null, cleanBestMs: null };
  const eligible = hints === 0;
  const isBest = eligible && (cur.bestMs === null || ms < cur.bestMs);
  const next: DifficultyStats = {
    played: cur.played + 1,
    bestMs: isBest ? ms : cur.bestMs,
    cleanBestMs:
      eligible && mistakes === 0 && (cur.cleanBestMs === null || ms < cur.cleanBestMs) ? ms : cur.cleanBestMs,
  };
  save(KEYS.stats, { ...stats, [difficulty]: next });
  return { bestMs: next.bestMs, isBest, played: next.played };
}

export function bestTimes(): Partial<Record<Difficulty, number | null>> {
  const stats = load<Stats>(KEYS.stats) ?? {};
  const out: Partial<Record<Difficulty, number | null>> = {};
  for (const [k, v] of Object.entries(stats)) out[k as Difficulty] = v?.bestMs ?? null;
  return out;
}
