import { describe, expect, it, vi } from "vitest";
import { DIFFICULTIES, type Difficulty } from "@/lib/sudoku/core";
import { practiceItems, type PracticeItem } from "@/lib/sudoku/practice";
import { PRACTICE_POSITIONS } from "@/lib/sudoku/practice-data";
import { createRng } from "@/lib/sudoku/rng";
import {
  ACHIEVEMENTS,
  evaluate,
  sanitizeUnlocked,
  unlock,
  updateAchievements,
  type AchievementId,
  type AchievementInputs,
} from "./achievements";
import { installMemoryStorage } from "./memoryStorage";
import { addDays, monthView, summarize, validRecords, type ClearRecord } from "./records";
import type { DifficultyStats, Stats } from "./stats";
import { KEYS } from "./storage";

const { store, memory } = installMemoryStorage();

const TODAY = "2026-10-17";
const rec = (date: string, difficulty: Difficulty = "easy"): ClearRecord => ({
  date,
  difficulty,
  points: 100,
  timeMs: 60_000,
});
/** start から n 日続けてクリアした記録 */
const days = (start: string, n: number, difficulty: Difficulty = "easy") =>
  Array.from({ length: n }, (_, i) => rec(addDays(start, i), difficulty));
const free = (s: Partial<DifficultyStats>): DifficultyStats => ({
  played: 1,
  bestMs: null,
  cleanBestMs: null,
  ...s,
});

function inputs(o: { records?: ClearRecord[]; stats?: Stats; today?: string } = {}): AchievementInputs {
  const today = o.today ?? TODAY;
  return { stats: o.stats ?? {}, daily: summarize(o.records ?? [], today), today, practice: null };
}
const achieved = (o: Parameters<typeof inputs>[0]) => evaluate(inputs(o));

