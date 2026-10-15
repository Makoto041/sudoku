import type { Difficulty, Grid } from "./core";
import { gradePuzzle, type LogicLevel } from "./logic";
import { createRng, shuffle } from "./rng";
import { countSolutions, randomSolution } from "./solver";

type Profile = {
  /** これ以下になってから手筋レベルを測る。完成とみなすヒント数の上限 */
  maxGivens: number;
  /** これより減らさない */
  minGivens: number;
  minLevel: LogicLevel;
  maxLevel: LogicLevel;
  /** 範囲に入った後も minGivens まで減らし続ける（いちばん難しい段階用） */
  exhaust?: boolean;
};

/**
 * 難易度ごとのヒント数の範囲と、必要な手筋レベルの範囲（レベルは logic.ts を参照）。
 *  かんたん: シングルだけ / ふつう: ロックドキャンディデートが要る / むずかしい: ペア〜X-Wing
 *  エキスパート: XY-Wing・ソードフィッシュ級 / 鬼: それでも解けず、チェーンや仮定が要る
 */
export const PROFILES: Record<Difficulty, Profile> = {
  easy: { maxGivens: 34, minGivens: 30, minLevel: 1, maxLevel: 1 },
  medium: { maxGivens: 30, minGivens: 26, minLevel: 2, maxLevel: 2 },
  hard: { maxGivens: 28, minGivens: 23, minLevel: 3, maxLevel: 4 },
  expert: { maxGivens: 27, minGivens: 22, minLevel: 5, maxLevel: 5 },
  master: { maxGivens: 28, minGivens: 17, minLevel: 6, maxLevel: 6, exhaust: true },
};

const MAX_ATTEMPTS = 60;

export type Puzzle = {
  seed: string;
  difficulty: Difficulty;
  puzzle: Grid;
  solution: Grid;
  givens: number;
  level: LogicLevel;
};

/**
 * シードから問題を作る。同じ seed と difficulty なら、サーバーでもブラウザでも同じ問題になる。
 * 点対称の 2 マスを組で抜き、解が 1 つに定まり、手筋レベルが難易度の範囲に入るまで減らす。
 * 組で抜くと難しくなりすぎるときは、片方だけ抜いて細かく合わせる。
 */
export function generatePuzzle(seed: string, difficulty: Difficulty): Puzzle {
  const profile = PROFILES[difficulty];
  const inBand = (level: LogicLevel) => level >= profile.minLevel && level <= profile.maxLevel;
  const rng = createRng(`${seed}:${difficulty}`);
  let fallback: Puzzle | null = null;
  let fallbackDistance = Infinity;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const solution = randomSolution(rng);
    const puzzle = solution.slice();
    let givens = 81;
    let level: LogicLevel = 1;

    /** cells を抜いてみて、条件を満たせば抜いたままにする */
    const tryRemove = (cells: number[]): boolean => {
      const saved = cells.map((i) => puzzle[i]);
      for (const i of cells) puzzle[i] = 0;
      let ok = countSolutions(puzzle, 2) === 1;
      let next = level;
      if (ok && givens - cells.length <= profile.maxGivens) {
        next = gradePuzzle(puzzle);
        ok = next <= profile.maxLevel;
      }
      if (!ok) {
        cells.forEach((i, k) => (puzzle[i] = saved[k]));
        return false;
      }
      givens -= cells.length;
      level = next;
      return true;
    };

    // 0〜40 のマスと、その点対称のマス（80 − i）。40 は盤の中央
    for (const i of shuffle(
      Array.from({ length: 41 }, (_, k) => k),
      rng,
    )) {
      if (givens <= profile.minGivens) break;
      if (!profile.exhaust && givens <= profile.maxGivens && inBand(level)) break;
      const j = 80 - i;
      if (i === j || givens - 2 < profile.minGivens) {
        tryRemove([i]);
      } else if (!tryRemove([i, j])) {
        // 組では難しすぎる・解が複数になるときは片方だけ
        if (!tryRemove([i])) tryRemove([j]);
      }
    }
    if (profile.exhaust && inBand(level)) {
      // 鬼：残ったヒントも 1 マスずつ試し、解が 1 つに定まる限り減らす
      for (const i of shuffle(
        puzzle.flatMap((v, k) => (v ? [k] : [])),
        rng,
      )) {
        if (givens <= profile.minGivens) break;
        tryRemove([i]);
      }
    }
    if (givens > profile.maxGivens) level = gradePuzzle(puzzle);
    const result: Puzzle = { seed, difficulty, puzzle, solution, givens, level };
    if (givens <= profile.maxGivens && inBand(level)) return result;
    // 範囲外のときは、難しさの近さを優先して一番近いものを残す
    const levelGap =
      level < profile.minLevel ? profile.minLevel - level : Math.max(0, level - profile.maxLevel);
    const distance = levelGap * 100 + Math.max(0, givens - profile.maxGivens);
    if (distance < fallbackDistance) {
      fallback = result;
      fallbackDistance = distance;
    }
  }
  return fallback!;
}

/** 日付（JST）の YYYY-MM-DD */
export function jstDateKey(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

export function dailySeed(dateKey: string): string {
  return `daily:${dateKey}`;
}

export function generateDaily(dateKey: string, difficulty: Difficulty): Puzzle {
  return generatePuzzle(dailySeed(dateKey), difficulty);
}
