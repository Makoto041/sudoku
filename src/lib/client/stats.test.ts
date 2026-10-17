import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatPoints } from "@/lib/game/score";
import { formatTime } from "@/lib/game/state";
import type { Difficulty } from "@/lib/sudoku/core";
import { summarize } from "./records";
import {
  MAX_COUNT,
  MAX_MS,
  MAX_POINTS,
  bestScores,
  combineStats,
  formatPlayTime,
  freeSummary,
  loadStats,
  mergeStats,
  recordFreeClear,
  recordFreeStart,
  totalPlayMs,
  type Stats,
} from "./stats";
import { KEYS } from "./storage";

// vitest は Node で動くので、localStorage をメモリで置き換える
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});
beforeEach(() => store.clear());

const setStats = (s: unknown) => store.set(KEYS.stats, JSON.stringify(s));

describe("旧形式の記録", () => {
  it("新しい項目が無くても読め、開始数・クリア率・平均時間は出さない", () => {
    setStats({ easy: { played: 5, bestMs: 90_000, cleanBestMs: null, bestPoints: 3000 } });
    expect(freeSummary(loadStats().easy)).toEqual({
      started: null,
      clears: 5,
      clearRate: null,
      avgMs: null,
      bestMs: 90_000,
      cleanBestMs: null,
      bestPoints: 3000,
    });
    expect(freeSummary(undefined)).toMatchObject({ started: 0, clears: 0, clearRate: null, avgMs: null });
  });

  it("更新後のクリアと開始だけでクリア率と平均時間を出し、クリア数は前からの分も数える", () => {
    setStats({ easy: { played: 10, bestMs: 90_000, cleanBestMs: 95_000, bestPoints: 3000 } });
    // 更新前に始めた問題をクリア → 開始数はまだ無い
    recordFreeClear("easy", 120_000.4, 2000, 1, 0);
    expect(freeSummary(loadStats().easy)).toMatchObject({ started: null, clears: 11, avgMs: 120_000 });
    recordFreeStart("easy", null);
    recordFreeStart("easy", null);
    recordFreeClear("easy", 60_000, 4000, 0, 2);
    const s = loadStats().easy!;
    expect(s).toMatchObject({ played: 12, started: 2, trackedClears: 2, totalMs: 180_000 });
    // ヒントを使ったクリアも平均に入れ、最速には入れない
    expect(freeSummary(s)).toMatchObject({
      started: 2,
      clears: 12,
      clearRate: 1,
      avgMs: 90_000,
      bestMs: 90_000,
      bestPoints: 4000,
    });
  });
});

describe("フリープレイの開始", () => {
  it("開始数を数え、途中の問題を上書きしたらその経過時間を足す", () => {
    recordFreeStart("hard", null);
    recordFreeStart("easy", { difficulty: "hard", elapsedMs: 30_000.6 });
    recordFreeStart("easy", { difficulty: "easy", elapsedMs: 0 });
    recordFreeStart("easy", { difficulty: "easy", elapsedMs: Number.NaN });
    const s = loadStats();
    expect(s.hard).toMatchObject({ played: 0, started: 1, abandonedMs: 30_001 });
    expect(s.easy).toMatchObject({ played: 0, started: 3 });
    expect(s.easy?.abandonedMs).toBeUndefined();
  });

  it("途中の問題の難易度や経過時間が不正なら足さず、長すぎる時間は上限で切り詰める", () => {
    recordFreeStart("easy", { difficulty: "nope" as Difficulty, elapsedMs: 5000 });
    recordFreeStart("easy", { difficulty: "easy", elapsedMs: "5000" as unknown as number });
    recordFreeStart("easy", { difficulty: "hard", elapsedMs: 1e20 });
    const s = loadStats();
    expect(s.easy).toEqual({ played: 0, bestMs: null, cleanBestMs: null, bestPoints: null, started: 3 });
    expect(s.hard?.abandonedMs).toBe(MAX_MS);
  });

  it("クリアしても開始数と途中でやめた時間は残る", () => {
    recordFreeStart("easy", { difficulty: "easy", elapsedMs: 5000 });
    recordFreeClear("easy", 70_000, 1000, 0, 0);
    expect(loadStats().easy).toMatchObject({
      started: 1,
      abandonedMs: 5000,
      trackedClears: 1,
      totalMs: 70_000,
    });
  });
});

