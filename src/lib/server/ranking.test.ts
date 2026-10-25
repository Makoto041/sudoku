import { describe, expect, it, vi } from "vitest";
import { DIFFICULTIES, parseGrid, serializeGrid } from "@/lib/sudoku/core";
import { PROFILES, generateDaily } from "@/lib/sudoku/generator";
import { solve } from "@/lib/sudoku/solver";
import {
  MAX_MARK_RUN,
  MAX_MOVES,
  MAX_STATS_BYTES,
  NAME_MAX,
  RankingError,
  TRANSFER_TOTAL_COUNTER,
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
import { DIFFICULTY_FLOOR_MS, MIN_MS_PER_CELL, MIN_MS_PER_MOVE, minPlausibleMs } from "./ranking-floor";
import { MemoryStore, fromRankValue, rankValue } from "./store";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-10-15T03:00:00Z"); // JST 12:00

const solutionOf = (puzzle: string) => serializeGrid(solve(parseGrid(puzzle))!);

/** 空きマスを順に正しく埋めた手の記録（1 秒おき） */
function movesFor(puzzle: string): MoveLog {
  const p = parseGrid(puzzle);
  const s = solve(p)!;
  return p
    .flatMap((v, i) => (v ? [] : [i]))
    .map((c, k): [number, number, number] => [(k + 1) * 1000, c, s[c]]);
}

async function solveDaily(store: MemoryStore, playerId: string, elapsedMs: number, name = "テスト") {
  const started = await startDaily(store, { playerId, difficulty: "easy" }, T0);
  const solution = solutionOf(started.puzzle);
  const moves = movesFor(started.puzzle);
  return submitDaily(
    store,
    { sessionId: started.sessionId, playerId, grid: solution, name, moves },
    T0 + elapsedMs,
  );
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toBeInstanceOf(RankingError);
  await promise.catch((e: RankingError) => expect(e.status).toBe(status));
}

async function expectError(promise: Promise<unknown>, status: number, message: string) {
  await expect(promise).rejects.toBeInstanceOf(RankingError);
  await promise.catch((e: RankingError) => expect([e.status, e.message]).toEqual([status, message]));
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
    const body = {
      sessionId: started.sessionId,
      playerId: ALICE,
      grid,
      name: "a",
      moves: movesFor(started.puzzle),
    };
    await submitDaily(store, body, T0 + 100_000);
    await expectStatus(submitDaily(store, body, T0 + 120_000), 409);
  });

  it("誤答・速すぎる送信・他人のセッションは拒否する", async () => {
    const store = new MemoryStore();
    const started = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const solution = parseGrid(solutionOf(started.puzzle));
    const wrong = solution.slice();
    [wrong[0], wrong[1]] = [wrong[1], wrong[0]];
    const base = {
      sessionId: started.sessionId,
      playerId: ALICE,
      name: "a",
      moves: movesFor(started.puzzle),
    };

    await expectStatus(submitDaily(store, { ...base, grid: serializeGrid(wrong) }, T0 + 100_000), 422);
    await expectStatus(
      submitDaily(store, { ...base, grid: serializeGrid(solution) }, T0 + DIFFICULTY_FLOOR_MS.easy - 1),
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
      {
        sessionId: started.sessionId,
        playerId: ALICE,
        grid: solutionOf(pinned),
        name: "a",
        moves: movesFor(pinned),
      },
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
      moves: movesFor(started.puzzle),
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

  it("向きを変える文字・ゼロ幅の文字・タグ文字・私用領域の文字を落とす", () => {
    expect(sanitizeName("ab\u202ecd")).toBe("abcd");
    expect(sanitizeName("\u202aa\u202bb\u202cc\u202dd")).toBe("abcd");
    expect(sanitizeName("\u2066a\u2069\u2067b\u2069\u2068c\u2069")).toBe("abc");
    expect(sanitizeName("a\u200eb\u200fc\u061cd")).toBe("abcd");
    expect(sanitizeName("a\u200bb\u200cc\u2060d\ufeffe\u00adf")).toBe("abcdef");
    expect(sanitizeName("a\u{e0041}b\ue000c")).toBe("abc");
    expect(sanitizeName("\u202e\u200b\u2066")).toBeNull();
  });

  it(`続けて置ける結合文字（と ZWJ）は ${MAX_MARK_RUN} 個まで。先頭の結合文字・ZWJ と末尾の ZWJ は落とす`, () => {
    const marks = (n: number) => "\u0301".repeat(n);
    expect(sanitizeName(`x${marks(MAX_MARK_RUN)}y`)).toBe(`x${marks(MAX_MARK_RUN)}y`);
    expect(sanitizeName(`x${marks(MAX_MARK_RUN + 1)}y`)).toBe(`x${marks(MAX_MARK_RUN)}y`);
    expect(sanitizeName(`x${marks(30)}y`)).toBe(`x${marks(MAX_MARK_RUN)}y`);
    // 種類の違う結合文字（上・下に付くもの）も、ZWJ を挟んでも、続いていれば 1 つの並びとして数える
    expect(sanitizeName("x\u0301\u0316\u0302\u0317\u0303\u0318y")).toHaveLength(1 + MAX_MARK_RUN + 1);
    expect(sanitizeName("x" + "\u200d\u0301".repeat(5) + "y")).toBe("x\u200d\u0301\u200d\u0301y");
    // 減らしてから長さを数える（重ねた結合文字で NAME_MAX を使い切らせない）
    expect(sanitizeName(`x${marks(20)}`.repeat(3))).toBe(
      `x${marks(MAX_MARK_RUN)}`.repeat(2) + `x${marks(1)}`,
    );
    expect(sanitizeName(`${marks(3)}ab`)).toBe("ab");
    expect(sanitizeName(`  ${marks(3)}ab`)).toBe("ab");
    expect(sanitizeName("\u200d\ufe0fab")).toBe("ab");
    expect(sanitizeName("ab\u200d")).toBe("ab");
    // 長さで切ったところが ZWJ の並びの途中でも、末尾に ZWJ を残さない
    expect(sanitizeName("abcdefghij👨\u200d👩\u200d👧")).toBe("abcdefghij👨");
  });

  it("正当な結合（絵文字の ZWJ・異体字セレクタ・キーキャップ・肌の色、タイ語・ヒンディー語・チベット語）は残す", () => {
    for (const name of [
      "1\ufe0f\u20e3",
      "👨\u200d👩\u200d👧\u200d👦",
      "👩🏽\u200d💻",
      "❤\ufe0f\u200d🔥",
      "🏳\ufe0f\u200d🌈",
      "ที่สุด",
      "नमस्ते",
      "क्षत्रिय",
      "བསྒྲུབས",
    ]) {
      expect(sanitizeName(name)).toBe(name.normalize("NFKC"));
    }
  });

  it("保存済みの名前も、表に出す前に今の規則で整える", async () => {
    const store = new MemoryStore();
    await solveDaily(store, ALICE, 100_000, "アリス");
    await solveDaily(store, BOB, 100_000, "ボブ");
    // 今の規則より前に保存された（今は受け付けない）名前、という想定で保存先に直接入れる
    await store.setName(ALICE, `x${"\u0301".repeat(11)}`);
    await store.setName(BOB, "\u0301\u0301");
    const board = await getLeaderboard(
      store,
      { scope: "daily", difficulty: "easy", date: "2026-10-15", playerId: ALICE },
      T0,
    );
    expect(board.entries.map((e) => e.name).sort()).toEqual(
      [`x${"\u0301".repeat(MAX_MARK_RUN)}`, "名無し"].sort(),
    );
    expect(board.me?.name).toBe(`x${"\u0301".repeat(MAX_MARK_RUN)}`);
  });
});

describe("記録できる最短の時間（下限）", () => {
  it("難易度ごとの下限・空きマス数 × 0.25 秒・手の記録の件数 × 0.05 秒のいちばん長いもの", () => {
    for (const d of DIFFICULTIES) expect(minPlausibleMs(d, 0, 0)).toBe(DIFFICULTY_FLOOR_MS[d]);
    expect(DIFFICULTY_FLOOR_MS.easy).toBe(15_000);
    // かんたんの下限 15 秒は、空きマス 60（15 秒）までは変わらず、61 から空きマスの項が上回る
    expect(minPlausibleMs("easy", 60, 60)).toBe(15_000);
    expect(minPlausibleMs("easy", 61, 61)).toBe(61 * MIN_MS_PER_CELL);
    expect(minPlausibleMs("easy", 64, 64)).toBe(16_000);
    // 手の記録が 300 件を超えると、件数の項が上回る
    expect(minPlausibleMs("easy", 51, 300)).toBe(15_000);
    expect(minPlausibleMs("easy", 51, 301)).toBe(301 * MIN_MS_PER_MOVE);
    expect(minPlausibleMs("master", 64, MAX_MOVES)).toBe(MAX_MOVES * MIN_MS_PER_MOVE);
  });

  it("今の生成の範囲では、空きマスの項は難易度ごとの下限を超えない（歴代ベストの点検は難易度ごとの下限で判定できる）", () => {
    for (const d of DIFFICULTIES) {
      expect([d, (81 - PROFILES[d].minGivens) * MIN_MS_PER_CELL <= DIFFICULTY_FLOOR_MS[d]]).toEqual([
        d,
        true,
      ]);
    }
  });

  it("難易度ごとに、下限より 1 ms でも速い送信は断り、同じセッションを下限ちょうどに送り直せば記録する", async () => {
    // 盤面は生成の速いかんたんのものを、どの難易度にも固定して使う（空きマスの項は下限より短い）
    const pinned = serializeGrid(generateDaily("2026-10-15", "easy").puzzle);
    const empties = [...pinned].filter((c) => c === "0").length;
    expect(empties * MIN_MS_PER_CELL).toBeLessThan(DIFFICULTY_FLOOR_MS.easy);
    for (const difficulty of DIFFICULTIES) {
      const store = new MemoryStore();
      await store.pinDailyPuzzle("2026-10-15", difficulty, pinned);
      const started = await startDaily(store, { playerId: ALICE, difficulty }, T0);
      const body = {
        sessionId: started.sessionId,
        playerId: ALICE,
        grid: solutionOf(pinned),
        name: "a",
        moves: movesFor(pinned),
      };
      const floor = DIFFICULTY_FLOOR_MS[difficulty];
      await expectError(submitDaily(store, body, T0 + floor - 1), 422, "too fast");
      await expect(submitDaily(store, body, T0 + floor)).resolves.toMatchObject({
        difficulty,
        timeMs: floor,
      });
    }
  });

  it("空きマスの多い盤面では、空きマス数 × 0.25 秒が下限になる（盤面はセッションのもの）", async () => {
    // ヒント 17 個（空きマス 64）の、解が 1 つの問題
    const sparse = "000000010400000000020000000000050407008000300001090000300400200050100000000806000";
    const store = new MemoryStore();
    await store.pinDailyPuzzle("2026-10-15", "easy", sparse);
    const started = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const body = {
      sessionId: started.sessionId,
      playerId: ALICE,
      grid: solutionOf(sparse),
      name: "a",
      moves: movesFor(sparse),
    };
    await expectError(submitDaily(store, body, T0 + 64 * MIN_MS_PER_CELL - 1), 422, "too fast");
    await expect(submitDaily(store, body, T0 + 64 * MIN_MS_PER_CELL)).resolves.toMatchObject({ rank: 1 });
  });

  it("手の記録が多いと、件数 × 0.05 秒が下限になる", async () => {
    const store = new MemoryStore();
    const started = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const filled = movesFor(started.puzzle);
    const [, cell, digit] = filled[0];
    // 同じマスで違う数字を置いてから正しい数字に戻す、を繰り返して 400 件にする
    const extra: MoveLog = Array.from({ length: 400 - filled.length }, (_, k) => [
      100_000 + k,
      cell,
      k % 2 ? digit : (digit % 9) + 1,
    ]);
    const body = {
      sessionId: started.sessionId,
      playerId: ALICE,
      grid: solutionOf(started.puzzle),
      name: "a",
      moves: [...filled, ...extra],
    };
    await expectError(submitDaily(store, body, T0 + 400 * MIN_MS_PER_MOVE - 1), 422, "too fast");
    await expect(submitDaily(store, body, T0 + 400 * MIN_MS_PER_MOVE)).resolves.toMatchObject({ rank: 1 });
  });

  it("空きマスのどれかに正しい数字を置いた手が無い送信は記録しない（時刻は見ない）", async () => {
    const store = new MemoryStore();
    const started = await startDaily(store, { playerId: ALICE, difficulty: "easy" }, T0);
    const puzzle = parseGrid(started.puzzle);
    const filled = movesFor(started.puzzle);
    const [lastT, lastCell, lastDigit] = filled[filled.length - 1];
    const given = puzzle.findIndex((v) => v !== 0);
    const base = {
      sessionId: started.sessionId,
      playerId: ALICE,
      grid: solutionOf(started.puzzle),
      name: "a",
    };
    const at = T0 + 100_000;
    for (const moves of [
      undefined,
      [],
      filled.slice(0, -1),
      // 最後のマスだけ違う数字
      [...filled.slice(0, -1), [lastT, lastCell, (lastDigit % 9) + 1]],
      // 足りない分を最初から入っているマスで数を合わせる
      [...filled.slice(0, -1), [lastT, given, puzzle[given]]],
    ]) {
      await expectError(submitDaily(store, { ...base, moves }, at), 422, "incomplete moves");
    }
    // 時刻が開始より前や、経過時間より後でも、置いた手があれば足りる（時刻は端末が決めるので見ない）
    const shifted: MoveLog = filled.map(([, c, d], k) => [k % 2 ? -1000 : 10_000_000, c, d]);
    await expect(submitDaily(store, { ...base, moves: shifted }, at)).resolves.toMatchObject({ rank: 1 });
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

  it("混雑の段は全体の 211 回目から。全体の 210 回目では IP の 3 回目も通し、211 回目では IP の 3 回目を断る", async () => {
    // IP の 3 回目が全体の 210 回目になる
    const a = new MemoryStore();
    for (let i = 0; i < 207; i++) await createTransfer(a, { playerId: pid(i) }, T0, { ip: ipOf(i) });
    for (let i = 0; i < 2; i++) await createTransfer(a, { playerId: pid(300 + i) }, T0, { ip: IP });
    await expect(createTransfer(a, { playerId: pid(302) }, T0, { ip: IP })).resolves.toHaveProperty("code");
    // IP の 3 回目が全体の 211 回目になる
    const b = new MemoryStore();
    for (let i = 0; i < 208; i++) await createTransfer(b, { playerId: pid(i) }, T0, { ip: ipOf(i) });
    for (let i = 0; i < 2; i++) await createTransfer(b, { playerId: pid(300 + i) }, T0, { ip: IP });
    await expectStatus(createTransfer(b, { playerId: pid(302) }, T0, { ip: IP }), 429);
    // 2 回目までの IP は、211 回目からも通る
    await expect(createTransfer(b, { playerId: pid(303) }, T0, { ip: OTHER_IP })).resolves.toHaveProperty(
      "code",
    );
  });

  it("全体を数えたあとで断った発行（混雑の段の 429・全体の上限の 503）は、全体と playerId の回数から戻す。全体を超えていても、混雑の段で断る要求は 429", async () => {
    const store = new MemoryStore();
    const P = pid(7777);
    // P は 99 回発行する（10 の IP から）
    for (let i = 0; i < 99; i++) await createTransfer(store, { playerId: P }, T0, { ip: ipOf(i % 10) });
    // 全体を 210 回にする（IP の 3 回を含む）
    for (let i = 99; i < 207; i++)
      await createTransfer(store, { playerId: pid(i) }, T0, { ip: ipOf(100 + i) });
    for (let i = 0; i < 3; i++) await createTransfer(store, { playerId: pid(400 + i) }, T0, { ip: IP });
    // IP の 4〜10 回目（P）は混雑の段で断る
    for (let i = 0; i < 7; i++)
      await expectStatus(createTransfer(store, { playerId: P }, T0, { ip: IP }), 429);
    // 全体は 210 回のまま: ほかの IP で 90 回発行できる（最後の 2 回は OTHER_IP）
    for (let i = 0; i < 88; i++) {
      await createTransfer(store, { playerId: pid(500 + i) }, T0, { ip: ipOf(1000 + i) });
    }
    for (let i = 0; i < 2; i++) await createTransfer(store, { playerId: pid(590 + i) }, T0, { ip: OTHER_IP });
    // 全体の上限に達した。OTHER_IP の 3 回目は混雑の段で 429、ほかの IP の 1 回目（P）は 503
    await expectStatus(createTransfer(store, { playerId: pid(600) }, T0, { ip: OTHER_IP }), 429);
    await expectStatus(createTransfer(store, { playerId: P }, T0, { ip: ipOf(2000) }), 503);
    // P は 99 回のまま: 次の 1 時間（playerId は 24 時間の窓）に 1 回だけ発行できる
    await expect(
      createTransfer(store, { playerId: P }, T0 + HOUR, { ip: ipOf(3000) }),
    ).resolves.toHaveProperty("code");
    await expectStatus(createTransfer(store, { playerId: P }, T0 + HOUR, { ip: ipOf(3001) }), 429);
  });

  /** 保存先の往復の遅れを真似る（INCR・DECR は実行した時点で原子的で、その前後で待つ）。遅れは決まった並びの擬似乱数 */
  class SlowStore extends MemoryStore {
    private seed = 1;
    private wait() {
      this.seed = (this.seed * 48271) % 2147483647;
      return new Promise((resolve) => setTimeout(resolve, this.seed % 5));
    }
    async incrRateWindow(name: string, windowSec: number, now: number) {
      await this.wait();
      const count = await super.incrRateWindow(name, windowSec, now);
      await this.wait();
      return count;
    }
    async decrRateWindow(name: string, windowSec: number, now: number) {
      await this.wait();
      await super.decrRateWindow(name, windowSec, now);
      await this.wait();
    }
  }

  /**
   * 全体のカウンタの INCR を、gate 件そろうまで返さない。すべての要求が全体を数えてから判定と戻しが走る
   * （戻す前の、超えた回数が最も長く見える順）
   */
  class GateStore extends SlowStore {
    private waiting: (() => void)[] = [];
    private readonly gate: number;
    constructor(gate: number) {
      super();
      this.gate = gate;
    }
    async incrRateWindow(name: string, windowSec: number, now: number) {
      const count = await super.incrRateWindow(name, windowSec, now);
      if (name === TRANSFER_TOTAL_COUNTER && this.waiting.length < this.gate) {
        await new Promise<void>((resolve) => {
          this.waiting.push(resolve);
          if (this.waiting.length === this.gate) for (const release of this.waiting) release();
        });
      }
      return count;
    }
  }

  /** 各 IP から per 回ずつ、別々のプレイヤー ID で一斉に発行する。応答の状態の一覧を返す */
  const burst = (store: MemoryStore, ips: string[], per: number) =>
    Promise.all(
      ips.flatMap((ip, n) =>
        Array.from({ length: per }, (_, k) =>
          createTransfer(store, { playerId: pid(n * per + k) }, T0, { ip }).then(
            () => 200,
            (e: RankingError) => e.status,
          ),
        ),
      ),
    );
  const countOf = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

  /** 全体の回数が発行した数（ok）だけか: 別の IP の 1 回目から順に、全体の上限まで発行でき、次は 503 */
  async function expectOnlyIssuedCounted(store: MemoryStore, ok: number) {
    for (let i = 0; i < 300 - ok; i++) {
      await expect(
        createTransfer(store, { playerId: pid(1000 + i) }, T0, { ip: ipOf(1000 + i) }),
      ).resolves.toHaveProperty("code");
    }
    await expectStatus(createTransfer(store, { playerId: pid(9999) }, T0, { ip: ipOf(9999) }), 503);
  }

  it("一斉に送り、すべてが全体を数えてから判定する最も悪い順でも、IPv4 の 44 個（10 回ずつ）では全体の上限まで発行できず、窓は閉じない", async () => {
    const store = new GateStore(44 * 10);
    const statuses = await burst(
      store,
      Array.from({ length: 44 }, (_, i) => ipOf(i)),
      10,
    );
    const ok = countOf(statuses, 200);
    // 211 回目からは IP ごとに 2 回まで: 210 + 2 × 44 = 298 を超えない
    expect(ok).toBeGreaterThanOrEqual(210);
    expect(ok).toBeLessThanOrEqual(298);
    // 全体を超えた要求のうち 503 は、混雑の段に当たらない IP の 1・2 回目だけ（ほかは 429）
    expect(countOf(statuses, 503)).toBeLessThanOrEqual(2 * 44);
    expect(ok + countOf(statuses, 429) + countOf(statuses, 503)).toBe(440);
    await expectOnlyIssuedCounted(store, ok);
  });

  it("一斉に送り、すべてが全体を数えてから判定する最も悪い順でも、IPv6 の 5 つの /48（/64 を 8 つずつ、10 回ずつ）では全体の上限まで発行できず、窓は閉じない", async () => {
    const store = new GateStore(5 * 8 * 10);
    const ips = Array.from({ length: 5 * 8 }, (_, i) => `2001:db8:${(i >> 3) + 1}:${i & 7}::1`);
    const statuses = await burst(store, ips, 10);
    const ok = countOf(statuses, 200);
    // 211 回目からは /48 ごとに 16 回（2 × 8）まで: 210 + 16 × 5 = 290 を超えない
    expect(ok).toBeGreaterThanOrEqual(210);
    expect(ok).toBeLessThanOrEqual(290);
    expect(countOf(statuses, 503)).toBeLessThanOrEqual(16 * 5);
    await expectOnlyIssuedCounted(store, ok);
  });

  it("一斉に送っても（遅れだけで順は決めない）、IPv4 の 30 個（10 回ずつ）では 210 + 2 × 30 = 270 を超えず、全体に残るのは発行した分だけ", async () => {
    const store = new SlowStore();
    const statuses = await burst(
      store,
      Array.from({ length: 30 }, (_, i) => ipOf(i)),
      10,
    );
    const ok = countOf(statuses, 200);
    expect(ok).toBeGreaterThanOrEqual(210);
    expect(ok).toBeLessThanOrEqual(270);
    expect(countOf(statuses, 429)).toBe(300 - ok);
    await expectOnlyIssuedCounted(store, ok);
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
