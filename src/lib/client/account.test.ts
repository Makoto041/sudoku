import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage } from "./memoryStorage";
import { combineStats, type Stats } from "./stats";
import { KEYS } from "./storage";

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

const { store, memory } = installMemoryStorage();

/** account.ts は先取りした options と同期の状態をモジュールに持つので、テストごとに読み込み直す */
let account: typeof import("./account");
let webauthn: typeof import("@simplewebauthn/browser");
/** 読み込み直した api.ts の ApiError（account.ts はこれで見分ける） */
let ApiError: typeof import("./api").ApiError;
beforeEach(async () => {
  vi.resetModules();
  ({ ApiError } = await import("./api"));
  webauthn = await import("@simplewebauthn/browser");
  vi.mocked(webauthn.startRegistration).mockReset();
  vi.mocked(webauthn.startAuthentication).mockReset();
  vi.mocked(webauthn.browserSupportsWebAuthn).mockReset().mockReturnValue(true);
  account = await import("./account");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // unstubAllGlobals で localStorage の置き換えも外れるので、戻す
  vi.stubGlobal("localStorage", memory);
});

const DEVICE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";

const EASY = {
  played: 1,
  bestMs: 100_000,
  cleanBestMs: null,
  bestPoints: 500,
  started: 2,
  trackedClears: 1,
  totalMs: 100_000,
};
const NORMAL = {
  played: 3,
  bestMs: 200_000,
  cleanBestMs: 210_000,
  bestPoints: 900,
  started: 3,
  trackedClears: 3,
  totalMs: 700_000,
};

type Reply = { status?: number; json?: unknown } | "offline";
type Call = { method: string; path: string; body: unknown; rawBody: unknown };

/**
 * fetch を偽のサーバーにする。routes は "METHOD /path" ごとの応答（関数なら受けた本文から作る。Promise も可）。
 * 無いものは 404。"offline" は通信の失敗。受けた要求を順に返す
 */
function fakeServer(routes: Record<string, Reply | ((body: unknown) => Reply | Promise<Reply>)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url, body, rawBody: init?.body });
      const route = routes[`${method} ${url}`];
      const reply = typeof route === "function" ? await route(body) : (route ?? { status: 404 });
      if (reply === "offline") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
    }),
  );
  return calls;
}

/** open() を呼ぶまで解決しない Promise（応答を止めておく） */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

const view = (
  o: Partial<{ playerId: string; name: string | null; passkeys: number; stats: unknown }> = {},
) => ({
  playerId: ACCOUNT,
  name: "アカウント",
  passkeys: 1,
  stats: null,
  ...o,
});

/** サーバーと同じく、保存済みの記録と送られた記録を合わせて返す PUT /api/auth/stats */
function statsRoute(stored: { stats: Stats }) {
  return (body: unknown) => {
    stored.stats = combineStats(stored.stats, (body as { stats: unknown }).stats);
    return { json: { stats: stored.stats } };
  };
}

const localStats = () => JSON.parse(store.get(KEYS.stats) ?? "null");
const putCalls = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

