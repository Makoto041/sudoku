import { createECDH, randomBytes } from "node:crypto";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 実際のプッシュサービスへは送らない
const sendNotification = vi.hoisted(() => vi.fn(async () => ({ statusCode: 201, body: "", headers: {} })));
vi.mock("web-push", () => ({ default: { sendNotification } }));

import { DELETE, POST } from "@/app/api/push/route";
import { GET as cron } from "@/app/api/cron/remind/route";
import { clientIp, handle } from "./http";
import { FAILURE_KINDS } from "./push";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/routeTest:APA91b-x";
const KEYS = {
  p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
  auth: randomBytes(16).toString("base64url"),
};
const ENV = {
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "BPublicKeyForTest",
  VAPID_PRIVATE_KEY: "private-key-for-test",
  VAPID_SUBJECT: "mailto:test@example.com",
  CRON_SECRET: "cron-secret-for-test",
};
const NO_FAILURES = Object.fromEntries(FAILURE_KINDS.map((k) => [k, 0]));
const SECRETS = [
  ENDPOINT,
  "routeTest",
  KEYS.p256dh,
  KEYS.auth,
  ALICE,
  ENV.VAPID_PRIVATE_KEY,
  ENV.CRON_SECRET,
];

const req = (method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/push", {
    method,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
const cronReq = (authorization?: string) =>
  new Request("http://localhost/api/cron/remind", {
    headers: authorization === undefined ? {} : { authorization },
  });

async function read(res: Response) {
  const text = await res.text();
  for (const s of SECRETS) expect(text).not.toContain(s);
  return { status: res.status, body: JSON.parse(text) as unknown };
}

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
  for (const k of Object.keys(ENV)) vi.stubEnv(k, "");
  sendNotification.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const setEnv = () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
};

