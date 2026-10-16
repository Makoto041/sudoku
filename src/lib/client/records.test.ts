import { describe, expect, it } from "vitest";
import { addDays, mergeRecords, monthView, summarize, type ClearRecord } from "./records";

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
  it("回数・最高点・最速タイム", () => {
    const s = summarize(
      [
        r("2026-10-14", "hard", 300, 90_000),
        r("2026-10-15", "hard", 500, 120_000),
        r("2026-10-15", "easy", null),
      ],
      "2026-10-15",
    );
    expect(s.perDifficulty.hard).toEqual({ clears: 2, bestPoints: 500, bestMs: 90_000 });
    expect(s.perDifficulty.easy.bestPoints).toBeNull();
    expect(s.perDifficulty.master.clears).toBe(0);
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
});
