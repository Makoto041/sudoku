import type { Mode } from "@/lib/game/state";
import { TECHNIQUE_NAME, type Hint } from "@/lib/sudoku/hint";
import type { TechniqueId } from "@/lib/sudoku/logic";
import { techniqueRows } from "@/lib/sudoku/practice";
import { KEYS, isPlainObject, load, save } from "./storage";

/**
 * ヒントで示した手筋の回数（手筋の ID ごと。0 回の手筋は持たない）。
 * ヒントで教わった手筋は、自分では見つけにくかった手筋とみなす。端末内だけに保存し、サーバー・引き継ぎ・アカウントの
 * 同期には送らない（記録 sudoku:stats には入れない）。ログアウトで消す（account.ts の resetDevice）
 */
export type WeakCounts = Partial<Record<TechniqueId, number>>;

/** ヒントを数えるプレイ。id はフリープレイなら問題のシード、練習なら局面の id */
export type HintPlay = { mode: Mode; id: string };

/** 数えたヒントを覚えているプレイ。keys は数えたヒント（手筋とマス） */
type Played = { id: string; keys: string[] };
/** モードごとに直近の 1 プレイだけ覚える（フリープレイの途中の盤面は 1 つだけなので、ほかのモードを挟んでも残る） */
type Seen = Partial<Record<"free" | "practice", Played>>;

const TECHNIQUE_IDS = Object.keys(TECHNIQUE_NAME) as TechniqueId[];
const MODES = ["free", "practice"] as const;
/** 1 プレイで覚えるヒントの数の上限（壊れた保存データで大きな配列を読まないように。超えたら古いものから忘れる） */
const MAX_KEYS = 300;
/** プレイの id の長さの上限（共有された盤面のシードは 88 文字） */
const MAX_ID = 200;

function sanitizeCounts(raw: unknown): WeakCounts {
  const out: WeakCounts = {};
  if (!isPlainObject(raw)) return out;
  for (const id of TECHNIQUE_IDS) {
    const n = raw[id];
    if (Number.isSafeInteger(n) && (n as number) > 0) out[id] = n as number;
  }
  return out;
}

function sanitizePlayed(raw: unknown): Played | null {
  if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id || raw.id.length > MAX_ID) return null;
  if (!Array.isArray(raw.keys)) return null;
  const keys = raw.keys.slice(-MAX_KEYS).filter((k): k is string => typeof k === "string");
  return { id: raw.id, keys: [...new Set(keys)] };
}

/** 保存データを読む。読めない・壊れている・形が違う（古い版を含む）ものは空として扱う */
function loadWeak(): { counts: WeakCounts; seen: Seen } {
  const raw = load<unknown>(KEYS.weak);
  const seen: Seen = {};
  if (!isPlainObject(raw)) return { counts: {}, seen };
  if (isPlainObject(raw.seen)) {
    for (const mode of MODES) {
      const played = sanitizePlayed(raw.seen[mode]);
      if (played) seen[mode] = played;
    }
  }
  return { counts: sanitizeCounts(raw.counts), seen };
}

/** ヒントで示した手筋の回数 */
export const loadWeakCounts = (): WeakCounts => loadWeak().counts;

/**
 * ヒントで手筋を示したことを数える。数えたら true。
 * - 数えるのはヒントを開いて手筋の名前を見せたとき（盤面に反映したかは問わない）。名前を見せた時点で手筋を教えていて、
 *   反映せずに自分で置く・消す人もいるため。フリープレイのヒントの回数（hints）も開いた時点で数える。
 * - 同じプレイで、同じ手筋・同じマス（置くマス・候補を消すマス）のヒントは 1 回だけ数える
 *   （閉じて開き直した・ほかのマスを埋めてからまた同じヒントが出た・続きから開き直した・再読み込みした）。
 * - プレイはモードごとに直近の 1 つだけ覚える。フリープレイは問題（シード）ごと、練習は局面ごと。
 *   そのため、同じ局面を続けて開き直したときや、同じ共有の盤面を遊び直したときも、同じヒントは数えない。
 * - ヒントが使えない今日の一問と、手筋の無いヒント（違う数字・手筋では進めない）は数えない
 */
export function recordHintTechnique(play: HintPlay, hint: Hint): boolean {
  if (play.mode === "daily" || (hint.kind !== "place" && hint.kind !== "eliminate")) return false;
  const { counts, seen } = loadWeak();
  const prev = seen[play.mode];
  const keys = prev?.id === play.id ? prev.keys : [];
  const key = `${hint.technique}:${[...hint.targets].sort((a, b) => a - b).join(",")}`;
  if (keys.includes(key)) return false;
  save(KEYS.weak, {
    counts: { ...counts, [hint.technique]: (counts[hint.technique] ?? 0) + 1 },
    seen: { ...seen, [play.mode]: { id: play.id, keys: [...keys, key].slice(-MAX_KEYS) } },
  });
  return true;
}

/**
 * 記録画面に出す、ヒントを使った手筋の上位（回数の多い順。同じ回数なら練習の項目の順）。
 * ポインティングとクレーミングは練習の項目と同じくロックドキャンディデートにまとめる。key で練習の項目を開く
 */
export const topWeakTechniques = (counts: WeakCounts, limit = 3) =>
  techniqueRows(counts)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