describe("クリア率と平均時間", () => {
  it("クリア率は 1 を超えず、開始数が 0 なら出さない", () => {
    const base = { played: 3, bestMs: null, cleanBestMs: null };
    expect(freeSummary({ ...base, started: 2, trackedClears: 3 }).clearRate).toBe(1);
    expect(freeSummary({ ...base, started: 4, trackedClears: 1 }).clearRate).toBe(0.25);
    expect(freeSummary({ ...base, started: 0, trackedClears: 3 }).clearRate).toBeNull();
    expect(freeSummary({ ...base, started: 3 }).clearRate).toBe(0);
  });

  it("平均時間はクリア時間の合計 ÷ クリア数。クリアが無ければ出さない", () => {
    const base = { played: 3, bestMs: null, cleanBestMs: null };
    expect(freeSummary({ ...base, trackedClears: 3, totalMs: 300_000 }).avgMs).toBe(100_000);
    expect(freeSummary({ ...base, trackedClears: 0, totalMs: 300_000 }).avgMs).toBeNull();
    expect(freeSummary({ ...base, totalMs: 300_000 }).avgMs).toBeNull();
    // 1 未満のクリア数で割らない（検証前の値を渡されても）
    expect(freeSummary({ ...base, trackedClears: 0.5, totalMs: 60_000 }).avgMs).toBeNull();
    expect(freeSummary({ ...base, trackedClears: 5e-324, totalMs: 60_000 }).avgMs).toBeNull();
  });
});

describe("合計プレイ時間", () => {
  it("フリープレイのクリア時間・途中でやめた時間と、今日の一問のクリア時間を足す", () => {
    const stats: Stats = {
      easy: { played: 1, bestMs: null, cleanBestMs: null, totalMs: 600_000, abandonedMs: 60_000 },
      // 旧形式（時間が無い）は 0 として数える
      hard: { played: 4, bestMs: 100_000, cleanBestMs: null },
    };
    const daily = summarize(
      [
        { date: "2026-10-14", difficulty: "hard", points: 100, timeMs: 1_200_000 },
        { date: "2026-10-15", difficulty: "master", points: null, timeMs: 3_000_000 },
      ],
      "2026-10-15",
    ).perDifficulty;
    expect(totalPlayMs(stats, daily)).toBe(4_860_000);
    expect(formatPlayTime(4_860_000)).toBe("1時間21分");
    expect(formatPlayTime(59_999)).toBe("0分");
    expect(formatPlayTime(12 * 60_000)).toBe("12分");
    expect(formatPlayTime(3 * 3_600_000)).toBe("3時間0分");
  });
});