describe("今日の一問の実績", () => {
  it("記録が無ければ何も達成していない。1 問クリアで「初めてのクリア」", () => {
    expect(achieved({})).toEqual(new Set());
    expect(achieved({ records: [rec("2026-10-01")] })).toEqual(new Set(["daily-first"]));
  });

  it("連続日数は最長で判定する（2 日と 3 日、6 日と 7 日、29 日と 30 日、99 日と 100 日の境目）", () => {
    for (const [n, id] of [
      [3, "streak-3"],
      [7, "streak-7"],
      [30, "streak-30"],
      [100, "streak-100"],
    ] as const) {
      expect(achieved({ records: days("2026-01-01", n - 1) }).has(id), `${n - 1}日`).toBe(false);
      expect(achieved({ records: days("2026-01-01", n) }).has(id), `${n}日`).toBe(true);
    }
    // 今は途切れていても、過去に 3 日続いていれば達成
    const set = achieved({ records: [...days("2026-09-01", 3), rec("2026-10-17")] });
    expect(set.has("streak-3")).toBe(true);
    expect(set.has("streak-7")).toBe(false);
    // 1 日あいていれば続かない（休みには前の 6 日のクリアが要る）
    expect(
      achieved({ records: [rec("2026-10-01"), rec("2026-10-02"), rec("2026-10-04")] }).has("streak-3"),
    ).toBe(false);
  });

  it("連続日数の実績は休みを挟んだ連続でも数える。休みの日は日数に数えない（記録画面の最長と同じ数え方）", () => {
    // 10-07 が休み。8 日のうちクリアした 7 日で 7日連続。6 日では達成しない
    const week = [...days("2026-10-01", 6), rec("2026-10-08")];
    expect(summarize(week, TODAY).longest).toBe(7);
    expect(achieved({ records: week }).has("streak-7")).toBe(true);
    expect(achieved({ records: week.slice(0, -1) }).has("streak-7")).toBe(false);
    // 今日がまだで昨日を暫定の休みにして続いている途中でも、最長はクリアした日だけで数える
    expect(achieved({ records: days("2026-10-09", 6), today: "2026-10-16" }).has("streak-7")).toBe(false);
    // 9-07・9-14 が休み（6 + 6 + 18 = 30 日）
    const spaced = [...days("2026-09-01", 6), ...days("2026-09-08", 6), ...days("2026-09-15", 18)];
    expect(summarize(spaced, TODAY).longest).toBe(30);
    expect(achieved({ records: spaced }).has("streak-30")).toBe(true);
    // 9-13 は前の 6 日に 9-07 が入るので休みにならず途切れ、30 日には届かない
    const twice = [...days("2026-09-01", 6), ...days("2026-09-08", 5), ...days("2026-09-14", 19)];
    expect(summarize(twice, TODAY).longest).toBe(19);
    expect(achieved({ records: twice }).has("streak-30")).toBe(false);
  });

  it("クリアした日が増えても（ほかの端末やアカウントから届いた過去の日など）、達成していた連続日数の実績は達成したまま", () => {
    const rng = createRng("streak-achievements");
    const ids = ["streak-3", "streak-7", "streak-30", "streak-100"] as const;
    const start = "2026-06-01";
    for (let n = 0; n < 500; n++) {
      // 130 日のうち、多めに遊んだ日を選ぶ
      const p = 0.75 + rng() * 0.25;
      const all = Array.from({ length: 130 }, (_, i) => addDays(start, i));
      const records = all.filter(() => rng() < p).map((d) => rec(d));
      const missing = all.filter((d) => !records.some((r) => r.date === d));
      if (!missing.length) continue;
      const added = rec(missing[Math.floor(rng() * missing.length)]);
      const today = addDays(start, 120 + Math.floor(rng() * 14));
      const before = achieved({ records, today });
      const after = achieved({ records: [...records, added], today });
      for (const id of ids) if (before.has(id)) expect(after.has(id), `${id} +${added.date}`).toBe(true);
    }
  });

  it("連続日数の実績の名前と説明は変えていない", () => {
    expect(ACHIEVEMENTS.filter((a) => a.id.startsWith("streak-"))).toEqual([
      { id: "streak-3", name: "3日連続", desc: "3日続けて今日の一問をクリア" },
      { id: "streak-7", name: "7日連続", desc: "7日続けて今日の一問をクリア" },
      { id: "streak-30", name: "30日連続", desc: "30日続けて今日の一問をクリア" },
      { id: "streak-100", name: "100日連続", desc: "100日続けて今日の一問をクリア" },
    ]);
  });

  it("皆勤は月初めから月末まで毎日クリアした月があるとき。過去の月も数える", () => {
    expect(achieved({ records: days("2026-09-01", 30) }).has("perfect-month")).toBe(true);
    // 1 日でも抜けていれば皆勤でない
    const missing = days("2026-09-01", 30).filter((r) => r.date !== "2026-09-15");
    expect(achieved({ records: missing }).has("perfect-month")).toBe(false);
    // 前の月から続いていても、その月の全日がそろっていれば皆勤
    expect(achieved({ records: days("2026-07-20", 50) }).has("perfect-month")).toBe(true);
  });

  it("今月は今日までそろっていても、月末になるまで皆勤にしない", () => {
    const recs = days("2026-10-01", 17);
    // カレンダーの皆勤の印は今日までで判定する
    expect(monthView(summarize(recs, TODAY), 2026, 10, TODAY).perfect).toBe(true);
    expect(achieved({ records: recs }).has("perfect-month")).toBe(false);
    // 月末の日にクリアすれば皆勤
    expect(achieved({ records: days("2026-10-01", 31), today: "2026-10-31" }).has("perfect-month")).toBe(
      true,
    );
    // 未来の日付の記録（時計のずれ・書き換え）で先の月や今月を皆勤にしない
    expect(achieved({ records: days("2026-11-01", 30) }).has("perfect-month")).toBe(false);
    expect(achieved({ records: days("2026-10-01", 31) }).has("perfect-month")).toBe(false);
  });

  it("同じ日に 6 難易度すべてクリアしたとき「1日で全難易度」。日が分かれていれば達成しない", () => {
    expect(achieved({ records: DIFFICULTIES.map((d) => rec("2026-10-01", d)) }).has("daily-all")).toBe(true);
    const split = DIFFICULTIES.map((d, i) => rec(i < 5 ? "2026-10-01" : "2026-10-02", d));
    expect(achieved({ records: split }).has("daily-all")).toBe(false);
  });

  it("鬼・極は今日の一問の難易度別のクリアで判定する", () => {
    expect(achieved({ records: [rec("2026-10-01", "expert")] }).has("daily-master")).toBe(false);
    const set = achieved({ records: [rec("2026-10-01", "master")] });
    expect(set.has("daily-master")).toBe(true);
    expect(set.has("daily-extreme")).toBe(false);
    expect(achieved({ records: [rec("2026-10-01", "extreme")] }).has("daily-extreme")).toBe(true);
  });
});

