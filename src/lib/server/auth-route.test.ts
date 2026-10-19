import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// パスキーの検証は本物を通さず、成否を決める（本物の検証は webauthn-real.test.ts）
const result = vi.hoisted(() => ({ registration: true, authentication: true }));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async ({ response }: { response: { id: string } }) =>
      result.registration
        ? {
            verified: true,
            registrationInfo: {
              credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
              credentialDeviceType: "multiDevice",
              credentialBackedUp: true,
            },
          }
        : { verified: false },
    ),
    verifyAuthenticationResponse: vi.fn(async ({ credential }: { credential: { id: string } }) => ({
      verified: result.authentication,
      authenticationInfo: {
        credentialID: credential.id,
        newCounter: 1,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
      },
    })),
  };
});

import { verifyRegistrationResponse } from "@simplewebauthn/server";
import * as accountRoute from "@/app/api/auth/account/route";
import * as loginOptionsRoute from "@/app/api/auth/login/options/route";
import * as loginVerifyRoute from "@/app/api/auth/login/verify/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as mergeRoute from "@/app/api/auth/merge/route";
import * as passkeysOptionsRoute from "@/app/api/auth/passkeys/options/route";
import * as passkeysVerifyRoute from "@/app/api/auth/passkeys/verify/route";
import * as signupOptionsRoute from "@/app/api/auth/signup/options/route";
import * as signupVerifyRoute from "@/app/api/auth/signup/verify/route";
import * as statsRoute from "@/app/api/auth/stats/route";
import { SITE_HOST, SITE_ORIGIN } from "@/lib/site";
import { attestationObject, b64, clientData, unb64 } from "./auth-test-helpers";
import { getStore } from "./store";

const LOCAL = "http://localhost:3000";

let seq = 0;
/** テストごとに別のプレイヤー・IP にする（保存先と回数制限のカウンタはファイル内で共有する） */
const next = () => {
  seq++;
  return {
    playerId: `${seq.toString(16).padStart(8, "0")}-4444-4444-8444-444444444444`,
    ip: `198.51.100.${seq}`,
    credId: b64(`route-cred-${seq}`),
  };
};

type Opts = {
  method?: string;
  origin?: string | null;
  contentType?: string | null;
  cookie?: string;
  ip?: string;
  base?: string;
};

/** GET 以外の要求（既定は POST） */
function write(path: string, body: unknown, opts: Opts = {}) {
  const base = opts.base ?? SITE_ORIGIN;
  const headers: Record<string, string> = {};
  const origin = opts.origin === undefined ? base : opts.origin;
  if (origin !== null) headers.origin = origin;
  const contentType = opts.contentType === undefined ? "application/json" : opts.contentType;
  if (contentType !== null) headers["content-type"] = contentType;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  // 文字列の本文は Content-Type が自動で付くので、バイト列で渡す
  return new Request(`${base}/api/auth/${path}`, {
    method: opts.method ?? "POST",
    body: new TextEncoder().encode(text),
    headers,
  });
}

function get(path: string, opts: Opts & { host?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.host) headers.host = opts.host;
  return new Request(`${opts.base ?? SITE_ORIGIN}/api/auth/${path}`, { headers });
}

type Handler = (req: Request) => Promise<Response>;

/** GET 以外の API（パス → メソッド・route の関数・ログインが必要か） */
const WRITES: Record<string, { method: string; handler: Handler; signedIn: boolean }> = {
  "signup/options": { method: "POST", handler: signupOptionsRoute.POST, signedIn: false },
  "signup/verify": { method: "POST", handler: signupVerifyRoute.POST, signedIn: false },
  "login/options": { method: "POST", handler: loginOptionsRoute.POST, signedIn: false },
  "login/verify": { method: "POST", handler: loginVerifyRoute.POST, signedIn: false },
  logout: { method: "POST", handler: logoutRoute.POST, signedIn: true },
  "passkeys/options": { method: "POST", handler: passkeysOptionsRoute.POST, signedIn: true },
  "passkeys/verify": { method: "POST", handler: passkeysVerifyRoute.POST, signedIn: true },
  account: { method: "DELETE", handler: accountRoute.DELETE, signedIn: true },
  stats: { method: "PUT", handler: statsRoute.PUT, signedIn: true },
  merge: { method: "POST", handler: mergeRoute.POST, signedIn: true },
};

