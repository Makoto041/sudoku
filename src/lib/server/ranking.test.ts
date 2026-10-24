import { describe, expect, it, vi } from "vitest";
import { DIFFICULTIES, parseGrid, serializeGrid } from "@/lib/sudoku/core";
import { generateDaily } from "@/lib/sudoku/generator";
import { solve } from "@/lib/sudoku/solver";
import {
  MAX_STATS_BYTES,
  MIN_PLAUSIBLE_MS,
  NAME_MAX,
  RankingError,
  getLeaderboard,
  renamePlayer,
  sanitizeName,
  startDaily,
  submitDaily,
  getHistory,
  createTransfer,
  claimTransfer,
} from "./ranking";
import { normalizeCode } from "@/lib/transfer-code";
import { scoreMoves, timeBonus, type MoveLog } from "@/lib/game/score";
import { MemoryStore, fromRankValue, rankValue } from "./store";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-10-15T03:00:00Z"); // JST 12:00

const solutionOf = (puzzle: string) => serializeGrid(solve(parseGrid(puzzle))!);

async function solveDaily(store: MemoryStore, playerId: string, elapsedMs: number, name = "テスト") {
  const started = await startDaily(store, { playerId, difficulty: "easy" }, T0);
  const solution = solutionOf(started.puzzle);
  return submitDaily(store, { sessionId: started.sessionId, playerId, grid: solution, name }, T0 + elapsedMs);
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toBeInstanceOf(RankingError);
  await promise.catch((e: RankingError) => expect(e.status).toBe(status));
}

describe("daily ranking", () => {
  it("開始すると解答を含まない問題が返る", async () => {
    const store = new MemoryStore();
    const res = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    expect(res.date).toBe("2026-10-15");
    expect(res.puzzle).toMatch(/^[0-9]{81}$/);
    expect(res.puzzle).toContain("0");
    expect(res).not.toHaveProperty("solution");
  });

  it("開始し直しても最初の開始時刻が使われる", async () => {
    const store = new MemoryStore();
    const a = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const b = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0 + 60_000);
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.startedAt).toBe(T0);
  });

  it("正しい解答はサーバー時刻で記録され、順位が付く", async () => {
    const store = new MemoryStore();
    const bob = await solveDaily(store, BOB, 200_000, "ボブ");
    const alice = await solveDaily(store, ALICE, 100_000, "アリス");
    expect(bob).toMatchObject({ timeMs: 200_000, rank: 1, total: 1 });
    expect(alice).toMatchObject({ timeMs: 100_000, rank: 1, total: 2 });

    const board = await getLeaderboard(
      store,
      { scope: "daily", difficulty: "easy", date: "2026-10-15", playerId: BOB },
      T0,
    );
    expect(board.entries.map((e) => [e.rank, e.name, e.isMe])).toEqual([
      [1, "アリス", false],
      [2, "ボブ", true],
    ]);
    expect(board.me).toMatchObject({ rank: 2, timeMs: 200_000 });

    const best = await getLeaderboard(store, { scope: "best", difficulty: "easy" }, T0);
    expect(best.entries).toHaveLength(2);
  });

  it("2 回目の送信は拒否する", async () => {
    const store = new MemoryStore();
    const started = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const grid = solutionOf(started.puzzle);
    const body = { sessionId: started.sessionId, playerId: ALICE, grid, name: "a" };
    await submitDaily(store, body, T0 + 100_000);
    await expectStatus(submitDaily(store, body, T0 + 120_000), 409);
  });

  it("誤答・速すぎる送信・他人のセッションは拒否する", async () => {
    const store = new MemoryStore();
    const started = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const solution = parseGrid(solutionOf(started.puzzle));
    const wrong = solution.slice();
    [wrong[0], wrong[1]] = [wrong[1], wrong[0]];
    const base = { sessionId: started.sessionId, playerId: ALICE, name: "a" };

    await expectStatus(submitDaily(store, { ...base, grid: serializeGrid(wrong) }, T0 + 100_000), 422);
    await expectStatus(
      submitDaily(store, { ...base, grid: serializeGrid(solution) }, T0 + MIN_PLAUSIBLE_MS - 1),
      422,
    );
    await expectStatus(
      submitDaily(store, { ...base, playerId: BOB, grid: serializeGrid(solution) }, T0 + 100_000),
      404,
    );
    await expectStatus(submitDaily(store, { ...base, grid: "1".repeat(80) }, T0 + 100_000), 400);
    // 拒否された後でも正しい解答は記録できる
    await expect(
      submitDaily(store, { ...base, grid: serializeGrid(solution) }, T0 + 100_000),
    ).resolves.toMatchObject({ rank: 1 });
  });

  it("不正な入力は 400", async () => {
    const store = new MemoryStore();
    await expectStatus(startDaily(store, { playerId: "nope", difficulty: "easy" }, T0), 400);
    await expectStatus(startDaily(store, { playerId: ALICE, difficulty: "insane" }, T0), 400);
    await expectStatus(renamePlayer(store, { playerId: ALICE, name: "   " }), 400);
    await expectStatus(
      getLeaderboard(store, { scope: "daily", difficulty: "easy", date: "2026-99-99" }, T0),
      400,
    );
  });
});

