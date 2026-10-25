import { DIFFICULTIES, isDifficulty, type Difficulty } from "@/lib/sudoku/core";
// stats.ts からこのファイルへの import は型だけなので、循環しない
import { MAX_MS, MAX_POINTS } from "./stats";
import { isPlainObject } from "./storage";

/** 今日の一問を 1 問クリアした記録 */
export type ClearRecord = { date: string; difficulty: Difficulty; points: number | null; timeMs: number };

export type DifficultySummary = {
  clears: number;
  bestPoints: number | null;
  bestMs: number | null;
  /** クリア時間の合計 */
  totalMs: number;
  avgMs: number | null;
  /** 点数のある記録（スコア制になってから）の平均。四捨五入 */
  avgPoints: number | null;
};

export type RecordSummary = {
  /** 今日まで（今日がまだなら昨日まで）続いている連続日数。休みの日は数えない（streaks を参照） */
  streak: number;
  /** 最も長かった連続日数（休みを挟んだ連続も 1 つに数える） */
  longest: number;
  /** 連続を途切れさせなかった休みの日（streaks を参照） */
  restDays: Set<string>;
  /** 日付ごとのクリアした難易度 */
  byDate: Map<string, Set<Difficulty>>;
  perDifficulty: Record<Difficulty, DifficultySummary>;
};

const DAY_MS = 86_400_000;
const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, n: number) => toDate(toMs(date) + n * DAY_MS);

/**
 * 記録と解除の日付として受け付ける年。記録はサーバーの日付（2026 年から）で付くので、それより前と遠い先は書き換えか壊れた値。
 * 年が 4 桁でないと日付の計算が壊れる（V8 は「1-01-01」を読めず、10000 年は toISOString の形が変わる）
 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2999;

/** 「2026-10-17」の形で、受け付ける年の実在する日付か（2 月 30 日などは日付の計算で別の日になるので外す） */
export function isDateKey(x: unknown): x is string {
  if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const year = Number(x.slice(0, 4));
  const ms = toMs(x);
  return year >= MIN_YEAR && year <= MAX_YEAR && Number.isFinite(ms) && toDate(ms) === x;
}

/**
 * 保存データや受け取った履歴の記録のうち、日付と難易度が正しいものだけを残す。
 * summarize は日付を計算するので、日付でない値が入っていると例外になる
 */
export function validRecords(raw: unknown): ClearRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is ClearRecord => isPlainObject(r) && isDateKey(r.date) && isDifficulty(r.difficulty),
  );
}

/** 有限で 0〜max の数か（フリープレイの記録と同じ範囲） */
const inRange = (x: unknown, max: number): x is number =>
  Number.isFinite(x) && (x as number) >= 0 && (x as number) <= max;

/** 同じ日・難易度の記録は 1 つにまとめる（サーバーと端末の両方にあるとき） */
export function mergeRecords(...lists: ClearRecord[][]): ClearRecord[] {
  const map = new Map<string, ClearRecord>();
  for (const list of lists) {
    for (const r of list) {
      const key = `${r.date}:${r.difficulty}`;
      const prev = map.get(key);
      if (!prev || (prev.points === null && r.points !== null)) map.set(key, r);
    }
  }
  return [...map.values()];
}

/** 休みを判定する窓の日数。休みの日を含むこの日数の間に、クリアしなかった日は休みの 1 日だけ */
export const REST_WINDOW_DAYS = 7;

export type Streaks = Pick<RecordSummary, "streak" | "longest" | "restDays">;

/**
 * 今日の一問をクリアした日（日本時間の「2026-10-17」。順番と重複は問わない）から、連続日数・最長・休みの日を決める。
 * 同じ日付の列と今日からは、いつも同じ結果になる。
 *
 * 休み: クリアしなかった日 g は、その前の 6 日（g−6〜g−1）をすべてクリアしていて、次の日（g+1）もクリアしていれば休みにし、
 * 連続を途切れさせない。休みの日は連続日数に数えない。
 * - 休みの日を含む 7 日（g−6〜g）の間に、クリアしなかった日は g だけ。窓に 2 日以上あれば休みにしない。
 *   そのため休みは 7 日に 1 日までで、2 日続けてクリアしないと途切れる
 * - 休みかどうかは g の前後の日だけで決まり、ほかの休みには左右されない。別の端末やアカウントの同期で過去の日のクリアが
 *   増えても、休みが休みでなくなるのは、その日がクリアになったときだけなので、連続日数と最長は減らない
 *   （前に休みを使った日から数える決め方だと、過去の日が増えて前の休みが前にずれ、後の休みが使えなくなって減る）
 * - 今日（と、時計のずれなどで付いた先の日）は休みにしない（まだ解ける）。今日がまだで、昨日をクリアしておらず、
 *   昨日の前の 6 日をすべてクリアしていれば、昨日を暫定の休みとして連続が続く。今日クリアすれば休みのまま、
 *   今日も解かなければ次の日には途切れ、昨日は休みでなくなる
 * - 休みの無い連続は前と同じに数えるので、休みが無かったときの数え方より連続日数と最長が減ることもない
 */