/** 応答の本文を読む。secrets（トークンなど）を含まないことも確かめる */
async function read(res: Response, secrets: string[] = []) {
  const text = await res.text();
  for (const s of secrets) expect(text).not.toContain(s);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

const setCookies = (res: Response) => res.headers.getSetCookie();
const tokenIn = (setCookie: string, name: string) =>
  new RegExp(`^${name}=([^;]*)`).exec(setCookie)?.[1] ?? null;

/** 応答の Set-Cookie から、https のログインの Cookie（要求に付ける形）とトークンを取り出す */
function cookieOf(res: Response) {
  const token = tokenIn(setCookies(res)[0], "__Secure-sdk_auth")!;
  return { cookie: `__Secure-sdk_auth=${token}`, token };
}

/** https の Cookie を消す Set-Cookie が 1 つだけ付いている（Path と Secure をそろえ、期限を過去にする） */
function expectCleared(res: Response) {
  const [cleared, ...rest] = setCookies(res);
  expect(rest).toEqual([]);
  expect(tokenIn(cleared, "__Secure-sdk_auth")).toBe("");
  expect(cleared).toMatch(/; Path=\/api\/auth(;|$)/);
  expect(cleared).toMatch(/; Expires=Thu, 01 Jan 1970 00:00:00 GMT(;|$)/);
  expect(cleared).toMatch(/; Secure(;|$)/);
}

/** 登録の応答（検証は偽物なので、形だけそろえる） */
const createResponse = (credId: string, challenge: string, origin = SITE_ORIGIN) => ({
  id: credId,
  rawId: credId,
  type: "public-key",
  response: {
    clientDataJSON: clientData("webauthn.create", challenge, origin),
    attestationObject: attestationObject(),
  },
});

async function signup(p: ReturnType<typeof next>, base = SITE_ORIGIN) {
  const opts = await signupOptionsRoute.POST(
    write("signup/options", { playerId: p.playerId }, { ip: p.ip, base }),
  );
  const { options } = (await read(opts)).body as { options: { challenge: string; user: { id: string } } };
  const response = createResponse(p.credId, options.challenge, base);
  const res = await signupVerifyRoute.POST(write("signup/verify", { response }, { ip: p.ip, base }));
  return { res, accountId: unb64(options.user.id) };
}

async function login(p: ReturnType<typeof next>, accountId: string, opts: Opts = {}) {
  const res = await loginOptionsRoute.POST(write("login/options", {}, { ip: p.ip, ...opts }));
  const { options } = (await read(res)).body as { options: { challenge: string } };
  const response = {
    id: p.credId,
    rawId: p.credId,
    type: "public-key",
    response: {
      clientDataJSON: clientData("webauthn.get", options.challenge),
      authenticatorData: b64("authenticator-data"),
      signature: b64("signature"),
      userHandle: b64(accountId),
    },
  };
  return loginVerifyRoute.POST(write("login/verify", { response }, { ip: p.ip, ...opts }));
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
  vi.stubEnv("WEBAUTHN_ORIGIN", SITE_ORIGIN);
  result.registration = true;
  result.authentication = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("アカウントの API", () => {
  it("どの route も動的で、Node.js で動く", () => {
    for (const route of [
      meRoute,
      signupOptionsRoute,
      signupVerifyRoute,
      loginOptionsRoute,
      loginVerifyRoute,
      logoutRoute,
      passkeysOptionsRoute,
      passkeysVerifyRoute,
      accountRoute,
      statsRoute,
      mergeRoute,
    ]) {
      expect([route.dynamic, route.runtime]).toEqual(["force-dynamic", "nodejs"]);
    }
  });

  it("GET 以外は Origin が無い・違えば 403、Content-Type が application/json でなければ 415（本文を読む前に）", async () => {
    const p = next();
    for (const [path, { method, handler }] of Object.entries(WRITES)) {
      for (const origin of [null, "https://sudoku-xi-five.vercel.app", "null", `${SITE_ORIGIN}/`, LOCAL]) {
        const res = await read(await handler(write(path, "not json", { method, origin, ip: p.ip })));
        expect([path, origin, res]).toEqual([
          path,
          origin,
          { status: 403, body: { error: "invalid origin" } },
        ]);
      }
      for (const contentType of [
        null,
        "text/plain",
        "application/x-www-form-urlencoded",
        "application/jsonx",
      ]) {
        const res = await read(await handler(write(path, "not json", { method, contentType, ip: p.ip })));
        expect([path, contentType, res]).toEqual([
          path,
          contentType,
          { status: 415, body: { error: "invalid content type" } },
        ]);
      }
      // JSON なら charset などの付け足しや大文字でも通り、本文の読み取りに進む
      for (const contentType of ["application/json; charset=utf-8", "Application/JSON"]) {
        const res = await read(await handler(write(path, "not json", { method, contentType, ip: p.ip })));
        expect([path, res]).toEqual([path, { status: 400, body: { error: "invalid json" } }]);
      }
    }
  });

  it("作成からログアウトまで：トークンは HttpOnly・Secure・SameSite=Strict の __Secure- Cookie だけに入れ、本文には出さない", async () => {
    const p = next();
    const { res, accountId } = await signup(p);
    const [cookie, ...rest] = setCookies(res);
    expect(rest).toEqual([]);
    const token = tokenIn(cookie, "__Secure-sdk_auth")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatch(/; Path=\/api\/auth(;|$)/);
    expect(cookie).toMatch(/; Max-Age=7776000(;|$)/);
    expect(cookie).toMatch(/; Secure(;|$)/);
    expect(cookie).toMatch(/; HttpOnly(;|$)/);
    expect(cookie).toMatch(/; SameSite=strict(;|$)/i);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(await read(res, [token])).toEqual({
      status: 200,
      body: { account: { playerId: p.playerId, name: null, passkeys: 1, stats: null } },
    });

    // ログイン状態の確認は、同じトークンの Cookie を出し直して期限を延ばす
    const auth = `__Secure-sdk_auth=${token}`;
    const meRes = await meRoute.GET(get("me", { cookie: `other=1; ${auth}` }));
    expect(setCookies(meRes)).toHaveLength(1);
    expect(tokenIn(setCookies(meRes)[0], "__Secure-sdk_auth")).toBe(token);
    expect((await read(meRes, [token])).body).toEqual({
      account: { playerId: p.playerId, name: null, passkeys: 1, stats: null },
    });

    // 別の端末でログイン → その端末からほかの端末をログアウトすると、最初の端末のセッションは無効
    const loginRes = await login(p, accountId);
    const other = tokenIn(setCookies(loginRes)[0], "__Secure-sdk_auth")!;
    expect(other).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(other).not.toBe(token);
    expect(await read(loginRes, [other, token])).toEqual({
      status: 200,
      body: { account: { playerId: p.playerId, name: null, passkeys: 1, stats: null } },
    });
    const others = await logoutRoute.POST(
      write("logout", { scope: "others" }, { cookie: `__Secure-sdk_auth=${other}`, ip: p.ip }),
    );
    expect(setCookies(others)).toEqual([]);
    expect(await read(others, [other])).toEqual({ status: 200, body: { ok: true } });
    const stale = await meRoute.GET(get("me", { cookie: auth }));
    expect(setCookies(stale)).toEqual([]);
    expect((await read(stale)).body).toEqual({ account: null });

    // この端末のログアウトは Cookie も消す
    const out = await logoutRoute.POST(
      write("logout", {}, { cookie: `__Secure-sdk_auth=${other}`, ip: p.ip }),
    );
    expectCleared(out);
    expect(await read(out)).toEqual({ status: 200, body: { ok: true } });
    expect((await read(await meRoute.GET(get("me", { cookie: `__Secure-sdk_auth=${other}` })))).body).toEqual(
      {
        account: null,
      },
    );
  });

  it("http の localhost では Cookie は sdk_auth で Secure を付けない", async () => {
    vi.stubEnv("WEBAUTHN_ORIGIN", "");
    const p = next();
    const { res } = await signup(p, LOCAL);
    const [cookie] = setCookies(res);
    const token = tokenIn(cookie, "sdk_auth")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).not.toMatch(/Secure/i);
    expect(cookie).toMatch(/; HttpOnly(;|$)/);
    expect(cookie).toMatch(/; Path=\/api\/auth(;|$)/);
    expect((await read(res, [token])).status).toBe(200);
    const meRes = await meRoute.GET(get("me", { base: LOCAL, cookie: `sdk_auth=${token}` }));
    expect((await read(meRes)).body).toMatchObject({ account: { playerId: p.playerId } });
    // https の名前の Cookie は読まない
    const wrong = await meRoute.GET(get("me", { base: LOCAL, cookie: `__Secure-sdk_auth=${token}` }));
    expect((await read(wrong)).body).toEqual({ account: null });
  });

  it("ログインが必要な API は、Cookie が無い・無効なら 401 not signed in で、Cookie を消す", async () => {
    const p = next();
    for (const [path, { method, handler }] of Object.entries(WRITES).filter(([, r]) => r.signedIn)) {
      for (const cookie of [
        undefined,
        "__Secure-sdk_auth=",
        `__Secure-sdk_auth=${"A".repeat(43)}`,
        "sdk_auth=x",
      ]) {
        const res = await handler(write(path, {}, { method, cookie, ip: p.ip }));
        expectCleared(res);
        expect([path, await read(res)]).toEqual([path, { status: 401, body: { error: "not signed in" } }]);
      }
    }
  });

  it("ログインの失敗は 401 login failed で、Cookie を付けない", async () => {
    const p = next();
    const { accountId } = await signup(p);
    result.authentication = false;
    const res = await login(p, accountId);
    expect(setCookies(res)).toEqual([]);
    expect(await read(res)).toEqual({ status: 401, body: { error: "login failed" } });
  });

  it("検証のエラーの中身（challenge）は返さず、記録もしない", async () => {
    const p = next();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(verifyRegistrationResponse).mockImplementationOnce(async ({ expectedChallenge }) => {
      throw new Error(`Unexpected registration response challenge "${String(expectedChallenge)}"`);
    });
    const { res } = await signup(p);
    expect(setCookies(res)).toEqual([]);
    expect(await read(res)).toEqual({ status: 400, body: { error: "verification failed" } });
    expect(log).not.toHaveBeenCalled();
  });

  it("Vercel 上で WEBAUTHN_ORIGIN が無ければ、どの API も 503 auth unavailable", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("WEBAUTHN_ORIGIN", "");
    const p = next();
    expect(await read(await meRoute.GET(get("me")))).toEqual({
      status: 503,
      body: { error: "auth unavailable" },
    });
    for (const [path, { method, handler }] of Object.entries(WRITES)) {
      const res = await read(await handler(write(path, {}, { method, ip: p.ip })));
      expect([path, res]).toEqual([path, { status: 503, body: { error: "auth unavailable" } }]);
    }
  });

  it("ログイン状態の確認は、設定した origin と違うホストでは 503。ログインしていなければ null で Cookie を付けない", async () => {
    expect(await read(await meRoute.GET(get("me", { host: "sudoku-xi-five.vercel.app" })))).toEqual({
      status: 503,
      body: { error: "auth unavailable" },
    });
    expect(
      (await read(await meRoute.GET(get("me", { base: "https://sudoku-xi-five.vercel.app" })))).status,
    ).toBe(503);
    const res = await meRoute.GET(get("me", { host: SITE_HOST }));
    expect(setCookies(res)).toEqual([]);
    expect(await read(res)).toEqual({ status: 200, body: { account: null } });
  });

  it("本文の上限は検証 API が 16KB、ほかは 1KB（超えたら 413）", async () => {
    const p = next();
    const big = (bytes: number) => JSON.stringify({ pad: "x".repeat(bytes - 10) });
    expect(
      (await read(await signupVerifyRoute.POST(write("signup/verify", big(16 * 1024 + 1), { ip: p.ip }))))
        .status,
    ).toBe(413);
    expect(
      (await read(await loginVerifyRoute.POST(write("login/verify", big(16 * 1024 + 1), { ip: p.ip }))))
        .status,
    ).toBe(413);
    expect(
      (await read(await signupVerifyRoute.POST(write("signup/verify", big(16 * 1024), { ip: p.ip })))).status,
    ).toBe(400);
    expect(
      (await read(await loginOptionsRoute.POST(write("login/options", big(1025), { ip: p.ip })))).status,
    ).toBe(413);
    expect(
      (await read(await loginOptionsRoute.POST(write("login/options", big(1024), { ip: p.ip })))).status,
    ).toBe(200);
    expect(
      (await read(await signupOptionsRoute.POST(write("signup/options", big(1025), { ip: p.ip })))).status,
    ).toBe(413);
    // ログインが必要な API も、本文の上限はセッションより先に確かめる
    const limits: [string, number][] = [
      ["passkeys/verify", 16 * 1024],
      ["stats", 8 * 1024],
      ["passkeys/options", 1024],
      ["account", 1024],
      ["merge", 1024],
    ];
    for (const [path, max] of limits) {
      const { method, handler } = WRITES[path];
      const over = await read(await handler(write(path, big(max + 1), { method, ip: p.ip })));
      const within = await read(await handler(write(path, big(max), { method, ip: p.ip })));
      expect([path, over.status, within.status]).toEqual([path, 413, 401]);
    }
  });
});