describe("フリープレイの実績", () => {
  const all = (s: Partial<DifficultyStats>) =>
    Object.fromEntries(DIFFICULTIES.map((d) => [d, free(s)])) as Stats;

  it("6 難易度すべてにクリアがあれば「全難易度クリア」。1 つでも 0 なら達成しない", () => {
    expect(achieved({ stats: all({}) }).has("free-all")).toBe(true);
    expect(achieved({ stats: { ...all({}), extreme: free({ played: 0 }) } }).has("free-all")).toBe(false);
    const { hard: _, ...five } = all({});
    expect(achieved({ stats: five }).has("free-all")).toBe(false);
  });

  it("鬼・極はヒントなしのクリア（bestMs がある）で判定し、ヒントを使ったクリアだけでは達成しない", () => {
    expect(achieved({ stats: { master: free({ played: 5 }) } }).has("free-master")).toBe(false);
    const set = achieved({ stats: { master: free({ bestMs: 600_000 }), extreme: free({}) } });
    expect(set.has("free-master")).toBe(true);
    expect(set.has("free-extreme")).toBe(false);
    expect(achieved({ stats: { extreme: free({ bestMs: 0 }) } }).has("free-extreme")).toBe(true);
  });

  it("ノーミスはヒントもミスもないクリア（cleanBestMs がある）が 1 つあれば", () => {
    expect(achieved({ stats: { easy: free({ bestMs: 60_000 }) } }).has("free-clean")).toBe(false);
    expect(
      achieved({ stats: { hard: free({ bestMs: 60_000, cleanBestMs: 60_000 }) } }).has("free-clean"),
    ).toBe(true);
  });

  it("合計 100 問は難易度を合わせて数える（99 問と 100 問の境目）", () => {
    expect(
      achieved({ stats: { easy: free({ played: 50 }), hard: free({ played: 49 }) } }).has("free-100"),
    ).toBe(false);
    expect(
      achieved({ stats: { easy: free({ played: 50 }), hard: free({ played: 50 }) } }).has("free-100"),
    ).toBe(true);
  });
});

describe("手筋の練習の実績", () => {
  const items = practiceItems(PRACTICE_POSITIONS);
  const withPractice = (progress: AchievementInputs["practice"]) =>
    evaluate({ ...inputs(), practice: progress });
  const oneEach = Object.fromEntries(items.map((i) => [i.key, [i.positions[0].id]]));

  it("すべての手筋に解いた局面が 1 つ以上あれば達成。1 つでも無ければ達成しない", () => {
    expect(withPractice({ items, progress: oneEach }).has("practice-all")).toBe(true);
    const { [items[3].key]: _, ...missing } = oneEach;
    expect(withPractice({ items, progress: missing }).has("practice-all")).toBe(false);
  });

  it("局面のデータを読んでいないときは判定しない", () => {
    expect(withPractice(null).has("practice-all")).toBe(false);
    expect(withPractice({ items: [], progress: {} }).has("practice-all")).toBe(false);
  });
});

describe("壊れた記録", () => {
  it("検証した記録で判定できる（年が 1000 未満や 2999 より後の日付、実在しない日でも落ちない）", () => {
    const raw = [
      { date: "0x", difficulty: "easy" },
      rec("2026-02-30"),
      rec("0001-01-01"),
      rec("0999-05-01"),
      rec("9999-12-31"),
      { date: "2026-10-01", difficulty: "nope" },
      null,
      rec("2026-10-02"),
      rec("2026-10-03"),
    ];
    const valid = validRecords(raw);
    expect(valid).toEqual([rec("2026-10-02"), rec("2026-10-03")]);
    expect(achieved({ records: valid })).toEqual(new Set(["daily-first"]));
  });
});

describe("解除の保存データ", () => {
  it("オブジェクトでなければ null（まだ判定していない）", () => {
    for (const raw of [null, undefined, "x", 42, [], [["daily-first", TODAY]]])
      expect(sanitizeUnlocked(raw), JSON.stringify(raw)).toBeNull();
    expect(sanitizeUnlocked({})).toEqual({});
  });

  it("知らない実績と、日付でも null でもない値は捨てる", () => {
    expect(
      sanitizeUnlocked({
        "daily-first": "2026-10-01",
        "streak-3": null,
        "streak-7": "2026-02-30",
        "streak-30": "2026/10/01",
        "streak-100": 20261001,
        "perfect-month": "0001-01-01",
        "free-all": "",
        "free-100": {},
        unknown: "2026-10-01",
      }),
    ).toEqual({ "daily-first": "2026-10-01", "streak-3": null });
  });

  it("大きなオブジェクトでも、実績の数までしか読まない", () => {
    const raw: Record<string, string> = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, i) => [`x${i}`, TODAY]),
    );
    raw["free-100"] = TODAY;
    expect(sanitizeUnlocked(raw)).toEqual({ "free-100": TODAY });
  });
});

