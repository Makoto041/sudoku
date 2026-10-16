import { UNITS, UNITS_OF, type Difficulty, type Grid } from "@/lib/sudoku/core";

/**
 * スコアの計算。ブラウザ（遊んでいる間の表示）とサーバー（ランキングの記録）で同じものを使う。
 *
 * - 正しい数字を置くと、難易度の基本点 × コンボの倍率
 *   - コンボ：続けて正解するたびに +5%（最大 +50%）。間違えると切れる
 * - 行・列・ブロックのすべてのマスで得点したとき、そのユニットごとに基本点 × 3
 * - 間違えると基本点ぶん減点（0 より下がらない）
 * - 同じマスで得点するのは 1 回だけ（消して置き直しても増えない）
 * - ヒントで埋めたマスは 0 点で、コンボが切れる
 * - 解き終えたら時間ボーナス：基本点 × 空きマス数 × 2 × (1 − 経過時間 ÷ 基準時間)。基準時間を過ぎたら 0
 *
 * 速さは「解き終えるまでの時間」だけで測る。手と手の間隔で測ると、メモで解いておいて最後に
 * まとめて置くだけで点が増え（鬼で 1.5 倍）、日次では端末が送る手の時刻も書き換えられてしまう。
 * 解き終えるまでの時間は、日次ならサーバーが測る
 */
export const BASE_POINTS: Record<Difficulty, number> = {
  easy: 50,
  medium: 75,
  hard: 100,
  expert: 150,
  master: 200,
  extreme: 300,
};

/** 時間ボーナスが 0 になる時間 */
export const PAR_MS: Record<Difficulty, number> = {
  easy: 10 * 60_000,
  medium: 15 * 60_000,
  hard: 25 * 60_000,
  expert: 40 * 60_000,
  master: 60 * 60_000,
  extreme: 120 * 60_000,
};
const TIME_BONUS_FACTOR = 2;
/** 記録の時刻が実際の経過時間をこれ以上超えていたら、その手は数えない（時計のずれの許容） */
const LATE_TOLERANCE_MS = 5_000;
const COMBO_STEP = 0.05;
const COMBO_MAX_STEPS = 10;
const UNIT_BONUS = 3;

export type ScoreState = {
  points: number;
  /** 続けて正解した回数 */
  streak: number;
  /** 最後に得点した時刻（開始からの ms） */
  lastAt: number;
  /** マスごとに得点済みか（ヒントのマスも 1）。81 文字の "0"/"1" */
  scored: string;
  /** ボーナスを付けたユニット（UNITS の番号のビット） */
  units: number;
  /** 解き終えたときに足した時間ボーナス（points に含む） */
  timeBonus?: number;
};

export type ScoreDelta =
  | { kind: "correct"; points: number; bonus: number; units: number[] }
  | { kind: "repeat"; points: 0; bonus: 0; units: [] }
  | { kind: "wrong"; points: number; bonus: 0; units: [] }
  | { kind: "hint"; points: 0; bonus: number; units: number[] };

export function emptyScore(puzzle: readonly number[]): ScoreState {
  return {
    points: 0,
    streak: 0,
    lastAt: 0,
    scored: puzzle.map((v) => (v ? "1" : "0")).join(""),
    units: 0,
  };
}

const roundTo5 = (n: number) => Math.round(n / 5) * 5;

/** 解き終えたときの時間ボーナス */
export function timeBonus(difficulty: Difficulty, puzzle: readonly number[], elapsedMs: number): number {
  const empties = puzzle.filter((v) => !v).length;
  const left = Math.min(1, Math.max(0, 1 - elapsedMs / PAR_MS[difficulty]));
  return roundTo5(BASE_POINTS[difficulty] * empties * TIME_BONUS_FACTOR * left);
}

export function comboMultiplier(streak: number): number {
  return 1 + Math.min(Math.max(0, streak - 1), COMBO_MAX_STEPS) * COMBO_STEP;
}

/** このマスを埋めたことで、すべてのマスで得点済みになったユニット（まだボーナスを付けていないもの） */
function newlyCompletedUnits(scored: string, units: number, cell: number): number[] {
  const out: number[] = [];
  for (const u of UNITS_OF[cell]) {
    if (units & (1 << u)) continue;
    if (UNITS[u].every((i) => scored[i] === "1")) out.push(u);
  }
  return out;
}

function markScored(scored: string, cell: number): string {
  return scored.slice(0, cell) + "1" + scored.slice(cell + 1);
}

/**
 * 1 手ぶんの得点を計算する。
 * t は開始からの経過 ms（日次はサーバーの開始時刻から、フリープレイは一時停止を除いた時間）
 */
export function applyPlacement(
  st: ScoreState,
  move: { cell: number; digit: number; t: number; viaHint?: boolean },
  solution: Grid,
  difficulty: Difficulty,
): [ScoreState, ScoreDelta] {
  const base = BASE_POINTS[difficulty];
  const { cell, digit, t } = move;
  const correct = solution[cell] === digit;

  if (move.viaHint) {
    if (st.scored[cell] === "1")
      return [
        { ...st, streak: 0, lastAt: t },
        { kind: "hint", points: 0, bonus: 0, units: [] },
      ];
    const scored = markScored(st.scored, cell);
    const done = newlyCompletedUnits(scored, st.units, cell);
    const unitsMask = done.reduce((m, u) => m | (1 << u), st.units);
    const bonus = done.length * base * UNIT_BONUS;
    return [
      { points: st.points + bonus, streak: 0, lastAt: t, scored, units: unitsMask },
      { kind: "hint", points: 0, bonus, units: done },
    ];
  }

  if (!correct) {
    const penalty = Math.min(base, st.points);
    return [
      { ...st, points: st.points - penalty, streak: 0 },
      { kind: "wrong", points: penalty ? -penalty : 0, bonus: 0, units: [] },
    ];
  }

  if (st.scored[cell] === "1") return [st, { kind: "repeat", points: 0, bonus: 0, units: [] }];

  const streak = st.streak + 1;
  const points = roundTo5(base * comboMultiplier(streak));
  const scored = markScored(st.scored, cell);
  const done = newlyCompletedUnits(scored, st.units, cell);
  const unitsMask = done.reduce((m, u) => m | (1 << u), st.units);
  const bonus = done.length * base * UNIT_BONUS;
  return [
    { points: st.points + points + bonus, streak, lastAt: t, scored, units: unitsMask },
    { kind: "correct", points, bonus, units: done },
  ];
}

/** 置いた手の記録 [開始からの ms, マス, 数字] */
export type MoveLog = [number, number, number][];

/**
 * 記録からスコアを計算し直す（サーバー用）。
 * 時刻順に並べ直してから計算する。実際の経過時間（limitMs）を大きく超えた時刻の手は数えない。
 * ヒントの記録は受け付けない
 */
export function scoreMoves(
  puzzle: Grid,
  solution: Grid,
  difficulty: Difficulty,
  moves: MoveLog,
  limitMs: number,
): ScoreState {
  const sorted = moves
    .filter(([t]) => t <= limitMs + LATE_TOLERANCE_MS)
    .map(([t, cell, digit], k) => ({ t: Math.max(0, t), cell, digit, k }))
    .sort((a, b) => a.t - b.t || a.k - b.k);
  let st = emptyScore(puzzle);
  for (const m of sorted) {
    if (puzzle[m.cell]) continue;
    [st] = applyPlacement(st, m, solution, difficulty);
  }
  return st;
}

export function formatPoints(n: number): string {
  return n.toLocaleString("ja-JP");
}
