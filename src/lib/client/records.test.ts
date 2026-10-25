import { describe, expect, it } from "vitest";
import { formatPoints } from "@/lib/game/score";
import { formatTime } from "@/lib/game/state";
import { jstDateKey } from "@/lib/sudoku/generator";
import { createRng } from "@/lib/sudoku/rng";
import {
  addDays,
  isDateKey,
  mergeRecords,
  monthView,
  REST_WINDOW_DAYS,
  streaks,
  summarize,
  validRecords,
  type ClearRecord,
} from "./records";
import { MAX_MS, MAX_POINTS } from "./stats";

const r = (
  date: string,
  difficulty: ClearRecord["difficulty"],
  points: number | null = 100,
  timeMs = 60_000,
) => ({
  date,
  difficulty,
  points,
  timeMs,
});

describe("連続日数", () => {
  it("今日まで続いていれば今日を含めて数え、今日がまだなら昨日までで数える", () => {
    const recs = [r("2026-10-13", "easy"), r("2026-10-14", "hard"), r("2026-10-15", "easy")];
    expect(summarize(recs, "2026-10-15").streak).toBe(3);
    expect(summarize(recs, "2026-10-16").streak).toBe(3);
    expect(summarize(recs, "2026-10-17").streak).toBe(0);
  });

  it("最長の連続は途中で切れていても数える", () => {
    const recs = ["01", "02", "03", "04", "06", "07"].map((d) => r(`2026-10-${d}`, "easy"));
    const s = summarize(recs, "2026-10-07");
    expect(s.streak).toBe(2);
    expect(s.longest).toBe(4);
  });

  it("月をまたいでも続く", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(summarize([r("2026-10-31", "easy"), r("2026-11-01", "easy")], "2026-11-01").streak).toBe(2);
  });
});

/** 2026 年 10 月の日 */
const oct = (...days: number[]) => days.map((d) => `2026-10-${String(d).padStart(2, "0")}`);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** day の前の 6 日（休みにするのに要る日） */
const before6 = (day: string) => range(1, 6).map((k) => addDays(day, -k));

