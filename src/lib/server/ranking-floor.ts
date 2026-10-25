// 今日の一問で記録できる最短の時間（下限）。人が物理的に出せない速さの送信だけを弾く。
// 正当な最速の人を弾かないことを最優先にし、どの値も控えめ（短め）にしてある。根拠は README の「今日の一問の下限」。
// 型以外は何も読み込まない（scripts/ranking-audit.mjs が Node の型の除去だけで読み込む。拡張子なしの読み込みや @/ は解決できない）
import type { Difficulty } from "@/lib/sudoku/core";

/**
 * 空きマス 1 つに要る最短の時間。数字を置くにはマスを選ぶ・数字を押すの 2 回の操作が要り、狙った場所を押す操作は
 * 速い人でも 1 回 0.2 秒ほどかかる（目安。測ったものではない）。考える時間を 0 とし、2 回の操作で 0.25 秒とした
 */
export const MIN_MS_PER_CELL = 250;

/**
 * 手の記録 1 件に要る最短の時間。同じマスで数字を打ち直すとマスを選び直さずに 1 件増えるので、1 マスよりずっと短くする。
 * 数字のキーを押しっぱなしにすると、同じ数字で置く・消すを繰り返す（置く手は 2 回に 1 回）ので、OS のキーリピートの
 * 速い設定（1 秒に 30 回ほど。目安で、OS の隠れた設定ではもっと速くできる）でも 1 件に 66 ms ほどかかる
 */
export const MIN_MS_PER_MOVE = 50;

/**
 * 難易度ごとの固定の下限。手筋の要る難易度ほど、見つけるのに時間がかかる。かんたんは以前の一律の下限と同じ 15 秒。
 * 今の生成の範囲（空きマスは最大 64）では、空きマス × MIN_MS_PER_CELL（最大 16 秒）はこれを超えないので、
 * 実際に効くのはこの値（と手の記録の件数）。空きマスの項は、生成を変えて空きマスが増えたときの歯止め
 */
export const DIFFICULTY_FLOOR_MS: Record<Difficulty, number> = {
  easy: 15_000,
  medium: 20_000,
  hard: 30_000,
  expert: 40_000,
  master: 45_000,
  extreme: 45_000,
};

/** 記録できる最短の時間。難易度ごとの下限・空きマス数・手の記録の件数のそれぞれから決まる時間の、いちばん長いもの */
export function minPlausibleMs(difficulty: Difficulty, empties: number, moves: number): number {
  return Math.max(DIFFICULTY_FLOOR_MS[difficulty], empties * MIN_MS_PER_CELL, moves * MIN_MS_PER_MOVE);
}

/**
 * 歴代ベストの表の行が、今の下限を下回るか（点検用）。行には盤面も手の記録も無いので、その難易度のどの盤面でも
 * 下回る時間（難易度ごとの固定の下限より短い）だけを下回るとする（正当な行を下回るとしない）
 */
export function isBelowBestFloor(difficulty: Difficulty, timeMs: number): boolean {
  return timeMs < DIFFICULTY_FLOOR_MS[difficulty];
}