describe("applyAccount（ログインしたアカウントに端末を合わせる）", () => {
  it("端末のプレイヤーが違えば、履歴を写してからアカウントのプレイヤーにし、記録を合わせて送る", async () => {
    store.set(KEYS.stats, JSON.stringify({ easy: EASY }));
    const stored = { stats: { medium: NORMAL } as Stats };
    const calls = fakeServer({
      "POST /api/auth/merge": { json: { merged: 2 } },
      "PUT /api/auth/stats": statsRoute(stored),
    });
    const player = await account.applyAccount(view({ stats: { medium: NORMAL } }), {
      id: DEVICE,
      name: "端末",
    });
    expect(player).toEqual({ id: ACCOUNT, name: "アカウント" });
    expect(JSON.parse(store.get(KEYS.player)!)).toEqual({ id: ACCOUNT, name: "アカウント" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/auth/merge",
      "PUT /api/auth/stats",
    ]);
    expect(calls[0].body).toEqual({ fromPlayerId: DEVICE });
    // 端末の記録とアカウントの記録の両方が、端末とアカウントに入る
    expect(calls[1].body).toEqual({ stats: { easy: EASY, medium: NORMAL } });
    expect(localStats()).toEqual({ easy: EASY, medium: NORMAL });
    expect(stored.stats).toEqual({ easy: EASY, medium: NORMAL });
  });

  it("同じプレイヤーなら履歴を写さない。サーバーに名前が無ければ端末の名前を残す", async () => {
    store.set(KEYS.stats, JSON.stringify({ easy: EASY }));
    const calls = fakeServer({ "PUT /api/auth/stats": statsRoute({ stats: {} }) });
    const player = await account.applyAccount(view({ playerId: DEVICE, name: null }), {
      id: DEVICE,
      name: "端末",
    });
    expect(player).toEqual({ id: DEVICE, name: "端末" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /api/auth/stats"]);
  });

  it("違うプレイヤーで、アカウントに名前が無ければ名前は未設定にする", async () => {
    fakeServer({ "POST /api/auth/merge": { json: { merged: 0 } } });
    const player = await account.applyAccount(view({ name: null }), { id: DEVICE, name: "端末" });
    expect(player).toEqual({ id: ACCOUNT, name: null });
  });

  it("履歴の取り込みや記録の送信に失敗しても、アカウントのプレイヤーと記録に切り替える", async () => {
    store.set(KEYS.stats, JSON.stringify({ easy: EASY }));
    fakeServer({ "POST /api/auth/merge": "offline", "PUT /api/auth/stats": { status: 429 } });
    const player = await account.applyAccount(view({ stats: { medium: NORMAL } }), {
      id: DEVICE,
      name: null,
    });
    expect(player.id).toBe(ACCOUNT);
    expect(localStats()).toEqual({ easy: EASY, medium: NORMAL });
  });

  it("端末の記録がアカウントの記録に含まれていれば送らない", async () => {
    store.set(KEYS.stats, JSON.stringify({ medium: { ...NORMAL, played: 1 } }));
    const calls = fakeServer({});
    await account.applyAccount(view({ playerId: DEVICE, stats: { medium: NORMAL } }), {
      id: DEVICE,
      name: null,
    });
    expect(calls).toEqual([]);
    expect(localStats()).toEqual({ medium: NORMAL });
  });
});

describe("syncStats（記録の同期）", () => {
  /** アカウントの記録が NORMAL のログイン中の端末（端末の記録も同じ） */
  async function signedIn(stored: { stats: Stats }) {
    const calls = fakeServer({ "PUT /api/auth/stats": statsRoute(stored) });
    await account.applyAccount(view({ playerId: DEVICE, stats: stored.stats }), { id: DEVICE, name: null });
    return calls;
  }

  it("変わっていなければ送らない。記録が増えたら 1 回だけ送り、合わせた記録を端末に入れる", async () => {
    const stored = { stats: { medium: NORMAL } as Stats };
    const calls = await signedIn(stored);
    await account.syncStats(DEVICE);
    expect(putCalls(calls)).toHaveLength(0);

    store.set(KEYS.stats, JSON.stringify({ medium: NORMAL, easy: EASY }));
    await account.syncStats(DEVICE);
    await account.syncStats(DEVICE);
    expect(putCalls(calls)).toHaveLength(1);
    expect(putCalls(calls)[0].body).toEqual({ stats: { easy: EASY, medium: NORMAL } });

    // ほかの端末の分がアカウントに入っていれば、送った応答で端末にも入る
    stored.stats = combineStats(stored.stats, { hard: NORMAL });
    store.set(KEYS.stats, JSON.stringify({ medium: { ...NORMAL, started: 4 }, easy: EASY }));
    await account.syncStats(DEVICE);
    expect(putCalls(calls)).toHaveLength(2);
    expect(localStats()).toEqual({ easy: EASY, medium: { ...NORMAL, started: 4 }, hard: NORMAL });
  });

  it("送っている途中に呼んでも、もう 1 回は送らない", async () => {
    store.set(KEYS.stats, JSON.stringify({ easy: EASY }));
    const hold = gate();
    const calls = fakeServer({
      "PUT /api/auth/stats": async (body) => {
        await hold.wait;
        return { json: { stats: (body as { stats: unknown }).stats } };
      },
    });
    const a = account.syncStats(DEVICE);
    const b = account.syncStats(DEVICE);
    hold.open();
    await Promise.all([a, b]);
    expect(putCalls(calls)).toHaveLength(1);
    // 送れたので、次は送らない
    await account.syncStats(DEVICE);
    expect(putCalls(calls)).toHaveLength(1);
  });

  it("送れなかったら、次に呼んだときに送り直す", async () => {
    store.set(KEYS.stats, JSON.stringify({ easy: EASY }));
    let fail = true;
    const calls = fakeServer({
      "PUT /api/auth/stats": (body) =>
        fail ? "offline" : { json: { stats: (body as { stats: unknown }).stats } },
    });
    await account.syncStats(DEVICE);
    fail = false;
    await account.syncStats(DEVICE);
    expect(putCalls(calls)).toHaveLength(2);
  });

  it("記録が無ければ送らない", async () => {
    const calls = fakeServer({});
    await account.syncStats(DEVICE);
    expect(calls).toEqual([]);
  });

  it("送っている途中にログアウトで端末の記録を消したら、届いた記録を端末に入れない", async () => {
    store.set(KEYS.stats, JSON.stringify({ easy: EASY }));
    const hold = gate();
    fakeServer({
      "PUT /api/auth/stats": async () => {
        await hold.wait;
        return { json: { stats: { easy: EASY, medium: NORMAL } } };
      },
    });
    const sending = account.syncStats(DEVICE);
    account.resetDevice();
    hold.open();
    await sending;
    expect(store.has(KEYS.stats)).toBe(false);
  });

  it("ログアウトの後は、前に送っている途中の記録を待たずに送る（別のアカウントにログインしたとき）", async () => {
    store.set(KEYS.stats, JSON.stringify({ easy: EASY }));
    const hold = gate();
    const calls = fakeServer({
      "PUT /api/auth/stats": async (body) => {
        await hold.wait;
        return { json: { stats: (body as { stats: unknown }).stats } };
      },
    });
    const before = account.syncStats(DEVICE);
    account.resetDevice();
    store.set(KEYS.stats, JSON.stringify({ medium: NORMAL }));
    const after = account.syncStats(ACCOUNT);
    expect(putCalls(calls)).toHaveLength(2);
    hold.open();
    await Promise.all([before, after]);
    expect(localStats()).toEqual({ medium: NORMAL });
  });
});

describe("resetDevice・logoutDevice・deleteAccount", () => {
  /** 消すもの（端末の記録）と残すもの（設定・途中のフリープレイ・練習・案内・通知の印など） */
  const ERASED = [
    KEYS.player,
    KEYS.stats,
    KEYS.historyCache,
    KEYS.achievements,
    KEYS.dailyResult("2026-10-19", "easy"),
    KEYS.dailyResult("2026-10-18", "extreme"),
    KEYS.daily("2026-10-19", "hard"),
  ];
  const KEPT = [
    KEYS.reminder,
    KEYS.movedWithReminder,
    KEYS.settings,
    KEYS.free,
    KEYS.practice,
    KEYS.howto,
    KEYS.installHint,
    KEYS.clockOffset,
    "other-app:key",
  ];
  const fill = () => {
    for (const key of [...ERASED, ...KEPT]) store.set(key, "true");
  };

  it("端末の記録（プレイヤー・記録・履歴・実績・今日の一問の結果と途中）だけを消し、通知の印や設定は残す", () => {
    fill();
    account.resetDevice();
    expect([...store.keys()].sort()).toEqual([...KEPT].sort());
  });

  it("ログアウトはサーバーでこの端末のセッションを消してから、端末の記録を消す", async () => {
    fill();
    const calls = fakeServer({ "POST /api/auth/logout": { json: { ok: true } } });
    await account.logoutDevice(DEVICE);
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/auth/logout", { scope: "this" }],
    ]);
    expect([...store.keys()].sort()).toEqual([...KEPT].sort());
  });

  /** 端末の記録（フリープレイ）が、アカウントにまだ送っていない EASY の端末 */
  const unsynced = () => {
    fill();
    store.set(KEYS.stats, JSON.stringify({ easy: EASY }));
  };

  it("ログアウトの前に、まだ送っていない記録をアカウントに送る（PUT /api/auth/stats → POST /api/auth/logout の順）", async () => {
    unsynced();
    const stored = { stats: {} as Stats };
    const calls = fakeServer({
      "PUT /api/auth/stats": statsRoute(stored),
      "POST /api/auth/logout": { json: { ok: true } },
    });
    await account.logoutDevice(DEVICE);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /api/auth/stats",
      "POST /api/auth/logout",
    ]);
    expect(stored.stats).toEqual({ easy: EASY });
    expect([...store.keys()].sort()).toEqual([...KEPT].sort());
  });

  it("送っていない記録が無ければ、送らずにログアウトする", async () => {
    const calls = fakeServer({ "POST /api/auth/logout": { json: { ok: true } } });
    await account.applyAccount(view({ playerId: DEVICE, stats: { easy: EASY } }), { id: DEVICE, name: null });
    await account.logoutDevice(DEVICE);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/auth/logout"]);
  });

  it.each([
    ["通信の失敗", "offline" as const, "オフラインです"],
    ["429", { status: 429, json: { error: "rate limited" } }, "しばらくしてからもう一度試してください"],
    ["500", { status: 500, json: { error: "internal error" } }, "もう一度試してください"],
  ])("記録を送れなければ（%s）、ログアウトせず端末の記録も消さない", async (_, reply, text) => {
    unsynced();
    const before = new Map(store);
    const calls = fakeServer({
      "PUT /api/auth/stats": reply,
      "POST /api/auth/logout": { json: { ok: true } },
    });
    const err = await account.logoutDevice(DEVICE).catch((e: unknown) => e);
    expect(account.accountError(err, "other")).toBe(text);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /api/auth/stats"]);
    expect(new Map(store)).toEqual(before);
  });

  it("送っている途中の記録があれば、それを待ってから送る。それが失敗したらログアウトしない", async () => {
    unsynced();
    let hold = gate();
    let fail = false;
    const calls = fakeServer({
      "PUT /api/auth/stats": async (body) => {
        await hold.wait;
        return fail ? "offline" : { json: { stats: (body as { stats: unknown }).stats } };
      },
      "POST /api/auth/logout": { json: { ok: true } },
    });
    // 送っている途中に記録が増えたら、その分も送ってからログアウトする
    void account.syncStats(DEVICE);
    store.set(KEYS.stats, JSON.stringify({ easy: EASY, medium: NORMAL }));
    const out = account.logoutDevice(DEVICE);
    hold.open();
    await out;
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /api/auth/stats",
      "PUT /api/auth/stats",
      "POST /api/auth/logout",
    ]);
    expect(calls[1].body).toEqual({ stats: { easy: EASY, medium: NORMAL } });

    // ログアウトしたので同期の状態は空。送っている途中のものが失敗したら、ログアウトしない
    unsynced();
    calls.length = 0;
    hold = gate();
    fail = true;
    void account.syncStats(DEVICE);
    const failed = account.logoutDevice(DEVICE).catch((e: unknown) => e);
    hold.open();
    expect(account.accountError(await failed, "other")).toBe("オフラインです");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /api/auth/stats"]);
    expect(store.has(KEYS.player)).toBe(true);
  });

  it("401（もうログインしていない）なら、記録を送れなくても・ログアウトが 401 でも端末の記録を消す", async () => {
    unsynced();
    const calls = fakeServer({
      "PUT /api/auth/stats": { status: 401, json: { error: "not signed in" } },
      "POST /api/auth/logout": { json: { ok: true } },
    });
    await account.logoutDevice(DEVICE);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /api/auth/stats"]);
    expect([...store.keys()].sort()).toEqual([...KEPT].sort());

    fill();
    fakeServer({ "POST /api/auth/logout": { status: 401, json: { error: "not signed in" } } });
    await account.logoutDevice(DEVICE);
    expect(store.has(KEYS.player)).toBe(false);
  });

  it("ログアウトの通信に失敗したら消さずに失敗する", async () => {
    fill();
    fakeServer({ "POST /api/auth/logout": "offline" });
    await expect(account.logoutDevice(DEVICE)).rejects.toMatchObject({ status: 0 });
    expect(store.size).toBe(ERASED.length + KEPT.length);
  });

  it("ほかの端末のログアウトは scope: others を送る", async () => {
    const calls = fakeServer({ "POST /api/auth/logout": { json: { ok: true } } });
    await account.logoutOthers();
    expect(calls[0].body).toEqual({ scope: "others" });
  });

  it("アカウントの削除は本文 {} の DELETE を送り、端末の記録は残す。401 はログインしていないものとして扱う", async () => {
    fill();
    const calls = fakeServer({ "DELETE /api/auth/account": { json: { ok: true } } });
    await account.deleteAccount();
    expect(calls.map((c) => [c.method, c.path, c.rawBody])).toEqual([["DELETE", "/api/auth/account", "{}"]]);
    expect(store.size).toBe(ERASED.length + KEPT.length);

    fakeServer({ "DELETE /api/auth/account": { status: 401, json: { error: "not signed in" } } });
    await expect(account.deleteAccount()).resolves.toBeUndefined();
    fakeServer({ "DELETE /api/auth/account": { status: 500, json: { error: "internal error" } } });
    await expect(account.deleteAccount()).rejects.toMatchObject({ status: 500 });
  });
});

