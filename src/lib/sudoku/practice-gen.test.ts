import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { it } from "vitest";
import { PEERS, digitsOf, serializeGrid, type Grid } from "./core";
import { candidatesOf, findAllSteps, findNextStep, type NextStep, type TechniqueId } from "./logic";
import { PRACTICE_KEYS, practiceKeyOf, type PracticeKey, type RawPosition } from "./practice";
import { createRng, hashSeed, shuffle } from "./rng";
import { countSolutions, randomSolution } from "./solver";

/**
 * 手筋の練習の局面を作り、practice-data.ts に書き出す。GEN_PRACTICE=1 のときだけ動く:
 *   npm run gen:practice
 *
 * 解が 1 つになるまでヒントを抜いた問題を、findNextStep の手で解き進め、途中の盤面と候補を局面の候補にする。
 * findNextStep が最初に返す手筋がその局面の手筋になる。答えが 1 つに決まる局面（isOnlyAnswer）だけを使う。
 */

/** 1 項目に入れる局面の数。MIN より少ない項目は一覧から外す */
const TARGET = 5;
const MIN = 3;
/** ロックドキャンディデートは、ポインティングとクレーミングを混ぜる */
const QUOTA: Partial<Record<TechniqueId, number>> = { pointing: 3, claiming: 2 };
/** 探す問題の数。時間ではなく数で打ち切り、いつ作っても同じ結果にする */
const PUZZLES = 6000;
/** 空きマスがこれより少ない（解き終わりに近い）局面は使わない */
const MIN_EMPTIES = 30;

/** 解が 1 つのまま抜けるだけヒントを抜いた問題と、その解答 */
function minimalPuzzle(seed: string): { puzzle: Grid; solution: Grid } {
  const rng = createRng(seed);
  const solution = randomSolution(rng);
  const puzzle = solution.slice();
  for (const i of shuffle(
    Array.from({ length: 81 }, (_, k) => k),
    rng,
  )) {
    puzzle[i] = 0;
    if (countSolutions(puzzle, 2) !== 1) puzzle[i] = solution[i];
  }
  return { puzzle, solution };
}

/** 手を比べるための文字列 */
function movesOf(step: NextStep): string {
  if (step.placement) return `${step.placement.cell}=${step.placement.digit}`;
  return step.eliminations
    .map((e) => `${e.cell}-${e.digit}`)
    .sort()
    .join(" ");
}

/**
 * 答えが 1 つか。局面で使える手を findAllSteps ですべて集め、狙いの手筋の手がどれも狙いの手と同じかを確かめる。
 * 置く手筋は、シングル（ネイキッド・ヒドゥン）で置ける手が他に無いこと。
 * 消す手筋は、同じ項目の手筋（ロックドキャンディデートはポインティングとクレーミング）で別の消し方が無いこと。
 * 別の消し方があると、それを見つけて消しても正解にならない
 */
function isOnlyAnswer(grid: Grid, cands: number[], step: NextStep): boolean {
  const want = movesOf(step);
  const key = practiceKeyOf(step.trace.technique);
  return findAllSteps(grid, cands)
    .filter((s) =>
      step.placement ? !!s.placement : !s.placement && practiceKeyOf(s.trace.technique) === key,
    )
    .every((s) => movesOf(s) === want);
}

type Candidate = { position: RawPosition; k: number };

it.runIf(process.env.GEN_PRACTICE === "1")(
  "手筋の練習の局面を作って practice-data.ts に書き出す",
  async () => {
    const started = Date.now();
    const found = new Map<TechniqueId, Candidate[]>();
    for (let k = 0; k < PUZZLES; k++) {
      const { puzzle: grid, solution } = minimalPuzzle(`practice:${k}`);
      const cands = candidatesOf(grid);
      // 1 つの問題からは、1 項目につき 1 局面だけ使う
      const used = new Set<PracticeKey>();
      for (let n = 0; n < 200; n++) {
        const step = findNextStep(grid, cands);
        if (!step) break;
        const t = step.trace.technique;
        const key = practiceKeyOf(t);
        if (
          !used.has(key) &&
          grid.filter((v) => !v).length >= MIN_EMPTIES &&
          isOnlyAnswer(grid, cands, step)
        ) {
          used.add(key);
          const base = candidatesOf(grid);
          const removed: [number, number][] = [];
          for (let i = 0; i < 81; i++) {
            if (!grid[i]) for (const d of digitsOf(base[i] & ~cands[i])) removed.push([i, d]);
          }
          const values = serializeGrid(grid);
          const position: RawPosition = {
            id: hashSeed(values + JSON.stringify(removed)).toString(36),
            technique: t,
            values,
            solution: serializeGrid(solution),
            removed,
          };
          if (!found.has(t)) found.set(t, []);
          found.get(t)!.push({ position, k });
        }
        if (step.placement) {
          const { cell, digit } = step.placement;
          grid[cell] = digit;
          cands[cell] = 0;
          for (const p of PEERS[cell]) cands[p] &= ~(1 << digit);
        } else {
          for (const e of step.eliminations) cands[e.cell] &= ~(1 << e.digit);
        }
      }
    }

    // 取り除く候補の少ない（候補をすべて書いた状態に近い）局面から選ぶ
    const out: RawPosition[] = [];
    const dropped: string[] = [];
    const counts: string[] = [];
    for (const key of PRACTICE_KEYS) {
      const picked: Candidate[] = [];
      for (const [t, list] of found) {
        if (practiceKeyOf(t) !== key) continue;
        const sorted = list
          .slice()
          .sort((a, b) => a.position.removed.length - b.position.removed.length || a.k - b.k);
        picked.push(...sorted.slice(0, QUOTA[t] ?? TARGET));
        counts.push(`${t}: ${list.length}`);
      }
      picked.sort((a, b) => a.position.removed.length - b.position.removed.length || a.k - b.k);
      if (picked.length < MIN) dropped.push(key);
      else out.push(...picked.slice(0, TARGET).map((c) => c.position));
    }

    const file = fileURLToPath(new URL("./practice-data.ts", import.meta.url));
    const body = out.map((p) => JSON.stringify(p)).join(",\n");
    const source = [
      "// 手筋の練習の局面。practice-gen.test.ts が書き出す（手で書き換えない）:",
      "//   npm run gen:practice",
      'import type { RawPosition } from "./practice";',
      "",
      `export const PRACTICE_POSITIONS: RawPosition[] = [\n${body}\n];`,
      "",
    ].join("\n");
    writeFileSync(file, await format(source, { ...(await resolveConfig(file)), filepath: file }));
    console.log({ puzzles: PUZZLES, ms: Date.now() - started, positions: out.length, dropped });
    console.log(counts.join("\n"));
  },
  30 * 60_000,
);