export function streaks(dates: Iterable<string>, today: string): Streaks {
  // 記録が無くても日付の計算を 1 回する（日付を読めない環境では例外にして、実績の判定を止める。achievements.ts）
  const yesterday = addDays(today, -1);
  const played = new Set(dates);
  /** g の前の 6 日をすべてクリアしていて、g が今日より前なら、g を休みにできる（g の次の日は呼び出し側で見る） */
  const restable = (g: string) => {
    if (g >= today) return false;
    for (let k = 1; k < REST_WINDOW_DAYS; k++) if (!played.has(addDays(g, -k))) return false;
    return true;
  };
  const restDays = new Set<string>();
  /** クリアした日ごとの、その日までの連続日数 */
  const runAt = new Map<string, number>();
  let run = 0;
  let longest = 0;
  let prev: string | null = null;
  for (const d of [...played].sort()) {
    const next: string | null = prev === null ? null : addDays(prev, 1);
    if (next === d) run++;
    else if (next !== null && addDays(next, 1) === d && restable(next)) {
      restDays.add(next);
      run++;
    } else run = 1;
    longest = Math.max(longest, run);
    runAt.set(d, run);
    prev = d;
  }

  // 先の日付の記録は、今日までの連続には入れない（その日までの値を使う）
  let streak = runAt.get(today) ?? runAt.get(yesterday) ?? 0;
  if (!played.has(today) && !played.has(yesterday) && restable(yesterday)) {
    restDays.add(yesterday);
    streak = runAt.get(addDays(today, -2)) ?? 0;
  }
  return { streak, longest, restDays };
}

/** 6 段階のどれか 1 問でもクリアした日を「遊んだ日」として数える */
export function summarize(records: ClearRecord[], today: string): RecordSummary {
  const byDate = new Map<string, Set<Difficulty>>();
  const perDifficulty = Object.fromEntries(
    DIFFICULTIES.map((d) => [
      d,
      { clears: 0, bestPoints: null, bestMs: null, totalMs: 0, avgMs: null, avgPoints: null },
    ]),
  ) as Record<Difficulty, DifficultySummary>;
  const points = Object.fromEntries(DIFFICULTIES.map((d) => [d, { sum: 0, n: 0 }])) as Record<
    Difficulty,
    { sum: number; n: number }
  >;
  /** 時間が数になっている記録の数（平均時間の分母） */
  const timed = Object.fromEntries(DIFFICULTIES.map((d) => [d, 0])) as Record<Difficulty, number>;

  for (const r of records) {
    if (!(DIFFICULTIES as readonly string[]).includes(r.difficulty)) continue;
    let set = byDate.get(r.date);
    if (!set) byDate.set(r.date, (set = new Set()));
    set.add(r.difficulty);
    const s = perDifficulty[r.difficulty];
    s.clears++;
    // 端末に保存した結果は書き換えられうる。時間や点数が数でないか範囲外の記録は、その集計に入れない
    // （クリア数と連続日数には数える）
    if (inRange(r.timeMs, MAX_MS)) {
      s.totalMs += r.timeMs;
      timed[r.difficulty]++;
      if (s.bestMs === null || r.timeMs < s.bestMs) s.bestMs = r.timeMs;
    }
    if (inRange(r.points, MAX_POINTS)) {
      if (s.bestPoints === null || r.points > s.bestPoints) s.bestPoints = r.points;
      points[r.difficulty].sum += r.points;
      points[r.difficulty].n++;
    }
  }
  for (const d of DIFFICULTIES) {
    const s = perDifficulty[d];
    if (timed[d]) s.avgMs = s.totalMs / timed[d];
    if (points[d].n) s.avgPoints = Math.round(points[d].sum / points[d].n);
  }

  const { streak, longest, restDays } = streaks(byDate.keys(), today);
  return { streak, longest, restDays, byDate, perDifficulty };
}

export type MonthView = {
  year: number;
  month: number;
  /** 1 日の曜日（0 = 日曜） */
  firstWeekday: number;
  /** count はその日にクリアした難易度の数。isRest は連続を途切れさせなかった休みの日（count は 0） */
  days: { date: string; day: number; count: number; isRest: boolean; isToday: boolean; isFuture: boolean }[];
  /** その月で遊んだ日数と、数える対象の日数（今月は今日まで）。休みの日は遊んだ日に数えない */
  played: number;
  target: number;
  /** 対象の日をすべて遊んだ（今月は今日まで） */
  perfect: boolean;
};

export function monthView(summary: RecordSummary, year: number, month: number, today: string): MonthView {
  // 年は 4 桁にそろえる（「1-01-01」は V8 が日付として読めず、日付の計算で落ちる）
  const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const days: MonthView["days"] = [];
  for (let d = first; d.startsWith(first.slice(0, 7)); d = addDays(d, 1)) {
    days.push({
      date: d,
      day: Number(d.slice(8)),
      count: summary.byDate.get(d)?.size ?? 0,
      isRest: summary.restDays.has(d),
      isToday: d === today,
      isFuture: d > today,
    });
  }
  const counted = days.filter((d) => !d.isFuture);
  const played = counted.filter((d) => d.count > 0).length;
  return {
    year,
    month,
    firstWeekday: new Date(toMs(first)).getUTCDay(),
    days,
    played,
    target: counted.length,
    perfect: counted.length > 0 && played === counted.length,
  };
}
