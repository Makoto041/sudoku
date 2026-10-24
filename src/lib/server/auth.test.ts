import { createHash } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { describe, expect, it, vi } from "vitest";
import { SITE_HOST, SITE_ORIGIN } from "@/lib/site";
import {
  AUTH_CHALLENGE_TTL_SEC,
  AUTH_MAX_ACCOUNTS,
  AUTH_MAX_SESSIONS,
  AUTH_RATE_LIMITS,
  currentAccount,
  loginOptions,
  loginVerify,
  logout,
  sessionFromToken,
  signupOptions,
  signupVerify,
} from "./auth";
import { RP_NAME, authConfig, servedHere } from "./auth-config";
import {
  AUTH_SESSION_TTL_SEC,
  MemoryAuthStore,
  RedisAuthStore,
  type AuthStore,
  type StoredCredential,
} from "./auth-store";
import {
  ALICE,
  BOB,
  CONFIG,
  T0,
  attestationObject,
  b64,
  clientData,
  createResponse,
  expectError,
  fakeSetup,
  getResponse,
  login,
  signup,
  unb64,
} from "./auth-test-helpers";
import { RankingError } from "./ranking";

const DAY = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const player = (i: number) => `${i.toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`;

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof RankingError ? e.status : -1;
  }
}

describe("アカウントの作成", () => {
  it("playerId を新しいアカウントに紐づけてログインする。パスキーの user.id は accountId で、名前はランキングの名前", async () => {
    const s = fakeSetup();
    await s.store.setName(ALICE, "アリス");
    const { options } = await signupOptions(s.deps(), { playerId: ALICE });
    const accountId = unb64(options.user.id);
    expect(accountId).toMatch(UUID_RE);
    expect(accountId).not.toBe(ALICE);
    expect(options).toMatchObject({
      rp: { name: RP_NAME, id: SITE_HOST },
      user: { name: "アリス", displayName: "アリス" },
      attestation: "none",
      excludeCredentials: [],
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const credId = b64("cred-alice");
    const res = await signupVerify(s.deps(), { response: createResponse(options.challenge, credId) });
    expect(res.account).toEqual({ playerId: ALICE, name: "アリス", passkeys: 1, stats: null });
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.fake.calls.verifyRegistration[0]).toMatchObject({
      expectedChallenge: options.challenge,
      expectedOrigin: SITE_ORIGIN,
      expectedRPID: SITE_HOST,
      requireUserVerification: false,
      supportedAlgorithmIDs: [-8, -7, -257],
    });
    expect(await s.auth.accountOfPlayer(ALICE)).toBe(accountId);
    expect(await s.auth.getAccount(accountId)).toEqual({ id: accountId, playerId: ALICE, createdAt: T0 });
    expect(await s.auth.getCredential(credId)).toEqual({
      id: credId,
      accountId,
      publicKey: Buffer.from([1, 2, 3]).toString("base64url"),
      counter: 0,
      transports: ["internal", "hybrid"],
      deviceType: "multiDevice",
      backedUp: false,
      createdAt: T0,
      lastUsedAt: T0,
    } satisfies StoredCredential);
    const session = await sessionFromToken(s.deps(), res.token);
    expect(session).toMatchObject({ accountId, record: { createdAt: T0, expiresAt: T0 + 90 * DAY } });
    // 保存先のキーはトークンの SHA-256（トークンそのものは保存しない）
    expect(session?.hash).toBe(createHash("sha256").update(res.token).digest("hex"));
  });

  it("ランキングの名前が無ければ「プレイヤー」", async () => {
    const s = fakeSetup();
    const { options } = await signupOptions(s.deps(), { playerId: ALICE });
    expect(options.user).toMatchObject({ name: "プレイヤー", displayName: "プレイヤー" });
  });

  it("playerId の形が違えば 400", async () => {
    const s = fakeSetup();
    for (const playerId of [undefined, "nope", 1, "AAAAAAAA-1111-4111-8111-111111111111"]) {
      await expectError(signupOptions(s.deps(), { playerId }), 400, "invalid player id");
    }
  });

  it("紐づけ済みの playerId は、options も検証も 409 already linked", async () => {
    const s = fakeSetup();
    const early = await signupOptions(s.deps(), { playerId: ALICE });
    await signup(s, ALICE, b64("cred-1"));
    await expectError(signupOptions(s.deps(), { playerId: ALICE }), 409, "already linked");
    await expectError(
      signupVerify(s.deps(), { response: createResponse(early.options.challenge, b64("cred-2")) }),
      409,
      "already linked",
    );
    expect(s.auth.counts()).toMatchObject({ accounts: 1, credentials: 1, players: 1 });
  });

  it("同じ playerId の options を 2 回取って両方を検証すると、2 つ目は 409 で、アカウントもパスキーも残さない", async () => {
    const s = fakeSetup();
    const a = await signupOptions(s.deps(), { playerId: ALICE });
    const b = await signupOptions(s.deps(), { playerId: ALICE });
    const results = await Promise.allSettled([
      signupVerify(s.deps(), { response: createResponse(a.options.challenge, b64("cred-a")) }),
      signupVerify(s.deps(), { response: createResponse(b.options.challenge, b64("cred-b")) }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const err = (results[1] as PromiseRejectedResult).reason as RankingError;
    expect([err.status, err.message]).toEqual([409, "already linked"]);
    expect(s.auth.counts()).toMatchObject({ accounts: 1, credentials: 1, players: 1, sessions: 1 });
    expect(await s.auth.getCredential(b64("cred-b"))).toBeNull();
    expect(await s.auth.getAccount(unb64(b.options.user.id))).toBeNull();
    expect(await s.auth.accountOfPlayer(ALICE)).toBe(unb64(a.options.user.id));
  });

  it("登録済みのパスキーで別の playerId のアカウントを作ると 409 credential exists", async () => {
    const s = fakeSetup();
    await signup(s, ALICE, b64("cred-1"));
    await expectError(signup(s, BOB, b64("cred-1")), 409, "credential exists");
    expect(await s.auth.accountOfPlayer(BOB)).toBeNull();
    expect(s.auth.counts()).toMatchObject({ accounts: 1, credentials: 1, players: 1 });
  });

  it("検証に失敗したら 400 verification failed で、エラーの文言（challenge）は返さない", async () => {
    const s = fakeSetup();
    s.fake.state.verified = false;
    await expectError(signup(s, ALICE, b64("cred-1")), 400, "verification failed");
    s.fake.state.verified = true;
    s.fake.state.throws = true;
    await expectError(signup(s, ALICE, b64("cred-1")), 400, "verification failed");
    // 認証器のデータの id が、ブラウザの送った id と違う
    s.fake.state.throws = false;
    s.fake.state.authDataId = b64("other");
    await expectError(signup(s, ALICE, b64("cred-1")), 400, "verification failed");
    expect(s.auth.counts()).toMatchObject({ accounts: 0, credentials: 0, players: 0, sessions: 0 });
  });

  it("attestation が none でない・読めない応答は、ライブラリに渡さずに 400 verification failed", async () => {
    const s = fakeSetup();
    const cases = [
      attestationObject(undefined, "packed"),
      attestationObject(undefined, "android-key"),
      attestationObject(undefined, "NONE"),
      attestationObject(undefined, 0),
      b64("not cbor"),
      b64(new Uint8Array([0xa0])), // 空の map（fmt が無い）
      b64(new Uint8Array([0x80])), // map でなく配列
    ];
    for (const att of cases) {
      const { options } = await signupOptions(s.deps(), { playerId: ALICE });
      const ok = createResponse(options.challenge);
      const response = { ...ok, response: { ...ok.response, attestationObject: att } };
      await expectError(signupVerify(s.deps(), { response }), 400, "verification failed");
    }
    expect(s.fake.calls.verifyRegistration).toEqual([]);
    expect(s.auth.counts()).toMatchObject({ accounts: 0, credentials: 0, challenges: 0 });
  });

  it("保存する公開鍵は 1KB まで（超えたら 400 verification failed）", async () => {
    const s = fakeSetup();
    s.fake.state.publicKey = new Uint8Array(1025);
    await expectError(signup(s, ALICE, b64("cred-1")), 400, "verification failed");
    expect(s.auth.counts()).toMatchObject({ accounts: 0, credentials: 0 });
    s.fake.state.publicKey = new Uint8Array(1024);
    await signup(s, ALICE, b64("cred-1"));
    expect((await s.auth.getCredential(b64("cred-1")))?.publicKey).toBe(b64(new Uint8Array(1024)));
  });

  it("アカウントが上限に達していれば、options も検証も 503 too many accounts", async () => {
    const s = fakeSetup();
    const early = await signupOptions(s.deps(), { playerId: ALICE });
    const count = vi.spyOn(s.auth, "countAccounts").mockResolvedValue(AUTH_MAX_ACCOUNTS);
    await expectError(signupOptions(s.deps(), { playerId: BOB }), 503, "too many accounts");
    await expectError(
      signupVerify(s.deps(), { response: createResponse(early.options.challenge) }),
      503,
      "too many accounts",
    );
    count.mockResolvedValue(AUTH_MAX_ACCOUNTS - 1);
    await signup(s, BOB, b64("cred-bob"));
    expect(s.auth.counts()).toMatchObject({ accounts: 1 });
  });
});

describe("challenge", () => {
  it("1 回しか使えない（同じ応答の再送は 400 challenge expired）", async () => {
    const s = fakeSetup();
    const { options } = await signupOptions(s.deps(), { playerId: ALICE });
    const response = createResponse(options.challenge);
    await signupVerify(s.deps(), { response });
    await expectError(signupVerify(s.deps(), { response }), 400, "challenge expired");
  });

  it("300 秒を過ぎたら 400 challenge expired（保存先が消さなくても時刻で確かめる）", async () => {
    const s = fakeSetup();
    const { options } = await signupOptions(s.deps(), { playerId: ALICE });
    await expectError(
      signupVerify(s.deps({ now: T0 + AUTH_CHALLENGE_TTL_SEC * 1000 + 1 }), {
        response: createResponse(options.challenge),
      }),
      400,
      "challenge expired",
    );
    const login = await loginOptions(s.deps());
    await expectError(
      loginVerify(s.deps({ now: T0 + AUTH_CHALLENGE_TTL_SEC * 1000 + 1 }), {
        response: getResponse(login.options.challenge, b64("cred-1"), b64(ALICE)),
      }),
      400,
      "challenge expired",
    );
    // ちょうど 300 秒は受け付ける
    const again = await signupOptions(s.deps(), { playerId: ALICE });
    await signupVerify(s.deps({ now: T0 + AUTH_CHALLENGE_TTL_SEC * 1000 }), {
      response: createResponse(again.options.challenge),
    });
  });

  it("発行していない challenge は 400 challenge expired、用途の違う challenge は 400 invalid challenge", async () => {
    const s = fakeSetup();
    await expectError(
      signupVerify(s.deps(), { response: createResponse(b64("x".repeat(32))) }),
      400,
      "challenge expired",
    );
    const login = await loginOptions(s.deps());
    await expectError(
      signupVerify(s.deps(), { response: createResponse(login.options.challenge) }),
      400,
      "invalid challenge",
    );
    const { options } = await signupOptions(s.deps(), { playerId: ALICE });
    await expectError(
      loginVerify(s.deps(), { response: getResponse(options.challenge, b64("cred-1"), b64(ALICE)) }),
      400,
      "invalid challenge",
    );
    // 用途が違っても challenge は使い切る
    await expectError(signupVerify(s.deps(), { response: createResponse(options.challenge) }), 400);
    expect(s.auth.counts()).toMatchObject({ challenges: 0, accounts: 0 });
  });
});

describe("パスキーの応答の検査", () => {
  it("形の違う応答は、challenge を使わずに 400 invalid response", async () => {
    const s = fakeSetup();
    const { options } = await signupOptions(s.deps(), { playerId: ALICE });
    const ok = createResponse(options.challenge);
    const longId = "A".repeat(1367);
    const cases: unknown[] = [
      undefined,
      null,
      "response",
      [],
      { ...ok, response: undefined },
      { ...ok, id: longId, rawId: longId },
      { ...ok, rawId: b64("other") },
      { ...ok, type: "password" },
      { ...ok, id: "cred+1", rawId: "cred+1" },
      { ...ok, id: "", rawId: "" },
      { ...ok, id: b64("cred") + "=", rawId: b64("cred") + "=" },
      { ...ok, response: { ...ok.response, attestationObject: undefined } },
      { ...ok, response: { ...ok.response, clientDataJSON: "not base64url!" } },
      { ...ok, response: { ...ok.response, transports: "internal" } },
      { ...ok, response: { ...ok.response, transports: Array(9).fill("usb") } },
      { ...ok, response: { ...ok.response, clientDataJSON: b64("not json") } },
      { ...ok, response: { ...ok.response, clientDataJSON: b64("null") } },
      { ...ok, response: { ...ok.response, clientDataJSON: clientData("webauthn.create", "short") } },
      // attestationObject は base64url で 4096 文字まで（authData 3042 バイトで 4098 文字）
      { ...ok, response: { ...ok.response, attestationObject: attestationObject(new Uint8Array(3042)) } },
    ];
    for (const response of cases) {
      await expectError(signupVerify(s.deps(), { response }), 400, "invalid response");
    }
    expect(s.fake.calls.verifyRegistration).toEqual([]);
    // 1366 文字の id、4096 文字の attestationObject、知らない値を除いた transports は受け付ける
    const id = "A".repeat(1366);
    const att = attestationObject(new Uint8Array(3041));
    expect(att).toHaveLength(4096);
    const res = await signupVerify(s.deps(), {
      response: {
        ...ok,
        id,
        rawId: id,
        response: {
          ...ok.response,
          attestationObject: att,
          transports: ["usb", "carrier-pigeon", "usb", 1, "nfc"],
        },
        extra: "ignored",
      },
    });
    expect(res.account.passkeys).toBe(1);
    expect((await s.auth.getCredential(id))?.transports).toEqual(["usb", "nfc"]);
  });
});

describe("回数制限", () => {
  it("challenge の発行は IP ごとに 1 時間 60 回まで（signup と login を合わせて数える）", async () => {
    const s = fakeSetup();
    const limit = 60;
    const at = Math.floor(T0 / 3_600_000) * 3_600_000;
    for (let i = 0; i < limit; i++) {
      const p =
        i % 2 === 0
          ? signupOptions(s.deps({ now: at }), { playerId: player(i) })
          : loginOptions(s.deps({ now: at }));
      await p;
    }
    await expectError(loginOptions(s.deps({ now: at })), 429, "rate limited");
    await expectError(signupOptions(s.deps({ now: at }), { playerId: ALICE }), 429, "rate limited");
    // 別の IP と、次の窓は受け付ける
    await loginOptions(s.deps({ now: at, ip: "198.51.100.2" }));
    await loginOptions(s.deps({ now: at + 3_600_000 }));
  });

  it("紐づき済みの playerId への options も、409 を返す前に数える（紐づいているかを回数の制限なしに調べられない）", async () => {
    const s = fakeSetup();
    await signup(s, ALICE, b64("cred-1"));
    // アカウントの作成で 1 回数えている
    for (let i = 1; i < AUTH_RATE_LIMITS.chal.limit; i++) {
      await expectError(signupOptions(s.deps(), { playerId: ALICE }), 409, "already linked");
    }
    await expectError(signupOptions(s.deps(), { playerId: ALICE }), 429, "rate limited");
  });

  it("アカウントの作成は IP ごとに 1 時間 5 件まで。検証に失敗したものと、数える前に確かめる紐づけ済みの playerId（409）は数えない", async () => {
    const s = fakeSetup();
    const limit = 5;
    s.fake.state.verified = false;
    for (let i = 0; i < 10; i++) await expectError(signup(s, player(100 + i), b64(`bad-${i}`)), 400);
    s.fake.state.verified = true;
    const early = await signupOptions(s.deps(), { playerId: player(0) });
    for (let i = 0; i < limit; i++) await signup(s, player(i), b64(`cred-${i}`));
    await expectError(
      signupVerify(s.deps(), { response: createResponse(early.options.challenge, b64("dup")) }),
      409,
    );
    await expectError(signup(s, player(50), b64("cred-50")), 429, "rate limited");
    expect(await s.auth.accountOfPlayer(player(50))).toBeNull();
    expect(await s.auth.getCredential(b64("cred-50"))).toBeNull();
    await signup(s, player(51), b64("cred-51"), { ip: "198.51.100.3" });
    expect(s.auth.counts()).toMatchObject({ accounts: limit + 1 });
  });
});

describe("ログイン", () => {
  it("パスキーでログインし、counter・最終使用日時・バックアップの状態を更新する", async () => {
    const s = fakeSetup();
    await s.store.setName(ALICE, "アリス");
    const credId = b64("cred-1");
    const { accountId, token: first } = await signup(s, ALICE, credId);
    const { options } = await loginOptions(s.deps({ now: T0 + DAY }));
    expect(options).toMatchObject({ rpId: SITE_HOST, allowCredentials: [], userVerification: "preferred" });
    s.fake.state.newCounter = 7;
    const res = await loginVerify(s.deps({ now: T0 + DAY }), {
      response: getResponse(options.challenge, credId, b64(accountId)),
    });
    expect(res.account).toEqual({ playerId: ALICE, name: "アリス", passkeys: 1, stats: null });
    expect(res.token).not.toBe(first);
    expect(s.fake.calls.verifyAuthentication[0]).toMatchObject({
      expectedChallenge: options.challenge,
      expectedOrigin: SITE_ORIGIN,
      expectedRPID: SITE_HOST,
      requireUserVerification: false,
      credential: { id: credId, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
    });
    expect(await s.auth.getCredential(credId)).toMatchObject({
      counter: 7,
      backedUp: true,
      createdAt: T0,
      lastUsedAt: T0 + DAY,
    });
    expect((await sessionFromToken(s.deps(), res.token))?.accountId).toBe(accountId);
  });

  it("知らないパスキー・userHandle の違い・検証の失敗は、どれも 401 login failed", async () => {
    const s = fakeSetup();
    const credId = b64("cred-1");
    const { accountId } = await signup(s, ALICE, credId);
    const bob = await signup(s, BOB, b64("cred-bob"));
    const attempt = async (id: string, userHandle: string | undefined) => {
      const { options } = await loginOptions(s.deps());
      return loginVerify(s.deps(), { response: getResponse(options.challenge, id, userHandle) });
    };
    await expectError(attempt(b64("unknown"), b64(accountId)), 401, "login failed");
    await expectError(attempt(credId, b64(bob.accountId)), 401, "login failed");
    await expectError(attempt(credId, undefined), 401, "login failed");
    await expectError(attempt(credId, b64(ALICE)), 401, "login failed");
    expect(s.fake.calls.verifyAuthentication).toEqual([]);
    s.fake.state.verified = false;
    await expectError(attempt(credId, b64(accountId)), 401, "login failed");
    s.fake.state.verified = true;
    s.fake.state.throws = true;
    await expectError(attempt(credId, b64(accountId)), 401, "login failed");
    expect(await s.auth.getCredential(credId)).toMatchObject({ counter: 0, lastUsedAt: T0 });
    s.fake.state.throws = false;
    await attempt(credId, b64(accountId));
  });
});

describe("セッション", () => {
  it("期限を過ぎたら無効。ログイン状態を確かめるたびに 90 日延ばす", async () => {
    const s = fakeSetup();
    const { token, accountId } = await signup(s, ALICE, b64("cred-1"));
    const at = (now: number) => sessionFromToken(s.deps({ now }), token);
    expect(await at(T0 + 90 * DAY - 1)).not.toBeNull();
    expect(await at(T0 + 90 * DAY)).toBeNull();

    const session = await at(T0 + 80 * DAY);
    const res = await currentAccount(s.deps({ now: T0 + 80 * DAY }), session);
    expect(res.account?.playerId).toBe(ALICE);
    expect(await at(T0 + 100 * DAY)).toMatchObject({ accountId, record: { expiresAt: T0 + 170 * DAY } });
    expect(await at(T0 + 170 * DAY)).toBeNull();
  });

  it("トークンの形が違えば引かない。アカウントが無ければ null", async () => {
    const s = fakeSetup();
    const { token, accountId } = await signup(s, ALICE, b64("cred-1"));
    for (const t of [null, "", token.slice(1), `${token}A`, token.replace(/.$/, "+")]) {
      expect(await sessionFromToken(s.deps(), t)).toBeNull();
    }
    expect(await currentAccount(s.deps(), null)).toEqual({ account: null });
    const session = await sessionFromToken(s.deps(), token);
    await s.auth.deleteAccount(accountId);
    expect(await currentAccount(s.deps(), session)).toEqual({ account: null });
  });

  it(`1 アカウント ${AUTH_MAX_SESSIONS} 件まで。超えたら期限の近いものから消す`, async () => {
    const s = fakeSetup();
    const credId = b64("cred-1");
    const { token: first, accountId } = await signup(s, ALICE, credId);
    const tokens = [first];
    for (let i = 1; i <= AUTH_MAX_SESSIONS; i++) {
      tokens.push((await login(s, credId, accountId, { now: T0 + i * 1000 })).token);
    }
    const valid = async () => {
      const out: boolean[] = [];
      for (const t of tokens) out.push((await sessionFromToken(s.deps(), t)) !== null);
      return out;
    };
    expect(await valid()).toEqual([false, ...Array(AUTH_MAX_SESSIONS).fill(true)]);
    // 最初に作ったものでも、使って延ばしたものは残る
    await currentAccount(s.deps({ now: T0 + 100_000 }), await sessionFromToken(s.deps(), tokens[1]));
    tokens.push((await login(s, credId, accountId, { now: T0 + 200_000 })).token);
    expect(await valid()).toEqual([false, true, false, ...Array(AUTH_MAX_SESSIONS - 1).fill(true)]);
  });

  it("ログアウト：this はこの端末、others はこの端末以外。消したセッションは延ばしても戻らない", async () => {
    const s = fakeSetup();
    const credId = b64("cred-1");
    const { token: a, accountId } = await signup(s, ALICE, credId);
    const b = (await login(s, credId, accountId)).token;
    const c = (await login(s, credId, accountId)).token;
    const bob = await signup(s, BOB, b64("cred-bob"));
    const sessionOf = (t: string) => sessionFromToken(s.deps(), t);

    const sb = await sessionOf(b);
    expect(await logout(s.deps(), sb, { scope: "others" })).toEqual({ ok: true });
    expect([await sessionOf(a), await sessionOf(b), await sessionOf(c)].map((x) => x !== null)).toEqual([
      false,
      true,
      false,
    ]);
    // 別のアカウントのセッションは消さない
    expect(await sessionOf(bob.token)).not.toBeNull();

    expect(await logout(s.deps(), sb, {})).toEqual({ ok: true });
    expect(await sessionOf(b)).toBeNull();
    // ログアウトの前に引いたセッションで延ばしても、生き返らない
    await currentAccount(s.deps(), sb);
    expect(await sessionOf(b)).toBeNull();

    const sbob = await sessionOf(bob.token);
    expect(await logout(s.deps(), sbob, { scope: "this" })).toEqual({ ok: true });
    expect(await sessionOf(bob.token)).toBeNull();
  });

  it("ログアウトの scope が違えば 400、セッションが無ければ 401", async () => {
    const s = fakeSetup();
    const { token } = await signup(s, ALICE, b64("cred-1"));
    const session = await sessionFromToken(s.deps(), token);
    for (const scope of ["all", 1, null]) {
      await expectError(logout(s.deps(), session, { scope }), 400, "invalid scope");
    }
    await expectError(logout(s.deps(), null, {}), 401, "not signed in");
    expect(await sessionFromToken(s.deps(), token)).not.toBeNull();
  });
});

/** RedisAuthStore のテスト用。使うコマンドだけを、Redis と同じ意味でメモリに持つ（期限は持たない） */
class FakeRedis {
  data = new Map<string, string | Set<string> | Map<string, number>>();
  /** pipeline でこのコマンドを実行しようとしたら失敗させる（途中で失敗したときの確認用） */
  failInPipeline: string | null = null;
  private of<T>(key: string, make: () => T): T {
    if (!this.data.has(key)) this.data.set(key, make() as never);
    return this.data.get(key) as T;
  }
  private zset(key: string) {
    return this.of(key, () => new Map<string, number>());
  }
  private sorted(key: string) {
    return [...this.zset(key)].sort(([a, ta], [b, tb]) => ta - tb || (a < b ? -1 : 1)).map(([m]) => m);
  }
  private cleanup(key: string) {
    const v = this.data.get(key);
    if (typeof v === "object" && v.size === 0) this.data.delete(key);
  }
  async set(key: string, value: unknown, opts: { nx?: boolean; xx?: boolean; ex?: number } = {}) {
    if ((opts.nx && this.data.has(key)) || (opts.xx && !this.data.has(key))) return null;
    this.data.set(key, String(value));
    return "OK";
  }
  async get(key: string) {
    const v = this.data.get(key);
    return typeof v === "string" ? v : null;
  }
  async getdel(key: string) {
    const v = await this.get(key);
    this.data.delete(key);
    return v;
  }
  async mget(...keys: string[]) {
    return Promise.all(keys.map((k) => this.get(k)));
  }
  async del(...keys: string[]) {
    return keys.filter((k) => this.data.delete(k)).length;
  }
  async expire() {
    return 1;
  }
  async sadd(key: string, ...members: string[]) {
    const set = this.of(key, () => new Set<string>());
    members.forEach((m) => set.add(m));
    return members.length;
  }
  async srem(key: string, ...members: string[]) {
    const set = this.of(key, () => new Set<string>());
    members.forEach((m) => set.delete(m));
    this.cleanup(key);
    return members.length;
  }
  async smembers(key: string) {
    const v = this.data.get(key);
    return v instanceof Set ? [...v] : [];
  }
  async scard(key: string) {
    return (await this.smembers(key)).length;
  }
  async zadd(key: string, ...args: ({ xx?: boolean } | { score: number; member: string })[]) {
    const opts = "score" in args[0] ? {} : (args.shift() as { xx?: boolean });
    const z = this.zset(key);
    for (const { score, member } of args as { score: number; member: string }[]) {
      if (!opts.xx || z.has(member)) z.set(member, score);
    }
    this.cleanup(key);
    return args.length;
  }
  async zrange(key: string, start: number, stop: number) {
    const all = this.sorted(key);
    this.cleanup(key);
    return all.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async zrem(key: string, ...members: string[]) {
    const z = this.zset(key);
    members.forEach((m) => z.delete(m));
    this.cleanup(key);
    return members.length;
  }
  async zremrangebyscore(key: string, _min: string, max: number) {
    const z = this.zset(key);
    for (const [m, t] of z) if (t <= max) z.delete(m);
    this.cleanup(key);
    return 0;
  }
  pipeline() {
    const ops: [string, unknown[]][] = [];
    const run = async () => {
      const out: unknown[] = [];
      for (const [name, args] of ops) {
        if (name === this.failInPipeline) throw new Error(`${name} failed`);
        out.push(await (this as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args));
      }
      return out;
    };
    const p: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_, name: string) =>
          name === "exec"
            ? run
            : (...args: unknown[]) => {
                ops.push([name, args]);
                return p;
              },
      },
    );
    return p;
  }
}

describe.each([
  ["メモリ", () => ({ auth: new MemoryAuthStore() as AuthStore, keys: null })],
  [
    "Redis（つながない）",
    () => {
      const redis = new FakeRedis();
      return { auth: new RedisAuthStore(redis as unknown as Redis) as AuthStore, keys: redis.data };
    },
  ],
])("アカウントの保存先（%s）", (_, make) => {
  const ACCOUNT = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", playerId: ALICE, createdAt: T0 };
  const OTHER = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", playerId: ALICE, createdAt: T0 };
  const cred = (id: string, accountId = ACCOUNT.id): StoredCredential => ({
    id,
    accountId,
    publicKey: "AQID",
    counter: 0,
    transports: [],
    deviceType: "singleDevice",
    backedUp: false,
    createdAt: T0,
    lastUsedAt: T0,
  });
  const session = (accountId: string, expiresAt: number) => ({ accountId, createdAt: T0, expiresAt });

  it("アカウントの作成：パスキーが登録済みなら exists、playerId が紐づき済みなら linked で、どちらも何も残さない", async () => {
    const { auth, keys } = make();
    expect(await auth.createAccount(ACCOUNT, cred("c1"))).toBe("ok");
    const before = keys && [...keys.keys()].sort();
    expect(await auth.createAccount(OTHER, cred("c2", OTHER.id))).toBe("linked");
    expect(await auth.createAccount({ ...OTHER, playerId: BOB }, cred("c1", OTHER.id))).toBe("exists");
    if (keys) expect([...keys.keys()].sort()).toEqual(before);
    expect(await auth.getAccount(OTHER.id)).toBeNull();
    expect(await auth.getCredential("c2")).toBeNull();
    expect(await auth.getCredential("c1")).toEqual(cred("c1"));
    expect(await auth.accountOfPlayer(ALICE)).toBe(ACCOUNT.id);
    expect(await auth.accountOfPlayer(BOB)).toBeNull();
    expect(await auth.countAccounts()).toBe(1);
    expect((await auth.listCredentials(ACCOUNT.id)).map((c) => c.id)).toEqual(["c1"]);
  });

  it("パスキーの追加は id が重なれば exists、上限に達していれば full（足さない）。更新は消えたパスキーを書き戻さない", async () => {
    const { auth, keys } = make();
    await auth.createAccount(ACCOUNT, cred("c1"));
    expect(await auth.addCredential(cred("c1"), 10)).toBe("exists");
    expect(await auth.addCredential(cred("c2"), 2)).toBe("ok");
    expect(await auth.addCredential(cred("c3"), 2)).toBe("full");
    expect(await auth.getCredential("c3")).toBeNull();
    if (keys) expect(keys.has("sdk:cred:c3")).toBe(false);
    expect((await auth.listCredentials(ACCOUNT.id)).map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    await auth.updateCredential({ ...cred("c1"), counter: 5 });
    expect((await auth.getCredential("c1"))?.counter).toBe(5);
    await auth.deleteAccount(ACCOUNT.id);
    await auth.updateCredential(cred("c1"));
    expect(await auth.getCredential("c1")).toBeNull();
  });

  it("同時に足しても、パスキーは上限を超えず、足さなかったものは残さない", async () => {
    const { auth } = make();
    await auth.createAccount(ACCOUNT, cred("c0"));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => auth.addCredential(cred(`n${i}`), 10)),
    );
    const ids = (await auth.listCredentials(ACCOUNT.id)).map((c) => c.id);
    expect(ids.length).toBeLessThanOrEqual(10);
    expect(results.filter((r) => r === "ok").length).toBe(ids.length - 1);
    for (let i = 0; i < 12; i++) {
      const kept = ids.includes(`n${i}`);
      expect([i, results[i], (await auth.getCredential(`n${i}`)) !== null]).toEqual([
        i,
        kept ? "ok" : "full",
        kept,
      ]);
    }
  });

  it("同期した記録はアカウントごとに保存し、上書きする", async () => {
    const { auth } = make();
    expect(await auth.getStats(ACCOUNT.id)).toBeNull();
    await auth.putStats(ACCOUNT.id, '{"easy":{"played":1}}');
    await auth.putStats(ACCOUNT.id, '{"easy":{"played":2}}');
    expect(await auth.getStats(ACCOUNT.id)).toBe('{"easy":{"played":2}}');
    expect(await auth.getStats(OTHER.id)).toBeNull();
  });

  it("challenge は 1 回だけ取り出せる", async () => {
    const { auth } = make();
    await auth.putChallenge("ch", { kind: "add", accountId: ACCOUNT.id, createdAt: T0 }, 300);
    expect(await auth.takeChallenge("ch")).toEqual({ kind: "add", accountId: ACCOUNT.id, createdAt: T0 });
    expect(await auth.takeChallenge("ch")).toBeNull();
  });

  it("セッション：上限を超えたら期限の近いものから消し（今回のものは残す）、消えたものは延ばしても戻らない", async () => {
    const { auth } = make();
    for (let i = 0; i < 4; i++) await auth.putSession(`h${i}`, session(ACCOUNT.id, T0 + 10 + i), T0, 3);
    expect(await auth.getSession("h0")).toBeNull();
    expect(await auth.getSession("h1")).toEqual(session(ACCOUNT.id, T0 + 11));
    // 今回のものの期限が一番近くても残す
    await auth.putSession("h4", session(ACCOUNT.id, T0 + 1), T0, 3);
    expect(await auth.getSession("h4")).not.toBeNull();
    expect(await auth.getSession("h1")).toBeNull();
    await auth.touchSession("h2", session(ACCOUNT.id, T0 + 100));
    expect(await auth.getSession("h2")).toEqual(session(ACCOUNT.id, T0 + 100));
    await auth.removeSession("h2", ACCOUNT.id);
    await auth.touchSession("h2", session(ACCOUNT.id, T0 + 200));
    expect(await auth.getSession("h2")).toBeNull();
    await auth.putSession("x", session(OTHER.id, T0 + 50), T0, 3);
    await auth.removeOtherSessions(ACCOUNT.id, "h3");
    expect(await auth.getSession("h3")).not.toBeNull();
    expect(await auth.getSession("h4")).toBeNull();
    expect(await auth.getSession("x")).not.toBeNull();
    await auth.removeOtherSessions(ACCOUNT.id, null);
    expect(await auth.getSession("h3")).toBeNull();
  });

  it("アカウントを消すと、パスキー・セッション・記録・紐づけ・一覧から消える", async () => {
    const { auth, keys } = make();
    await auth.createAccount(ACCOUNT, cred("c1"));
    await auth.addCredential(cred("c2"), 10);
    await auth.putSession("h1", session(ACCOUNT.id, T0 + 10), T0, 20);
    await auth.putStats(ACCOUNT.id, "{}");
    await auth.deleteAccount(ACCOUNT.id);
    expect(await auth.getAccount(ACCOUNT.id)).toBeNull();
    expect(await auth.getCredential("c1")).toBeNull();
    expect(await auth.getCredential("c2")).toBeNull();
    expect(await auth.getSession("h1")).toBeNull();
    expect(await auth.getStats(ACCOUNT.id)).toBeNull();
    expect(await auth.accountOfPlayer(ALICE)).toBeNull();
    expect(await auth.countAccounts()).toBe(0);
    if (keys) expect([...keys.keys()]).toEqual([]);
  });
});

it("Redis：アカウントの削除が途中で失敗しても、紐づけは先に消えていて、その playerId でまた作れる。もう一度消せば残りも消える", async () => {
  const redis = new FakeRedis();
  const auth = new RedisAuthStore(redis as unknown as Redis);
  const account = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", playerId: ALICE, createdAt: T0 };
  await auth.createAccount(account, {
    id: "c1",
    accountId: account.id,
    publicKey: "AQID",
    counter: 0,
    transports: [],
    deviceType: "singleDevice",
    backedUp: false,
    createdAt: T0,
    lastUsedAt: T0,
  });
  redis.failInPipeline = "srem";
  await expect(auth.deleteAccount(account.id)).rejects.toThrow("srem failed");
  expect(await auth.accountOfPlayer(ALICE)).toBeNull();
  redis.failInPipeline = null;
  await auth.deleteAccount(account.id);
  expect([...redis.data.keys()]).toEqual([]);
});

it("Redis：アカウントを消すとき、紐づけが別のアカウントを指していれば残す", async () => {
  const redis = new FakeRedis();
  const auth = new RedisAuthStore(redis as unknown as Redis);
  const account = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", playerId: ALICE, createdAt: T0 };
  await redis.set(`sdk:acct:${account.id}`, JSON.stringify(account));
  await redis.set(`sdk:acctp:${ALICE}`, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  await auth.deleteAccount(account.id);
  expect(await auth.getAccount(account.id)).toBeNull();
  expect(await auth.accountOfPlayer(ALICE)).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
});

describe("設定", () => {
  it("https の origin なら RP ID はホスト名で、Cookie は __Secure- と Secure", () => {
    expect(authConfig({ WEBAUTHN_ORIGIN: SITE_ORIGIN, VERCEL: "1" })).toEqual({
      rpID: SITE_HOST,
      rpName: RP_NAME,
      origin: SITE_ORIGIN,
      secureCookie: true,
      cookieName: "__Secure-sdk_auth",
    });
    expect(authConfig({ WEBAUTHN_ORIGIN: "https://localhost:8443" })).toMatchObject({
      rpID: "localhost",
      origin: "https://localhost:8443",
    });
  });

  it("Vercel 以外で未設定なら http://localhost:3000、http の localhost は Secure なし", () => {
    for (const env of [{}, { WEBAUTHN_ORIGIN: "" }, { VERCEL: "" }]) {
      expect(authConfig(env)).toEqual({
        rpID: "localhost",
        rpName: RP_NAME,
        origin: "http://localhost:3000",
        secureCookie: false,
        cookieName: "sdk_auth",
      });
    }
    expect(authConfig({ WEBAUTHN_ORIGIN: "http://localhost:3100" }).origin).toBe("http://localhost:3100");
  });

  it("Vercel 上で未設定・http で localhost 以外・IP アドレス・origin でない形は 503", () => {
    const bad = [
      { VERCEL: "1" },
      { VERCEL: "1", WEBAUTHN_ORIGIN: "" },
      { WEBAUTHN_ORIGIN: "http://nanpure-game.vercel.app" },
      { WEBAUTHN_ORIGIN: "http://127.0.0.1:3000" },
      { WEBAUTHN_ORIGIN: "http://[::1]:3000" },
      { WEBAUTHN_ORIGIN: "https://127.0.0.1" },
      { WEBAUTHN_ORIGIN: "https://[::1]" },
      { WEBAUTHN_ORIGIN: "https://[2001:db8::1]" },
      { WEBAUTHN_ORIGIN: `${SITE_ORIGIN}/` },
      { WEBAUTHN_ORIGIN: `${SITE_ORIGIN}/app` },
      { WEBAUTHN_ORIGIN: SITE_ORIGIN.toUpperCase() },
      { WEBAUTHN_ORIGIN: "https://user@nanpure-game.vercel.app" },
      { WEBAUTHN_ORIGIN: "ftp://nanpure-game.vercel.app" },
      { WEBAUTHN_ORIGIN: "nanpure-game.vercel.app" },
      { WEBAUTHN_ORIGIN: "not a url" },
    ];
    for (const env of bad) expect([env, statusOf(() => authConfig(env))]).toEqual([env, 503]);
  });

  it("GET の 503 の判定は、Host ヘッダー（無ければ URL）のホストとポートで比べる", () => {
    const req = (url: string, host?: string) => new Request(url, { headers: host ? { host } : {} });
    expect(servedHere(req(`${SITE_ORIGIN}/api/auth/me`), CONFIG)).toBe(true);
    expect(servedHere(req("http://localhost:3000/api/auth/me", SITE_HOST), CONFIG)).toBe(true);
    expect(servedHere(req("http://localhost:3000/api/auth/me", SITE_HOST.toUpperCase()), CONFIG)).toBe(true);
    expect(servedHere(req(`${SITE_ORIGIN}/api/auth/me`, "sudoku-xi-five.vercel.app"), CONFIG)).toBe(false);
    expect(servedHere(req("https://sudoku-xi-five.vercel.app/api/auth/me"), CONFIG)).toBe(false);
    const local = authConfig({});
    expect(servedHere(req("http://localhost:3000/api/auth/me"), local)).toBe(true);
    expect(servedHere(req("http://localhost:3000/api/auth/me", "localhost:3100"), local)).toBe(false);
  });
});

it("セッションの有効期間は 90 日", () => {
  expect(AUTH_SESSION_TTL_SEC).toBe(7_776_000);
});
