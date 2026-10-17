import { DIFFICULTIES, isDifficulty, type Difficulty } from "@/lib/sudoku/core";
import type { DifficultySummary } from "./records";
import { KEYS, isPlainObject, load, save } from "./storage";

export type DifficultyStats = {
  /** クリア数（名前は古いまま） */
  played: number;
  bestMs: number | null;
  cleanBestMs: number | null;
  /** スコア制になってからの最高点 */
  bestPoints?: number | null;
  /** 新しく始めた数。数え始める前の記録には無い */
  started?: number;
  /** started を数え始めてからのクリア数（クリア率と平均時間はこれで計算する） */
  trackedClears?: number;
  /** trackedClears のクリア時間の合計 */
  totalMs?: number;
  /** 途中で新しい問題に替えたときの経過時間の合計 */
  abandonedMs?: number;
};
export type Stats = Partial<Record<Difficulty, DifficultyStats>>;

/** 時間の上限（100 年） */
export const MAX_MS = 100 * 365 * 86_400_000;
/** 回数の上限。1 日 100 問を 27 年続けても届かない */
export const MAX_COUNT = 1_000_000;
/** 点数の上限。極で満点を取っても 1 問 10 万点に届かない（score.ts の計算から） */
export const MAX_POINTS = 1_000_000;

/**
 * 項目ごとの上限と、整数にする方法。回数は切り捨て、点数は四捨五入する。
 * 時間は丸めない（最速はクリア時間を小数のまま保存してきたので、丸めると表示の秒や最速の比べ方が変わる）
 */
const FIELDS: Record<keyof DifficultyStats, { max: number; int?: (n: number) => number }> = {
  played: { max: MAX_COUNT, int: Math.floor },
  bestMs: { max: MAX_MS },
  cleanBestMs: { max: MAX_MS },
  bestPoints: { max: MAX_POINTS, int: Math.round },
  started: { max: MAX_COUNT, int: Math.floor },
  trackedClears: { max: MAX_COUNT, int: Math.floor },
  totalMs: { max: MAX_MS },
  abandonedMs: { max: MAX_MS },
};

const EMPTY: DifficultyStats = { played: 0, bestMs: null, cleanBestMs: null, bestPoints: null };

/** 有限の数だけを 0〜max に収めて返す。それ以外は null */
function num(x: unknown, max: number): number | null {
  return Number.isFinite(x) ? Math.min(max, Math.max(0, x as number)) : null;
}

/**
 * 難易度 1 つ分の記録を検証済みの値にする。知らない項目は捨て、無効な数は null（任意の項目は未設定）。
 * 0〜上限に収めてから整数にするので、上限（整数）を超えない
 */
