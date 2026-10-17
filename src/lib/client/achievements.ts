import { DIFFICULTIES, type Difficulty } from "@/lib/sudoku/core";
import type { PracticeItem } from "@/lib/sudoku/practice";
import { deviceRecords } from "./history";
import { loadPracticeProgress, type PracticeProgress } from "./practiceProgress";
import { isDateKey, monthView, summarize, type RecordSummary } from "./records";
import { loadStats, type Stats } from "./stats";
import { KEYS, isPlainObject, load, save } from "./storage";

export const ACHIEVEMENTS = [
  { id: "daily-first", name: "初めてのクリア", desc: "今日の一問を1問クリア" },
  { id: "streak-3", name: "3日連続", desc: "3日続けて今日の一問をクリア" },
  { id: "streak-7", name: "7日連続", desc: "7日続けて今日の一問をクリア" },
  { id: "streak-30", name: "30日連続", desc: "30日続けて今日の一問をクリア" },
  { id: "streak-100", name: "100日連続", desc: "100日続けて今日の一問をクリア" },
  { id: "perfect-month", name: "1か月皆勤", desc: "月初めから月末まで毎日、今日の一問をクリア" },
  { id: "daily-all", name: "1日で全難易度", desc: "同じ日の今日の一問を6難易度すべてクリア" },
  { id: "daily-master", name: "鬼クリア", desc: "今日の一問の鬼をクリア" },
  { id: "daily-extreme", name: "極クリア", desc: "今日の一問の極をクリア" },
  { id: "free-all", name: "全難易度クリア", desc: "フリープレイで6難易度をすべてクリア" },
  { id: "free-master", name: "ヒントなしの鬼", desc: "フリープレイの鬼をヒントなしでクリア" },
  { id: "free-extreme", name: "ヒントなしの極", desc: "フリープレイの極をヒントなしでクリア" },
  { id: "free-clean", name: "ノーミスクリア", desc: "フリープレイをヒントもミスもなしでクリア" },
  { id: "free-100", name: "100問クリア", desc: "フリープレイを合計100問クリア" },
  { id: "practice-all", name: "全手筋の練習", desc: "手筋の練習で、すべての手筋を1局面以上解く" },
] as const;

export type Achievement = (typeof ACHIEVEMENTS)[number];
export type AchievementId = Achievement["id"];

/** 判定の材料。どれも検証済みの値（loadStats・deviceRecords の記録の summarize・loadPracticeProgress） */
export type AchievementInputs = {
  stats: Stats;
  daily: RecordSummary;
  today: string;
  /** 手筋の練習。局面のデータを読んでいなければ null で、練習の実績は判定しない */
  practice: { items: readonly PracticeItem[]; progress: PracticeProgress } | null;
};

/** 1 日から月末まで毎日クリアした月があるか。今月は月末の日（未来の日が無い）までは数えない */
function hasPerfectMonth(daily: RecordSummary, today: string): boolean {
  const months = new Set([...daily.byDate.keys()].map((d) => d.slice(0, 7)));
  return [...months].some((ym) => {
    const v = monthView(daily, Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), today);
    // played は今日までの日だけを数えるので、月のすべての日と同じなら月末まで過ぎている
    return v.played === v.days.length;
  });
}