describe("loadAccount（ログインの状態）", () => {
  it("ログイン中ならアカウント、していなければ signed-out", async () => {
    fakeServer({ "GET /api/auth/me": { json: { account: view({ passkeys: 2 }) } } });
    expect(await account.loadAccount()).toEqual({ status: "signed-in", account: view({ passkeys: 2 }) });

    fakeServer({ "GET /api/auth/me": { json: { account: null } } });
    expect(await account.loadAccount()).toEqual({ status: "signed-out" });
  });

  it("503（設定が無い・旧 URL）は確かめ直さない。通信の失敗や 500 は確かめ直す。形の違う応答は出さない", async () => {
    fakeServer({ "GET /api/auth/me": { status: 503, json: { error: "auth unavailable" } } });
    expect(await account.loadAccount()).toEqual({ status: "unavailable", retry: false });
    fakeServer({ "GET /api/auth/me": "offline" });
    expect(await account.loadAccount()).toEqual({ status: "unavailable", retry: true });
    fakeServer({ "GET /api/auth/me": { status: 500, json: { error: "internal error" } } });
    expect(await account.loadAccount()).toEqual({ status: "unavailable", retry: true });
    fakeServer({ "GET /api/auth/me": { json: { account: { playerId: 1 } } } });
    expect(await account.loadAccount()).toEqual({ status: "unavailable", retry: false });
  });
});