describe("daily puzzle pinning", () => {
  it("固定済みの問題があればそれを配り、その問題で照合する", async () => {
    const store = new MemoryStore();
    // 生成のコードが変わる前に固定された問題、という想定で別の日の問題を入れておく
    const pinned = serializeGrid(generateDaily("2000-01-01", "easy").puzzle);
    await store.pinDailyPuzzle("2026-10-15", "easy", pinned);
    const started = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    expect(started.puzzle).toBe(pinned);
    const res = await submitDaily(
      store,
      { sessionId: started.sessionId, playerId: ALICE, grid: solutionOf(pinned), name: "a" },
      T0 + 60_000,
    );
    expect(res.rank).toBe(1);
  });

  it("同じ日・難易度は全員が同じ問題", async () => {
    const store = new MemoryStore();
    const a = await startDaily(store, { playerId: ALICE, difficulty: "master" }, T0);
    const b = await startDaily(store, { playerId: BOB, difficulty: "master" }, T0 + 1000);
    expect(a.puzzle).toBe(b.puzzle);
  });

  it("記録の途中で失敗しても、再送すれば記録できる", async () => {
    class Flaky extends MemoryStore {
      failOnce = true;
      async record(...args: Parameters<MemoryStore["record"]>) {
        if (this.failOnce) {
          this.failOnce = false;
          throw new Error("redis down");
        }
        return super.record(...args);
      }
    }
    const store = new Flaky();
    const started = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const body = {
      sessionId: started.sessionId,
      playerId: ALICE,
      grid: solutionOf(started.puzzle),
      name: "a",
    };
    await expect(submitDaily(store, body, T0 + 60_000)).rejects.toThrow("redis down");
    await expect(submitDaily(store, body, T0 + 61_000)).resolves.toMatchObject({ rank: 1, timeMs: 61_000 });
  });
});

describe("sanitizeName", () => {
  it("正規化・制御文字除去・長さ制限", () => {
    expect(sanitizeName("  ＡＢＣ  ")).toBe("ABC");
    expect(sanitizeName("a\u0000b\nc")).toBe("abc");
    expect(sanitizeName("あいうえおかきくけこさしすせそ")).toBe("あいうえおかきくけこさし");
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName(42)).toBeNull();
    expect(sanitizeName("👨\u200d👩\u200d👧")).toBe("👨\u200d👩\u200d👧");
    expect(sanitizeName("\u3164\u3164")).toBeNull();
    expect(sanitizeName("\u0301\u0301")).toBeNull();
  });
});