function sanitize(raw: unknown): DifficultyStats | undefined {
  if (!isPlainObject(raw)) return undefined;
  const n = (k: keyof DifficultyStats) => {
    const { max, int } = FIELDS[k];
    const v = num(raw[k], max);
    return v !== null && int ? int(v) : v;
  };
  const out: DifficultyStats = {
    played: n("played") ?? 0,
    bestMs: n("bestMs"),
    cleanBestMs: n("cleanBestMs"),
    bestPoints: n("bestPoints"),
  };
  for (const k of ["started", "trackedClears", "totalMs", "abandonedMs"] as const) {
    const v = n(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/** 端末の保存データも引き継ぎで受け取った記録も信用せず、難易度のキーだけを検証済みの値で残す */
function sanitizeStats(raw: unknown): Stats {
  const out: Stats = {};
  if (!isPlainObject(raw)) return out;
  for (const d of DIFFICULTIES) {
    const s = sanitize(raw[d]);
    if (s) out[d] = s;
  }
  return out;
}

export function loadStats(): Stats {
  return sanitizeStats(load<unknown>(KEYS.stats));
}

export type FreeClear = {
  bestMs: number | null;
  bestPoints: number | null;
  isBest: boolean;
  played: number;
};

/** フリープレイの自己ベスト（端末内のみ）。ベストは最高点で、ヒントを使ったクリアも点数で比べる */
export function recordFreeClear(
  difficulty: Difficulty,
  ms: number,
  points: number,
  mistakes: number,
  hints: number,
): FreeClear {
  const stats = loadStats();
  const cur = stats[difficulty] ?? EMPTY;
  const noHints = hints === 0;
  const prevPoints = cur.bestPoints ?? null;
  const isBest = prevPoints === null || points > prevPoints;
  const next: DifficultyStats = {
    ...cur,
    played: cur.played + 1,
    bestMs: noHints && (cur.bestMs === null || ms < cur.bestMs) ? ms : cur.bestMs,
    cleanBestMs:
      noHints && mistakes === 0 && (cur.cleanBestMs === null || ms < cur.cleanBestMs) ? ms : cur.cleanBestMs,
    bestPoints: isBest ? points : prevPoints,
    // 平均時間にはヒントを使ったクリアも入れる
    trackedClears: (cur.trackedClears ?? 0) + 1,
    totalMs: (cur.totalMs ?? 0) + Math.round(ms),
  };
  save(KEYS.stats, { ...stats, [difficulty]: next });
  return { bestMs: next.bestMs, bestPoints: next.bestPoints ?? null, isBest, played: next.played };
}

/** フリープレイを新しく始めたときに数える。途中のフリープレイを上書きするなら、その経過時間も足す */
export function recordFreeStart(
  difficulty: Difficulty,
  abandoned: { difficulty: Difficulty; elapsedMs: number } | null,
) {
  const stats = loadStats();
  // 途中の問題は保存データから読んだものなので、難易度と経過時間を確かめる
  const elapsed = num(abandoned?.elapsedMs, MAX_MS);
  if (abandoned && isDifficulty(abandoned.difficulty) && elapsed) {
    const a = stats[abandoned.difficulty] ?? EMPTY;
    stats[abandoned.difficulty] = { ...a, abandonedMs: (a.abandonedMs ?? 0) + Math.round(elapsed) };
  }
  const s = stats[difficulty] ?? EMPTY;
  stats[difficulty] = { ...s, started: (s.started ?? 0) + 1 };
  save(KEYS.stats, stats);
}

export function bestScores(): Partial<Record<Difficulty, number | null>> {
  const stats = loadStats();
  const out: Partial<Record<Difficulty, number | null>> = {};
  for (const [k, v] of Object.entries(stats)) out[k as Difficulty] = v?.bestPoints ?? null;
  return out;
}

export type FreeSummary = {
  /** 数え始める前のクリアしか無ければ null */
  started: number | null;
  clears: number;
  clearRate: number | null;
  avgMs: number | null;
  bestMs: number | null;
  cleanBestMs: number | null;
  bestPoints: number | null;
};

/**
 * 記録画面に出すフリープレイの数字（loadStats で検証済みの値を受け取る）。
 * クリア率と平均時間は、開始数を数え始めてからの分だけで計算する
 */
export function freeSummary(s: DifficultyStats | undefined): FreeSummary {
  const clears = s?.played ?? 0;
  const started = s?.started ?? null;
  const tracked = s?.trackedClears ?? 0;
  return {
    started: started ?? (clears > 0 ? null : 0),
    clears,
    // 保存しておけるフリープレイは 1 つなので、数え始める前に始めた 1 問の分だけ開始数より多くなりうる
    clearRate: started ? Math.min(1, tracked / started) : null,
    // 1 未満で割ると時間が上限を超えて大きくなる（検証前の値を渡されたときも出さない）
    avgMs: tracked >= 1 ? (s?.totalMs ?? 0) / tracked : null,
    bestMs: s?.bestMs ?? null,
    cleanBestMs: s?.cleanBestMs ?? null,
    bestPoints: s?.bestPoints ?? null,
  };
}

/** フリープレイ（クリアと途中でやめた分）と今日の一問のクリア時間の合計 */
export function totalPlayMs(stats: Stats, daily: Record<Difficulty, DifficultySummary>): number {
  let ms = 0;
  for (const d of DIFFICULTIES) {
    ms += (stats[d]?.totalMs ?? 0) + (stats[d]?.abandonedMs ?? 0) + daily[d].totalMs;
  }
  return ms;
}

/** 「3時間5分」「12分」 */
export function formatPlayTime(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  return h ? `${h}時間${min % 60}分` : `${min}分`;
}

/** 良い方を返す。片方しか無ければそちら */
function pick(
  x: number | null | undefined,
  y: number | null | undefined,
  better: (p: number, q: number) => boolean,
): number | null {
  if (x == null) return y ?? null;
  if (y == null) return x;
  return better(x, y) ? x : y;
}

/** 開始数・クリア数・時間（クリアと途中でやめた分）。この順に比べる */
const weight = (s: DifficultyStats) => [
  s.started ?? 0,
  s.trackedClears ?? 0,
  (s.totalMs ?? 0) + (s.abandonedMs ?? 0),
];

/** x の方が y より多く遊んだ記録か（開始数、同じならクリア数、それも同じなら時間で比べる）。全部同じなら false */
function newer(x: DifficultyStats, y: DifficultyStats): boolean {
  const wx = weight(x);
  const wy = weight(y);
  const k = wx.findIndex((n, i) => n !== wy[i]);
  return k >= 0 && wx[k] > wy[k];
}

function combine(a: DifficultyStats, v: DifficultyStats): DifficultyStats {
  // 開始数・クリア数・時間は比率が崩れないよう、多く遊んだ側からまとめて取る（同じなら端末の方）
  const { started, trackedClears, totalMs, abandonedMs } = newer(v, a) ? v : a;
  return {
    played: Math.max(a.played, v.played),
    bestMs: pick(a.bestMs, v.bestMs, (p, q) => p < q),
    cleanBestMs: pick(a.cleanBestMs, v.cleanBestMs, (p, q) => p < q),
    bestPoints: pick(a.bestPoints, v.bestPoints, (p, q) => p > q),
    started,
    trackedClears,
    totalMs,
    abandonedMs,
  };
}

/**
 * 引き継ぎで受け取った記録と合わせる（難易度ごとに良い方を残す）。cur は loadStats で検証済みの値。
 * 受け取った記録は loadStats と同じく検証してから使う
 */
export function combineStats(cur: Stats, incoming: unknown): Stats {
  const inc = sanitizeStats(incoming);
  const out: Stats = {};
  for (const d of DIFFICULTIES) {
    const a = cur[d];
    const v = inc[d];
    const s = a && v ? combine(a, v) : (a ?? v);
    if (s) out[d] = s;
  }
  return out;
}

export function mergeStats(incoming: unknown) {
  if (!incoming || typeof incoming !== "object") return;
  save(KEYS.stats, combineStats(loadStats(), incoming));
}
