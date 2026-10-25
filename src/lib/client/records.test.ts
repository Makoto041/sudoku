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
  it("今日まで続いていれば今日を含めて数え、今日がまだなら昨日までで数える。2 日続けてクリアしなければ 0", () => {
    const recs = [r("2026-10-13", "easy"), r("2026-10-14", "hard"), r("2026-10-15", "easy")];
    expect(summarize(recs, "2026-10-15").streak).toBe(3);
    expect(summarize(recs, "2026-10-16").streak).toBe(3);
    // 10-16 を休みにして続く（今日の 10-17 はまだ解ける）
    expect(summarize(recs, "2026-10-17").streak).toBe(3);
    expect(summarize(recs, "2026-10-18").streak).toBe(0);
  });

  it("最長の連続は途中で切れていても数える", () => {
    const recs = ["01", "02", "03", "04", "07", "08"].map((d) => r(`2026-10-${d}`, "easy"));
    const s = summarize(recs, "2026-10-08");
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

describe("連続日数の休み", () => {
  it("休みが無ければ今までと同じで、休みの日も無い", () => {
    expect(streaks(oct(...range(1, 5)), "2026-10-05")).toEqual({
      streak: 5,
      longest: 5,
      restDays: new Set(),
    });
  });

  it("1 日だけクリアしなかった日は休みにして、連続は途切れない。休みの日は日数に数えない", () => {
    expect(streaks(oct(1, 2, 4, 5), "2026-10-05")).toEqual({
      streak: 4,
      longest: 4,
      restDays: new Set(oct(3)),
    });
    const s = summarize(
      oct(1, 2, 4, 5).map((d) => r(d, "easy")),
      "2026-10-05",
    );
    expect([s.streak, s.longest, [...s.restDays]]).toEqual([4, 4, oct(3)]);
  });

  it("2 日続けてクリアしないと途切れ、休みにもしない", () => {
    expect(streaks(oct(1, 2, 5, 6), "2026-10-06")).toEqual({ streak: 2, longest: 2, restDays: new Set() });
  });

  it("休みは使った日の 7 日後から使える（7 日後は休み、6 日後は途切れる）", () => {
    // 10-03 に休み。10-10 は 7 日後なので休みにできる
    expect(streaks(oct(1, 2, ...range(4, 9), 11), "2026-10-11")).toEqual({
      streak: 9,
      longest: 9,
      restDays: new Set(oct(3, 10)),
    });
    // 10-09 は 6 日後なので途切れる
    expect(streaks(oct(1, 2, ...range(4, 8), 10), "2026-10-10")).toEqual({
      streak: 1,
      longest: 7,
      restDays: new Set(oct(3)),
    });
  });

  it("古い日から順に決める。後の記録で前の休みや途切れは変わらない", () => {
    // 新しい日から数えると 10-08 が休みになり 10-03 で途切れる（6 日）が、10-08 の時点で 10-03 の休みから 7 日たっていない
    const dates = oct(1, 2, 4, 5, 6, 7, 9, 10);
    expect(streaks(dates, "2026-10-10")).toEqual({ streak: 2, longest: 6, restDays: new Set(oct(3)) });
    // 10-08 の時点の結果と同じ休み
    expect(streaks(oct(1, 2, 4, 5, 6, 7), "2026-10-08").restDays).toEqual(new Set(oct(3)));
  });

  it("連続が途切れても、休みの 7 日は数え直さない", () => {
    // 10-03 に休み、10-05・06 で途切れ、10-07 からの連続で 10-08 は休みにできない
    expect(streaks(oct(1, 2, 4, 7, 9), "2026-10-09")).toEqual({
      streak: 1,
      longest: 3,
      restDays: new Set(oct(3)),
    });
    // 10-10 なら 7 日後なので休みにできる
    expect(streaks(oct(1, 2, 4, 7, 8, 9, 11), "2026-10-11")).toEqual({
      streak: 4,
      longest: 4,
      restDays: new Set(oct(3, 10)),
    });
  });

  it("今日は休みにしない。今日がまだで昨日をクリアしていなければ、昨日を休みとして続ける", () => {
    const dates = oct(1, 2, 3);
    expect(streaks(dates, "2026-10-04")).toEqual({ streak: 3, longest: 3, restDays: new Set() });
    expect(streaks(dates, "2026-10-05")).toEqual({ streak: 3, longest: 3, restDays: new Set(oct(4)) });
    // 今日も解かずに次の日になると途切れ、休みでもなくなる
    expect(streaks(dates, "2026-10-06")).toEqual({ streak: 0, longest: 3, restDays: new Set() });
    // 今日解けば、ふつうの休みと同じ
    expect(streaks(oct(1, 2, 3, 5), "2026-10-05")).toEqual({
      streak: 4,
      longest: 4,
      restDays: new Set(oct(4)),
    });
  });

  it("昨日を休みにしたくても、7 日の間に休みを使っていれば途切れる", () => {
    // 10-02 に休み。10-06 は 4 日後
    expect(streaks(oct(1, 3, 4, 5), "2026-10-07")).toEqual({
      streak: 0,
      longest: 4,
      restDays: new Set(oct(2)),
    });
    // 10-09 は 7 日後なので続く
    expect(streaks(oct(1, ...range(3, 8)), "2026-10-10")).toEqual({
      streak: 7,
      longest: 7,
      restDays: new Set(oct(2, 9)),
    });
  });

  it("先の日付の記録（時計のずれ・書き換え）は今日の連続に入れず、今日より後を休みにしない", () => {
    // 今日の 10-04 をはさんで 10-05 があっても、10-04 は休みにしない
    expect(streaks(oct(1, 2, 3, 5), "2026-10-04")).toEqual({ streak: 3, longest: 3, restDays: new Set() });
    // 最長は今までどおり先の日付の連続も数える
    expect(streaks(oct(10, 11, 12, 14), "2026-10-04")).toEqual({
      streak: 0,
      longest: 3,
      restDays: new Set(),
    });
  });

  it("月・年・うるう年の 2 月の終わりをまたいでも休みにする", () => {
    for (const [from, rest, to] of [
      ["2026-10-31", "2026-11-01", "2026-11-02"],
      ["2026-12-31", "2027-01-01", "2027-01-02"],
      ["2028-02-28", "2028-02-29", "2028-03-01"],
      ["2027-02-28", "2027-03-01", "2027-03-02"],
    ]) {
      expect(streaks([from, to], to), rest).toEqual({ streak: 2, longest: 2, restDays: new Set([rest]) });
    }
  });

  it("日付は日本時間の 0 時で区切る（サーバーと同じ jstDateKey の日付）", () => {
    const key = (iso: string) => jstDateKey(new Date(iso));
    // 日本時間の 10-15 23:59:59 と 10-17 0:00:00。UTC では続いた 2 日だが、日本時間では 10-16 が休み
    const dates = [key("2026-10-15T14:59:59Z"), key("2026-10-16T15:00:00Z")];
    expect(dates).toEqual(oct(15, 17));
    expect(streaks(dates, key("2026-10-17T03:00:00Z"))).toEqual({
      streak: 2,
      longest: 2,
      restDays: new Set(oct(16)),
    });
    // 日本時間の 10-16 0:00:00 と 23:59:59 は同じ日
    const sameDay = [key("2026-10-15T15:00:00Z"), key("2026-10-16T14:59:59Z")];
    expect(streaks(sameDay, "2026-10-16")).toEqual({ streak: 1, longest: 1, restDays: new Set() });
    // 今日が日本時間で変わった直後（10-18 0:00）。10-17 はまだ解いていないが、今日の 10-18 が残っているので休みで続く
    expect(streaks(oct(15, 16), key("2026-10-17T15:00:00Z"))).toEqual({
      streak: 2,
      longest: 2,
      restDays: new Set(oct(17)),
    });
  });

  it("端末のタイムゾーンによらず同じ結果になる（日付は UTC の 0 時として計算する）", () => {
    const tz = process.env.TZ;
    // 米国の夏時間の終わり（2026-11-01）をまたぐ。日付変更線の両側（UTC+14 と UTC-11）でも試す
    const dates = ["2026-10-30", "2026-10-31", ...range(2, 7).map((d) => `2026-11-0${d}`), "2026-11-09"];
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
      expect(s).toEqual({ streak: 9, longest: 9, restDays: new Set(["2026-11-01", "2026-11-08"]) });
  });
});

/** 休みの無かったときの数え方（この変更の前の summarize） */
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

describe("休みで連続日数が減らない（既存の記録）", () => {
  it("休みの無い連続は今までと同じ値になる", () => {
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

  it("どんな日付の列でも、連続日数と最長は今までの数え方より減らない。休みの日は規則どおり", () => {
    const rng = createRng("streak-rest");
    const start = "2026-09-01";
    for (let n = 0; n < 2000; n++) {
      // 60 日のうち、遊ぶ割合を変えて選ぶ。今日は範囲の中か少し後（先の日付の記録も混じる）
      const p = 0.3 + rng() * 0.7;
      const dates = range(0, 59)
        .filter(() => rng() < p)
        .map((i) => addDays(start, i));
      const today = addDays(start, Math.floor(rng() * 64));
      const s = streaks(dates, today);
      const old = strict(dates, today);
      const label = `${dates.join(",")} ${today}`;
      expect(s.streak, label).toBeGreaterThanOrEqual(old.streak);
      expect(s.longest, label).toBeGreaterThanOrEqual(old.longest);
      expect(s.longest, label).toBeGreaterThanOrEqual(s.streak);

      const played = new Set(dates);
      const rests = [...s.restDays].sort();
      for (const [i, d] of rests.entries()) {
        // クリアしなかった今日より前の日で、前の日をクリアしている。次の日もクリアしているか、
        // 今日がまだのときの昨日（休みで続いている途中）
        expect(played.has(d), label).toBe(false);
        expect(d < today, label).toBe(true);
        expect(played.has(addDays(d, -1)), label).toBe(true);
        const pending = d === addDays(today, -1) && !played.has(today);
        expect(played.has(addDays(d, 1)) || pending, label).toBe(true);
        // どの 7 日の間にも休みは 1 日まで
        if (i > 0) expect(addDays(rests[i - 1], 7) <= d, label).toBe(true);
      }

      // 並びと重複によらず同じ結果
      const shuffled = [...dates, ...dates.slice(0, 3)].sort(() => rng() - 0.5);
      expect(streaks(shuffled, today), label).toEqual(s);
    }
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
    const recs = oct(1, 2, 3, 5).map((d) => r(d, "easy"));
    const m = monthView(summarize(recs, "2026-10-05"), 2026, 10, "2026-10-05");
    expect(m.days.filter((d) => d.isRest).map((d) => d.date)).toEqual(oct(4));
    expect(m.days[3]).toMatchObject({ count: 0, isRest: true });
    expect([m.played, m.target, m.perfect]).toEqual([4, 5, false]);
    // 前の月の休みは、その月の日として持つ
    const over = monthView(
      summarize(
        ["2026-09-29", "2026-10-01"].map((d) => r(d, "easy")),
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
