import { DIFFICULTIES, type Difficulty } from "@/lib/sudoku/core";

/** 今日の一問を 1 問クリアした記録 */
export type ClearRecord = { date: string; difficulty: Difficulty; points: number | null; timeMs: number };

export type DifficultySummary = { clears: number; bestPoints: number | null; bestMs: number | null };

export type RecordSummary = {
  /** 今日まで（今日がまだなら昨日まで）続いている連続日数 */
  streak: number;
  longest: number;
  /** 日付ごとのクリアした難易度 */
  byDate: Map<string, Set<Difficulty>>;
  perDifficulty: Record<Difficulty, DifficultySummary>;
};

const DAY_MS = 86_400_000;
const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, n: number) => toDate(toMs(date) + n * DAY_MS);

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

/** 6 段階のどれか 1 問でもクリアした日を「遊んだ日」として数える */
export function summarize(records: ClearRecord[], today: string): RecordSummary {
  const byDate = new Map<string, Set<Difficulty>>();
  const perDifficulty = Object.fromEntries(
    DIFFICULTIES.map((d) => [d, { clears: 0, bestPoints: null, bestMs: null }]),
  ) as Record<Difficulty, DifficultySummary>;

  for (const r of records) {
    if (!(DIFFICULTIES as readonly string[]).includes(r.difficulty)) continue;
    let set = byDate.get(r.date);
    if (!set) byDate.set(r.date, (set = new Set()));
    set.add(r.difficulty);
    const s = perDifficulty[r.difficulty];
    s.clears++;
    if (r.points !== null && (s.bestPoints === null || r.points > s.bestPoints)) s.bestPoints = r.points;
    if (s.bestMs === null || r.timeMs < s.bestMs) s.bestMs = r.timeMs;
  }

  let streak = 0;
  let day = byDate.has(today) ? today : addDays(today, -1);
  while (byDate.has(day)) {
    streak++;
    day = addDays(day, -1);
  }

  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of [...byDate.keys()].sort()) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }

  return { streak, longest, byDate, perDifficulty };
}

export type MonthView = {
  year: number;
  month: number;
  /** 1 日の曜日（0 = 日曜） */
  firstWeekday: number;
  days: { date: string; day: number; count: number; isToday: boolean; isFuture: boolean }[];
  /** その月で遊んだ日数と、数える対象の日数（今月は今日まで） */
  played: number;
  target: number;
  /** 対象の日をすべて遊んだ（今月は今日まで） */
  perfect: boolean;
};

export function monthView(summary: RecordSummary, year: number, month: number, today: string): MonthView {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const days: MonthView["days"] = [];
  for (let d = first; d.startsWith(first.slice(0, 7)); d = addDays(d, 1)) {
    days.push({
      date: d,
      day: Number(d.slice(8)),
      count: summary.byDate.get(d)?.size ?? 0,
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
