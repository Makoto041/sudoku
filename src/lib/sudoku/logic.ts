import {
  ALL_DIGITS_MASK,
  PEERS,
  UNITS,
  bitCount,
  colOf,
  digitsOf,
  lowestDigit,
  rowOf,
  type Grid,
} from "./core";

/**
 * 人が解くときの手筋で解けるかを調べ、必要だった最も難しい手筋のレベルを返す。
 *  1: ネイキッド／ヒドゥンシングル
 *  2: ロックドキャンディデート（ポインティング／クレーミング）
 *  3: ネイキッドペア・トリプル、ヒドゥンペア
 *  4: X-Wing、ヒドゥントリプル、ネイキッドクアッド
 *  5: XY-Wing、XYZ-Wing、ソードフィッシュ
 *  6: 上の手筋だけでは解けない（チェーンや仮定が要る）
 */
export type LogicLevel = 1 | 2 | 3 | 4 | 5 | 6;

type State = { grid: Grid; cands: number[] };

const IS_PEER: boolean[][] = Array.from({ length: 81 }, (_, i) => {
  const row = Array<boolean>(81).fill(false);
  for (const p of PEERS[i]) row[p] = true;
  return row;
});

/** どの手筋が、どのマスを根拠に進んだか（ヒントの説明用） */
export type TechniqueId =
  | "naked-single"
  | "hidden-single"
  | "pointing"
  | "claiming"
  | "naked-pair"
  | "naked-triple"
  | "naked-quad"
  | "hidden-pair"
  | "hidden-triple"
  | "x-wing"
  | "swordfish"
  | "xy-wing"
  | "xyz-wing";

export type Trace = {
  technique: TechniqueId;
  /** 根拠になるマス */
  pattern: number[];
  digits: number[];
  /** 関係するユニット（UNITS の番号）。ロックドキャンディデートは [元, 消す先] */
  units: number[];
};

let tracer: ((t: Trace) => void) | null = null;
const note = (t: Trace) => tracer?.(t);

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

