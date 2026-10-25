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
  RankingError,
  SUBMIT_MAX_BODY_BYTES,
  TRANSFER_MAX_BODY_BYTES,
  claimTransfer,
  createTransfer,
  startDaily,
} from "./ranking";
import { MIN_MS_PER_MOVE } from "./ranking-floor";
import { MemoryStore, getStore } from "./store";

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
    const p = parseGrid(puzzle);
    const solution = solve(p)!;
    const grid = serializeGrid(solution);
    // 空きマスをすべて正しく埋めた手（記録の条件）のあとを、上限の手数まで埋める
    const filled = p.flatMap((v, i) => (v ? [] : [[-Number.MAX_SAFE_INTEGER, i, solution[i]]]));
    const moves = [
      ...filled,
      ...Array.from({ length: MAX_MOVES - filled.length }, () => [-Number.MAX_SAFE_INTEGER, 80, 9]),
    ];
    const body = JSON.stringify({ sessionId, playerId: ALICE, grid, name: "𠮷".repeat(NAME_MAX), moves });
    const bytes = new TextEncoder().encode(body).length;
    expect(bytes).toBeGreaterThan(48 * 1024);
    expect(bytes).toBeLessThanOrEqual(SUBMIT_MAX_BODY_BYTES);
    // 手の記録の件数から決まる下限（2,000 件 × 0.05 秒）ちょうどに送る
    at(2, MAX_MOVES * MIN_MS_PER_MOVE);
    const res = await read(await submitRoute(post("/api/daily/submit", body)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rank: 1, total: 1 });
  });
});

describe("ランキング API の回数制限（route は要求元の IP で数える）", () => {
  // 上限までの数え方と断った要求の扱いは ranking.test.ts で確かめる。ここでは route が要求元の IP を渡して数えることだけ
  const pid = (test: number, i: number) =>
    `${test.toString(16).padStart(4, "0")}${i.toString(16).padStart(4, "0")}-3333-4333-8333-333333333333`;
  /** 同じ IP からの要求を、route を通さずに保存先へ直接 1 回送る（route と同じ数え方で数える） */
  const direct = {
    start: (ip: string, i: number, hour: number) =>
      startDaily(getStore()!, { playerId: pid(hour, i), difficulty: "easy" }, Date.now(), { ip }),
    transfer: (ip: string, i: number, hour: number) =>
      createTransfer(getStore()!, { playerId: pid(hour, i) }, Date.now(), { ip }),
    claim: (ip: string) =>
      claimTransfer(getStore()!, { code: "ABCD-EFGH" }, Date.now(), { ip }).catch((e: RankingError) =>
        expect(e.status).toBe(404),
      ),
  };
  const COUNTED = [
    {
      what: "今日の一問の開始",
      rule: RANKING_RATE_LIMITS.start,
      fill: direct.start,
      ok: 200,
      send: (headers: Record<string, string>) =>
        startRoute(
          post("/api/daily/start", JSON.stringify({ playerId: ALICE, difficulty: "easy" }), headers),
        ),
    },
    {
      what: "引き継ぎコードの発行",
      rule: RANKING_RATE_LIMITS.transfer,
      fill: direct.transfer,
      ok: 200,
      send: (headers: Record<string, string>) =>
        transferRoute(
          post("/api/player/transfer", JSON.stringify({ playerId: ALICE, name: null, stats: null }), headers),
        ),
    },
    {
      what: "引き継ぎコードの使用",
      rule: RANKING_RATE_LIMITS.claim,
      fill: direct.claim,
      // 形の正しい、発行していないコード
      ok: 404,
      send: (headers: Record<string, string>) =>
        claimRoute(post("/api/player/claim", JSON.stringify({ code: "ABCD-EFGH" }), headers)),
    },
  ];

  it.each(COUNTED.map((r, i) => ({ ...r, hour: 10 + i })))(
    "$what：x-forwarded-for の最初の要素の IP で数え、上限を超えたら 429 で、応答に IP を含めない。別の IP は通る",
    async ({ rule, fill, ok, send, hour }) => {
      at(hour);
      const IP = `203.0.113.${70 + hour}`;
      expect((await send({ "x-forwarded-for": `${IP}, 10.0.0.1` })).status).toBe(ok);
      // 同じ IP の残りの枠を、route を通さずに使い切る（route の 1 回目が同じ IP で数えられていなければ、次は通る）
      for (let i = 1; i < rule.limit; i++) await fill(IP, i, hour);
      expect(await read(await send({ "x-forwarded-for": `${IP}, 10.0.0.2` }), [IP])).toEqual({
        status: 429,
        body: { error: "rate limited" },
      });
      expect((await send({ "x-real-ip": "198.51.100.70" })).status).toBe(ok);
    },
  );

  it("引き継ぎコードの発行：全体の上限を超えたら 503 too many codes で、Retry-After に窓が変わるまでの秒数を付ける", async () => {
    // 1 時間の窓の 15 分目
    at(14, 15 * 60 * 1000);
    for (let i = 0; i < RANKING_RATE_LIMITS.transferTotal.limit; i++) {
      await direct.transfer(`198.18.${i >> 8}.${i & 0xff}`, i, 14);
    }
    const res = await transferRoute(
      post("/api/player/transfer", JSON.stringify({ playerId: ALICE, name: null, stats: null }), {
        "x-forwarded-for": "192.0.2.14",
      }),
    );
    expect(res.headers.get("retry-after")).toBe(String(45 * 60));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await read(res, ["192.0.2.14"])).toEqual({ status: 503, body: { error: "too many codes" } });
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
