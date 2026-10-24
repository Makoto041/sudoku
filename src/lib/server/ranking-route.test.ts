import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as startRoute } from "@/app/api/daily/start/route";
import { POST as submitRoute } from "@/app/api/daily/submit/route";
import { GET as leaderboardRoute } from "@/app/api/leaderboard/route";
import { POST as renameRoute } from "@/app/api/player/route";
import { POST as claimRoute } from "@/app/api/player/claim/route";
import { POST as transferRoute } from "@/app/api/player/transfer/route";
import { parseGrid, serializeGrid } from "@/lib/sudoku/core";
import { solve } from "@/lib/sudoku/solver";
import { handle } from "./http";
import {
  MAX_MOVES,
  NAME_MAX,
  RANKING_MAX_BODY_BYTES,
  RANKING_RATE_LIMITS,
  SUBMIT_MAX_BODY_BYTES,
  TRANSFER_MAX_BODY_BYTES,
} from "./ranking";
import { MemoryStore } from "./store";

const ALICE = "11111111-1111-4111-8111-111111111111";

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });

async function read(res: Response, secrets: string[] = []) {
  const text = await res.text();
  for (const s of secrets) expect(text).not.toContain(s);
  return { status: res.status, body: JSON.parse(text) as unknown };
}

/** ちょうど bytes バイトの JSON（ASCII） */
const asciiBody = (bytes: number) => `{"pad":"${"x".repeat(bytes - 10)}"}`;
/** 文字数は bytes より少ないが、UTF-8 では bytes を超える JSON */
const multibyteBody = (bytes: number) => `{"pad":"${"あ".repeat(Math.floor(bytes / 3))}"}`;

/** 1 時間の窓の番号を hour にした時刻へ時計を合わせる（テストの間で回数制限のカウンタを重ねない） */
const at = (hour: number, ms = 0) =>
  vi.setSystemTime(Date.parse("2020-01-01T00:00:00Z") + hour * 60 * 60 * 1000 + ms);

beforeEach(() => {
  // 保存先は必ずメモリにする（実際の Redis には触れない）
  for (const k of [
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "VERCEL",
  ]) {
    vi.stubEnv(k, "");
  }
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ランキング API の本文の上限", () => {
  const ROUTES: [string, (req: Request) => Promise<Response>, number][] = [
    ["/api/daily/start", startRoute, RANKING_MAX_BODY_BYTES],
    ["/api/player", renameRoute, RANKING_MAX_BODY_BYTES],
    ["/api/player/claim", claimRoute, RANKING_MAX_BODY_BYTES],
    ["/api/player/transfer", transferRoute, TRANSFER_MAX_BODY_BYTES],
    ["/api/daily/submit", submitRoute, SUBMIT_MAX_BODY_BYTES],
  ];

  it("開始・名前・コードの使用は 1KB、発行は 8KB、送信は 64KB", () => {
    expect([RANKING_MAX_BODY_BYTES, TRANSFER_MAX_BODY_BYTES, SUBMIT_MAX_BODY_BYTES]).toEqual([
      1024,
      8 * 1024,
      64 * 1024,
    ]);
  });

  it("上限は UTF-8 のバイト数で数え、超えたら 413（上限ちょうどは読んで、入力の検査で 400）", async () => {
    at(1);
    for (const [path, route, max] of ROUTES) {
      expect(new TextEncoder().encode(asciiBody(max)).length).toBe(max);
      const within = await read(await route(post(path, asciiBody(max))));
      const over = await read(await route(post(path, asciiBody(max + 1))));
      const body = multibyteBody(max);
      expect(body.length).toBeLessThan(max);
      const multibyte = await read(await route(post(path, body)));
      expect([path, within.status, over.status, multibyte.status]).toEqual([path, 400, 413, 413]);
      expect(over.body).toEqual({ error: "too large" });
    }
  });

  it("送信は、手の記録が上限の手数で時刻が最も長い形でも 413 にならず記録できる", async () => {
    at(2);
    const started = await read(
      await startRoute(post("/api/daily/start", JSON.stringify({ playerId: ALICE, difficulty: "easy" }))),
    );
    expect(started.status).toBe(200);
    const { sessionId, puzzle } = started.body as { sessionId: string; puzzle: string };
    const grid = serializeGrid(solve(parseGrid(puzzle))!);
    const moves = Array.from({ length: MAX_MOVES }, () => [-Number.MAX_SAFE_INTEGER, 80, 9]);
    const body = JSON.stringify({ sessionId, playerId: ALICE, grid, name: "𠮷".repeat(NAME_MAX), moves });
    const bytes = new TextEncoder().encode(body).length;
    expect(bytes).toBeGreaterThan(48 * 1024);
    expect(bytes).toBeLessThanOrEqual(SUBMIT_MAX_BODY_BYTES);
    at(2, 60_000);
    const res = await read(await submitRoute(post("/api/daily/submit", body)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rank: 1, total: 1 });
  });
});