describe("連続日数の休み", () => {
  it("休みが無ければ今までと同じで、休みの日も無い", () => {
    expect(streaks(oct(...range(1, 5)), "2026-10-05")).toEqual({
      streak: 5,
      longest: 5,
      restDays: new Set(),
    });
  });

  it("前の 6 日をすべてクリアしていて次の日もクリアすれば、クリアしなかった日は休み。休みの日は日数に数えない", () => {
    const dates = oct(...range(1, 6), 8, 9);
    expect(streaks(dates, "2026-10-09")).toEqual({ streak: 8, longest: 8, restDays: new Set(oct(7)) });
    const s = summarize(
      dates.map((d) => r(d, "easy")),
      "2026-10-09",
    );
    expect([s.streak, s.longest, [...s.restDays]]).toEqual([8, 8, oct(7)]);
  });

  it("前の 6 日にクリアしなかった日があれば休みにしない（休みの日を含む 7 日に、クリアしなかった日は 1 日まで）", () => {
    // 10-01 をクリアしていないので、10-07 は休みにならない
    expect(streaks(oct(...range(2, 6), 8, 9), "2026-10-09")).toEqual({
      streak: 2,
      longest: 5,
      restDays: new Set(),
    });
    // 10-07 に休み。10-14 は前の 6 日（10-08〜13）がそろうので休み、10-13 は 10-07 が窓に入るので途切れる
    expect(streaks(oct(...range(1, 6), ...range(8, 13), 15), "2026-10-15")).toEqual({
      streak: 13,
      longest: 13,
      restDays: new Set(oct(7, 14)),
    });
    expect(streaks(oct(...range(1, 6), ...range(8, 12), 14), "2026-10-14")).toEqual({
      streak: 1,
      longest: 11,
      restDays: new Set(oct(7)),
    });
  });

  it("2 日続けてクリアしないと途切れ、休みにもしない", () => {
    expect(streaks(oct(...range(1, 6), 9, 10), "2026-10-10")).toEqual({
      streak: 2,
      longest: 6,
      restDays: new Set(),
    });
  });

  it("過去の日が増えても、休みは休みのまま。連続日数と最長は減らない", () => {
    const grow = (dates: string[], added: string, today: string) => {
      const a = streaks(dates, today);
      const b = streaks([...dates, added], today);
      expect(b.streak, added).toBeGreaterThanOrEqual(a.streak);
      expect(b.longest, added).toBeGreaterThanOrEqual(a.longest);
      return [a, b].map(({ streak, longest, restDays }) => [streak, longest, [...restDays].sort()]);
    };
    // 前に休みを使った日から数える決め方では、10-02 が増えると 10-03 が休みになり、10-09 を休めなくなって 26 日から 21 日に減っていた
    expect(grow(oct(1, ...range(4, 8), ...range(10, 30)), "2026-10-02", "2026-10-30")).toEqual([
      [21, 21, []],
      [21, 21, []],
    ]);
    expect(grow(oct(1, ...range(4, 8)), "2026-10-02", "2026-10-08")).toEqual([
      [5, 5, []],
      [5, 5, []],
    ]);
    // 休みの日がクリアになれば、休みでなくなり日数に数える
    expect(grow(oct(...range(1, 6), 8, 9), "2026-10-07", "2026-10-09")).toEqual([
      [8, 8, oct(7)],
      [9, 9, []],
    ]);
    // 前の 6 日がそろえば、休みになってつながる
    expect(grow(oct(...range(2, 6), 8, 9), "2026-10-01", "2026-10-09")).toEqual([
      [2, 5, []],
      [8, 8, oct(7)],
    ]);
    // 10-11 が増えて 10-14 の前の 6 日がそろうと、10-07 と 10-14 の両方が休みになる
    expect(grow(oct(...range(1, 6), 8, 9, 10, 12, 13, 15), "2026-10-11", "2026-10-15")).toEqual([
      [1, 9, oct(7)],
      [13, 13, oct(7, 14)],
    ]);
  });

  it("今日は休みにしない。今日がまだで昨日をクリアしておらず、昨日の前の 6 日がそろっていれば、昨日を暫定の休みにして続ける", () => {
    const dates = oct(...range(1, 6));
    expect(streaks(dates, "2026-10-07")).toEqual({ streak: 6, longest: 6, restDays: new Set() });
    expect(streaks(dates, "2026-10-08")).toEqual({ streak: 6, longest: 6, restDays: new Set(oct(7)) });
    // 今日も解かずに次の日になると途切れ、休みでもなくなる
    expect(streaks(dates, "2026-10-09")).toEqual({ streak: 0, longest: 6, restDays: new Set() });
    // 今日解けば、そのまま休み
    expect(streaks([...dates, "2026-10-08"], "2026-10-08")).toEqual({
      streak: 7,
      longest: 7,
      restDays: new Set(oct(7)),
    });
    // 昨日の前の 6 日がそろっていなければ、今日がまだでも 0
    expect(streaks(oct(...range(2, 6)), "2026-10-08")).toEqual({
      streak: 0,
      longest: 5,
      restDays: new Set(),
    });
    expect(streaks(oct(...range(1, 6), ...range(8, 12)), "2026-10-14")).toEqual({
      streak: 0,
      longest: 11,
      restDays: new Set(oct(7)),
    });
    expect(streaks(oct(...range(1, 6), ...range(8, 13)), "2026-10-15")).toEqual({
      streak: 12,
      longest: 12,
      restDays: new Set(oct(7, 14)),
    });
  });

  it("先の日付の記録（時計のずれ・書き換え）は今日の連続に入れず、今日より後を休みにしない", () => {
    // 今日の 10-07 をはさんで 10-08 があっても、10-07 は休みにしない
    expect(streaks(oct(...range(1, 6), 8), "2026-10-07")).toEqual({
      streak: 6,
      longest: 6,
      restDays: new Set(),
    });
    // 今日より後の 10-07 は、前の 6 日がそろっていても休みにしない。最長は今までどおり先の日付の連続も数える
    expect(streaks(oct(...range(1, 6), 8), "2026-10-05")).toEqual({
      streak: 5,
      longest: 6,
      restDays: new Set(),
    });
  });

  it("月・年・うるう年の 2 月の終わりをまたいでも休みにする", () => {
    for (const [rest, next] of [
      ["2026-11-01", "2026-11-02"],
      ["2027-01-01", "2027-01-02"],
      ["2028-02-29", "2028-03-01"],
      ["2027-03-01", "2027-03-02"],
    ]) {
      expect(addDays(rest, 1)).toBe(next);
      expect(streaks([...before6(rest), next], next), rest).toEqual({
        streak: 7,
        longest: 7,
        restDays: new Set([rest]),
      });
    }
    expect(before6("2027-03-01")[0]).toBe("2027-02-28");
  });

  it("日付は日本時間の 0 時で区切る（サーバーと同じ jstDateKey の日付）", () => {
    const key = (iso: string) => jstDateKey(new Date(iso));
    // 日本時間の 10-15 23:59:59 と 10-17 0:00:00。UTC では続いた 2 日だが、日本時間では 10-16 が休み
    const edges = [key("2026-10-15T14:59:59Z"), key("2026-10-16T15:00:00Z")];
    expect(edges).toEqual(oct(15, 17));
    expect(streaks([...oct(...range(10, 14)), ...edges], key("2026-10-17T03:00:00Z"))).toEqual({
      streak: 7,
      longest: 7,
      restDays: new Set(oct(16)),
    });
    // 日本時間の 10-16 0:00:00 と 23:59:59 は同じ日
    const sameDay = [key("2026-10-15T15:00:00Z"), key("2026-10-16T14:59:59Z")];
    expect(streaks(sameDay, "2026-10-16")).toEqual({ streak: 1, longest: 1, restDays: new Set() });
    // 今日が日本時間で変わった直後（10-18 0:00）。10-17 はまだ解いていないが、今日の 10-18 が残っているので暫定の休みで続く
    expect(streaks(oct(...range(11, 16)), key("2026-10-17T15:00:00Z"))).toEqual({
      streak: 6,
      longest: 6,
      restDays: new Set(oct(17)),
    });
  });

  it("端末のタイムゾーンによらず同じ結果になる（日付は UTC の 0 時として計算する）", () => {
    const tz = process.env.TZ;
    // 米国の夏時間の終わり（2026-11-01）をまたぐ。日付変更線の両側（UTC+14 と UTC-11）でも試す
    const dates = [...before6("2026-11-01"), ...before6("2026-11-08"), "2026-11-09"];
    const results = [];
    try {
      for (const zone of [
        "UTC",
        "Asia/Tokyo",
        "America/New_York",
        "Pacific/Kiritimati",
        "Pacific/Pago_Pago",
      ]) {
        process.env.TZ = zone;
        results.push(streaks(dates, "2026-11-09"));
      }
      // タイムゾーンを切り替えられている（切り替えられない環境ではこのテストは意味がない）
      process.env.TZ = "Pacific/Kiritimati";
      const east = new Date(0).getTimezoneOffset();
      process.env.TZ = "Pacific/Pago_Pago";
      expect(new Date(0).getTimezoneOffset()).not.toBe(east);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
    expect(results).toHaveLength(5);
    for (const s of results)
      expect(s).toEqual({ streak: 13, longest: 13, restDays: new Set(["2026-11-01", "2026-11-08"]) });
  });
});

/** 休みの無かったときの数え方（休みを入れる前の summarize） */
function strict(dates: string[], today: string) {
  const set = new Set(dates);
  let streak = 0;
  let day = set.has(today) ? today : addDays(today, -1);
  while (set.has(day)) {
    streak++;
    day = addDays(day, -1);
  }
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of [...set].sort()) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { streak, longest };
}