describe("通知の API", () => {
  it("環境変数が無ければ購読も解除も cron も 503", async () => {
    const sub = { playerId: ALICE, subscription: { endpoint: ENDPOINT, keys: KEYS } };
    expect(await read(await POST(req("POST", sub)))).toEqual({
      status: 503,
      body: { error: "push unavailable" },
    });
    expect((await read(await DELETE(req("DELETE", { playerId: ALICE, endpoint: ENDPOINT })))).status).toBe(
      503,
    );
    // シークレットが未設定なら、空の Bearer でも通さない
    expect((await read(await cron(cronReq("Bearer ")))).status).toBe(503);
    expect((await read(await cron(cronReq(`Bearer ${ENV.CRON_SECRET}`)))).status).toBe(503);
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", ENV.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
    vi.stubEnv("VAPID_PRIVATE_KEY", ENV.VAPID_PRIVATE_KEY);
    vi.stubEnv("VAPID_SUBJECT", ENV.VAPID_SUBJECT);
    expect((await read(await cron(cronReq("Bearer ")))).status).toBe(503);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("不正な入力は 400・413 で、応答に endpoint・鍵・プレイヤー ID を含めない", async () => {
    setEnv();
    const cases: [unknown, number][] = [
      ["not json", 400],
      ["", 400],
      [[1, 2], 400],
      ["null", 400],
      ["42", 400],
      ['"s"', 400],
      [{ playerId: "nope", subscription: { endpoint: ENDPOINT, keys: KEYS } }, 400],
      [{ playerId: ALICE, subscription: { endpoint: ENDPOINT.replace("https", "http"), keys: KEYS } }, 400],
      [{ playerId: ALICE, subscription: { endpoint: "https://127.0.0.1/routeTest", keys: KEYS } }, 400],
      [{ playerId: ALICE, subscription: { endpoint: ENDPOINT, keys: { ...KEYS, auth: KEYS.p256dh } } }, 400],
      [{ playerId: ALICE, subscription: { endpoint: ENDPOINT, keys: KEYS }, pad: "x".repeat(5000) }, 413],
    ];
    for (const [body, status] of cases) {
      const res = await read(await POST(req("POST", body)));
      expect(res.status).toBe(status);
      expect(res.body).toHaveProperty("error");
    }
    expect(
      (await read(await DELETE(req("DELETE", { playerId: ALICE, endpoint: "http://x/routeTest" })))).status,
    ).toBe(400);
  });

  it("url.parse では別のホストになる endpoint（SSRF の再現例）は 400 invalid endpoint で、送信もしない", async () => {
    setEnv();
    for (const endpoint of [
      "https://evil.example.com;.push.apple.com/routeTest",
      "https://169.254.169.254;.push.apple.com/routeTest",
      "https://internal-svc'.notify.windows.com/routeTest",
      "https://internal.svc%60.push.apple.com/routeTest",
    ]) {
      const res = await read(
        await POST(req("POST", { playerId: ALICE, subscription: { endpoint, keys: KEYS } })),
      );
      expect([endpoint, res]).toEqual([endpoint, { status: 400, body: { error: "invalid endpoint" } }]);
    }
    expect((await read(await cron(cronReq(`Bearer ${ENV.CRON_SECRET}`)))).body).toMatchObject({ targets: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("他人の購読と同じ endpoint を auth の違う鍵で登録すると 409", async () => {
    setEnv();
    const endpoint = `${ENDPOINT}-conflict`;
    const sub = (playerId: string, keys: typeof KEYS) =>
      req("POST", { playerId, subscription: { endpoint, keys } });
    expect((await read(await POST(sub(ALICE, KEYS)))).status).toBe(200);
    const other = {
      p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    };
    expect(await read(await POST(sub(BOB, other)))).toEqual({
      status: 409,
      body: { error: "subscription conflict" },
    });
    // auth が同じ（引き継ぎで同じ端末のプレイヤーが変わった）なら移せる
    expect((await read(await POST(sub(BOB, { ...other, auth: KEYS.auth })))).status).toBe(200);
    expect((await read(await DELETE(req("DELETE", { playerId: BOB, endpoint })))).status).toBe(200);
  });

  it("登録・解除は { ok: true }、cron は認証が合ったときだけ送り、件数だけを返す", async () => {
    setEnv();
    const sub = { playerId: ALICE, subscription: { endpoint: ENDPOINT, keys: KEYS } };
    expect(await read(await POST(req("POST", sub)))).toEqual({ status: 200, body: { ok: true } });

    expect((await read(await cron(cronReq()))).status).toBe(401);
    expect((await read(await cron(cronReq("Bearer wrong")))).status).toBe(401);
    expect((await read(await cron(cronReq(`Bearer ${ENV.CRON_SECRET}x`)))).status).toBe(401);
    expect(sendNotification).not.toHaveBeenCalled();

    const ok = await read(await cron(cronReq(`Bearer ${ENV.CRON_SECRET}`)));
    expect(ok).toEqual({
      status: 200,
      body: { targets: 1, sent: 1, removed: 0, failed: 0, failures: NO_FAILURES, truncated: false },
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [target, payload, options] = sendNotification.mock.calls[0] as unknown as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(target).toEqual({ endpoint: ENDPOINT, keys: KEYS });
    expect(JSON.parse(payload)).toEqual({ title: "ナンプレ", body: "今日の一問はまだです" });
    expect(options).toMatchObject({
      vapidDetails: {
        subject: ENV.VAPID_SUBJECT,
        publicKey: ENV.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        privateKey: ENV.VAPID_PRIVATE_KEY,
      },
      urgency: "normal",
      timeout: 10_000,
    });
    // web-push は https.Agent 以外の agent を警告だけで無視する
    expect(options.agent).toBeInstanceOf(https.Agent);
    expect(options.TTL).toBeGreaterThanOrEqual(0);
    expect(options.TTL).toBeLessThanOrEqual(6 * 60 * 60);

    expect(await read(await DELETE(req("DELETE", { playerId: ALICE, endpoint: ENDPOINT })))).toEqual({
      status: 200,
      body: { ok: true },
    });
    sendNotification.mockClear();
    await read(await cron(cronReq(`Bearer ${ENV.CRON_SECRET}`)));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("cron の失敗の内訳は種類の件数だけで、エラーの中身（endpoint・本文・鍵・プレイヤー ID）を含めない", async () => {
    setEnv();
    const endpoint = `${ENDPOINT}-failing`;
    const sub = { playerId: ALICE, subscription: { endpoint, keys: KEYS } };
    expect((await read(await POST(req("POST", sub)))).status).toBe(200);
    // web-push の WebPushError と同じ形（本文・endpoint・ヘッダーを持つ）
    sendNotification.mockRejectedValueOnce(
      Object.assign(new Error(`Received unexpected response code ${endpoint}`), {
        statusCode: 403,
        body: JSON.stringify({ reason: "BadJwtToken", endpoint, playerId: ALICE, auth: KEYS.auth }),
        headers: { "x-endpoint": endpoint },
        endpoint,
      }),
    );
    const res = await read(await cron(cronReq(`Bearer ${ENV.CRON_SECRET}`)));
    expect(res).toEqual({
      status: 200,
      body: {
        targets: 1,
        sent: 0,
        removed: 0,
        failed: 1,
        failures: { ...NO_FAILURES, http4xx: 1 },
        truncated: false,
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("BadJwtToken");
    expect((await read(await DELETE(req("DELETE", { playerId: ALICE, endpoint })))).status).toBe(200);
  });
});

describe("登録元の IP", () => {
  const ip = (headers: Record<string, string>) => clientIp(new Headers(headers));

  it("x-forwarded-for の最初の要素、無ければ x-real-ip。IP として読めなければ null", () => {
    expect(ip({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 192.0.2.1" })).toBe("203.0.113.7");
    expect(ip({ "x-forwarded-for": " 2001:DB8::1 ,10.0.0.1" })).toBe("2001:db8::1");
    expect(ip({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4" })).toBe("203.0.113.7");
    expect(ip({ "x-real-ip": "198.51.100.4" })).toBe("198.51.100.4");
    expect(ip({ "x-forwarded-for": "garbage, 203.0.113.7", "x-real-ip": "198.51.100.4" })).toBe(
      "198.51.100.4",
    );
    expect(ip({ "x-forwarded-for": "garbage, 203.0.113.7" })).toBeNull();
    expect(ip({ "x-forwarded-for": "", "x-real-ip": "nope" })).toBeNull();
    expect(ip({})).toBeNull();
  });
});

describe("新規登録の回数制限（購読 API）", () => {
  // カウンタは保存先（テストの間で共有するメモリ）に残るので、テストごとに別の 1 時間の窓に時刻を固定する。
  // 前のテストが実際の時刻で数えた分（IP のヘッダー無し）と重ならないよう、過去の日付にする
  const at = (hour: number) => vi.setSystemTime(Date.parse("2020-01-01T00:30:00Z") + hour * 60 * 60 * 1000);
  /** テストごとに別のプレイヤー ID・endpoint を作る（プレイヤーの回数制限は 24 時間の窓なので重ねない） */
  const pid = (test: number, i: number) =>
    `${test.toString(16).padStart(4, "0")}${i.toString(16).padStart(4, "0")}-3333-4333-8333-333333333333`;
  const ep = (test: number, i: number) => `${ENDPOINT}-rl${test}-${i}`;
  const post = (playerId: string, endpoint: string, headers: Record<string, string> = {}) =>
    POST(req("POST", { playerId, subscription: { endpoint, keys: KEYS } }, headers));
  let logs: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    setEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    logs = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 応答に IP・プレイヤー ID・endpoint を含めず、何も記録していないことを確かめて、状態と本文を返す */
  async function readQuiet(res: Response, secrets: string[]) {
    const text = await res.text();
    for (const s of [...SECRETS, ...secrets]) expect(text).not.toContain(s);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    return { status: res.status, body: JSON.parse(text) as unknown };
  }

  it("同じ IP（x-forwarded-for の最初の要素）からの新規登録は 20 件までで、21 件目は 429 rate limited。応答にも記録にも IP などを出さない", async () => {
    at(1);
    const IP = "203.0.113.70";
    const secrets = [IP, "10.0.0.", pid(1, 20), ep(1, 20), "rl1-"];
    for (let i = 0; i < 20; i++) {
      // 2 番目以降の要素は毎回変える（最初の要素で数えていなければ、21 件目も通ってしまう）
      const res = await post(pid(1, i), ep(1, i), { "x-forwarded-for": `${IP}, 10.0.0.${i}` });
      expect([i, await readQuiet(res, secrets)]).toEqual([i, { status: 200, body: { ok: true } }]);
    }
    const limited = await post(pid(1, 20), ep(1, 20), { "x-forwarded-for": `${IP}, 10.0.0.99` });
    expect(await readQuiet(limited, secrets)).toEqual({ status: 429, body: { error: "rate limited" } });
    // 登録済みの購読の更新と解除は制限しない
    for (let i = 0; i < 20; i++) {
      const res = await post(pid(1, i), ep(1, i), { "x-forwarded-for": IP });
      expect([i, (await readQuiet(res, secrets)).status]).toEqual([i, 200]);
    }
    const del = await DELETE(
      req("DELETE", { playerId: pid(1, 0), endpoint: ep(1, 0) }, { "x-forwarded-for": IP }),
    );
    expect((await readQuiet(del, secrets)).status).toBe(200);
    // 次の 1 時間の窓ではまた受け付ける
    at(2);
    const next = await post(pid(1, 20), ep(1, 20), { "x-forwarded-for": `${IP}, 10.0.0.99` });
    expect(await readQuiet(next, secrets)).toEqual({ status: 200, body: { ok: true } });
  });

  it("x-forwarded-for の 2 番目以降の要素では数えない（最初の要素が違えば別の IP）", async () => {
    at(3);
    for (let i = 0; i < 25; i++) {
      const res = await post(pid(3, i), ep(3, i), { "x-forwarded-for": `198.51.100.${i}, 203.0.113.80` });
      expect([i, (await readQuiet(res, ["203.0.113.80"])).status]).toEqual([i, 200]);
    }
  });

  it("x-forwarded-for が無ければ x-real-ip で数える", async () => {
    at(4);
    const IP = "198.51.100.40";
    for (let i = 0; i < 20; i++) {
      expect((await readQuiet(await post(pid(4, i), ep(4, i), { "x-real-ip": IP }), [IP])).status).toBe(200);
    }
    expect(await readQuiet(await post(pid(4, 20), ep(4, 20), { "x-real-ip": IP }), [IP])).toEqual({
      status: 429,
      body: { error: "rate limited" },
    });
  });

  it("IP のヘッダーが無い要求は、固定のキーでまとめて制限する（ヘッダーを外して回避できない）", async () => {
    at(5);
    for (let i = 0; i < 20; i++)
      expect((await readQuiet(await post(pid(5, i), ep(5, i)), [])).status).toBe(200);
    expect(await readQuiet(await post(pid(5, 20), ep(5, 20)), [])).toEqual({
      status: 429,
      body: { error: "rate limited" },
    });
    expect(
      (await readQuiet(await post(pid(5, 21), ep(5, 21), { "x-forwarded-for": "not-an-ip" }), [])).status,
    ).toBe(429);
    expect(
      (await readQuiet(await post(pid(5, 22), ep(5, 22), { "x-forwarded-for": "203.0.113.50" }), [])).status,
    ).toBe(200);
  });

  it("検査で弾いた要求（400・409）は数えない", async () => {
    at(6);
    const IP = "203.0.113.60";
    const h = { "x-forwarded-for": IP };
    const owner = await post(pid(6, 99), ep(6, 99), { "x-forwarded-for": "198.51.100.60" });
    expect((await readQuiet(owner, [IP])).status).toBe(200);
    const other = { p256dh: KEYS.p256dh, auth: Buffer.alloc(16, 7).toString("base64url") };
    for (let k = 0; k < 30; k++) {
      const bad: [unknown, number][] = [
        ["not json", 400],
        [{ playerId: "nope", subscription: { endpoint: ep(6, k), keys: KEYS } }, 400],
        [{ playerId: pid(6, k), subscription: { endpoint: "https://127.0.0.1/x", keys: KEYS } }, 400],
        [{ playerId: pid(6, k), subscription: { endpoint: ep(6, 99), keys: other } }, 409],
      ];
      for (const [body, status] of bad) {
        expect([k, (await readQuiet(await POST(req("POST", body, h)), [IP])).status]).toEqual([k, status]);
      }
    }
    for (let i = 0; i < 20; i++) {
      expect([i, (await readQuiet(await post(pid(6, i), ep(6, i), h), [IP])).status]).toEqual([i, 200]);
    }
    expect((await readQuiet(await post(pid(6, 20), ep(6, 20), h), [IP])).status).toBe(429);
  });

  it("同じプレイヤーの新規登録は、IP を変えても 24 時間に 10 件まで", async () => {
    at(7);
    const playerId = pid(7, 0);
    for (let i = 0; i < 10; i++) {
      const res = await post(playerId, ep(7, i), { "x-forwarded-for": `192.0.2.${i}` });
      expect([i, (await readQuiet(res, [playerId])).status]).toEqual([i, 200]);
    }
    const limited = await post(playerId, ep(7, 10), { "x-forwarded-for": "192.0.2.10" });
    expect(await readQuiet(limited, [playerId, ep(7, 10)])).toEqual({
      status: 429,
      body: { error: "rate limited" },
    });
  });
});

describe("エラーの記録", () => {
  it("redactErrors のときは、エラーの中身（Upstash が含める送ったコマンド）を記録しない", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handle(
      async () => {
        throw new Error(
          `command was: ["set","sdk:push:x","{\\"endpoint\\":\\"${ENDPOINT}\\",\\"playerId\\":\\"${ALICE}\\"}"]`,
        );
      },
      { redactErrors: true },
    );
    expect((await read(res)).status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.mock.calls[0].map(String));
    for (const s of SECRETS) expect(logged).not.toContain(s);
  });
});