describe("引き継ぎで受け取った記録と合わせる", () => {
  it("最速・最高点は良い方、クリア数は多い方。開始数などは開始数の多い側から 4 つまとめて取る", () => {
    const cur: Stats = {
      easy: {
        played: 5,
        bestMs: 80_000,
        cleanBestMs: null,
        bestPoints: 2000,
        started: 3,
        trackedClears: 3,
        totalMs: 300_000,
      },
      hard: { played: 1, bestMs: 500_000, cleanBestMs: 500_000, bestPoints: 100 },
    };
    const incoming = {
      easy: {
        played: 4,
        bestMs: 90_000,
        cleanBestMs: 95_000,
        bestPoints: 2500,
        started: 6,
        trackedClears: 2,
        totalMs: 250_000,
        abandonedMs: 10_000,
      },
      master: { played: 1, bestMs: 900_000, cleanBestMs: null, bestPoints: 700 },
    };
    const out = combineStats(cur, incoming);
    expect(out.easy).toEqual({
      played: 5,
      bestMs: 80_000,
      cleanBestMs: 95_000,
      bestPoints: 2500,
      started: 6,
      trackedClears: 2,
      totalMs: 250_000,
      abandonedMs: 10_000,
    });
    // 受け取っていない難易度はそのまま、端末に無い難易度は足す
    expect(out.hard).toEqual(cur.hard);
    expect(out.master).toEqual({ played: 1, bestMs: 900_000, cleanBestMs: null, bestPoints: 700 });

    // 開始数が端末の方が多ければ、端末の 4 つを残す（受け取った abandonedMs だけを混ぜない）
    const kept = combineStats(cur, { easy: { ...incoming.easy, started: 2 } });
    expect(kept.easy).toMatchObject({ started: 3, trackedClears: 3, totalMs: 300_000 });
    expect(kept.easy?.abandonedMs).toBeUndefined();
  });

  it("開始数が同じならクリア数、それも同じなら時間の多い側から取る", () => {
    const base = { played: 1, bestMs: null, cleanBestMs: null };
    const cur: Stats = { easy: { ...base, started: 2, trackedClears: 1, totalMs: 100_000 } };
    expect(
      combineStats(cur, { easy: { ...base, started: 2, trackedClears: 2, totalMs: 1 } }).easy,
    ).toMatchObject({
      trackedClears: 2,
      totalMs: 1,
    });
    expect(
      combineStats(cur, { easy: { ...base, started: 2, trackedClears: 1, totalMs: 100_000, abandonedMs: 5 } })
        .easy,
    ).toMatchObject({ abandonedMs: 5 });
    // 全部同じなら端末の方
    expect(
      combineStats(cur, { easy: { ...base, started: 2, trackedClears: 1, totalMs: 100_000 } }).easy,
    ).toEqual({ ...cur.easy, bestPoints: null });
    // 開始数を数える前の端末に、数え始めてからクリアした記録を受け取る
    expect(combineStats({}, { easy: { ...base, trackedClears: 1, totalMs: 70_000 } }).easy).toMatchObject({
      trackedClears: 1,
      totalMs: 70_000,
    });
  });

  it("受け取った値は検証してから端末の記録と比べる（文字列の数や Infinity で端末の記録を上書きしない）", () => {
    const cur: Stats = { easy: { played: 2, bestMs: 80_000, cleanBestMs: null, bestPoints: 1000 } };
    // JSON の 1e999 は Infinity になる
    const incoming = JSON.parse(
      `{"easy": {"played": "99", "bestMs": -5, "bestPoints": 1e999, "started": 1e300, "trackedClears": -3}}`,
    );
    const out = combineStats(cur, incoming);
    expect(out.easy).toEqual({
      played: 2,
      bestMs: 0,
      cleanBestMs: null,
      bestPoints: 1000,
      started: MAX_COUNT,
      trackedClears: 0,
    });
    expect(freeSummary(out.easy)).toMatchObject({ clearRate: 0, avgMs: null });
  });

  it.each([null, "x", 42, [1, 2]])("受け取った記録が %j なら、端末の記録をそのまま残す", (incoming) => {
    const cur: Stats = { easy: { played: 1, bestMs: null, cleanBestMs: null } };
    expect(combineStats(cur, incoming)).toEqual(cur);
  });

  it("端末に保存し、端末に残っていた難易度でないキーも消す", () => {
    setStats({ easy: { played: 1, bestMs: null, cleanBestMs: null }, junk: { played: 9 } });
    mergeStats({ easy: { played: 3, started: 4, trackedClears: 3, totalMs: 1000 }, other: 1 });
    expect(JSON.parse(store.get(KEYS.stats)!)).toEqual({
      easy: {
        played: 3,
        bestMs: null,
        cleanBestMs: null,
        bestPoints: null,
        started: 4,
        trackedClears: 3,
        totalMs: 1000,
      },
    });
    // オブジェクトでなければ何もしない
    mergeStats("x");
    expect(loadStats().easy?.played).toBe(3);
  });
});