describe("解除（unlock）", () => {
  const set = (...ids: AchievementId[]) => new Set(ids);

  it("まだ解除していない達成を、渡した日付（日付が分からなければ null）で足す", () => {
    expect(unlock(null, set("daily-first", "streak-3"), null)).toEqual({
      unlocked: { "daily-first": null, "streak-3": null },
      added: ["daily-first", "streak-3"],
    });
    expect(unlock({ "daily-first": null }, set("daily-first", "streak-3"), TODAY)).toEqual({
      unlocked: { "daily-first": null, "streak-3": TODAY },
      added: ["streak-3"],
    });
  });

  it("解除した実績はもう足さず、日付も変えない。今の記録で達成していなくても消さない", () => {
    const saved = { "daily-first": null, "free-100": "2026-10-01" };
    expect(unlock(saved, set("daily-first", "free-100"), TODAY)).toEqual({ unlocked: saved, added: [] });
    expect(unlock(saved, set("free-clean"), null)).toEqual({
      unlocked: { ...saved, "free-clean": null },
      added: ["free-clean"],
    });
  });

  it("足した実績は一覧の順", () => {
    expect(unlock({}, set("free-100", "daily-first", "streak-3"), TODAY).added).toEqual([
      "daily-first",
      "streak-3",
      "free-100",
    ]);
  });
});

describe("実績の一覧", () => {
  it("id は重複しない", () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
  });
});