describe("スコア", () => {
  it("並べ順の値から点数とタイムを元に戻せる", () => {
    for (const [points, timeMs] of [
      [0, 15_000],
      [12_345, 600_000],
      [99_999, 86_400_000],
      [1, 0],
    ]) {
      expect(fromRankValue(rankValue(points, timeMs))).toEqual({ points, timeMs });
    }
    // 点数が高いほうが上、同点ならタイムが速いほうが上
    expect(rankValue(200, 900_000)).toBeLessThan(rankValue(100, 20_000));
    expect(rankValue(100, 20_000)).toBeLessThan(rankValue(100, 30_000));
  });

  it("手の記録から点数を計算し、点数の高い順に並べる（端末の表示と同じ計算）", async () => {
    const store = new MemoryStore();
    const a = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const b = await startDaily(store, { playerId: BOB, difficulty: "easy" }, T0);
    const puzzle = parseGrid(a.puzzle);
    const solution = solve(puzzle)!;
    const empties = puzzle.flatMap((v, i) => (v ? [] : [i]));
    // アリス：ゆっくり（20 秒おき）。ボブ：速い（2 秒おき）が最初に 2 回間違える
    const slow: MoveLog = empties.map((c, k) => [(k + 1) * 20_000, c, solution[c]]);
    const fastWithMistakes: MoveLog = [
      [1000, empties[0], (solution[empties[0]] % 9) + 1],
      [1500, empties[1], (solution[empties[1]] % 9) + 1],
      ...empties.map((c, k): [number, number, number] => [(k + 1) * 2000, c, solution[c]]),
    ];
    const grid = serializeGrid(solution);
    const ra = await submitDaily(
      store,
      { sessionId: a.sessionId, playerId: ALICE, grid, name: "アリス", moves: slow },
      T0 + empties.length * 20_000 + 1000,
    );
    const rb = await submitDaily(
      store,
      { sessionId: b.sessionId, playerId: BOB, grid, name: "ボブ", moves: fastWithMistakes },
      T0 + empties.length * 2000 + 1000,
    );
    expect(ra.points).toBe(scoreMoves(puzzle, solution, "easy", slow, ra.timeMs).points);
    expect(rb.points).toBeGreaterThan(ra.points);
    const board = await getLeaderboard(store, { scope: "daily", difficulty: "easy", date: "2026-10-15" }, T0);
    expect(board.entries.map((e) => e.name)).toEqual(["ボブ", "アリス"]);
    expect(board.entries[0].points).toBe(rb.points);
  });

  it("手の記録の形が不正なら 400", async () => {
    const store = new MemoryStore();
    const a = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const grid = solutionOf(a.puzzle);
    const base = { sessionId: a.sessionId, playerId: ALICE, grid, name: "a" };
    await expectStatus(submitDaily(store, { ...base, moves: "x" }, T0 + 60_000), 400);
    await expectStatus(submitDaily(store, { ...base, moves: [[0, 81, 1]] }, T0 + 60_000), 400);
    await expectStatus(submitDaily(store, { ...base, moves: [[0, 1, 10]] }, T0 + 60_000), 400);
  });
});

describe("時間ボーナス", () => {
  it("サーバーが測った経過時間で時間ボーナスを付け、内訳を返す", async () => {
    const store = new MemoryStore();
    const a = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const puzzle = parseGrid(a.puzzle);
    const solution = solve(puzzle)!;
    const empties = puzzle.flatMap((v, i) => (v ? [] : [i]));
    const moves: MoveLog = empties.map((c, k) => [(k + 1) * 1000, c, solution[c]]);
    const res = await submitDaily(
      store,
      { sessionId: a.sessionId, playerId: ALICE, grid: serializeGrid(solution), name: "a", moves },
      T0 + 120_000,
    );
    expect(res.timeBonus).toBe(timeBonus("easy", puzzle, 120_000));
    expect(res.points).toBe(scoreMoves(puzzle, solution, "easy", moves, 120_000).points + res.timeBonus);
  });
});

