import { describe, expect, it } from "vitest";
import { SITE_HOST } from "@/lib/site";
import {
  AUTH_MAX_PASSKEYS,
  AUTH_RATE_LIMITS,
  currentAccount,
  deleteAccount,
  loginOptions,
  mergePlayer,
  passkeyOptions,
  passkeyVerify,
  putStats,
  sessionFromToken,
  signupOptions,
  signupVerify,
  type AuthDeps,
} from "./auth";
import {
  ALICE,
  BOB,
  T0,
  attestationObject,
  b64,
  createResponse,
  expectError,
  fakeSetup,
  login,
  signup,
  unb64,
  type FakeSetup,
} from "./auth-test-helpers";
import type { RankingError } from "./ranking";
import type { HistoryEntry } from "./store";

const CAROL = "33333333-3333-4333-8333-333333333333";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** アカウントを作り、そのセッションも返す */
async function signedIn(s: FakeSetup, playerId: string, credId: string, over: Partial<AuthDeps> = {}) {
  const res = await signup(s, playerId, credId, over);
  const session = await sessionFromToken(s.deps(over), res.token);
  return { ...res, session: session! };
}

type Session = Awaited<ReturnType<typeof signedIn>>["session"];

/** パスキーを足す */
async function addPasskey(s: FakeSetup, session: Session, credId: string, over: Partial<AuthDeps> = {}) {
  const { options } = await passkeyOptions(s.deps(over), session);
  return passkeyVerify(s.deps(over), session, { response: createResponse(options.challenge, credId) });
}