describe("ランキング API の回数制限（route は要求元の IP で数える）", () => {
  const pid = (test: number, i: number) =>
    `${test.toString(16).padStart(4, "0")}${i.toString(16).padStart(4, "0")}-3333-4333-8333-333333333333`;
  const start = (playerId: string, headers: Record<string, string>) =>
    startRoute(post("/api/daily/start", JSON.stringify({ playerId, difficulty: "easy" }), headers));
  const transfer = (playerId: string, headers: Record<string, string>) =>
    transferRoute(
      post("/api/player/transfer", JSON.stringify({ playerId, name: null, stats: null }), headers),
    );
  const claim = (code: string, headers: Record<string, string>) =>
    claimRoute(post("/api/player/claim", JSON.stringify({ code }), headers));

  it("今日の一問の開始：同じ IP（x-forwarded-for の最初の要素）から 241 回目は 429 で、応答に IP を含めない。別の IP は通る", async () => {
    at(10);
    const IP = "203.0.113.70";
    const { limit } = RANKING_RATE_LIMITS.start;
    for (let i = 0; i < limit; i++) {
      const res = await start(pid(10, i), { "x-forwarded-for": `${IP}, 10.0.0.${i % 250}` });
      expect([i, res.status]).toEqual([i, 200]);
    }
    const limited = await read(await start(pid(10, limit), { "x-forwarded-for": `${IP}, 10.0.0.1` }), [IP]);
    expect(limited).toEqual({ status: 429, body: { error: "rate limited" } });
    const other = await start(pid(10, limit), { "x-forwarded-for": "198.51.100.70" });
    expect(other.status).toBe(200);
  });

  it("引き継ぎコードの発行：同じ IP から 101 回目は 429。別の IP は通る", async () => {
    at(11);
    const IP = "203.0.113.71";
    const { limit } = RANKING_RATE_LIMITS.transfer;
    for (let i = 0; i < limit; i++) {
      expect([i, (await transfer(pid(11, i), { "x-real-ip": IP })).status]).toEqual([i, 200]);
    }
    expect(await read(await transfer(pid(11, limit), { "x-real-ip": IP }), [IP])).toEqual({
      status: 429,
      body: { error: "rate limited" },
    });
    expect((await transfer(pid(11, limit), { "x-real-ip": "198.51.100.71" })).status).toBe(200);
  });

  it("引き継ぎコードの使用：同じ IP から 101 回目は 429（見つからないコードも数える）。断ったコードは別の IP から使える", async () => {
    at(12);
    const IP = "203.0.113.72";
    const issued = await read(await transfer(ALICE, { "x-forwarded-for": "192.0.2.72" }));
    const { code } = issued.body as { code: string };
    const { limit } = RANKING_RATE_LIMITS.claim;
    for (let i = 0; i < limit; i++) {
      const res = await claim(`ABCD${"23456789"[i % 8]}${"23456789"[(i >> 3) % 8]}Z9`, {
        "x-forwarded-for": IP,
      });
      expect([i, res.status]).toEqual([i, 404]);
    }
    expect(await read(await claim(code, { "x-forwarded-for": IP }), [IP, code])).toEqual({
      status: 429,
      body: { error: "rate limited" },
    });
    expect(await read(await claim(code, { "x-forwarded-for": "198.51.100.72" }))).toMatchObject({
      status: 200,
      body: { playerId: ALICE },
    });
  });

  it("今日の一問の送信と名前の変更は回数を数えない", async () => {
    at(13);
    const counted = vi.spyOn(MemoryStore.prototype, "incrRateWindow");
    const h = { "x-forwarded-for": "203.0.113.73" };
    for (let i = 0; i < 5; i++) {
      const playerId = pid(13, i);
      const renamed = await renameRoute(post("/api/player", JSON.stringify({ playerId, name: "名前" }), h));
      // 形の検査を通る送信（セッションが無いので 404）
      const submit = { sessionId: pid(13, 99), playerId, grid: "1".repeat(81), name: "名前" };
      const submitted = await submitRoute(post("/api/daily/submit", JSON.stringify(submit), h));
      expect([renamed.status, submitted.status]).toEqual([200, 404]);
    }
    expect(counted).not.toHaveBeenCalled();
  });
});