/** 今の記録で達成している実績 */
export function evaluate({ stats, daily, today, practice }: AchievementInputs): Set<AchievementId> {
  const out = new Set<AchievementId>();
  const add = (id: AchievementId, ok: boolean) => ok && out.add(id);

  add("daily-first", daily.byDate.size > 0);
  add("streak-3", daily.longest >= 3);
  add("streak-7", daily.longest >= 7);
  add("streak-30", daily.longest >= 30);
  add("streak-100", daily.longest >= 100);
  add("perfect-month", hasPerfectMonth(daily, today));
  add(
    "daily-all",
    [...daily.byDate.values()].some((s) => s.size === DIFFICULTIES.length),
  );
  add("daily-master", daily.perDifficulty.master.clears > 0);
  add("daily-extreme", daily.perDifficulty.extreme.clears > 0);

  // played はクリア数。bestMs はヒントなしのクリア、cleanBestMs はヒントもミスもないクリアがあるときだけ入る（stats.ts）
  const played = (d: Difficulty) => stats[d]?.played ?? 0;
  add(
    "free-all",
    DIFFICULTIES.every((d) => played(d) > 0),
  );
  add("free-master", stats.master?.bestMs != null);
  add("free-extreme", stats.extreme?.bestMs != null);
  add(
    "free-clean",
    DIFFICULTIES.some((d) => stats[d]?.cleanBestMs != null),
  );
  add("free-100", DIFFICULTIES.reduce((n, d) => n + played(d), 0) >= 100);

  if (practice) {
    const { items, progress } = practice;
    add("practice-all", items.length > 0 && items.every((i) => (progress[i.key]?.length ?? 0) > 0));
  }
  return out;
}

/** 解除した実績と、解除した日。日付が分からないもの（前の版で達成していた分など）は null */
export type Unlocked = Partial<Record<AchievementId, string | null>>;

/**
 * 保存データを検証して読む。知らない実績と、日付でも null でもない値は捨てる。
 * 読むのは実績の数だけなので、大きなオブジェクトが保存されていても件数は増えない。
 * 保存が無い・オブジェクトでないときは null（まだ判定していない）
 */
export function sanitizeUnlocked(raw: unknown): Unlocked | null {
  if (!isPlainObject(raw)) return null;
  const out: Unlocked = {};
  for (const { id } of ACHIEVEMENTS) {
    const v = raw[id];
    if (v === null || isDateKey(v)) out[id] = v;
  }
  return out;
}

export function loadUnlocked(): Unlocked | null {
  return sanitizeUnlocked(load<unknown>(KEYS.achievements));
}

/**
 * 保存してある解除に、まだ解除していない達成を date の日付で足す（解除は消さない）。
 * added は足した実績で、一覧の順
 */
export function unlock(
  saved: Unlocked | null,
  achieved: ReadonlySet<AchievementId>,
  date: string | null,
): { unlocked: Unlocked; added: AchievementId[] } {
  const unlocked: Unlocked = { ...saved };
  const added: AchievementId[] = [];
  for (const { id } of ACHIEVEMENTS) {
    if (!achieved.has(id) || unlocked[id] !== undefined) continue;
    unlocked[id] = date;
    added.push(id);
  }
  return { unlocked, added };
}

/**
 * 端末の記録で実績を判定し、新しく解除したものを保存する。
 * クリアしたときの判定（notify）で新しく解除したものは、今日の日付を付けて fresh で返す。
 * 初めての判定（保存が無い。更新前からの達成）とクリア以外の判定（履歴の取り直し・引き継ぎなど）では、
 * いつ達成したか分からないので日付を付けず、通知もしない。
 * 初めての判定では、何も達成していなくても保存して、次からの判定と区別する。
 * 判定が例外を投げたときは何も保存せず、保存してある解除（読めなければ空）を fresh なしで返す
 */
export function updateAchievements(
  today: string,
  practice: readonly PracticeItem[] | null,
  notify: boolean,
): { unlocked: Unlocked; fresh: Achievement[] } {
  let saved: Unlocked | null = null;
  try {
    saved = loadUnlocked();
    const achieved = evaluate({
      stats: loadStats(),
      daily: summarize(deviceRecords(), today),
      today,
      practice: practice && { items: practice, progress: loadPracticeProgress(practice) },
    });
    const announce = notify && saved !== null;
    const { unlocked, added } = unlock(saved, achieved, announce ? today : null);
    const fresh = announce ? ACHIEVEMENTS.filter((a) => added.includes(a.id)) : [];
    if (saved === null || added.length) save(KEYS.achievements, unlocked);
    return { unlocked, fresh };
  } catch {
    // 実績はおまけなので、判定の失敗（想定していない保存データなど）でクリアの処理や画面を止めない。
    // 止まった実績は次に判定できたときに解除される
    return { unlocked: saved ?? {}, fresh: [] };
  }
}
