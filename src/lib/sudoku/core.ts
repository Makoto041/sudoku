/** 盤面は長さ 81 の配列。0 は空きマス、1〜9 は数字 */
export type Grid = number[];

export const DIFFICULTIES = ["easy", "medium", "hard", "expert", "master"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "かんたん",
  medium: "ふつう",
  hard: "むずかしい",
  expert: "エキスパート",
  master: "鬼",
};

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" && (DIFFICULTIES as readonly string[]).includes(value);
}

export const rowOf = (i: number) => Math.floor(i / 9);
export const colOf = (i: number) => i % 9;
export const boxOf = (i: number) => Math.floor(rowOf(i) / 3) * 3 + Math.floor(colOf(i) / 3);

/** 27 個のユニット（行 9・列 9・ブロック 9）。各要素はマスの index */
export const UNITS: number[][] = (() => {
  const units: number[][] = [];
  for (let r = 0; r < 9; r++) units.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
  for (let c = 0; c < 9; c++) units.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
  for (let b = 0; b < 9; b++) {
    const r0 = Math.floor(b / 3) * 3;
    const c0 = (b % 3) * 3;
    const unit: number[] = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) unit.push((r0 + r) * 9 + c0 + c);
    units.push(unit);
  }
  return units;
})();

/** 各マスが属する 3 ユニット（行・列・ブロック）の番号 */
export const UNITS_OF: number[][] = Array.from({ length: 81 }, (_, i) => [
  rowOf(i),
  9 + colOf(i),
  18 + boxOf(i),
]);

/** 各マスと同じ行・列・ブロックにある他の 20 マス */
export const PEERS: number[][] = Array.from({ length: 81 }, (_, i) => {
  const set = new Set<number>();
  for (const u of UNITS_OF[i]) for (const j of UNITS[u]) if (j !== i) set.add(j);
  return [...set];
});

export const ALL_DIGITS_MASK = 0x3fe; // bit1〜bit9

export function bitCount(mask: number): number {
  let n = 0;
  while (mask) {
    mask &= mask - 1;
    n++;
  }
  return n;
}

/** 立っている最下位ビットの数字（mask が 1 ビットのときの数字取り出しに使う） */
export function lowestDigit(mask: number): number {
  return 31 - Math.clz32(mask & -mask);
}

export function digitsOf(mask: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= 9; d++) if (mask & (1 << d)) out.push(d);
  return out;
}

export function parseGrid(text: string): Grid {
  if (!/^[0-9.]{81}$/.test(text)) throw new Error("invalid grid string");
  return [...text].map((ch) => (ch === "." ? 0 : Number(ch)));
}

export function serializeGrid(grid: readonly number[]): string {
  return grid.join("");
}

/** マス i に置ける候補（同じ行・列・ブロックに無い数字）のビットマスク */
export function candidatesAt(grid: readonly number[], i: number): number {
  if (grid[i]) return 0;
  let used = 0;
  for (const p of PEERS[i]) used |= 1 << grid[p];
  return ALL_DIGITS_MASK & ~used;
}

/** 同じ行・列・ブロックに同じ数字があるマスの集合 */
export function findConflicts(grid: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (const unit of UNITS) {
    const seen = new Map<number, number>();
    for (const i of unit) {
      const v = grid[i];
      if (!v) continue;
      const prev = seen.get(v);
      if (prev !== undefined) {
        out.add(prev);
        out.add(i);
      } else {
        seen.set(v, i);
      }
    }
  }
  return out;
}

/** solution が問題 puzzle の正しい完成形か（ヒントを保ち、全ユニットが 1〜9 を 1 回ずつ含む） */
export function isValidSolution(puzzle: readonly number[], solution: readonly number[]): boolean {
  if (puzzle.length !== 81 || solution.length !== 81) return false;
  for (let i = 0; i < 81; i++) {
    const v = solution[i];
    if (!Number.isInteger(v) || v < 1 || v > 9) return false;
    if (puzzle[i] && puzzle[i] !== v) return false;
  }
  for (const unit of UNITS) {
    let mask = 0;
    for (const i of unit) mask |= 1 << solution[i];
    if (mask !== ALL_DIGITS_MASK) return false;
  }
  return true;
}

/** 数字 d がまだ盤面に何個置けるか（9 − 置かれている数） */
export function remainingCounts(grid: readonly number[]): number[] {
  const counts = Array(10).fill(9);
  for (const v of grid) if (v) counts[v]--;
  return counts;
}