const START = "2026-09-01";
/** 60 日のうち、遊ぶ割合を変えて選んだ日付と、範囲の中か少し後の今日（先の日付の記録も混じる） */
function randomCase(rng: () => number) {
  const p = 0.3 + rng() * 0.7;
  const dates = range(0, 59)
    .filter(() => rng() < p)
    .map((i) => addDays(START, i));
  return { dates, today: addDays(START, Math.floor(rng() * 64)) };
}
/** 日付を作る範囲のすべての日 */
const ALL_DAYS = range(0, 63).map((i) => addDays(START, i));

describe("休みで連続日数が減らない", () => {
  it("休みの無い連続は前と同じ値になる", () => {
    for (const [dates, today] of [
      [oct(1, 2, 3, 6, 7), "2026-10-07"],
      [oct(1, 2, 3, 6, 7), "2026-10-08"],
      [oct(1, 2, 3, 6, 7), "2026-10-20"],
      [oct(5, 6, 7, 8), "2026-10-03"],
      [[], "2026-10-07"],
    ] as const) {
      const { streak, longest } = streaks(dates, today);
      expect({ streak, longest }, `${dates.join(",")} ${today}`).toEqual(strict([...dates], today));
    }
  });

  it("どんな日付の列でも、休みの無かったときの数え方より減らない。休みの日は規則どおりで、規則に合う日はすべて休み", () => {
    const rng = createRng("streak-rest");
    for (let n = 0; n < 2000; n++) {
      const { dates, today } = randomCase(rng);
      const s = streaks(dates, today);
      const old = strict(dates, today);
      const label = `${dates.join(",")} ${today}`;
      expect(s.streak, label).toBeGreaterThanOrEqual(old.streak);
      expect(s.longest, label).toBeGreaterThanOrEqual(old.longest);
      expect(s.longest, label).toBeGreaterThanOrEqual(s.streak);

      const played = new Set(dates);
      const yesterday = addDays(today, -1);
      // 規則で休みになる日: 今日より前のクリアしなかった日で、前の 6 日をすべてクリアし、次の日もクリアしているか、今日がまだのときの昨日
      const isRest = (g: string) =>
        !played.has(g) &&
        g < today &&
        before6(g).every((d) => played.has(d)) &&
        (played.has(addDays(g, 1)) || (g === yesterday && !played.has(today)));
      const expected = ALL_DAYS.filter(isRest);
      expect([...s.restDays].sort(), label).toEqual(expected);
      // 休みの日を含む 7 日に休みは 1 日まで
      for (let i = 1; i < expected.length; i++)
        expect(addDays(expected[i - 1], REST_WINDOW_DAYS) <= expected[i], label).toBe(true);

      // 並びと重複によらず同じ結果
      const shuffled = [...dates, ...dates.slice(0, 3)].sort(() => rng() - 0.5);
      expect(streaks(shuffled, today), label).toEqual(s);
    }
  });

  it("どんな日付の列でも、クリアした日を 1 つ足して（ほかの端末やアカウントから届いた過去の日など）連続日数と最長が減らない", () => {
    const rng = createRng("streak-rest-grow");
    let checked = 0;
    for (let n = 0; n < 3000; n++) {
      const { dates, today } = randomCase(rng);
      const played = new Set(dates);
      // 足す日は今日より前（過去の日）を中心に、今日と先の日もときどき選ぶ
      const missing = ALL_DAYS.filter((d) => !played.has(d) && (d < today || rng() < 0.2));
      if (!missing.length) continue;
      const added = missing[Math.floor(rng() * missing.length)];
      const a = streaks(dates, today);
      const b = streaks([...dates, added], today);
      const label = `${dates.join(",")} ${today} +${added}`;
      expect(b.streak, label).toBeGreaterThanOrEqual(a.streak);
      expect(b.longest, label).toBeGreaterThanOrEqual(a.longest);
      // 休みが休みでなくなるのは、その日をクリアしたときだけ
      for (const d of a.restDays) expect(b.restDays.has(d) || d === added, label).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(2000);
  });
});

describe("難易度ごとの集計と重複", () => {
  it("回数・最高点・最速タイム・平均・合計時間", () => {
    const s = summarize(
      [
        r("2026-10-14", "hard", 300, 90_000),
        r("2026-10-15", "hard", 500, 120_000),
        r("2026-10-15", "easy", null),
      ],
      "2026-10-15",
    );
    expect(s.perDifficulty.hard).toEqual({
      clears: 2,
      bestPoints: 500,
      bestMs: 90_000,
      totalMs: 210_000,
      avgMs: 105_000,
      avgPoints: 400,
    });
    expect(s.perDifficulty.easy.bestPoints).toBeNull();
    expect(s.perDifficulty.master).toEqual({
      clears: 0,
      bestPoints: null,
      bestMs: null,
      totalMs: 0,
      avgMs: null,
      avgPoints: null,
    });
  });

  it("平均点は点数のある記録（スコア制になってから）だけで出し、平均時間はすべての記録で出す", () => {
    const s = summarize(
      [
        r("2026-10-13", "easy", null, 300_000),
        r("2026-10-14", "easy", 101, 60_000),
        r("2026-10-15", "easy", 200, 90_000),
      ],
      "2026-10-15",
    ).perDifficulty.easy;
    expect(s).toMatchObject({ clears: 3, totalMs: 450_000, avgMs: 150_000, avgPoints: 151 });
    expect(summarize([r("2026-10-15", "easy", null)], "2026-10-15").perDifficulty.easy.avgPoints).toBeNull();
  });

  it("時間が数でない記録（端末の保存データが壊れていた）は、時間の集計に入れない", () => {
    const s = summarize(
      [
        r("2026-10-13", "easy", 100, "60000" as unknown as number),
        r("2026-10-14", "easy", 200, null as unknown as number),
        r("2026-10-15", "easy", 300, 90_000),
      ],
      "2026-10-15",
    );
    expect(s.perDifficulty.easy).toEqual({
      clears: 3,
      bestPoints: 300,
      bestMs: 90_000,
      totalMs: 90_000,
      avgMs: 90_000,
      avgPoints: 200,
    });
    expect(s.streak).toBe(3);
  });

  it("点数や時間が数でないか 0〜上限の外の記録は、その集計から除く（クリア数と連続日数には数える）", () => {
    const bad = (x: unknown) => x as number;
    const s = summarize(
      [
        // 0 と上限は入れる
        r("2026-10-06", "easy", 0, 0),
        r("2026-10-07", "easy", MAX_POINTS, MAX_MS),
        r("2026-10-08", "easy", bad("100"), 1e308),
        r("2026-10-09", "easy", bad({ toLocaleString: 0 }), -5000),
        r("2026-10-10", "easy", -1, MAX_MS + 1),
        r("2026-10-11", "easy", MAX_POINTS + 1, Number.NaN),
        r("2026-10-12", "easy", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
        r("2026-10-13", "easy", Number.NaN, -1),
        r("2026-10-13", "hard", bad({ toLocaleString: 0 }), 1e308),
      ],
      "2026-10-13",
    );
    expect(s.perDifficulty.easy).toEqual({
      clears: 8,
      bestPoints: MAX_POINTS,
      bestMs: 0,
      totalMs: MAX_MS,
      avgMs: MAX_MS / 2,
      avgPoints: MAX_POINTS / 2,
    });
    expect(s.perDifficulty.hard).toEqual({
      clears: 1,
      bestPoints: null,
      bestMs: null,
      totalMs: 0,
      avgMs: null,
      avgPoints: null,
    });
    expect(s.streak).toBe(8);
    // 記録画面の表示が壊れない
    const e = s.perDifficulty.easy;
    expect([
      formatTime(e.avgMs!),
      formatTime(e.bestMs!),
      formatPoints(e.bestPoints!),
      formatPoints(e.avgPoints!),
    ]).toEqual(["438000:00:00", "00:00", "1,000,000", "500,000"]);
  });

  it("サーバーと端末の両方にある記録は 1 つにまとめ、点数のある方を残す", () => {
    const merged = mergeRecords([r("2026-10-15", "easy", null)], [r("2026-10-15", "easy", 800)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].points).toBe(800);
  });
});

describe("カレンダー", () => {
  it("今月は今日までで皆勤を判定し、曜日と未来の日を持つ", () => {
    const recs = ["01", "02", "03"].map((d) => r(`2026-10-${d}`, "easy"));
    const m = monthView(summarize(recs, "2026-10-03"), 2026, 10, "2026-10-03");
    expect(m.days).toHaveLength(31);
    expect(m.firstWeekday).toBe(4); // 2026-10-01 は木曜
    expect(m.played).toBe(3);
    expect(m.target).toBe(3);
    expect(m.perfect).toBe(true);
    expect(m.days[3].isFuture).toBe(true);
    expect(m.days[2].isToday).toBe(true);
    const later = monthView(summarize(recs, "2026-10-05"), 2026, 10, "2026-10-05");
    expect(later.perfect).toBe(false);
  });

  it("休みの日を持つ。休みの日は遊んだ日にも皆勤にも数えない", () => {
    const recs = oct(...range(1, 6), 8).map((d) => r(d, "easy"));
    const m = monthView(summarize(recs, "2026-10-08"), 2026, 10, "2026-10-08");
    expect(m.days.filter((d) => d.isRest).map((d) => d.date)).toEqual(oct(7));
    expect(m.days[6]).toMatchObject({ count: 0, isRest: true });
    expect([m.played, m.target, m.perfect]).toEqual([7, 8, false]);
    // 前の月の休みは、その月の日として持つ
    const over = monthView(
      summarize(
        [...before6("2026-09-30"), "2026-10-01"].map((d) => r(d, "easy")),
        "2026-10-01",
      ),
      2026,
      9,
      "2026-10-01",
    );
    expect(over.days.filter((d) => d.isRest).map((d) => d.date)).toEqual(["2026-09-30"]);
  });

  it("その日にクリアした難易度の数を持つ", () => {
    const s = summarize([r("2026-10-02", "easy"), r("2026-10-02", "hard")], "2026-10-02");
    expect(monthView(s, 2026, 10, "2026-10-02").days[1].count).toBe(2);
  });

  it("年が 4 桁に満たなくても 4 桁にそろえた日付で月を作る（V8 は「1-01-01」を日付として読めず落ちる）", () => {
    const today = "2026-10-17";
    const m = monthView(summarize([r("0001-01-01", "easy")], today), 1, 1, today);
    expect(m.days).toHaveLength(31);
    expect(m.days[0]).toMatchObject({ date: "0001-01-01", count: 1 });
    expect(monthView(summarize([], today), 999, 5, today).days[0].date).toBe("0999-05-01");
  });
});

describe("記録の検証", () => {
  it("日付は 2000〜2999 年の実在する日だけを「2026-10-17」の形で受け付ける", () => {
    for (const ok of ["2000-01-01", "2026-10-17", "2028-02-29", "2999-12-31"])
      expect(isDateKey(ok), ok).toBe(true);
    for (const ng of [
      "1999-12-31",
      "3000-01-01",
      "0001-01-01",
      "0999-05-01",
      "9999-12-31",
      // 実在しない日
      "2026-02-30",
      "2027-02-29",
      "2026-13-01",
      "2026-00-10",
      // 形が違う
      "2026-1-01",
      "2026/10/01",
      " 2026-10-01",
      "+002026-10-01",
      "",
      20261001,
      null,
      undefined,
    ])
      expect(isDateKey(ng), String(ng)).toBe(false);
  });

  it("日付や難易度が正しくない記録を捨てる（summarize が日付の計算で落ちない）", () => {
    const raw = [
      { date: "0x", difficulty: "easy" },
      { date: "2026-02-30", difficulty: "easy" },
      { date: "0001-01-01", difficulty: "easy" },
      { date: "0999-05-01", difficulty: "easy" },
      { date: "9999-12-31", difficulty: "easy" },
      { date: 20261001, difficulty: "easy" },
      { date: "2026-10-01", difficulty: "nope" },
      null,
      "x",
      [],
      r("2026-10-02", "easy"),
      r("2026-10-03", "hard"),
    ];
    // そのままだと日付の計算で例外になる
    expect(() => summarize([raw[0], r("2026-10-02", "easy")] as ClearRecord[], "2026-10-17")).toThrow(
      RangeError,
    );
    expect(validRecords(raw)).toEqual([r("2026-10-02", "easy"), r("2026-10-03", "hard")]);
    for (const x of [null, "x", 42, { 0: r("2026-10-02", "easy") }]) expect(validRecords(x)).toEqual([]);
  });
});
