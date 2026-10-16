import type { Difficulty } from "@/lib/sudoku/core";
import { KEYS, load, save } from "./storage";

type DifficultyStats = {
  played: number;
  bestMs: number | null;
  cleanBestMs: number | null;
  /** スコア制になってからの最高点 */
  bestPoints?: number | null;
};
type Stats = Partial<Record<Difficulty, DifficultyStats>>;

export type FreeClear = {
  bestMs: number | null;
  bestPoints: number | null;
  isBest: boolean;
  played: number;
};

/** フリープレイの自己ベスト（端末内のみ）。ベストは最高点で、ヒントを使ったクリアも点数で比べる */
export function recordFreeClear(
  difficulty: Difficulty,
  ms: number,
  points: number,
  mistakes: number,
  hints: number,
): FreeClear {
  const stats = load<Stats>(KEYS.stats) ?? {};
  const cur = stats[difficulty] ?? { played: 0, bestMs: null, cleanBestMs: null, bestPoints: null };
  const noHints = hints === 0;
  const prevPoints = cur.bestPoints ?? null;
  const isBest = prevPoints === null || points > prevPoints;
  const next: DifficultyStats = {
    played: cur.played + 1,
    bestMs: noHints && (cur.bestMs === null || ms < cur.bestMs) ? ms : cur.bestMs,
    cleanBestMs:
      noHints && mistakes === 0 && (cur.cleanBestMs === null || ms < cur.cleanBestMs) ? ms : cur.cleanBestMs,
    bestPoints: isBest ? points : prevPoints,
  };
  save(KEYS.stats, { ...stats, [difficulty]: next });
  return { bestMs: next.bestMs, bestPoints: next.bestPoints ?? null, isBest, played: next.played };
}

export function bestScores(): Partial<Record<Difficulty, number | null>> {
  const stats = load<Stats>(KEYS.stats) ?? {};
  const out: Partial<Record<Difficulty, number | null>> = {};
  for (const [k, v] of Object.entries(stats)) out[k as Difficulty] = v?.bestPoints ?? null;
  return out;
}

/** 引き継ぎで受け取った記録と合わせる（難易度ごとに良い方を残す） */
export function mergeStats(incoming: unknown) {
  if (!incoming || typeof incoming !== "object") return;
  const cur = load<Stats>(KEYS.stats) ?? {};
  const out: Stats = { ...cur };
  for (const [k, v] of Object.entries(incoming as Stats)) {
    if (!v || typeof v !== "object") continue;
    const a = cur[k as Difficulty];
    const pick = (
      x: number | null | undefined,
      y: number | null | undefined,
      better: (p: number, q: number) => boolean,
    ) => (x == null ? (y ?? null) : y == null ? x : better(x, y) ? x : y);
    out[k as Difficulty] = {
      played: Math.max(a?.played ?? 0, Number(v.played) || 0),
      bestMs: pick(a?.bestMs, v.bestMs, (p, q) => p < q),
      cleanBestMs: pick(a?.cleanBestMs, v.cleanBestMs, (p, q) => p < q),
      bestPoints: pick(a?.bestPoints, v.bestPoints, (p, q) => p > q),
    };
  }
  save(KEYS.stats, out);
}