describe("パスキーの追加", () => {
  it("ログイン中のアカウントに足す。user.id はアカウント ID で、登録済みのパスキーは excludeCredentials に入る。足したパスキーでもログインできる", async () => {
    const s = fakeSetup();
    await s.store.setName(ALICE, "アリス");
    const { session, accountId } = await signedIn(s, ALICE, b64("cred-1"));
    const { options } = await passkeyOptions(s.deps(), session);
    expect(unb64(options.user.id)).toBe(accountId);
    expect(options).toMatchObject({
      rp: { id: SITE_HOST },
      user: { name: "アリス", displayName: "アリス" },
      attestation: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      excludeCredentials: [{ id: b64("cred-1"), type: "public-key", transports: ["internal", "hybrid"] }],
    });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);

    const res = await passkeyVerify(s.deps(), session, {
      response: createResponse(options.challenge, b64("cred-2")),
    });
    expect(res).toEqual({ account: { playerId: ALICE, name: "アリス", passkeys: 2, stats: null } });
    expect(await s.auth.getCredential(b64("cred-2"))).toMatchObject({ accountId, createdAt: T0 });
    expect(s.fake.calls.verifyRegistration.at(-1)).toMatchObject({
      expectedChallenge: options.challenge,
      requireUserVerification: false,
      supportedAlgorithmIDs: [-8, -7, -257],
    });
    expect((await login(s, b64("cred-2"), accountId)).account.playerId).toBe(ALICE);
  });

  it("ログインしていない・アカウントが消えていれば 401 not signed in", async () => {
    const s = fakeSetup();
    const { session, accountId } = await signedIn(s, ALICE, b64("cred-1"));
    const { options } = await passkeyOptions(s.deps(), session);
    await expectError(passkeyOptions(s.deps(), null), 401, "not signed in");
    await expectError(
      passkeyVerify(s.deps(), null, { response: createResponse(options.challenge, b64("cred-2")) }),
      401,
      "not signed in",
    );
    await s.auth.deleteAccount(accountId);
    await expectError(passkeyOptions(s.deps(), session), 401, "not signed in");
    await expectError(
      passkeyVerify(s.deps(), session, { response: createResponse(options.challenge, b64("cred-2")) }),
      401,
      "not signed in",
    );
  });

  it("別のアカウントで発行した challenge・用途の違う challenge は 400 invalid challenge で、足さない", async () => {
    const s = fakeSetup();
    const alice = await signedIn(s, ALICE, b64("cred-1"));
    const bob = await signedIn(s, BOB, b64("cred-bob"));
    const forBob = await passkeyOptions(s.deps(), bob.session);
    await expectError(
      passkeyVerify(s.deps(), alice.session, {
        response: createResponse(forBob.options.challenge, b64("x")),
      }),
      400,
      "invalid challenge",
    );
    const signupChallenge = (await signupOptions(s.deps(), { playerId: CAROL })).options.challenge;
    await expectError(
      passkeyVerify(s.deps(), alice.session, { response: createResponse(signupChallenge, b64("y")) }),
      400,
      "invalid challenge",
    );
    const loginChallenge = (await loginOptions(s.deps())).options.challenge;
    await expectError(
      passkeyVerify(s.deps(), alice.session, { response: createResponse(loginChallenge, b64("z")) }),
      400,
      "invalid challenge",
    );
    // 追加の challenge ではアカウントを作れない
    const forAlice = await passkeyOptions(s.deps(), alice.session);
    await expectError(
      signupVerify(s.deps(), { response: createResponse(forAlice.options.challenge, b64("w")) }),
      400,
      "invalid challenge",
    );
    // どれも challenge は使い切り、検証もしない
    expect(s.auth.counts()).toMatchObject({ challenges: 0, credentials: 2, accounts: 2 });
    expect(s.fake.calls.verifyRegistration).toHaveLength(2);
  });

  it(`${AUTH_MAX_PASSKEYS} 件に達していれば、options も検証も 409 too many passkeys`, async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-0"));
    for (let i = 1; i < AUTH_MAX_PASSKEYS - 1; i++) await addPasskey(s, session, b64(`cred-${i}`));
    // 9 件のときに取った options で、10 件目を足したあとに検証する
    const early = await passkeyOptions(s.deps(), session);
    await addPasskey(s, session, b64("cred-9"));
    expect((await s.auth.listCredentials(session.accountId)).length).toBe(AUTH_MAX_PASSKEYS);
    await expectError(passkeyOptions(s.deps(), session), 409, "too many passkeys");
    await expectError(
      passkeyVerify(s.deps(), session, { response: createResponse(early.options.challenge, b64("cred-10")) }),
      409,
      "too many passkeys",
    );
    expect(await s.auth.getCredential(b64("cred-10"))).toBeNull();
  });

  it("登録済みのパスキー（自分のものも別のアカウントのものも）は 409 credential exists", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    await signedIn(s, BOB, b64("cred-bob"));
    await expectError(addPasskey(s, session, b64("cred-1")), 409, "credential exists");
    await expectError(addPasskey(s, session, b64("cred-bob")), 409, "credential exists");
    expect((await s.auth.getCredential(b64("cred-bob")))?.accountId).not.toBe(session.accountId);
    expect((await s.auth.listCredentials(session.accountId)).length).toBe(1);
  });

  it("登録と同じ検査を通す（attestation が none でなければライブラリに渡さずに 400）", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    const calls = s.fake.calls.verifyRegistration.length;
    const { options } = await passkeyOptions(s.deps(), session);
    const ok = createResponse(options.challenge, b64("cred-2"));
    const response = {
      ...ok,
      response: { ...ok.response, attestationObject: attestationObject(undefined, "packed") },
    };
    await expectError(passkeyVerify(s.deps(), session, { response }), 400, "verification failed");
    expect(s.fake.calls.verifyRegistration).toHaveLength(calls);
    expect((await s.auth.listCredentials(session.accountId)).length).toBe(1);
  });

  it(`同時に足しても ${AUTH_MAX_PASSKEYS} 件を超えない（超えた分は 409 too many passkeys）`, async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-0"));
    // 1 件のときに 12 件分の options を取り、同時に検証する
    const challenges: string[] = [];
    for (let i = 0; i < 12; i++) challenges.push((await passkeyOptions(s.deps(), session)).options.challenge);
    const results = await Promise.allSettled(
      challenges.map((c, i) =>
        passkeyVerify(s.deps(), session, { response: createResponse(c, b64(`cred-${i + 1}`)) }),
      ),
    );
    expect((await s.auth.listCredentials(session.accountId)).length).toBe(AUTH_MAX_PASSKEYS);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(
      rejected.map((r) => [(r.reason as RankingError).status, (r.reason as RankingError).message]),
    ).toEqual(Array(12 + 1 - AUTH_MAX_PASSKEYS).fill([409, "too many passkeys"]));
  });

  it("options は challenge の発行として IP ごとに数える", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    // アカウントの作成で 1 回数えている
    for (let i = 1; i < AUTH_RATE_LIMITS.chal.limit; i++) await passkeyOptions(s.deps(), session);
    await expectError(passkeyOptions(s.deps(), session), 429, "rate limited");
    await passkeyOptions(s.deps({ ip: "198.51.100.9" }), session);
  });
});

