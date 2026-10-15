import { ALL_DIGITS_MASK, bitCount, boxOf, colOf, rowOf, type Grid } from "./core";
import { shuffle, type Rng } from "./rng";

/**
 * 行・列・ブロックごとの使用済みビットを持つバックトラック探索。
 * 候補が最も少ないマスから埋める（MRV）ので、難しい問題でも数ミリ秒で終わる。
 */
class Search {
  private rows = new Int32Array(9);
  private cols = new Int32Array(9);
  private boxes = new Int32Array(9);
  readonly grid: Grid;
  ok = true;

  constructor(grid: readonly number[]) {
    this.grid = grid.slice();
    for (let i = 0; i < 81; i++) {
      const v = this.grid[i];
      if (!v) continue;
      const bit = 1 << v;
      const r = rowOf(i);
      const c = colOf(i);
      const b = boxOf(i);
      if ((this.rows[r] | this.cols[c] | this.boxes[b]) & bit) this.ok = false;
      this.rows[r] |= bit;
      this.cols[c] |= bit;
      this.boxes[b] |= bit;
    }
  }

  private place(i: number, v: number) {
    const bit = 1 << v;
    this.grid[i] = v;
    this.rows[rowOf(i)] |= bit;
    this.cols[colOf(i)] |= bit;
    this.boxes[boxOf(i)] |= bit;
  }

  private unplace(i: number, v: number) {
    const bit = ~(1 << v);
    this.grid[i] = 0;
    this.rows[rowOf(i)] &= bit;
    this.cols[colOf(i)] &= bit;
    this.boxes[boxOf(i)] &= bit;
  }

  /** 次に埋めるマス（候補最少）。空きが無ければ -1、行き詰まりなら -2 */
  private pick(): { index: number; mask: number } {
    let best = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (this.grid[i]) continue;
      const mask = ALL_DIGITS_MASK & ~(this.rows[rowOf(i)] | this.cols[colOf(i)] | this.boxes[boxOf(i)]);
      const n = bitCount(mask);
      if (n === 0) return { index: -2, mask: 0 };
      if (n < bestCount) {
        best = i;
        bestMask = mask;
        bestCount = n;
        if (n === 1) break;
      }
    }
    return { index: best, mask: bestMask };
  }

  /** 解の数を limit まで数える */
  count(limit: number): number {
    const { index, mask } = this.pick();
    if (index === -1) return 1;
    if (index === -2) return 0;
    let total = 0;
    for (let v = 1; v <= 9; v++) {
      if (!(mask & (1 << v))) continue;
      this.place(index, v);
      total += this.count(limit - total);
      this.unplace(index, v);
      if (total >= limit) break;
    }
    return total;
  }

  /** 解を 1 つ見つけて grid に残す。rng があれば候補順をランダムにする */
  fill(rng?: Rng): boolean {
    const { index, mask } = this.pick();
    if (index === -1) return true;
    if (index === -2) return false;
    const digits: number[] = [];
    for (let v = 1; v <= 9; v++) if (mask & (1 << v)) digits.push(v);
    for (const v of rng ? shuffle(digits, rng) : digits) {
      this.place(index, v);
      if (this.fill(rng)) return true;
      this.unplace(index, v);
    }
    return false;
  }
}

/** 解の個数（limit で打ち切り）。矛盾した盤面は 0 */
export function countSolutions(grid: readonly number[], limit = 2): number {
  const s = new Search(grid);
  if (!s.ok) return 0;
  return s.count(limit);
}

export function solve(grid: readonly number[]): Grid | null {
  const s = new Search(grid);
  if (!s.ok || !s.fill()) return null;
  return s.grid;
}

/** 乱数で完成盤面を 1 つ作る */
export function randomSolution(rng: Rng): Grid {
  const s = new Search(Array(81).fill(0));
  s.fill(rng);
  return s.grid;
}
