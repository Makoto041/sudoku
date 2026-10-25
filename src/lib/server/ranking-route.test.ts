import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as startRoute } from "@/app/api/daily/start/route";
import { POST as submitRoute } from "@/app/api/daily/submit/route";
import { GET as leaderboardRoute } from "@/app/api/leaderboard/route";
import { POST as renameRoute } from "@/app/api/player/route";
import { POST as claimRoute } from "@/app/api/player/claim/route";
import { GET as historyRoute } from "@/app/api/player/history/route";
import { POST as transferRoute } from "@/app/api/player/transfer/route";
import { PLAYER_ID_HEADER } from "@/lib/player-id-header";
import { parseGrid, serializeGrid } from "@/lib/sudoku/core";
import { solve } from "@/lib/sudoku/solver";
import { handle } from "./http";
import { PLAYER_ID_QUERY_DEPRECATED, PLAYER_ID_QUERY_SUNSET } from "./player-id";
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
  const get = (query: string, headers: HeadersInit = {}) =>
    leaderboardRoute(new Request(`http://localhost/api/leaderboard?${query}`, { headers }));

  it("playerId の無い要求の成功は CDN に短くキャッシュさせ、playerId 付きは private, no-store、エラーは no-store。どれも Vary: x-player-id", async () => {
    at(20);
    const shared = await get("scope=daily&difficulty=easy");
    expect(shared.status).toBe(200);
    expect(shared.headers.get("cache-control")).toBe("public, s-maxage=10, stale-while-revalidate=30");
    const best = await get("scope=best&difficulty=easy");
    expect(best.headers.get("cache-control")).toBe("public, s-maxage=10, stale-while-revalidate=30");
    // クエリの空の playerId は今までどおり無いものとする
    const empty = await get("scope=best&difficulty=easy&playerId=");
    expect(empty.headers.get("cache-control")).toBe("public, s-maxage=10, stale-while-revalidate=30");
    for (const res of [
      await get("scope=daily&difficulty=easy", { [PLAYER_ID_HEADER]: ALICE }),
      await get(`scope=daily&difficulty=easy&playerId=${ALICE}`),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    for (const [query, headers] of [
      ["scope=daily&difficulty=insane", {}],
      ["difficulty=easy&playerId=nope", {}],
      ["difficulty=easy", { [PLAYER_ID_HEADER]: "nope" }],
    ] as const) {
      const res = await get(query, headers);
      expect([query, res.status, res.headers.get("cache-control")]).toEqual([query, 400, "no-store"]);
    }
    for (const res of [shared, best, empty, await get("difficulty=easy", { [PLAYER_ID_HEADER]: ALICE })]) {
      expect(res.headers.get("vary")).toContain(PLAYER_ID_HEADER);
    }
  });
});