function singles(s: State): boolean {
  for (let i = 0; i < 81; i++) {
    if (!s.grid[i] && bitCount(s.cands[i]) === 1) {
      note({ technique: "naked-single", pattern: [i], digits: [lowestDigit(s.cands[i])], units: [] });
      assign(s, i, lowestDigit(s.cands[i]));
      return true;
    }
  }
  for (let u = 0; u < 27; u++) {
    const unit = UNITS[u];
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
        note({ technique: "hidden-single", pattern: [spot], digits: [d], units: [u] });
        assign(s, spot, d);
        return true;
      }
    }
  }
  return false;
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
          if (eliminate(s, others, bit)) {
            note({ technique: "pointing", pattern: spots, digits: [d], units: [u, r] });
            return true;
          }
        }
        const c = colOf(spots[0]);
        if (spots.every((i) => colOf(i) === c)) {
          const others = UNITS[9 + c].filter((i) => !unit.includes(i));
          if (eliminate(s, others, bit)) {
            note({ technique: "pointing", pattern: spots, digits: [d], units: [u, 9 + c] });
            return true;
          }
        }
      } else {
        // クレーミング：行（列）内の候補が 1 ブロックに収まれば、そのブロックの他から消す
        const b = 18 + Math.floor(rowOf(spots[0]) / 3) * 3 + Math.floor(colOf(spots[0]) / 3);
        if (spots.every((i) => UNITS[b].includes(i))) {
          const others = UNITS[b].filter((i) => !unit.includes(i));
          if (eliminate(s, others, bit)) {
            note({ technique: "claiming", pattern: spots, digits: [d], units: [u, b] });
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** ネイキッドサブセット：size 個のマスの候補の和が size 個なら、ユニットの他のマスから消す */
const NAKED: Record<number, TechniqueId> = { 2: "naked-pair", 3: "naked-triple", 4: "naked-quad" };
const HIDDEN: Record<number, TechniqueId> = { 2: "hidden-pair", 3: "hidden-triple" };

function nakedSubset(s: State, size: number): boolean {
  for (let u = 0; u < 27; u++) {
    const unit = UNITS[u];
    const open = unit.filter((i) => !s.grid[i]);
    if (open.length <= size) continue;
    const pool = open.filter((i) => bitCount(s.cands[i]) <= size);
    for (const combo of combinations(pool, size)) {
      let mask = 0;
      for (const i of combo) mask |= s.cands[i];
      if (bitCount(mask) !== size) continue;
      if (
        eliminate(
          s,
          open.filter((i) => !combo.includes(i)),
          mask,
        )
      ) {
        note({ technique: NAKED[size], pattern: combo, digits: digitsOf(mask), units: [u] });
        return true;
      }
    }
  }
  return false;
}

/** ヒドゥンサブセット：size 個の数字の置き場所が size 個のマスに限られるなら、そのマスの他の候補を消す */
function hiddenSubset(s: State, size: number): boolean {
  for (let u = 0; u < 27; u++) {
    const unit = UNITS[u];
    const places = new Map<number, number[]>();
    for (let d = 1; d <= 9; d++) {
      const spots = unit.filter((i) => s.cands[i] & (1 << d));
      if (spots.length >= 2 && spots.length <= size) places.set(d, spots);
    }
    for (const digits of combinations([...places.keys()], size)) {
      const cells = new Set<number>();
      for (const d of digits) for (const i of places.get(d)!) cells.add(i);
      if (cells.size !== size) continue;
      let keep = 0;
      for (const d of digits) keep |= 1 << d;
      let changed = false;
      for (const i of cells) {
        if (s.cands[i] & ~keep) {
          s.cands[i] &= keep;
          changed = true;
        }
      }
      if (changed) {
        note({ technique: HIDDEN[size], pattern: [...cells], digits, units: [u] });
        return true;
      }
    }
  }
  return false;
}

/** フィッシュ（size=2 で X-Wing、3 でソードフィッシュ） */
function fish(s: State, size: number): boolean {
  for (const byRow of [true, false]) {
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << d;
      const lines: { line: number; cross: number[] }[] = [];
      for (let k = 0; k < 9; k++) {
        const cross = UNITS[byRow ? k : 9 + k]
          .filter((i) => s.cands[i] & bit)
          .map((i) => (byRow ? colOf(i) : rowOf(i)));
        if (cross.length >= 2 && cross.length <= size) lines.push({ line: k, cross });
      }
      for (const combo of combinations(lines, size)) {
        const crosses = new Set<number>();
        for (const l of combo) for (const c of l.cross) crosses.add(c);
        if (crosses.size !== size) continue;
        const base = new Set(combo.map((l) => l.line));
        const others: number[] = [];
        for (const cross of crosses) {
          for (const i of UNITS[byRow ? 9 + cross : cross]) {
            if (!base.has(byRow ? rowOf(i) : colOf(i))) others.push(i);
          }
        }
        if (eliminate(s, others, bit)) {
          const baseUnits = combo.map((l) => (byRow ? l.line : 9 + l.line));
          note({
            technique: size === 2 ? "x-wing" : "swordfish",
            pattern: baseUnits.flatMap((bu) => UNITS[bu].filter((i) => s.cands[i] & bit)),
            digits: [d],
            units: [...baseUnits, ...[...crosses].map((c) => (byRow ? 9 + c : c))],
          });
          return true;
        }
      }
    }
  }
  return false;
}

/** XY-Wing：候補 {x,y} の軸から見える {x,z} と {y,z} の 2 マスに共通して見えるマスから z を消す */
function xyWing(s: State): boolean {
  const bivalue = [];
  for (let i = 0; i < 81; i++) if (!s.grid[i] && bitCount(s.cands[i]) === 2) bivalue.push(i);
  for (const pivot of bivalue) {
    const [x, y] = digitsOf(s.cands[pivot]);
    const wings = bivalue.filter((i) => i !== pivot && IS_PEER[pivot][i]);
    for (const a of wings) {
      const ca = s.cands[a];
      if ((ca & (1 << x)) === 0 || ca & (1 << y)) continue;
      const z = lowestDigit(ca & ~(1 << x));
      for (const b of wings) {
        if (b === a || s.cands[b] !== ((1 << y) | (1 << z))) continue;
        const targets = [];
        for (let i = 0; i < 81; i++) {
          if (i !== pivot && i !== a && i !== b && IS_PEER[a][i] && IS_PEER[b][i]) targets.push(i);
        }
        if (eliminate(s, targets, 1 << z)) {
          note({ technique: "xy-wing", pattern: [pivot, a, b], digits: [z], units: [] });
          return true;
        }
      }
    }
  }
  return false;
}

/** XYZ-Wing：候補 {x,y,z} の軸と、軸から見える {x,z}・{y,z} の 3 マスすべてから見えるマスから z を消す */
function xyzWing(s: State): boolean {
  for (let pivot = 0; pivot < 81; pivot++) {
    if (s.grid[pivot] || bitCount(s.cands[pivot]) !== 3) continue;
    const pc = s.cands[pivot];
    const wings = PEERS[pivot].filter(
      (i) => !s.grid[i] && bitCount(s.cands[i]) === 2 && (s.cands[i] & pc) === s.cands[i],
    );
    for (const [a, b] of combinations(wings, 2)) {
      if ((s.cands[a] | s.cands[b]) !== pc) continue;
      const shared = s.cands[a] & s.cands[b];
      if (bitCount(shared) !== 1) continue;
      const targets = [];
      for (let i = 0; i < 81; i++) {
        if (i === pivot || i === a || i === b) continue;
        if (IS_PEER[pivot][i] && IS_PEER[a][i] && IS_PEER[b][i]) targets.push(i);
      }
      if (eliminate(s, targets, shared)) {
        note({ technique: "xyz-wing", pattern: [pivot, a, b], digits: [lowestDigit(shared)], units: [] });
        return true;
      }
    }
  }
  return false;
}

const TECHNIQUES: [LogicLevel, (s: State) => boolean][] = [
  [1, singles],
  [2, lockedCandidates],
  [3, (s) => nakedSubset(s, 2) || hiddenSubset(s, 2) || nakedSubset(s, 3)],
  [4, (s) => fish(s, 2) || hiddenSubset(s, 3) || nakedSubset(s, 4)],
  [5, (s) => xyWing(s) || xyzWing(s) || fish(s, 3)],
];

/** 手筋だけで解き進め、行き詰まった時点の盤面と候補、必要だったレベルを返す */
export function solveLogically(puzzle: readonly number[]): State & { level: LogicLevel } {
  const s = init(puzzle);
  let hardest: LogicLevel = 1;
  for (;;) {
    if (s.grid.every((v) => v !== 0)) return { ...s, level: hardest };
    let progressed = false;
    for (const [level, technique] of TECHNIQUES) {
      if (technique(s)) {
        if (level > hardest) hardest = level;
        progressed = true;
        break;
      }
    }
    if (!progressed) return { ...s, level: 6 };
  }
}

/** 必要な手筋レベルを返す（易しい手筋から順に試し、進んだら最初に戻る） */
export function gradePuzzle(puzzle: readonly number[]): LogicLevel {
  return solveLogically(puzzle).level;
}

/**
 * 仮定の手数。シングルとロックドキャンディデートで進められるところまで進め、
 * 詰まったら候補の最も少ないマスで候補を 1 つずつ仮定して試す。
 * 解が 1 つであることまで確かめる探索全体で、仮定した回数（nodes）と最も深い仮定の重なり（depth）を数える。
 * 手筋では解けない問題どうしの難しさを比べるのに使う
 */
export function searchEffort(puzzle: readonly number[], limit = 200_000): { nodes: number; depth: number } {
  let nodes = 0;
  let deepest = 0;

  const propagate = (s: State): boolean => {
    for (;;) {
      let changed = false;
      for (let i = 0; i < 81; i++) {
        if (s.grid[i]) continue;
        const n = bitCount(s.cands[i]);
        if (n === 0) return false;
        if (n === 1) {
          const v = lowestDigit(s.cands[i]);
          if (PEERS[i].some((p) => s.grid[p] === v)) return false;
          assign(s, i, v);
          changed = true;
        }
      }
      for (const unit of UNITS) {
        for (let d = 1; d <= 9; d++) {
          const bit = 1 << d;
          if (unit.some((i) => s.grid[i] === d)) continue;
          const spots = unit.filter((i) => s.cands[i] & bit);
          if (spots.length === 0) return false;
          if (spots.length === 1) {
            assign(s, spots[0], d);
            changed = true;
          }
        }
      }
      if (!changed && !lockedCandidates(s)) return true;
    }
  };

  const search = (s: State, depth: number): number => {
    if (nodes >= limit) return 0;
    if (!propagate(s)) return 0;
    let best = -1;
    let bestN = 10;
    for (let i = 0; i < 81; i++) {
      if (s.grid[i]) continue;
      const n = bitCount(s.cands[i]);
      if (n < bestN) {
        best = i;
        bestN = n;
      }
    }
    if (best === -1) return 1;
    let found = 0;
    for (const v of digitsOf(s.cands[best])) {
      nodes++;
      deepest = Math.max(deepest, depth + 1);
      const child: State = { grid: s.grid.slice(), cands: s.cands.slice() };
      assign(child, best, v);
      found += search(child, depth + 1);
    }
    return found;
  };

  search(init(puzzle), 0);
  return { nodes, depth: deepest };
}

/** ヒントで試す順番（易しい手筋から） */
const STEPS: ((s: State) => boolean)[] = [
  singles,
  lockedCandidates,
  (s) => nakedSubset(s, 2),
  (s) => hiddenSubset(s, 2),
  (s) => nakedSubset(s, 3),
  (s) => fish(s, 2),
  (s) => hiddenSubset(s, 3),
  (s) => nakedSubset(s, 4),
  xyWing,
  xyzWing,
  (s) => fish(s, 3),
];

export type NextStep = {
  trace: Trace;
  /** 置けるマス */
  placement: { cell: number; digit: number } | null;
  /** 消せる候補 */
  eliminations: { cell: number; digit: number }[];
};

/**
 * 盤面（数字と候補）から、次に使える手筋を 1 つ見つける。盤面は変えない。
 * 手筋で進めなければ null（チェーンや仮定が要る局面）
 */
export function findNextStep(grid: readonly number[], cands: readonly number[]): NextStep | null {
  for (const step of STEPS) {
    const s: State = { grid: grid.slice(), cands: cands.slice() };
    let trace: Trace | null = null;
    tracer = (t) => {
      if (!trace) trace = t;
    };
    let progressed = false;
    try {
      progressed = step(s);
    } finally {
      tracer = null;
    }
    if (!progressed || !trace) continue;
    const t: Trace = trace;
    let placement: NextStep["placement"] = null;
    const eliminations: NextStep["eliminations"] = [];
    for (let i = 0; i < 81; i++) {
      if (!grid[i] && s.grid[i]) placement = { cell: i, digit: s.grid[i] };
      if (!s.grid[i]) {
        const gone = cands[i] & ~s.cands[i];
        for (const d of digitsOf(gone)) eliminations.push({ cell: i, digit: d });
      }
    }
    return { trace: t, placement, eliminations };
  }
  return null;
}

/** 盤面の数字から、空いているマスの候補を計算する */
export function candidatesOf(grid: readonly number[]): number[] {
  return init(grid).cands;
}