describe("端末の記録での判定（updateAchievements）", () => {
  const saveResult = (date: string, difficulty: Difficulty = "easy") =>
    store.set(
      KEYS.dailyResult(date, difficulty),
      JSON.stringify({ date, difficulty, timeMs: 60_000, points: 100, rank: 1, total: 1 }),
    );
  const savedUnlocked = () => JSON.parse(store.get(KEYS.achievements)!);

  it("初めての判定は何も無くても保存し、次のクリアから新しく解除したものを通知する", () => {
    expect(updateAchievements(TODAY, null, true).fresh).toEqual([]);
    expect(savedUnlocked()).toEqual({});

    saveResult(TODAY);
    const r = updateAchievements(TODAY, null, true);
    expect(r.fresh.map((a) => a.name)).toEqual(["初めてのクリア"]);
    expect(savedUnlocked()).toEqual({ "daily-first": TODAY });
    // 同じ記録で判定し直しても、もう通知しない
    expect(updateAchievements(TODAY, null, true).fresh).toEqual([]);
  });

  it("更新前からの達成は、最初の判定で日付なしの解除にして通知しない", () => {
    for (const d of days("2026-10-10", 7)) saveResult(d.date);
    store.set(KEYS.stats, JSON.stringify({ easy: { played: 100, bestMs: 1000, cleanBestMs: 1000 } }));
    const r = updateAchievements(TODAY, null, false);
    expect(r.fresh).toEqual([]);
    expect(savedUnlocked()).toEqual({
      "daily-first": null,
      "streak-3": null,
      "streak-7": null,
      "free-clean": null,
      "free-100": null,
    });
    // クリアの判定でも、すでに解除したものは出さない
    expect(updateAchievements(TODAY, null, true).fresh).toEqual([]);
  });

  it("前回取ったサーバーの履歴と端末の結果を合わせて判定する", () => {
    updateAchievements(TODAY, null, false);
    store.set(KEYS.historyCache, JSON.stringify(days("2026-10-14", 2)));
    saveResult("2026-10-16");
    expect(updateAchievements(TODAY, null, true).fresh.map((a) => a.id)).toEqual(["daily-first", "streak-3"]);
  });

  it("練習の局面のデータを渡したときだけ練習の実績を判定する", () => {
    const items = practiceItems(PRACTICE_POSITIONS);
    updateAchievements(TODAY, null, false);
    store.set(
      KEYS.practice,
      JSON.stringify(Object.fromEntries(items.map((i) => [i.key, [i.positions[0].id]]))),
    );
    expect(updateAchievements(TODAY, null, true).fresh).toEqual([]);
    expect(updateAchievements(TODAY, items, true).fresh.map((a) => a.id)).toEqual(["practice-all"]);
  });

  it("保存データが壊れていても落ちず、検証した値だけで判定する", () => {
    store.set(KEYS.stats, "{");
    store.set(KEYS.historyCache, JSON.stringify({ not: "array" }));
    store.set("sudoku:result:x", JSON.stringify({ date: "0x", difficulty: "easy" }));
    store.set("sudoku:result:y", JSON.stringify("x"));
    store.set("sudoku:result:z", JSON.stringify({ date: "2026-10-01", difficulty: "easy" }));
    store.set(KEYS.practice, "[1,2]");
    store.set(KEYS.achievements, JSON.stringify({ "daily-first": 1, unknown: TODAY }));
    const items = practiceItems(PRACTICE_POSITIONS);
    // 保存はオブジェクトなので判定済みとして扱い、壊れた値を捨てた残りに新しく解除したものを足す
    expect(updateAchievements(TODAY, items, true).fresh.map((a) => a.id)).toEqual(["daily-first"]);
    expect(savedUnlocked()).toEqual({ "daily-first": TODAY });
  });

  it("年が 1000 未満や 2999 より後の結果があっても落ちず、その結果は判定に使わない", () => {
    // V8 は年を 4 桁にそろえていない「1-01-01」を日付として読めず、起動時の判定で落ちていた
    for (const date of ["0001-01-01", "0999-05-01", "9999-12-31"]) saveResult(date);
    expect(updateAchievements(TODAY, null, false).unlocked).toEqual({});
    saveResult(TODAY);
    expect(updateAchievements(TODAY, null, true).fresh.map((a) => a.id)).toEqual(["daily-first"]);
  });

  it("解除の保存がオブジェクトでなければ、初めての判定として通知せずに保存し直す", () => {
    saveResult(TODAY);
    for (const raw of ["{", '"x"', "[]", "null"]) {
      store.set(KEYS.achievements, raw);
      expect(updateAchievements(TODAY, null, true).fresh, raw).toEqual([]);
      expect(savedUnlocked()).toEqual({ "daily-first": null });
    }
  });

  it("localStorage が使えなくても落ちず、毎回初めての判定になるので通知しない", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      key: () => {
        throw new Error("denied");
      },
      get length() {
        throw new Error("denied");
      },
    });
    try {
      expect(updateAchievements(TODAY, null, true)).toEqual({ unlocked: {}, fresh: [] });
    } finally {
      vi.stubGlobal("localStorage", memory);
    }
  });

  it("判定が例外を投げても落ちず、何も保存しないで、保存してある解除を通知なしで返す。次に判定できたときに解除する", () => {
    saveResult(TODAY);
    // 日付を読めなくすると、日付の計算（summarize）が RangeError を投げる
    const parse = vi.spyOn(Date, "parse").mockReturnValue(Number.NaN);
    try {
      expect(() => summarize([], TODAY)).toThrow(RangeError);
      // 初めての判定でも保存しない（例外が無ければ、何も達成していなくても保存する）
      expect(updateAchievements(TODAY, null, true)).toEqual({ unlocked: {}, fresh: [] });
      expect(store.has(KEYS.achievements)).toBe(false);
      // 保存してある解除はそのまま返し、保存も変えない
      const saved = JSON.stringify({ "streak-3": null });
      store.set(KEYS.achievements, saved);
      expect(updateAchievements(TODAY, null, true)).toEqual({ unlocked: { "streak-3": null }, fresh: [] });
      expect(store.get(KEYS.achievements)).toBe(saved);
    } finally {
      parse.mockRestore();
    }
    expect(updateAchievements(TODAY, null, true).fresh.map((a) => a.id)).toEqual(["daily-first"]);
  });

  it("記録を読む途中（練習の進み具合）で例外になっても落ちず、保存を変えない", () => {
    updateAchievements(TODAY, null, false);
    const before = store.get(KEYS.achievements);
    saveResult(TODAY);
    // 局面の無い項目の進み具合を読むと TypeError になる
    store.set(KEYS.practice, JSON.stringify({ "naked-single": ["x"] }));
    const broken = [{ key: "naked-single" }] as unknown as PracticeItem[];
    expect(updateAchievements(TODAY, broken, true)).toEqual({ unlocked: {}, fresh: [] });
    expect(store.get(KEYS.achievements)).toBe(before);
    expect(updateAchievements(TODAY, null, true).fresh.map((a) => a.id)).toEqual(["daily-first"]);
  });
});