describe("端末の保存データと受け取った記録の検証", () => {
  // JSON の 1e999 は Infinity になり、__proto__ などもふつうのキーとして読まれる
  const DIRTY = `{
    "easy": { "played": "99", "bestMs": -5, "cleanBestMs": "1", "bestPoints": { "toLocaleString": 0 },
              "started": 1e999, "trackedClears": -3, "totalMs": "x", "abandonedMs": null, "extra": { "a": 1 } },
    "medium": { "played": 1e12, "bestMs": 1e300, "cleanBestMs": ${MAX_MS}, "bestPoints": 1e9,
                "started": 2e6, "trackedClears": ${MAX_COUNT}, "totalMs": 1e20, "abandonedMs": 3.2e12 },
    "hard": [1, 2], "expert": 3, "master": "x", "extreme": null,
    "__proto__": { "played": 5 }, "constructor": { "played": 5 }, "foo": { "played": 5 }
  }`;
  const CLEAN: Stats = {
    easy: { played: 0, bestMs: 0, cleanBestMs: null, bestPoints: null, trackedClears: 0 },
    medium: {
      played: MAX_COUNT,
      bestMs: MAX_MS,
      cleanBestMs: MAX_MS,
      bestPoints: MAX_POINTS,
      started: MAX_COUNT,
      trackedClears: MAX_COUNT,
      totalMs: MAX_MS,
      abandonedMs: MAX_MS,
    },
  };

  it.each([
    [
      "端末の保存データ",
      () => {
        store.set(KEYS.stats, DIRTY);
        return loadStats();
      },
    ],
    ["引き継ぎで受け取った記録", () => combineStats({}, JSON.parse(DIRTY))],
  ])("%sは、難易度のキーだけを残し、知らない項目と不正な値を捨て、数を 0〜上限に収める", (_, read) => {
    const out = read();
    expect(out).toEqual(CLEAN);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    // 上限の値でも合計プレイ時間の表示が長くなりすぎない（1 難易度あたり 200 年分）
    expect(formatPlayTime(totalPlayMs(out, summarize([], "2026-10-15").perDifficulty))).toBe(
      "1752000時間0分",
    );
  });

  // 引き継ぎで細工した値。5e-324 は 0 より大きい最小の数
  const CRAFTED = {
    easy: {
      played: 2.9,
      bestMs: null,
      cleanBestMs: null,
      bestPoints: 1234.5678,
      started: 1e-7,
      trackedClears: 5e-324,
      totalMs: MAX_MS,
    },
    hard: {
      played: 1e-7,
      bestMs: 59_999.6,
      cleanBestMs: 0.5,
      started: 3.99,
      trackedClears: 1.9,
      totalMs: MAX_MS,
      abandonedMs: 1e-300,
    },
  };

  it.each([
    [
      "端末の保存データ",
      () => {
        setStats(CRAFTED);
        return loadStats();
      },
    ],
    ["引き継ぎで受け取った記録", () => combineStats({}, CRAFTED)],
  ])("%sの回数は切り捨てて整数に、最高点は四捨五入し、時間は小数のまま残す", (_, read) => {
    const out = read();
    expect(out).toEqual({
      easy: {
        played: 2,
        bestMs: null,
        cleanBestMs: null,
        bestPoints: 1235,
        started: 0,
        trackedClears: 0,
        totalMs: MAX_MS,
      },
      // 最速はクリア時間を小数のまま保存してきたので丸めない（丸めると 00:59 が 01:00 になりうる）
      hard: {
        played: 0,
        bestMs: 59_999.6,
        cleanBestMs: 0.5,
        bestPoints: null,
        started: 3,
        trackedClears: 1,
        totalMs: MAX_MS,
        abandonedMs: 1e-300,
      },
    });

    // 記録画面に出る文字に Infinity・NaN・指数表記・小数が出ず、平均時間は上限（100 年）を超えない
    const shown = (d: "easy" | "hard") => {
      const f = freeSummary(out[d]);
      return [
        f.started !== null ? String(f.started) : "-",
        String(f.clears),
        f.clearRate !== null ? `${Math.round(f.clearRate * 100)}%` : "-",
        ...[f.avgMs, f.bestMs, f.cleanBestMs].map((ms) => (ms !== null ? formatTime(ms) : "-")),
        f.bestPoints !== null ? formatPoints(f.bestPoints) : "-",
      ];
    };
    expect(shown("easy")).toEqual(["0", "2", "-", "-", "-", "-", "1,235"]);
    expect(shown("hard")).toEqual(["3", "0", "33%", "876000:00:00", "00:59", "00:00", "-"]);
    expect(formatPlayTime(totalPlayMs(out, summarize([], "2026-10-15").perDifficulty))).toBe(
      "1752000時間0分",
    );
  });

  it.each(['"x"', "5", "0", "true", "null", "[1, 2]", "{"])(
    "保存データが %s でも空の記録として読み、フリープレイを始められる",
    (raw) => {
      store.set(KEYS.stats, raw);
      expect(loadStats()).toEqual({});
      expect(bestScores()).toEqual({});
      recordFreeStart("easy", null);
      expect(loadStats()).toEqual({
        easy: { played: 0, bestMs: null, cleanBestMs: null, bestPoints: null, started: 1 },
      });
    },
  );

  it("旧版で最高点に不正な値が入った端末でも最高点を出せ、次に記録するときに正しい値で保存し直す", () => {
    setStats({
      easy: { played: 2, bestMs: 90_000, cleanBestMs: null, bestPoints: { toLocaleString: 0 } },
      junk: { played: 9 },
    });
    expect(bestScores()).toEqual({ easy: null });
    recordFreeClear("easy", 60_000, 500, 1, 0);
    expect(JSON.parse(store.get(KEYS.stats)!)).toEqual({
      easy: {
        played: 3,
        bestMs: 60_000,
        cleanBestMs: null,
        bestPoints: 500,
        trackedClears: 1,
        totalMs: 60_000,
      },
    });
  });
});