describe("アカウントの管理の API", () => {
  it("記録の同期・パスキーの追加・履歴の取り込みは Cookie のセッションで動き、トークンを本文に出さない。同期した記録はログイン状態の確認でも返る", async () => {
    const p = next();
    const { res: created } = await signup(p);
    const { cookie, token } = cookieOf(created);
    const opts = { cookie, ip: p.ip };

    const stats = { easy: { played: 2, bestMs: 70_000, cleanBestMs: null, bestPoints: 500 } };
    const put = await statsRoute.PUT(write("stats", { stats }, { method: "PUT", ...opts }));
    expect(setCookies(put)).toEqual([]);
    expect(await read(put, [token])).toEqual({ status: 200, body: { stats } });
    expect((await read(await meRoute.GET(get("me", { cookie })), [token])).body).toEqual({
      account: { playerId: p.playerId, name: null, passkeys: 1, stats },
    });

    const optionsRes = await read(await passkeysOptionsRoute.POST(write("passkeys/options", {}, opts)), [
      token,
    ]);
    const { options } = optionsRes.body as {
      options: { challenge: string; excludeCredentials: { id: string }[] };
    };
    expect(options.excludeCredentials.map((c) => c.id)).toEqual([p.credId]);
    const response = createResponse(b64(`${p.credId}-added`), options.challenge);
    const added = await passkeysVerifyRoute.POST(write("passkeys/verify", { response }, opts));
    expect(setCookies(added)).toEqual([]);
    expect(await read(added, [token])).toEqual({
      status: 200,
      body: { account: { playerId: p.playerId, name: null, passkeys: 2, stats } },
    });

    const from = next().playerId;
    await getStore()!.addHistory(from, {
      date: "2026-10-18",
      difficulty: "easy",
      points: 100,
      timeMs: 60_000,
    });
    const merged = await mergeRoute.POST(write("merge", { fromPlayerId: from }, opts));
    expect(await read(merged, [token])).toEqual({ status: 200, body: { merged: 1 } });
    expect(await getStore()!.getHistory(p.playerId)).toHaveLength(1);
  });

  it("アカウントの削除は本文 {} が要り、Cookie を消す。削除後はログインできず、ログイン状態の確認は null", async () => {
    const p = next();
    const { res: created, accountId } = await signup(p);
    const { cookie } = cookieOf(created);
    const empty = await accountRoute.DELETE(write("account", "", { method: "DELETE", cookie, ip: p.ip }));
    expect(await read(empty)).toEqual({ status: 400, body: { error: "invalid json" } });

    const res = await accountRoute.DELETE(write("account", {}, { method: "DELETE", cookie, ip: p.ip }));
    expectCleared(res);
    expect(await read(res)).toEqual({ status: 200, body: { ok: true } });
    expect((await read(await meRoute.GET(get("me", { cookie })))).body).toEqual({ account: null });
    const again = await login(p, accountId);
    expect(setCookies(again)).toEqual([]);
    expect(await read(again)).toEqual({ status: 401, body: { error: "login failed" } });
    // 消えたセッションの Cookie では、ログインが必要な API は 401
    const stale = await accountRoute.DELETE(write("account", {}, { method: "DELETE", cookie, ip: p.ip }));
    expectCleared(stale);
    expect((await read(stale)).status).toBe(401);
  });
});
