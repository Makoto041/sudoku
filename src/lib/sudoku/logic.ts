import { ALL_DIGITS_MASK, PEERS, UNITS, bitCount, boxOf, colOf, lowestDigit, rowOf, type Grid } from "./core";

/**
 * 人が解くときの手筋で解けるかを調べ、必要だった最も難しい手筋のレベルを返す。
 *  1: ネイキッド／ヒドゥンシングル
 *  2: ロックドキャンディデート（ポインティング／クレーミング）
 *  3: ネイキッド／ヒドゥンペア、ネイキッドトリプル
 *  4: X-Wing
 *  5: 上の手筋だけでは解けない（より高度な手筋か試行錯誤が要る）
 */
export type LogicLevel = 1 | 2 | 3 | 4 | 5;

type State = { grid: Grid; cands: number[] };

function init(puzzle: readonly number[]): State {
  const grid = puzzle.slice();
  const cands = Array<number>(81).fill(0);
  for (let i = 0; i < 81; i++) {
    if (grid[i]) continue;
    let used = 0;
    for (const p of PEERS[i]) used |= 1 << grid[p];
    cands[i] = ALL_DIGITS_MASK & ~used;
  }
  return { grid, cands };
}

function assign(s: State, i: number, v: number) {
  s.grid[i] = v;
  s.cands[i] = 0;
  const bit = ~(1 << v);
  for (const p of PEERS[i]) s.cands[p] &= bit;
}

function singles(s: State): boolean {
  for (let i = 0; i < 81; i++) {
    if (!s.grid[i] && bitCount(s.cands[i]) === 1) {
      assign(s, i, lowestDigit(s.cands[i]));
      return true;
    }
  }
  for (const unit of UNITS) {
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << d;
      let spot = -1;
      let n = 0;
      for (const i of unit) {
        if (s.cands[i] & bit) {
          spot = i;
          n++;
        }
      }
      if (n === 1) {
        assign(s, spot, d);
        return true;
      }
    }
  }
  return false;
}

function eliminate(s: State, cells: Iterable<number>, mask: number): boolean {
  let changed = false;
  for (const i of cells) {
    if (s.cands[i] & mask) {
      s.cands[i] &= ~mask;
      changed = true;
    }
  }
  return changed;
}

function lockedCandidates(s: State): boolean {
  for (let u = 0; u < 27; u++) {
    const unit = UNITS[u];
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << d;
      const spots = unit.filter((i) => s.cands[i] & bit);
      if (spots.length < 2) continue;
      if (u >= 18) {
        // ポインティング：ブロック内の候補が 1 行（1 列）に揃っていれば、その行（列）の他から消す
        const r = rowOf(spots[0]);
        if (spots.every((i) => rowOf(i) === r)) {
          const others = UNITS[r].filter((i) => !unit.includes(i));
          if (eliminate(s, others, bit)) return true;
        }
        const c = colOf(spots[0]);
        if (spots.every((i) => colOf(i) === c)) {
          const others = UNITS[9 + c].filter((i) => !unit.includes(i));
          if (eliminate(s, others, bit)) return true;
        }
      } else {
        // クレーミング：行（列）内の候補が 1 ブロックに収まれば、そのブロックの他から消す
        const b = boxOf(spots[0]);
        if (spots.every((i) => boxOf(i) === b)) {
          const others = UNITS[18 + b].filter((i) => !unit.includes(i));
          if (eliminate(s, others, bit)) return true;
        }
      }
    }
  }
  return false;
}

function subsets(s: State): boolean {
  for (const unit of UNITS) {
    const open = unit.filter((i) => !s.grid[i]);
    // ネイキッドペア／トリプル
    for (const size of [2, 3]) {
      const pool = open.filter((i) => bitCount(s.cands[i]) <= size);
      for (const combo of combinations(pool, size)) {
        let mask = 0;
        for (const i of combo) mask |= s.cands[i];
        if (bitCount(mask) !== size) continue;
        const others = open.filter((i) => !combo.includes(i));
        if (eliminate(s, others, mask)) return true;
      }
    }
    // ヒドゥンペア
    const places: number[][] = Array.from({ length: 10 }, () => []);
    for (const i of open) for (let d = 1; d <= 9; d++) if (s.cands[i] & (1 << d)) places[d].push(i);
    for (let a = 1; a <= 9; a++) {
      if (places[a].length !== 2) continue;
      for (let b = a + 1; b <= 9; b++) {
        if (places[b].length !== 2) continue;
        if (places[a][0] !== places[b][0] || places[a][1] !== places[b][1]) continue;
        const keep = (1 << a) | (1 << b);
        let changed = false;
        for (const i of places[a]) {
          if (s.cands[i] & ~keep) {
            s.cands[i] &= keep;
            changed = true;
          }
        }
        if (changed) return true;
      }
    }
  }
  return false;
}

function xWing(s: State): boolean {
  for (const byRow of [true, false]) {
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << d;
      const lines: number[][] = [];
      for (let k = 0; k < 9; k++) {
        const unit = UNITS[byRow ? k : 9 + k];
        lines.push(unit.filter((i) => s.cands[i] & bit).map((i) => (byRow ? colOf(i) : rowOf(i))));
      }
      for (let a = 0; a < 9; a++) {
        if (lines[a].length !== 2) continue;
        for (let b = a + 1; b < 9; b++) {
          if (lines[b].length !== 2) continue;
          if (lines[a][0] !== lines[b][0] || lines[a][1] !== lines[b][1]) continue;
          const others: number[] = [];
          for (const cross of lines[a]) {
            for (const i of UNITS[byRow ? 9 + cross : cross]) {
              const line = byRow ? rowOf(i) : colOf(i);
              if (line !== a && line !== b) others.push(i);
            }
          }
          if (eliminate(s, others, bit)) return true;
        }
      }
    }
  }
  return false;
}

function* combinations<T>(items: T[], size: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === size) {
    yield acc.slice();
    return;
  }
  for (let i = start; i < items.length; i++) {
    acc.push(items[i]);
    yield* combinations(items, size, i + 1, acc);
    acc.pop();
  }
}

const TECHNIQUES: [LogicLevel, (s: State) => boolean][] = [
  [1, singles],
  [2, lockedCandidates],
  [3, subsets],
  [4, xWing],
];

/** 必要な手筋レベルを返す（易しい手筋から順に試し、進んだら最初に戻る） */
export function gradePuzzle(puzzle: readonly number[]): LogicLevel {
  const s = init(puzzle);
  let hardest: LogicLevel = 1;
  for (;;) {
    if (s.grid.every((v) => v !== 0)) return hardest;
    let progressed = false;
    for (const [level, technique] of TECHNIQUES) {
      if (technique(s)) {
        if (level > hardest) hardest = level;
        progressed = true;
        break;
      }
    }
    if (!progressed) return 5;
  }
}