describe("パスキーの操作（options の先取り）", () => {
  const LOGIN_OPTIONS = { challenge: "login-challenge", allowCredentials: [] };
  const CREATE_OPTIONS = { challenge: "create-challenge" };
  const ASSERTION = { id: "cred", rawId: "cred", type: "public-key", response: {} };

  it("先取りした options があれば、待たずに（呼んだその場で）パスキーの画面を出し、応答を送ってログインする", async () => {
    const calls = fakeServer({
      "POST /api/auth/login/options": { json: { options: LOGIN_OPTIONS } },
      "POST /api/auth/login/verify": { json: { account: view() } },
    });
    vi.mocked(webauthn.startAuthentication).mockResolvedValue(ASSERTION as never);
    await account.prepareLogin();
    const done = account.login();
    expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: LOGIN_OPTIONS });
    expect(await done).toEqual(view());
    expect(calls.map((c) => c.path)).toEqual(["/api/auth/login/options", "/api/auth/login/verify"]);
    expect(calls[0].rawBody).toBe("{}");
    expect(calls[1].body).toEqual({ response: ASSERTION });
  });

  it("options がまだ無ければ始めずに取り直し、もう一度押せば始める", async () => {
    const calls = fakeServer({ "POST /api/auth/login/options": { json: { options: LOGIN_OPTIONS } } });
    vi.mocked(webauthn.startAuthentication).mockRejectedValue(
      Object.assign(new Error("cancel"), { name: "NotAllowedError" }),
    );
    const first = account.login();
    await expect(first).rejects.toBeInstanceOf(account.NotReadyError);
    expect(account.accountError(await first.catch((e) => e), "login")).toBe("もう一度試してください");
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
    await account.prepareLogin();
    await expect(account.login()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("取得から 4 分たった options は使わずに取り直す", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const calls = fakeServer({ "POST /api/auth/login/options": { json: { options: LOGIN_OPTIONS } } });
    await account.prepareLogin();
    now.mockReturnValue(1_000_000 + account.OPTIONS_MAX_AGE_MS);
    await expect(account.login()).rejects.toBeInstanceOf(account.NotReadyError);
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    // 期限内なら取り直さない
    await account.prepareLogin();
    expect(calls).toHaveLength(2);
  });

  it("キャンセルしたら options を残し、次に押したときにそのまま使う。応答を送ったら（失敗でも）捨てる", async () => {
    const calls = fakeServer({
      "POST /api/auth/login/options": { json: { options: LOGIN_OPTIONS } },
      "POST /api/auth/login/verify": { status: 401, json: { error: "login failed" } },
    });
    const start = vi.mocked(webauthn.startAuthentication);
    start.mockRejectedValueOnce(Object.assign(new Error("cancel"), { name: "NotAllowedError" }));
    await account.prepareLogin();
    const cancelled = await account.login().catch((e: unknown) => e);
    expect(account.accountError(cancelled, "login")).toBeNull();

    start.mockResolvedValueOnce(ASSERTION as never);
    const failed = await account.login().catch((e: unknown) => e);
    expect(account.accountError(failed, "login")).toBe("ログインできませんでした");
    expect(calls.filter((c) => c.path === "/api/auth/login/options")).toHaveLength(1);
    await expect(account.login()).rejects.toBeInstanceOf(account.NotReadyError);
  });

  it("作成の options を取れなかった理由（紐づき済み）を押したときに示し、パスキーの画面は出さない。プレイヤーが変わるまで取り直さない", async () => {
    const calls = fakeServer({
      "POST /api/auth/signup/options": { status: 409, json: { error: "already linked" } },
    });
    await account.prepareSignup(DEVICE);
    const err = await account.createAccount(DEVICE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(account.accountError(err, "signup")).toBe(
      "このプレイヤーのアカウントがあります。ログインしてください",
    );
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
    // 押したとき・操作の後（開き直したとき）も取り直さない（challenge の回数の制限に数えない）
    await account.createAccount(DEVICE).catch(() => {});
    await account.prepareSignup(DEVICE);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ playerId: DEVICE });
    await account.prepareSignup(ACCOUNT);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ playerId: ACCOUNT });
  });

  it("通信の失敗などで取れなかったときは、押したときと操作の後に取り直す", async () => {
    let offline = true;
    const calls = fakeServer({
      "POST /api/auth/login/options": () => (offline ? "offline" : { json: { options: LOGIN_OPTIONS } }),
    });
    await account.prepareLogin();
    offline = false;
    const err = await account.login().catch((e: unknown) => e);
    expect(account.accountError(err, "login")).toBe("オフラインです");
    expect(calls).toHaveLength(2);
    // 取り直したものは使える（取っている途中・使えるものは取り直さない）
    await account.prepareLogin();
    expect(calls).toHaveLength(2);
    vi.mocked(webauthn.startAuthentication).mockRejectedValue(
      Object.assign(new Error("cancel"), { name: "NotAllowedError" }),
    );
    await account.login().catch(() => {});
    expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);

    offline = true;
    const failing = fakeServer({ "POST /api/auth/login/options": "offline" });
    account.resetDevice();
    await account.prepareLogin();
    await account.prepareLogin();
    expect(failing).toHaveLength(2);
  });

  it("作成の options は先取りしたプレイヤーのときだけ使う", async () => {
    fakeServer({ "POST /api/auth/signup/options": { json: { options: CREATE_OPTIONS } } });
    await account.prepareSignup(DEVICE);
    await expect(account.createAccount(ACCOUNT)).rejects.toBeInstanceOf(account.NotReadyError);
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
  });

  it("パスキーを作ってアカウントを作る。追加は登録済みのパスキーを示す", async () => {
    const calls = fakeServer({
      "POST /api/auth/signup/options": { json: { options: CREATE_OPTIONS } },
      "POST /api/auth/signup/verify": { json: { account: view({ playerId: DEVICE }) } },
      "POST /api/auth/passkeys/options": { json: { options: CREATE_OPTIONS } },
    });
    const create = vi.mocked(webauthn.startRegistration);
    create.mockResolvedValueOnce(ASSERTION as never);
    await account.prepareSignup(DEVICE);
    expect(await account.createAccount(DEVICE)).toEqual(view({ playerId: DEVICE }));
    expect(calls.map((c) => c.path)).toEqual(["/api/auth/signup/options", "/api/auth/signup/verify"]);

    create.mockRejectedValueOnce(Object.assign(new Error("excluded"), { name: "InvalidStateError" }));
    await account.preparePasskey(DEVICE);
    const err = await account.addPasskey(DEVICE).catch((e: unknown) => e);
    expect(create).toHaveBeenCalledTimes(2);
    expect(account.accountError(err, "add")).toBe("このパスキーは登録済みです");
  });

  it("リセットで先取りした options を捨てる", async () => {
    fakeServer({ "POST /api/auth/login/options": { json: { options: LOGIN_OPTIONS } } });
    await account.prepareLogin();
    account.resetDevice();
    await expect(account.login()).rejects.toBeInstanceOf(account.NotReadyError);
  });

  it("追加の options は、先取りしたときにログインしていたアカウントでだけ使う", async () => {
    fakeServer({ "POST /api/auth/passkeys/options": { json: { options: CREATE_OPTIONS } } });
    await account.preparePasskey(DEVICE);
    await expect(account.addPasskey(ACCOUNT)).rejects.toBeInstanceOf(account.NotReadyError);
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
  });
});

