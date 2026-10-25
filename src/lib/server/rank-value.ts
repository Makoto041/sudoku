// ランキングの表（Redis のソート済み集合）のキーと並べ順の値。store.ts と scripts/ranking-audit.mjs が使う。
// 型以外は何も読み込まない（scripts/ranking-audit.mjs が Node の型の除去だけで読み込む。拡張子なしの読み込みや @/ は解決できない）
import type { Difficulty } from "@/lib/sudoku/core";

/** 歴代ベストの表のキー（スコア制になってからの表。タイム順だった頃の sdk:best は使わない） */
export const bestsKey = (difficulty: Difficulty) => `sdk:bests:${difficulty}`;

/**
 * 並べ順の値。点数が高いほど、同点ならタイムが速いほど小さくなる（小さいほど上位）。
 * timeMs は 10 億 ms（約 11 日）未満なので、点数と時間を 1 つの数に詰めて元に戻せる
 */
const SCALE = 1e9;
export function rankValue(points: number, timeMs: number): number {
  return Math.min(SCALE - 1, Math.max(0, Math.round(timeMs))) - Math.max(0, Math.round(points)) * SCALE;
}
export function fromRankValue(v: number): { points: number; timeMs: number } {
  const points = Math.max(0, Math.ceil(-v / SCALE));
  return { points, timeMs: v + points * SCALE };
}
