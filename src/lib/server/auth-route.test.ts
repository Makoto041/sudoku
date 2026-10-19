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
import * as loginOptionsRoute from "@/app/api/auth/login/options/route";
import * as loginVerifyRoute from "@/app/api/auth/login/verify/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as signupOptionsRoute from "@/app/api/auth/signup/options/route";
import * as signupVerifyRoute from "@/app/api/auth/signup/verify/route";
import { SITE_HOST, SITE_ORIGIN } from "@/lib/site";
import { attestationObject, b64, clientData, unb64 } from "./auth-test-helpers";

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
  origin?: string | null;
  contentType?: string | null;
  cookie?: string;
  ip?: string;
  base?: string;
};

function post(path: string, body: unknown, opts: Opts = {}) {
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
    method: "POST",
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

const POSTS = {
  "signup/options": signupOptionsRoute.POST,
  "signup/verify": signupVerifyRoute.POST,
  "login/options": loginOptionsRoute.POST,
  "login/verify": loginVerifyRoute.POST,
  logout: logoutRoute.POST,
} as const;

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

/** https の Cookie を消す Set-Cookie が 1 つだけ付いている（Path と Secure をそろえ、期限を過去にする） */
function expectCleared(res: Response) {
  const [cleared, ...rest] = setCookies(res);
  expect(rest).toEqual([]);
  expect(tokenIn(cleared, "__Secure-sdk_auth")).toBe("");
  expect(cleared).toMatch(/; Path=\/api\/auth(;|$)/);
  expect(cleared).toMatch(/; Expires=Thu, 01 Jan 1970 00:00:00 GMT(;|$)/);
  expect(cleared).toMatch(/; Secure(;|$)/);
}

async function signup(p: ReturnType<typeof next>, base = SITE_ORIGIN) {
  const opts = await signupOptionsRoute.POST(
    post("signup/options", { playerId: p.playerId }, { ip: p.ip, base }),
  );
  const { options } = (await read(opts)).body as { options: { challenge: string; user: { id: string } } };
  const response = {
    id: p.credId,
    rawId: p.credId,
    type: "public-key",
    response: {
      clientDataJSON: clientData("webauthn.create", options.challenge, base),
      attestationObject: attestationObject(),
    },
  };
  const res = await signupVerifyRoute.POST(post("signup/verify", { response }, { ip: p.ip, base }));
  return { res, accountId: unb64(options.user.id) };
}

async function login(p: ReturnType<typeof next>, accountId: string, opts: Opts = {}) {
  const res = await loginOptionsRoute.POST(post("login/options", {}, { ip: p.ip, ...opts }));
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
  return loginVerifyRoute.POST(post("login/verify", { response }, { ip: p.ip, ...opts }));
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
    ]) {
      expect([route.dynamic, route.runtime]).toEqual(["force-dynamic", "nodejs"]);
    }
  });

  it("POST は Origin が無い・違えば 403、Content-Type が application/json でなければ 415（本文を読む前に）", async () => {
    const p = next();
    for (const [path, handler] of Object.entries(POSTS)) {
      for (const origin of [null, "https://sudoku-xi-five.vercel.app", "null", `${SITE_ORIGIN}/`, LOCAL]) {
        const res = await read(await handler(post(path, "not json", { origin, ip: p.ip })));
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
        const res = await read(await handler(post(path, "not json", { contentType, ip: p.ip })));
        expect([path, contentType, res]).toEqual([
          path,
          contentType,
          { status: 415, body: { error: "invalid content type" } },
        ]);
      }
      // JSON なら charset などの付け足しや大文字でも通り、本文の読み取りに進む
      for (const contentType of ["application/json; charset=utf-8", "Application/JSON"]) {
        const res = await read(await handler(post(path, "not json", { contentType, ip: p.ip })));
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
      post("logout", { scope: "others" }, { cookie: `__Secure-sdk_auth=${other}`, ip: p.ip }),
    );
    expect(setCookies(others)).toEqual([]);
    expect(await read(others, [other])).toEqual({ status: 200, body: { ok: true } });
    const stale = await meRoute.GET(get("me", { cookie: auth }));
    expect(setCookies(stale)).toEqual([]);
    expect((await read(stale)).body).toEqual({ account: null });

    // この端末のログアウトは Cookie も消す
    const out = await logoutRoute.POST(
      post("logout", {}, { cookie: `__Secure-sdk_auth=${other}`, ip: p.ip }),
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
    for (const cookie of [
      undefined,
      "__Secure-sdk_auth=",
      `__Secure-sdk_auth=${"A".repeat(43)}`,
      "sdk_auth=x",
    ]) {
      const res = await logoutRoute.POST(post("logout", {}, { cookie, ip: p.ip }));
      expectCleared(res);
      expect(await read(res)).toEqual({ status: 401, body: { error: "not signed in" } });
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
    for (const [path, handler] of Object.entries(POSTS)) {
      const res = await read(await handler(post(path, {}, { ip: p.ip })));
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
      (await read(await signupVerifyRoute.POST(post("signup/verify", big(16 * 1024 + 1), { ip: p.ip }))))
        .status,
    ).toBe(413);
    expect(
      (await read(await loginVerifyRoute.POST(post("login/verify", big(16 * 1024 + 1), { ip: p.ip }))))
        .status,
    ).toBe(413);
    expect(
      (await read(await signupVerifyRoute.POST(post("signup/verify", big(16 * 1024), { ip: p.ip })))).status,
    ).toBe(400);
    expect(
      (await read(await loginOptionsRoute.POST(post("login/options", big(1025), { ip: p.ip })))).status,
    ).toBe(413);
    expect(
      (await read(await loginOptionsRoute.POST(post("login/options", big(1024), { ip: p.ip })))).status,
    ).toBe(200);
    expect(
      (await read(await signupOptionsRoute.POST(post("signup/options", big(1025), { ip: p.ip })))).status,
    ).toBe(413);
  });
});