describe("accountError（失敗の文言）", () => {
  /** [status, message] は ApiError、文字列はその名前のエラー（パスキーの操作の失敗） */
  type Spec = readonly [number, string] | string;
  const make = (spec: Spec): unknown =>
    typeof spec === "string" ? Object.assign(new Error(spec), { name: spec }) : new ApiError(...spec);

  it.each([
    [[0, "offline"], "login", "オフラインです"],
    [[429, "rate limited"], "signup", "しばらくしてからもう一度試してください"],
    [[409, "already linked"], "signup", "このプレイヤーのアカウントがあります。ログインしてください"],
    [[409, "credential exists"], "add", "このパスキーは登録済みです"],
    [[409, "credential exists"], "signup", "このパスキーは登録済みです"],
    [[409, "too many passkeys"], "add", "追加できませんでした"],
    [[400, "challenge expired"], "login", "もう一度試してください"],
    [[400, "invalid challenge"], "add", "もう一度試してください"],
    [[400, "verification failed"], "signup", "作成できませんでした"],
    [[400, "verification failed"], "add", "追加できませんでした"],
    [[401, "login failed"], "login", "ログインできませんでした"],
    [[401, "not signed in"], "add", null],
    [[503, "too many accounts"], "signup", "作成できませんでした"],
    [[500, "internal error"], "other", "もう一度試してください"],
    ["NotAllowedError", "login", null],
    ["AbortError", "signup", null],
    ["InvalidStateError", "add", "このパスキーは登録済みです"],
    ["NotSupportedError", "signup", "作成できませんでした"],
    ["SecurityError", "login", "ログインできませんでした"],
  ] as const)("%o（%s）→ %s", (spec, action, text) => {
    expect(account.accountError(make(spec), action)).toBe(text);
  });

  it("エラーでない値は操作の失敗、options がまだ無いときは、もう一度押すよう示す", () => {
    expect(account.accountError("?", "add")).toBe("追加できませんでした");
    expect(account.accountError(new account.NotReadyError(), "signup")).toBe("もう一度試してください");
  });
});
