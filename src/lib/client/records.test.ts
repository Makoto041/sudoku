import { describe, expect, it } from "vitest";
import { formatPoints } from "@/lib/game/score";
import { formatTime } from "@/lib/game/state";
import {
  addDays,
  isDateKey,
  mergeRecords,
  monthView,
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