describe("アカウントの削除", () => {
  it("パスキー・セッション・同期した記録・紐づけを消し、ランキング・履歴・名前・通知の購読は残す。そのパスキーではログインできない", async () => {
    const s = fakeSetup();
    const entry: HistoryEntry = { date: "2026-10-18", difficulty: "easy", points: 100, timeMs: 60_000 };
    await s.store.setName(ALICE, "アリス");
    await s.store.addHistory(ALICE, entry);
    await s.store.record(entry.date, entry.difficulty, { playerId: ALICE, timeMs: 60_000, points: 100 });
    const sub = {
      endpoint: "https://fcm.googleapis.com/x",
      p256dh: "k",
      auth: "a",
      playerId: ALICE,
      createdAt: T0,
    };
    await s.store.putPushSub("sub", sub, T0);
    const { session, token, accountId } = await signedIn(s, ALICE, b64("cred-1"));
    await addPasskey(s, session, b64("cred-2"));
    const other = (await login(s, b64("cred-2"), accountId)).token;
    await putStats(s.deps(), session, { stats: { easy: { played: 3, bestMs: 50_000, cleanBestMs: null } } });

    expect(await deleteAccount(s.deps(), session)).toEqual({ ok: true });
    expect(s.auth.counts()).toEqual({
      challenges: 0,
      accounts: 0,
      players: 0,
      credentials: 0,
      sessions: 0,
      stats: 0,
    });
    for (const t of [token, other]) expect(await sessionFromToken(s.deps(), t)).toBeNull();
    expect(await currentAccount(s.deps(), session)).toEqual({ account: null });
    await expectError(login(s, b64("cred-1"), accountId), 401, "login failed");
    await expectError(login(s, b64("cred-2"), accountId), 401, "login failed");

    expect(await s.store.getNames([ALICE])).toEqual({ [ALICE]: "アリス" });
    expect(await s.store.getHistory(ALICE)).toEqual([entry]);
    expect(await s.store.top({ scope: "daily", date: entry.date, difficulty: "easy" }, 10)).toEqual([
      { playerId: ALICE, timeMs: 60_000, points: 100 },
    ]);
    expect(await s.store.getPushSub("sub")).toEqual(sub);
    // 同じ playerId でアカウントを作り直せる
    await signup(s, ALICE, b64("cred-3"));
  });

  it("何度呼んでも成功。ログインしていなければ 401", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    expect(await deleteAccount(s.deps(), session)).toEqual({ ok: true });
    expect(await deleteAccount(s.deps(), session)).toEqual({ ok: true });
    await expectError(deleteAccount(s.deps(), null), 401, "not signed in");
  });
});

describe("記録の同期", () => {
  it("保存済みの記録と難易度ごとに良い方・多い方で合わせて保存し、合わせた記録を返す。ログイン状態の確認でも返る", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    const first = await putStats(s.deps(), session, {
      stats: { easy: { played: 3, bestMs: 50_000, cleanBestMs: null, extra: 1 }, unknown: { played: 9 } },
    });
    expect(first).toEqual({
      stats: { easy: { played: 3, bestMs: 50_000, cleanBestMs: null, bestPoints: null } },
    });
    const second = await putStats(s.deps(), session, {
      stats: {
        easy: { played: 2, bestMs: 40_000, cleanBestMs: 45_000, bestPoints: 900 },
        hard: { played: 1, bestMs: 300_000, cleanBestMs: null },
      },
    });
    const combined = {
      easy: { played: 3, bestMs: 40_000, cleanBestMs: 45_000, bestPoints: 900 },
      hard: { played: 1, bestMs: 300_000, cleanBestMs: null, bestPoints: null },
    };
    expect(second.stats).toMatchObject(combined);
    expect(JSON.parse((await s.auth.getStats(session.accountId))!)).toEqual(second.stats);
    expect((await currentAccount(s.deps(), session)).account?.stats).toEqual(second.stats);
    // 同じものを送り直しても変わらない
    expect((await putStats(s.deps(), session, { stats: second.stats })).stats).toEqual(second.stats);
  });

  it("2 台で別々に遊んだ回数は足さず、多い方になる（既知の限界）", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    await putStats(s.deps(), session, { stats: { easy: { played: 3, bestMs: null, cleanBestMs: null } } });
    const res = await putStats(s.deps(), session, {
      stats: { easy: { played: 2, bestMs: null, cleanBestMs: null } },
    });
    expect(res.stats.easy?.played).toBe(3);
  });

  it("stats がオブジェクトでなければ 400 invalid stats、ログインしていなければ 401", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    for (const stats of [undefined, null, [], "x", 1]) {
      await expectError(putStats(s.deps(), session, { stats }), 400, "invalid stats");
    }
    await expectError(putStats(s.deps(), null, { stats: {} }), 401, "not signed in");
    expect(await s.auth.getStats(session.accountId)).toBeNull();
  });

  it("アカウントごとに 1 時間 120 回まで。ほかのアカウントは数えない", async () => {
    const s = fakeSetup();
    const at = Math.floor(T0 / HOUR) * HOUR;
    const alice = await signedIn(s, ALICE, b64("cred-1"));
    const bob = await signedIn(s, BOB, b64("cred-bob"));
    const { limit, windowSec } = AUTH_RATE_LIMITS.stats;
    expect([limit, windowSec]).toEqual([120, 3600]);
    for (let i = 0; i < limit; i++) await putStats(s.deps({ now: at }), alice.session, { stats: {} });
    await expectError(putStats(s.deps({ now: at }), alice.session, { stats: {} }), 429, "rate limited");
    await putStats(s.deps({ now: at }), bob.session, { stats: {} });
    await putStats(s.deps({ now: at + HOUR }), alice.session, { stats: {} });
  });
});

