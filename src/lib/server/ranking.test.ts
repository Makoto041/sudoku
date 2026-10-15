import { describe, expect, it } from "vitest";
import { parseGrid, serializeGrid } from "@/lib/sudoku/core";
import { generateDaily } from "@/lib/sudoku/generator";
import { solve } from "@/lib/sudoku/solver";
import {
  MIN_PLAUSIBLE_MS,
  RankingError,
  getLeaderboard,
  renamePlayer,
  sanitizeName,
  startDaily,
  submitDaily,
} from "./ranking";
import { MemoryStore } from "./store";

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