describe("記録と引き継ぎ", () => {
  it("今日の一問をクリアすると履歴に残り、同じ日・難易度は最初の 1 回だけ", async () => {
    const store = new MemoryStore();
    await solveDaily(store, ALICE, 100_000, "アリス");
    const { entries } = await getHistory(store, { playerId: ALICE });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ date: "2026-10-15", difficulty: "easy", timeMs: 100_000 });
    expect(typeof entries[0].points).toBe("number");
    await store.addHistory(ALICE, { date: "2026-10-15", difficulty: "easy", points: 1, timeMs: 1 });
    expect((await getHistory(store, { playerId: ALICE })).entries[0].timeMs).toBe(100_000);
  });

  it("引き継ぎコードで同じプレイヤー ID と名前・記録を受け取れ、コードは 1 回だけ使える", async () => {
    const store = new MemoryStore();
    const { code, expiresAt } = await createTransfer(
      store,
      { playerId: ALICE, name: "アリス", stats: { easy: { bestPoints: 1234 } } },
      T0,
    );
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(expiresAt).toBe(T0 + 24 * 60 * 60 * 1000);
    const pretty = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
    await expect(claimTransfer(store, { code: pretty })).resolves.toEqual({
      playerId: ALICE,
      name: "アリス",
      stats: { easy: { bestPoints: 1234 } },
    });
    await expectStatus(claimTransfer(store, { code }), 404);
    await expectStatus(claimTransfer(store, { code: "abc" }), 400);
    expect(normalizeCode("0000-0000")).toBeNull();
  });

  it("大きすぎる記録は受け付けない", async () => {
    const store = new MemoryStore();
    await expectStatus(createTransfer(store, { playerId: ALICE, stats: "x".repeat(5000) }), 400);
  });

  it("記録の大きさは UTF-8 のバイト数で数える（文字数が上限より少なくても、バイト数で超えれば 400）", async () => {
    const store = new MemoryStore();
    const stats = "あ".repeat(1400);
    const payload = JSON.stringify({ playerId: ALICE, name: null, stats });
    expect(payload.length).toBeLessThan(MAX_STATS_BYTES);
    expect(Buffer.byteLength(payload)).toBeGreaterThan(MAX_STATS_BYTES);
    await expectStatus(createTransfer(store, { playerId: ALICE, stats }), 400);
    // 上限ちょうどのバイト数までは受け付ける
    const fits = "あ".repeat(Math.floor((MAX_STATS_BYTES - (payload.length - stats.length)) / 3));
    expect(
      Buffer.byteLength(JSON.stringify({ playerId: ALICE, name: null, stats: fits })),
    ).toBeLessThanOrEqual(MAX_STATS_BYTES);
    await expect(createTransfer(store, { playerId: ALICE, stats: fits })).resolves.toHaveProperty("code");
  });

  it("開始数などの新しい項目を含む記録も往復でき、6 難易度ぶんでも上限のバイト数に収まる", async () => {
    const store = new MemoryStore();
    // 端末の記録の数は 0 以上で、端末が切り詰める上限（1e21 よりずっと小さい）の付近までにしかならない。
    // そうした数を JSON にしたときにいちばん長くなる形（有効数字 17 桁の小数、24 文字）で項目をすべて埋めた最悪の記録
    const longest = 0.0000012345678901234567;
    expect(JSON.stringify(longest)).toHaveLength(24);
    const keys = "played bestMs cleanBestMs bestPoints started trackedClears totalMs abandonedMs".split(" ");
    const entry = Object.fromEntries(keys.map((k) => [k, longest]));
    const stats = Object.fromEntries(DIFFICULTIES.map((d) => [d, entry]));
    const name = "𠮷".repeat(NAME_MAX);
    const payload = JSON.stringify({ playerId: ALICE, name, stats });
    expect(new TextEncoder().encode(payload).length).toBeLessThan(MAX_STATS_BYTES);
    const { code } = await createTransfer(store, { playerId: ALICE, name, stats }, T0);
    const res = await claimTransfer(store, { code });
    expect(res.stats).toEqual(stats);
  });

  it("記録の中身はサーバーでは解釈せずにそのまま渡す（検証は受け取った端末でする）", async () => {
    const store = new MemoryStore();
    const stats = JSON.parse(
      `{"easy": {"played": "x", "started": -1, "trackedClears": 1e999, "totalMs": 60000, "future": {"a": 1}},
        "__proto__": {"played": 1}, "foo": [1, 2], "hard": null}`,
    );
    const { code } = await createTransfer(store, { playerId: ALICE, stats }, T0);
    const res = await claimTransfer(store, { code });
    expect(res.stats).toEqual(JSON.parse(JSON.stringify(stats)));
    // 記録が無い・オブジェクトでない場合も壊れない
    for (const s of [undefined, null, 42, "x", [1, 2]]) {
      const created = await createTransfer(store, { playerId: ALICE, stats: s }, T0);
      await expect(claimTransfer(store, { code: created.code })).resolves.toMatchObject({ playerId: ALICE });
    }
  });
});