describe("履歴の取り込み", () => {
  const e = (date: string, points: number): HistoryEntry => ({
    date,
    difficulty: "easy",
    points,
    timeMs: 90_000,
  });

  it("別の playerId の履歴をアカウントの playerId に写す。同じ日・難易度はアカウント側を残し、ランキングの行は移さない", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    await s.store.addHistory(ALICE, e("2026-10-17", 50));
    await s.store.addHistory(BOB, e("2026-10-17", 100));
    await s.store.addHistory(BOB, e("2026-10-18", 200));
    await s.store.record("2026-10-18", "easy", { playerId: BOB, timeMs: 90_000, points: 200 });

    expect(await mergePlayer(s.deps(), session, { fromPlayerId: BOB })).toEqual({ merged: 1 });
    const sorted = (xs: HistoryEntry[]) => [...xs].sort((a, b) => a.date.localeCompare(b.date));
    expect(sorted(await s.store.getHistory(ALICE))).toEqual([e("2026-10-17", 50), e("2026-10-18", 200)]);
    expect(sorted(await s.store.getHistory(BOB))).toEqual([e("2026-10-17", 100), e("2026-10-18", 200)]);
    expect(await s.store.top({ scope: "daily", date: "2026-10-18", difficulty: "easy" }, 10)).toEqual([
      { playerId: BOB, timeMs: 90_000, points: 200 },
    ]);
    // もう一度取り込んでも増えない
    expect(await mergePlayer(s.deps(), session, { fromPlayerId: BOB })).toEqual({ merged: 0 });
  });

  it("同じ playerId と、別のアカウントに紐づいた playerId は写さない（0）", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    await signedIn(s, CAROL, b64("cred-carol"));
    await s.store.addHistory(CAROL, e("2026-10-18", 300));
    expect(await mergePlayer(s.deps(), session, { fromPlayerId: ALICE })).toEqual({ merged: 0 });
    expect(await mergePlayer(s.deps(), session, { fromPlayerId: CAROL })).toEqual({ merged: 0 });
    expect(await s.store.getHistory(ALICE)).toEqual([]);
  });

  it("playerId の形が違えば 400、ログインしていなければ 401", async () => {
    const s = fakeSetup();
    const { session } = await signedIn(s, ALICE, b64("cred-1"));
    for (const fromPlayerId of [undefined, "nope", 1]) {
      await expectError(mergePlayer(s.deps(), session, { fromPlayerId }), 400, "invalid player id");
    }
    await expectError(mergePlayer(s.deps(), null, { fromPlayerId: BOB }), 401, "not signed in");
  });

  it("アカウントごとに 1 日 20 回まで。紐づいた playerId も数え、同じ playerId は数えない。ほかのアカウントは数えない", async () => {
    const s = fakeSetup();
    const at = Math.floor(T0 / DAY) * DAY;
    const alice = await signedIn(s, ALICE, b64("cred-1"));
    const bob = await signedIn(s, BOB, b64("cred-bob"));
    const { limit, windowSec } = AUTH_RATE_LIMITS.merge;
    expect([limit, windowSec]).toEqual([20, 86_400]);
    const merge = (session: Session, fromPlayerId: string, now = at) =>
      mergePlayer(s.deps({ now }), session, { fromPlayerId });
    for (let i = 0; i < 5; i++) await merge(alice.session, ALICE);
    for (let i = 0; i < limit - 1; i++) await merge(alice.session, CAROL);
    // 紐づいた playerId（BOB）も 1 回に数える
    expect(await merge(alice.session, BOB)).toEqual({ merged: 0 });
    await expectError(merge(alice.session, CAROL), 429, "rate limited");
    await expectError(merge(alice.session, BOB), 429, "rate limited");
    expect(await merge(alice.session, ALICE)).toEqual({ merged: 0 });
    await merge(bob.session, CAROL);
    await merge(alice.session, CAROL, at + DAY);
  });
});