describe("ランキングの表の Cache-Control", () => {
  const get = (query: string) => leaderboardRoute(new Request(`http://localhost/api/leaderboard?${query}`));

  it("playerId の無い要求の成功は CDN に短くキャッシュさせ、playerId 付きとエラーは no-store", async () => {
    at(20);
    const shared = await get("scope=daily&difficulty=easy");
    expect(shared.status).toBe(200);
    expect(shared.headers.get("cache-control")).toBe("public, s-maxage=10, stale-while-revalidate=30");
    const best = await get("scope=best&difficulty=easy");
    expect(best.headers.get("cache-control")).toBe("public, s-maxage=10, stale-while-revalidate=30");
    const mine = await get(`scope=daily&difficulty=easy&playerId=${ALICE}`);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    for (const query of ["scope=daily&difficulty=insane", `difficulty=easy&playerId=nope`]) {
      const res = await get(query);
      expect([query, res.status, res.headers.get("cache-control")]).toEqual([query, 400, "no-store"]);
    }
  });
});

describe("ランキング API のエラーの記録", () => {
  it("handle は既定で、想定外のエラーの中身（Upstash が含める送ったコマンド）を記録しない", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handle(async () => {
      throw new Error(`command was: ["set","sdk:xfer:ABCDEFGH","{\\"playerId\\":\\"${ALICE}\\"}"]`);
    });
    expect((await read(res, [ALICE])).status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.mock.calls[0].map(String));
    for (const s of [ALICE, "ABCDEFGH", "sdk:xfer"]) expect(logged).not.toContain(s);
    expect(logged).toContain("request failed (Error)");
  });

  it("route で保存先が失敗しても、プレイヤー ID や引き継ぎコードを記録しない", async () => {
    at(30);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(MemoryStore.prototype, "startSession").mockRejectedValueOnce(
      new Error(`command was: ["set","sdk:start:2020-01-01:easy:${ALICE}"]`),
    );
    vi.spyOn(MemoryStore.prototype, "takeTransfer").mockRejectedValueOnce(
      new Error(`command was: ["getdel","sdk:xfer:ABCDEFGH"]`),
    );
    const started = await startRoute(
      post("/api/daily/start", JSON.stringify({ playerId: ALICE, difficulty: "easy" })),
    );
    const claimed = await claimRoute(post("/api/player/claim", JSON.stringify({ code: "ABCD-EFGH" })));
    expect([started.status, claimed.status]).toEqual([500, 500]);
    expect(log).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(log.mock.calls.map((c) => c.map(String)));
    for (const s of [ALICE, "ABCDEFGH", "sdk:"]) expect(logged).not.toContain(s);
  });
});