describe("GET の playerId（x-player-id ヘッダーと、移行期間のクエリ）", () => {
  // ダミーの ID。英字を含める（大文字にすると形が変わる）。ほかのテストの記録と混ぜない
  const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const board = "scope=best&difficulty=expert";
  const get = (query: string, headers: HeadersInit = {}) =>
    leaderboardRoute(new Request(`http://localhost/api/leaderboard?${query}`, { headers }));
  const history = (query: string, headers: HeadersInit = {}) =>
    historyRoute(new Request(`http://localhost/api/player/history${query}`, { headers }));
  type Board = { me: { name: string | null } | null; entries: { name: string; isMe: boolean }[] };
  /** 応答の本文とヘッダーに、どの playerId も含まないことを確かめて読む */
  async function readBoard(res: Response) {
    for (const [, value] of res.headers) for (const id of [ANN, BOB]) expect(value).not.toContain(id);
    const { status, body } = await read(res, [ANN, BOB]);
    return { status, body: body as Board, cache: res.headers.get("cache-control") };
  }
  const meOf = (b: Board) => [b.me?.name, b.entries.filter((e) => e.isMe).map((e) => e.name)];

  beforeEach(async () => {
    // 歴代の表に 2 人（どちらの playerId で読んだかを、自分の順位で見分ける）
    const store = getStore()!;
    await store.setName(ANN, "アリス");
    await store.setName(BOB, "ボブ");
    await store.record("2020-01-01", "expert", { playerId: ANN, timeMs: 600_000, points: 9000 });
    await store.record("2020-01-01", "expert", { playerId: BOB, timeMs: 700_000, points: 8000 });
    await store.addHistory(ANN, { date: "2020-01-01", difficulty: "expert", points: 9000, timeMs: 600_000 });
    at(40);
  });

  it("ヘッダーの playerId で自分の順位を返す。クエリにもあればヘッダーを使う。応答に Deprecation は付けない", async () => {
    const mine = await get(board, { [PLAYER_ID_HEADER]: ANN });
    const both = await get(`${board}&playerId=${BOB}`, { [PLAYER_ID_HEADER]: ANN });
    for (const res of [mine, both]) {
      expect(res.headers.get("deprecation")).toBeNull();
      expect(res.headers.get("sunset")).toBeNull();
      const { status, body, cache } = await readBoard(res);
      expect([status, cache, ...meOf(body)]).toEqual([200, "private, no-store", "アリス", ["アリス"]]);
    }
    const res = await history("", { [PLAYER_ID_HEADER]: ANN });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("deprecation")).toBeNull();
    expect(await read(res, [ANN])).toEqual({
      status: 200,
      body: { entries: [{ date: "2020-01-01", difficulty: "expert", points: 9000, timeMs: 600_000 }] },
    });
  });

  it("ヘッダーが無ければ、期限の前はクエリの playerId も受け付け、Deprecation と Sunset を付ける。何も記録しない", async () => {
    const log = (["error", "warn", "info", "log", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const res = await get(`${board}&playerId=${BOB}`);
    expect(res.headers.get("deprecation")).toBe(`@${Date.parse(PLAYER_ID_QUERY_DEPRECATED) / 1000}`);
    expect(res.headers.get("sunset")).toBe("Sat, 19 Dec 2026 15:00:00 GMT");
    expect(Date.parse(res.headers.get("sunset")!)).toBe(Date.parse(PLAYER_ID_QUERY_SUNSET));
    expect(res.headers.get("vary")).toContain(PLAYER_ID_HEADER);
    const { status, body, cache } = await readBoard(res);
    expect([status, cache, ...meOf(body)]).toEqual([200, "private, no-store", "ボブ", ["ボブ"]]);
    const old = await history(`?playerId=${ANN}`);
    expect(old.headers.get("cache-control")).toBe("private, no-store");
    expect(old.headers.get("deprecation")).toMatch(/^@\d+$/);
    expect((await read(old, [ANN])).status).toBe(200);
    for (const spy of log) expect(spy).not.toHaveBeenCalled();
  });

  it("期限（PLAYER_ID_QUERY_SUNSET）からは、クエリに playerId があれば 400（ヘッダーがあっても）。1ms 前までは受け付ける", async () => {
    const sunset = Date.parse(PLAYER_ID_QUERY_SUNSET);
    expect(sunset).toBe(Date.parse("2026-12-19T15:00:00Z"));
    vi.setSystemTime(sunset - 1);
    expect((await get(`${board}&playerId=${BOB}`)).status).toBe(200);
    expect((await history(`?playerId=${ANN}`)).status).toBe(200);
    vi.setSystemTime(sunset);
    for (const res of [
      await get(`${board}&playerId=${BOB}`),
      await get(`${board}&playerId=${BOB}`, { [PLAYER_ID_HEADER]: ANN }),
      await get(`${board}&playerId=`),
      await history(`?playerId=${ANN}`),
      await history(`?playerId=${ANN}`, { [PLAYER_ID_HEADER]: ANN }),
    ]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("deprecation")).toBeNull();
      expect(await read(res, [ANN, BOB])).toEqual({ status: 400, body: { error: "player id in query" } });
    }
    // ヘッダーだけの要求と、playerId の無い要求は今までどおり
    const mine = await readBoard(await get(board, { [PLAYER_ID_HEADER]: ANN }));
    expect([mine.status, mine.cache, ...meOf(mine.body)]).toEqual([
      200,
      "private, no-store",
      "アリス",
      ["アリス"],
    ]);
    const shared = await readBoard(await get(board));
    expect([shared.status, shared.cache, ...meOf(shared.body)]).toEqual([
      200,
      "public, s-maxage=10, stale-while-revalidate=30",
      undefined,
      [],
    ]);
    expect((await history("", { [PLAYER_ID_HEADER]: ANN })).status).toBe(200);
  });

  it("ヘッダーの値の形が違えば（空・大文字・2 つ・余計な文字）400 invalid player id で、クエリの正しい値も使わない", async () => {
    const twice = new Headers();
    twice.append(PLAYER_ID_HEADER, ANN);
    twice.append(PLAYER_ID_HEADER, BOB);
    for (const headers of [
      { [PLAYER_ID_HEADER]: "" },
      { [PLAYER_ID_HEADER]: ANN.toUpperCase() },
      { [PLAYER_ID_HEADER]: `${ANN}0` },
      { [PLAYER_ID_HEADER]: `{${ANN}}` },
      twice,
    ]) {
      for (const res of [
        await get(board, headers),
        await get(`${board}&playerId=${BOB}`, headers),
        await history("", headers),
        await history(`?playerId=${ANN}`, headers),
      ]) {
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await read(res, [ANN, BOB])).toEqual({ status: 400, body: { error: "invalid player id" } });
      }
    }
    // 履歴は playerId が無ければ 400
    expect(await read(await history(""))).toEqual({ status: 400, body: { error: "invalid player id" } });
  });

  it("URL と Vary のヘッダーで鍵を作る共有キャッシュ（CDN）を通しても、別の人や公開の応答を返さない", async () => {
    /**
     * CDN の代わり。GET の 200 で、Cache-Control に s-maxage があり private・no-store・no-cache が無い応答だけを、
     * URL と Vary に挙げた要求ヘッダーの値で保存する（Vercel の CDN の保存の条件と鍵の作り方の要点。期限は見ない）。
     * ignoreVary は Vary を見ない CDN（Vary が要る理由を確かめる）
     */
    function sharedCache({ ignoreVary = false } = {}) {
      const saved: { url: string; vary: string[]; values: (string | null)[]; res: Response }[] = [];
      const send = async (url: string, headers: Record<string, string> = {}) => {
        const req = new Request(url, { headers });
        const hit = saved.find(
          (e) => e.url === req.url && e.vary.every((h, i) => req.headers.get(h) === e.values[i]),
        );
        if (hit) return { hit: true, res: hit.res.clone() };
        const res = await leaderboardRoute(req);
        const cc = res.headers.get("cache-control") ?? "";
        if (res.status === 200 && /s-maxage/.test(cc) && !/private|no-store|no-cache/.test(cc)) {
          const vary = ignoreVary
            ? []
            : (res.headers.get("vary") ?? "")
                .split(",")
                .map((h) => h.trim().toLowerCase())
                .filter(Boolean);
          saved.push({ url: req.url, vary, values: vary.map((h) => req.headers.get(h)), res: res.clone() });
        }
        return { hit: false, res };
      };
      return { saved, send };
    }
    const url = `http://localhost/api/leaderboard?${board}`;
    const cdn = sharedCache();
    const order = [
      ["公開", {}],
      ["アリス", { [PLAYER_ID_HEADER]: ANN }],
      ["ボブ", { [PLAYER_ID_HEADER]: BOB }],
      ["アリス", { [PLAYER_ID_HEADER]: ANN }],
      ["公開", {}],
    ] as const;
    const got: unknown[][] = [];
    for (const [who, headers] of order) {
      const { hit, res } = await cdn.send(url, headers);
      const { body } = await readBoard(res);
      got.push([who, hit, body.me?.name ?? null]);
    }
    expect(got).toEqual([
      ["公開", false, null],
      ["アリス", false, "アリス"],
      ["ボブ", false, "ボブ"],
      ["アリス", false, "アリス"],
      ["公開", true, null],
    ]);
    // 保存したのは公開の応答だけ
    expect(cdn.saved).toHaveLength(1);
    expect(cdn.saved[0].values).toEqual([null]);

    // Vary を見ない CDN なら、ヘッダー付きの要求に公開の応答（自分の順位が無い）が返る
    const blind = sharedCache({ ignoreVary: true });
    await blind.send(url);
    const { hit, res } = await blind.send(url, { [PLAYER_ID_HEADER]: ANN });
    expect([hit, (await readBoard(res)).body.me]).toEqual([true, null]);
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
