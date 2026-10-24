import { SITE_ORIGIN } from "@/lib/site";
import type { GameState } from "@/lib/game/state";
import {
  DIFFICULTIES,
  findConflicts,
  isDifficulty,
  serializeGrid,
  type Difficulty,
  type Grid,
} from "@/lib/sudoku/core";
import { PROFILES } from "@/lib/sudoku/generator";
import { gradePuzzle, type LogicLevel } from "@/lib/sudoku/logic";
import { countSolutionsWithin, solve } from "@/lib/sudoku/solver";

/** 共有された盤面。フリープレイとして始める */
export type SharedPuzzle = { seed: string; difficulty: Difficulty; puzzle: Grid; solution: Grid };

/** 読めなかった理由（画面にはどれも「読み込めない盤面です」と出す） */
export type SharedError = "format" | "givens" | "conflict" | "no-solution" | "multiple" | "too-hard";

export type SharedResult = { ok: true; puzzle: SharedPuzzle } | { ok: false; reason: SharedError };

/** クエリの長さの上限。共有の URL（?p=81 桁&d=難易度）に、ほかのアプリが足すパラメータの分を見込む */
export const MAX_SEARCH = 2048;
/**
 * 解が 1 つかを確かめるときに、数字を置く回数の上限。よく知られた難問でも 12 万回ほどで確かめ終わる。
 * 解の無い盤面や解の多い盤面には、数え終わるまでに何百万回も掛かるものがあるので、ここで打ち切って読めない盤面とする
 */
export const MAX_NODES = 200_000;
/** 解が 1 つに定まる問題のヒントは 17 個以上 */
const MIN_GIVENS = 17;

/** クエリの組（デコードしない。空の組は捨てる） */
const pairs = (search: string) =>
  search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair !== "");
const keyOf = (pair: string) => pair.split("=", 1)[0];
/** = の後ろ。= が無ければ null */
function valueOf(pair: string): string | null {
  const k = pair.indexOf("=");
  return k < 0 ? null : pair.slice(k + 1);
}

/** 難易度の手筋レベルの範囲に入るか（極は鬼と同じ範囲） */
const inBand = (d: Difficulty, level: LogicLevel) =>
  PROFILES[d].minLevel <= level && level <= PROFILES[d].maxLevel;

/**
 * URL のクエリ（location.search）から共有された盤面を読む。p が無ければ null。
 * 外から来る値なので、軽い検査から順に確かめる: 形（クエリが MAX_SEARCH 文字以内、p が 1 つで 81 桁の数字、0 は空き。
 * 値はデコードしない）→ ヒントの数（17〜80）→ 同じ行・列・ブロックの重複 → 解が 1 つか（2 つ目で打ち切り、
 * 置く回数も MAX_NODES まで）。難易度は手筋の判定で決め、d はその範囲に入るときだけ使う
 * （極と鬼は判定では見分けられないので d で分ける）
 */
export function parseShared(search: string): SharedResult | null {
  const fail = (reason: SharedError): SharedResult => ({ ok: false, reason });
  // 長すぎるクエリは組に分けず、p の有無だけを見る
  if (search.length > MAX_SEARCH) return /(?:^\??|&)p(?:[=&]|$)/.test(search) ? fail("format") : null;
  const all = pairs(search);
  const ps = all.filter((pair) => keyOf(pair) === "p");
  if (ps.length === 0) return null;
  const raw = ps.length === 1 ? valueOf(ps[0]) : null;
  if (raw === null || !/^[0-9]{81}$/.test(raw)) return fail("format");
  const puzzle = [...raw].map(Number);
  const givens = puzzle.filter((v) => v !== 0).length;
  // 81 個（空きマスが無い）だと、解き終えられない
  if (givens < MIN_GIVENS || givens === 81) return fail("givens");
  if (findConflicts(puzzle).size > 0) return fail("conflict");
  const count = countSolutionsWithin(puzzle, 2, MAX_NODES);
  if (count === null) return fail("too-hard");
  if (count === 0) return fail("no-solution");
  if (count > 1) return fail("multiple");
  // 解が 1 つと確かめた探索と同じ順で最初の解までたどるので、確かめるより時間は掛からない
  const solution = solve(puzzle)!;
  const level = gradePuzzle(puzzle);
  const ds = all.filter((pair) => keyOf(pair) === "d");
  const d = ds.length === 1 ? valueOf(ds[0]) : null;
  const difficulty = isDifficulty(d) && inBand(d, level) ? d : DIFFICULTIES.find((x) => inBand(x, level))!;
  return { ok: true, puzzle: { seed: `shared:${raw}`, difficulty, puzzle, solution } };
}

/** クエリから共有の盤面（p・d）を除く。ほかのパラメータは残し、何も残らなければ空文字（? を残さない） */
export function withoutShared(search: string): string {
  const rest = pairs(search).filter((pair) => keyOf(pair) !== "p" && keyOf(pair) !== "d");
  return rest.length ? `?${rest.join("&")}` : "";
}

/** フリープレイの最初の配置を遊べる URL（本番の URL）。d を付けないと、極は鬼として開く */
export const shareUrl = (game: Pick<GameState, "puzzle" | "difficulty">) =>
  `${SITE_ORIGIN}/?p=${serializeGrid(game.puzzle)}&d=${game.difficulty}`;