describe("回数制限（今日の一問の開始・引き継ぎ）", () => {
  const IP = "203.0.113.7";
  const OTHER_IP = "198.51.100.7";
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  /** 別々のプレイヤー ID */
  const pid = (i: number) => `${i.toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`;
  /** 形は正しいが発行していないコード */
  const unknownCode = (i: number) =>
    `ABCD${"23456789"[i % 8]}${"23456789"[(i >> 3) % 8]}${"23456789"[(i >> 6) % 8]}Z`;
  /** 別々の IP（i は 65,536 未満） */
  const ipOf = (i: number) => `198.18.${i >> 8}.${i & 0xff}`;
  const start = (store: MemoryStore, i: number, now: number, ip: string | null = IP) =>
    startDaily(store, { playerId: pid(i), difficulty: "easy" }, now, { ip });

  it("今日の一問の開始は IP ごとに 1 時間 240 回までで、次の 1 回は 429。窓が変われば、また受け付ける", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 240; i++) await start(store, i, T0 + i);
    await expectStatus(start(store, 240, T0 + 240), 429);
    // 開始し直し（同じプレイヤー）も数える
    await expectStatus(start(store, 0, T0 + 240), 429);
    // IP ごとに別に数える
    await expect(start(store, 240, T0 + 240, OTHER_IP)).resolves.toHaveProperty("sessionId");
    // 次の 1 時間の窓
    await expect(start(store, 241, T0 + HOUR)).resolves.toHaveProperty("sessionId");
  });

  it("IP が取れない要求は 1 つにまとめて数える。入力の誤り（400）は数えない", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 300; i++) {
      await expectStatus(startDaily(store, { playerId: "nope", difficulty: "easy" }, T0, { ip: null }), 400);
    }
    for (let i = 0; i < 240; i++) await start(store, i, T0, null);
    await expectStatus(start(store, 240, T0, null), 429);
  });

  it("引き継ぎコードの発行は IP ごとに 1 時間 10 回までで、次の 1 回は 429。窓が変われば、また受け付ける", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 10; i++) await createTransfer(store, { playerId: pid(i) }, T0, { ip: IP });
    await expectStatus(createTransfer(store, { playerId: pid(10) }, T0, { ip: IP }), 429);
    await expect(createTransfer(store, { playerId: pid(10) }, T0, { ip: OTHER_IP })).resolves.toHaveProperty(
      "code",
    );
    await expect(createTransfer(store, { playerId: pid(10) }, T0 + HOUR, { ip: IP })).resolves.toHaveProperty(
      "code",
    );
  });

  it("引き継ぎコードの発行は、IP を変えても同じプレイヤー ID なら 24 時間に 100 回まで。IP で断った分は数えない", async () => {
    const store = new MemoryStore();
    // IP の枠を使い切り、ALICE の発行を IP の制限で断らせる
    for (let i = 0; i < 10; i++) await createTransfer(store, { playerId: pid(i) }, T0, { ip: IP });
    for (let i = 0; i < 10; i++)
      await expectStatus(createTransfer(store, { playerId: ALICE }, T0, { ip: IP }), 429);
    for (let i = 0; i < 100; i++) {
      await createTransfer(store, { playerId: ALICE }, T0, { ip: ipOf(i) });
    }
    await expectStatus(createTransfer(store, { playerId: ALICE }, T0, { ip: ipOf(100) }), 429);
    await expect(
      createTransfer(store, { playerId: ALICE }, T0 + DAY, { ip: ipOf(100) }),
    ).resolves.toHaveProperty("code");
  });

  it("引き継ぎコードの発行は、IP とプレイヤー ID を変えても全体で 1 時間 300 回まで。次の 1 回は 503 で保存せず、窓が変わるまでの秒数を返す。窓が変われば、また受け付ける", async () => {
    const store = new MemoryStore();
    const put = vi.spyOn(store, "putTransfer");
    for (let i = 0; i < 300; i++) {
      await createTransfer(store, { playerId: pid(i) }, T0 + i, { ip: ipOf(i) });
    }
    await expect(
      createTransfer(store, { playerId: pid(300) }, T0 + HOUR / 2, { ip: OTHER_IP }),
    ).rejects.toMatchObject({ status: 503, message: "too many codes", retryAfterSec: 30 * 60 });
    await expect(
      createTransfer(store, { playerId: pid(300) }, T0 + HOUR - 1, { ip: ipOf(1000) }),
    ).rejects.toMatchObject({ status: 503, retryAfterSec: 1 });
    expect(put).toHaveBeenCalledTimes(300);
    await expect(
      createTransfer(store, { playerId: pid(300) }, T0 + HOUR, { ip: OTHER_IP }),
    ).resolves.toHaveProperty("code");
  });

  it("全体の発行が 1 時間に 210 回に達した窓では、IP ごとの上限を 10 回から 2 回に下げる（同じカウンタで数える）。次の窓では 10 回に戻る", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 200; i++) await createTransfer(store, { playerId: pid(i) }, T0, { ip: ipOf(i) });
    // 全体が 210 回に達するまでは、1 つの IP から 10 回まで
    for (let i = 0; i < 10; i++) {
      await expect(createTransfer(store, { playerId: pid(500 + i) }, T0, { ip: IP })).resolves.toHaveProperty(
        "code",
      );
    }
    // 210 回に達した。2 回を超えて発行した IP は断る
    await expectStatus(createTransfer(store, { playerId: pid(600) }, T0, { ip: IP }), 429);
    // ほかの IP も 2 回まで
    for (let i = 0; i < 2; i++) await createTransfer(store, { playerId: pid(700 + i) }, T0, { ip: OTHER_IP });
    await expectStatus(createTransfer(store, { playerId: pid(702) }, T0, { ip: OTHER_IP }), 429);
    // 次の窓
    for (let i = 0; i < 10; i++)
      await createTransfer(store, { playerId: pid(800 + i) }, T0 + HOUR, { ip: IP });
    await expectStatus(createTransfer(store, { playerId: pid(810) }, T0 + HOUR, { ip: IP }), 429);
  });

  it("IP ごと・プレイヤー ID ごとの制限で断った発行（429）は、全体の回数に数えない", async () => {
    const store = new MemoryStore();
    // 1 つの IP が枠（10 回）を使い切ったあと、断られながら送り続ける
    for (let i = 0; i < 10; i++) await createTransfer(store, { playerId: pid(i) }, T0, { ip: IP });
    for (let i = 0; i < 300; i++) {
      await expectStatus(createTransfer(store, { playerId: pid(i) }, T0, { ip: IP }), 429);
    }
    // 1 つのプレイヤー ID が枠（100 回）を使い切ったあと、IP を変えて断られながら送り続ける
    for (let i = 0; i < 100; i++) await createTransfer(store, { playerId: ALICE }, T0, { ip: ipOf(i) });
    for (let i = 0; i < 300; i++) {
      await expectStatus(createTransfer(store, { playerId: ALICE }, T0, { ip: ipOf(1000 + i) }), 429);
    }
    // 全体の枠（300 回）の残りは、ほかの要求で使える
    for (let i = 110; i < 300; i++) {
      await createTransfer(store, { playerId: pid(1000 + i) }, T0, { ip: ipOf(2000 + i) });
    }
    await expectStatus(createTransfer(store, { playerId: pid(9999) }, T0, { ip: ipOf(9999) }), 503);
  });

  it("大きすぎる記録（400）は数えない", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 150; i++) {
      await expectStatus(
        createTransfer(store, { playerId: ALICE, stats: "x".repeat(5000) }, T0, { ip: IP }),
        400,
      );
    }
    await expect(createTransfer(store, { playerId: ALICE }, T0, { ip: IP })).resolves.toHaveProperty("code");
    expect(store.rateWindowKeys()).toHaveLength(3);
  });

  it("引き継ぎコードの使用は IP ごとに 1 時間 100 回まで（見つからないコードも数える）。断ったときはコードを消さない", async () => {
    const store = new MemoryStore();
    const { code } = await createTransfer(store, { playerId: ALICE, name: "アリス" }, T0);
    // 形の違うコード（400）は数えない
    for (let i = 0; i < 150; i++)
      await expectStatus(claimTransfer(store, { code: "abc" }, T0, { ip: IP }), 400);
    for (let i = 0; i < 100; i++) {
      await expectStatus(claimTransfer(store, { code: unknownCode(i) }, T0, { ip: IP }), 404);
    }
    await expectStatus(claimTransfer(store, { code }, T0, { ip: IP }), 429);
    // 断った要求ではコードを使わないので、別の IP からはまだ使える
    await expect(claimTransfer(store, { code }, T0, { ip: OTHER_IP })).resolves.toMatchObject({
      playerId: ALICE,
    });
    // 次の窓ではまた受け付ける
    await expectStatus(claimTransfer(store, { code: unknownCode(0) }, T0 + HOUR, { ip: IP }), 404);
  });

  it("カウンタは API ごとに分け、生の IP は入れない（通知の購読の IP ごとのカウンタとも別）", async () => {
    const store = new MemoryStore();
    await start(store, 0, T0);
    const { code } = await createTransfer(store, { playerId: ALICE }, T0, { ip: IP });
    await claimTransfer(store, { code }, T0, { ip: IP });
    const keys = store.rateWindowKeys();
    expect(keys.map((k) => k.replace(/[0-9a-f]{64}/, "<hash>").replace(/:\d+$/, ":<window>"))).toEqual([
      "sdk:push:rl:claim:ip:<hash>:<window>",
      "sdk:push:rl:daily:ip:<hash>:<window>",
      "sdk:push:rl:xfer:ip:<hash>:<window>",
      `sdk:push:rl:xfer:player:${ALICE}:<window>`,
      "sdk:push:rl:xfer:total:<window>",
    ]);
    for (const k of keys) expect(k).not.toContain(IP);
  });

  it("client を渡さなければ数えない（route は必ず渡す）", async () => {
    const store = new MemoryStore();
    await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const { code } = await createTransfer(store, { playerId: ALICE }, T0);
    await claimTransfer(store, { code }, T0);
    expect(store.rateWindowKeys()).toEqual([]);
  });
});
