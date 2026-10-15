import type { Difficulty, Grid } from "./core";
import { gradePuzzle, type LogicLevel } from "./logic";
import { createRng, shuffle } from "./rng";
import { countSolutions, randomSolution } from "./solver";

type Profile = {
  maxGivens: number;
  minGivens: number;
  minLevel: LogicLevel;
  maxLevel: LogicLevel;
  /** 前半の試行ではこのレベルまでに抑え、見つからなければ maxLevel まで許す */
  preferredMaxLevel?: LogicLevel;
};

/**
 * 難易度ごとのヒント数の範囲と、必要な手筋レベルの範囲。
 * maxGivens 以下になったら手筋レベルを測り、範囲に入った時点で抜くのを止める。
 */
export const PROFILES: Record<Difficulty, Profile> = {
  easy: { maxGivens: 38, minGivens: 36, minLevel: 1, maxLevel: 1 },
  medium: { maxGivens: 32, minGivens: 30, minLevel: 1, maxLevel: 2 },
  hard: { maxGivens: 28, minGivens: 24, minLevel: 2, maxLevel: 4 },
  expert: { maxGivens: 26, minGivens: 22, minLevel: 3, maxLevel: 5, preferredMaxLevel: 4 },
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
 * 点対称にマスを抜き、解が 1 つに定まり、手筋レベルが難易度の範囲に入るまで減らす。
 */
export function generatePuzzle(seed: string, difficulty: Difficulty): Puzzle {
  const profile = PROFILES[difficulty];
  const rng = createRng(`${seed}:${difficulty}`);
  let fallback: Puzzle | null = null;
  let fallbackDistance = Infinity;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const maxLevel =
      attempt < MAX_ATTEMPTS / 2 ? (profile.preferredMaxLevel ?? profile.maxLevel) : profile.maxLevel;
    const inBand = (level: LogicLevel) => level >= profile.minLevel && level <= maxLevel;
    const solution = randomSolution(rng);
    const puzzle = solution.slice();
    let givens = 81;
    let level: LogicLevel = 1;
    // 0〜40 のマスと、その点対称のマス（80 − i）を組で抜く。40 は盤の中央
    for (const i of shuffle(
      Array.from({ length: 41 }, (_, k) => k),
      rng,
    )) {
      if (givens <= profile.minGivens) break;
      const j = 80 - i;
      const a = puzzle[i];
      const b = puzzle[j];
      const removed = i === j ? 1 : 2;
      puzzle[i] = 0;
      puzzle[j] = 0;
      if (countSolutions(puzzle, 2) !== 1) {
        puzzle[i] = a;
        puzzle[j] = b;
        continue;
      }
      if (givens - removed > profile.maxGivens) {
        givens -= removed;
        continue;
      }
      const next = gradePuzzle(puzzle);
      if (next > maxLevel) {
        puzzle[i] = a;
        puzzle[j] = b;
        continue;
      }
      givens -= removed;
      level = next;
      if (inBand(level)) break;
    }
    if (givens > profile.maxGivens) level = gradePuzzle(puzzle);
    const result: Puzzle = { seed, difficulty, puzzle, solution, givens, level };
    if (givens <= profile.maxGivens && inBand(level)) return result;
    const distance =
      Math.max(0, givens - profile.maxGivens) +
      (level < profile.minLevel ? profile.minLevel - level : Math.max(0, level - maxLevel));
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
