import { createECDH } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage } from "./memoryStorage";
import type { PushState } from "./push";
import { KEYS } from "./storage";

const { store, memory } = installMemoryStorage();

/** push.ts を読み込み直す（公開鍵と実行中の操作をモジュールに持つ。別のタブの代わりにも使う） */
async function freshPush() {
  vi.resetModules();
  return import("./push");
}

let push: typeof import("./push");
beforeEach(async () => {
  push = await freshPush();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // unstubAllGlobals で localStorage の置き換えも外れるので、戻す
  vi.stubGlobal("localStorage", memory);
});

const PLAYER = "11111111-1111-4111-8111-111111111111";

/** 決まった秘密鍵（seed を並べた 32 バイト）の公開鍵（P-256 の点を未圧縮で表した 65 バイト）。実行ごとに変えない */
function fixedKey(seed: number): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.alloc(32, seed));
  return ecdh.getPublicKey();
}

/** サーバーの公開鍵。base64url に - と _ の両方を含む鍵にする（標準の base64 に直したものを拒むかを確かめるため） */
const KEY_BYTES = fixedKey(1);
const PUBLIC_KEY = KEY_BYTES.toString("base64url");

const UA = {
  desktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneLine:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari Line/14.0.0",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1",
};

/** open() を呼ぶまで解決しない Promise（途中で止めて、別の操作を割り込ませる） */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** 待たされていない処理を先に進める（割り込ませた操作が、待たずに進むならここで終わる） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type FakeSub = {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => PushSubscriptionJSON;
  unsubscribe: () => Promise<boolean>;
};

/**
 * ブラウザの API（navigator・window・Notification・Service Worker の購読）を偽物に置き換える。
 * apis が false なら Service Worker・PushManager・Notification を置かない
 */
function fakeBrowser(
  opts: {
    ua?: string;
    platform?: string;
    maxTouchPoints?: number;
    standalone?: boolean;
    displayStandalone?: boolean;
    apis?: boolean;
    permission?: NotificationPermission;
    grant?: NotificationPermission;
    /** 許可を求めたときに、これが解決するまで答えない（ダイアログを開いたまま） */
    holdPermission?: Promise<void>;
    subscribed?: boolean;
    /** 残っている購読の公開鍵（既定は今の公開鍵） */
    subscribedKey?: Buffer;
    subscribeError?: boolean;
    /** 購読を作るのを、これが解決するまで待たせる */
    holdSubscribe?: Promise<void>;
    noRegistration?: boolean;
  } = {},
) {
  const log = { subscribe: 0, unsubscribe: 0, requested: 0 };
  /** 作った購読（作った順） */
  const made: FakeSub[] = [];
  let current: FakeSub | null = null;
  const makeSub = (key: ArrayBuffer | null): FakeSub => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/test-${made.length}`;
    const sub: FakeSub = {
      endpoint,
      options: { applicationServerKey: key },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "p256dh-test", auth: "auth-test" } }),
      unsubscribe: async () => {
        log.unsubscribe++;
        if (current === sub) current = null;
        return true;
      },
    };
    made.push(sub);
    return sub;
  };
  const toBuffer = (b: Uint8Array) =>
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  if (opts.subscribed) current = makeSub(toBuffer(opts.subscribedKey ?? KEY_BYTES));
  const reg = {
    active: {},
    pushManager: {
      getSubscription: async () => current,
      subscribe: async (o: PushSubscriptionOptionsInit) => {
        log.subscribe++;
        // Safari・Chrome は userVisibleOnly が true でないと購読を作らない
        if (o.userVisibleOnly !== true) throw new Error("userVisibleOnly is not true");
        const key = o.applicationServerKey;
        if (!(key instanceof Uint8Array) || !Buffer.from(key).equals(KEY_BYTES)) {
          throw new Error("applicationServerKey is not the server's public key");
        }
        await opts.holdSubscribe;
        if (opts.subscribeError) throw new Error("subscribe failed");
        if (current) return current;
        current = makeSub(toBuffer(key));
        return current;
      },
    },
  };
  const notification = {
    permission: opts.permission ?? "default",
    requestPermission: async () => {
      log.requested++;
      if (opts.holdPermission) await opts.holdPermission;
      notification.permission = opts.grant ?? "granted";
      return notification.permission;
    },
  };
  const apis = opts.apis ?? true;
  vi.stubGlobal("navigator", {
    userAgent: opts.ua ?? UA.desktop,
    platform: opts.platform ?? "MacIntel",
    maxTouchPoints: opts.maxTouchPoints ?? 0,
    standalone: opts.standalone,
    ...(apis && {
      serviceWorker: {
        getRegistration: async () => (opts.noRegistration ? undefined : reg),
        ready: new Promise(() => {}),
      },
    }),
  });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("matchMedia", () => ({ matches: opts.displayStandalone ?? false }));
  if (apis) {
    vi.stubGlobal("PushManager", function PushManager() {});
    vi.stubGlobal("Notification", notification);
  }
  return { log, notification, made, current: () => current };
}

/** hold があれば、応答をそれが解決するまで待たせる */
type Reply = { status: number; body?: unknown; hold?: Promise<void> } | "network";

/**
 * /api/push への要求に、メソッドごとに用意した応答を順に返す（最後の応答はその後も返し続ける）。
 * 送った本文を、送った時点で記録する
 */
function fakeServer(replies: { GET?: Reply[]; POST?: Reply[]; DELETE?: Reply[] }) {
  const calls: { method: string; body: unknown }[] = [];
  const queues: Record<string, Reply[]> = {
    GET: replies.GET ?? [{ status: 200, body: { publicKey: PUBLIC_KEY } }],
    POST: replies.POST ?? [{ status: 200, body: { ok: true } }],
    DELETE: replies.DELETE ?? [{ status: 200, body: { ok: true } }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/push");
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const queue = queues[method];
      const reply = queue.length > 1 ? queue.shift()! : queue[0];
      if (reply === "network") throw new TypeError("Failed to fetch");
      await reply.hold;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
    }),
  );
  return calls;
}

/** 有効にしてある端末（許可・購読・印がそろっている）と、/api/push の応答を用意する */
function enabled(
  server: Parameters<typeof fakeServer>[0] = {},
  browser: Parameters<typeof fakeBrowser>[0] = {},
) {
  const b = fakeBrowser({ permission: "granted", subscribed: true, ...browser });
  const calls = fakeServer(server);
  push.setReminderOn(true);
  return { ...b, calls };
}

/** 設定を開いたときと同じく、先に状態を読んで公開鍵を取っておく */
async function opened(browser: Parameters<typeof fakeBrowser>[0], server: Parameters<typeof fakeServer>[0]) {
  const b = fakeBrowser(browser);
  const calls = fakeServer(server);
  await push.loadPushState();
  return { ...b, calls };
}

describe("base64url → バイト列", () => {
  it("= を付けない base64url を読む", () => {
    expect(push.base64UrlToBytes("")).toEqual(new Uint8Array());
    expect(push.base64UrlToBytes("QQ")).toEqual(new Uint8Array([65]));
    expect(push.base64UrlToBytes("-_8")).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(push.base64UrlToBytes(PUBLIC_KEY)).toEqual(new Uint8Array(KEY_BYTES));
  });

  it("使えない文字・=・半端な長さ・同じ文字列に戻らないものは null", () => {
    for (const bad of ["+/8", "QQ==", "QQ=", "Q", "QUJDR", "Q Q", "QR", "QUJ\n", "あ", "QQ%"]) {
      expect([bad, push.base64UrlToBytes(bad)]).toEqual([bad, null]);
    }
  });

  it("公開鍵は 0x04 で始まる 65 バイトだけ", () => {
    // - か _ が無いと、標準の base64 に直しても同じ文字列になり、下の検査が意味を持たない
    expect(PUBLIC_KEY).toMatch(/-/);
    expect(PUBLIC_KEY).toMatch(/_/);
    expect(push.publicKeyBytes(PUBLIC_KEY)).toEqual(new Uint8Array(KEY_BYTES));
    const wrongPrefix = Buffer.from(KEY_BYTES);
    wrongPrefix[0] = 0x03;
    for (const bad of [
      undefined,
      null,
      65,
      [],
      {},
      "",
      `${PUBLIC_KEY}=`,
      PUBLIC_KEY.slice(0, -1),
      `${PUBLIC_KEY}AA`,
      PUBLIC_KEY.replace(/-/g, "+").replace(/_/g, "/"),
      wrongPrefix.toString("base64url"),
      KEY_BYTES.subarray(0, 33).toString("base64url"),
    ]) {
      expect([bad, push.publicKeyBytes(bad)]).toEqual([bad, null]);
    }
  });
});

describe("端末の対応", () => {
  it("navigator を置き換えられる（Node 22 の組み込みの navigator）", () => {
    fakeBrowser({ ua: "test-agent" });
    expect(navigator.userAgent).toBe("test-agent");
  });

  it("iPhone・iPad の Safari のページは needs-install。ホーム画面に追加したアプリなら API で決める", () => {
    fakeBrowser({ ua: UA.iphone, apis: false });
    expect(push.pushSupport()).toBe("needs-install");
    // iPadOS の Safari は Mac と名乗る
    fakeBrowser({ ua: UA.desktop, platform: "MacIntel", maxTouchPoints: 5, apis: false });
    expect(push.pushSupport()).toBe("needs-install");
    fakeBrowser({ ua: UA.iphone, standalone: true });
    expect(push.pushSupport()).toBe("supported");
    fakeBrowser({ ua: UA.iphone, displayStandalone: true });
    expect(push.pushSupport()).toBe("supported");
    // iOS 16.4 より前のホーム画面のアプリには API が無い
    fakeBrowser({ ua: UA.iphone, standalone: true, apis: false });
    expect(push.pushSupport()).toBe("unsupported");
  });

  it("iOS のアプリ内ブラウザ（LINE・Chrome）は API が無いので unsupported", () => {
    for (const ua of [UA.iphoneLine, UA.iphoneChrome]) {
      fakeBrowser({ ua, apis: false });
      expect(push.pushSupport()).toBe("unsupported");
    }
  });

  it("デスクトップは API があれば supported、無ければ unsupported", () => {
    fakeBrowser();
    expect(push.pushSupport()).toBe("supported");
    fakeBrowser({ apis: false });
    expect(push.pushSupport()).toBe("unsupported");
  });
});

describe("有効にした印", () => {
  it("保存した true のときだけ有効。外すとキーごと消す", () => {
    expect(push.reminderOn()).toBe(false);
    push.setReminderOn(true);
    expect(store.get(KEYS.reminder)).toBe("true");
    expect(push.reminderOn()).toBe(true);
    push.setReminderOn(false);
    expect(store.has(KEYS.reminder)).toBe(false);
  });

  it("true 以外の保存データ（壊れた値・別の型）は無効", () => {
    for (const raw of ["{", "", "null", "false", "1", '"true"', "[]", "{}", "True"]) {
      store.set(KEYS.reminder, raw);
      expect([raw, push.reminderOn()]).toEqual([raw, false]);
    }
  });

  it("localStorage が使えなくても落ちない", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(push.reminderOn()).toBe(false);
    expect(() => push.setReminderOn(true)).not.toThrow();
    expect(() => push.setReminderOn(false)).not.toThrow();
  });
});

describe("設定に出す状態（loadPushState）", () => {
  it("公開鍵を取れない（503・通信の失敗・形の違う鍵）なら unavailable", async () => {
    for (const reply of [
      { status: 503, body: { error: "push unavailable" } },
      { status: 503, body: { error: "ranking unavailable" } },
      { status: 500, body: { error: "internal error" } },
      "network" as const,
      { status: 200, body: {} },
      { status: 200, body: { publicKey: "not-a-key" } },
      { status: 200, body: { publicKey: `${PUBLIC_KEY}=` } },
    ]) {
      push = await freshPush();
      fakeBrowser();
      fakeServer({ GET: [reply] });
      expect([reply, await push.loadPushState()]).toEqual([reply, "unavailable"]);
    }
  });

  it("公開鍵を取れなければ、端末・許可・印・購読によらず unavailable", async () => {
    fakeServer({ GET: [{ status: 503, body: { error: "push unavailable" } }] });
    push.setReminderOn(true);
    for (const browser of [
      { ua: UA.iphone, apis: false },
      { ua: UA.iphone, permission: "granted", subscribed: true },
      { apis: false },
      { permission: "default", subscribed: true },
      { permission: "denied", subscribed: true },
      { permission: "granted", subscribed: true },
    ] as const) {
      fakeBrowser(browser);
      expect([browser, await push.loadPushState()]).toEqual([browser, "unavailable"]);
    }
  });

  it("iOS の Safari のページは needs-install、API の無い端末は unsupported（許可・印・購読によらない）", async () => {
    fakeServer({});
    push.setReminderOn(true);
    for (const permission of ["default", "denied", "granted"] as const) {
      fakeBrowser({ ua: UA.iphone, permission, subscribed: true });
      expect([permission, await push.loadPushState()]).toEqual([permission, "needs-install"]);
    }
    fakeBrowser({ ua: UA.iphone, apis: false });
    expect(await push.loadPushState()).toBe("needs-install");
    fakeBrowser({ apis: false });
    expect(await push.loadPushState()).toBe("unsupported");
    fakeBrowser({ ua: UA.iphone, standalone: true, apis: false });
    expect(await push.loadPushState()).toBe("unsupported");
  });

  it("許可がブロックされていれば denied。許可・印・購読がそろえば on、どれかが欠ければ off", async () => {
    fakeServer({});
    push.setReminderOn(true);
    fakeBrowser({ permission: "denied", subscribed: true });
    expect(await push.loadPushState()).toBe("denied");
    fakeBrowser({ permission: "granted", subscribed: true });
    expect(await push.loadPushState()).toBe("on");
    // 購読が消えていた・Service Worker が無い・許可が取り消されていた
    fakeBrowser({ permission: "granted" });
    expect(await push.loadPushState()).toBe("off");
    fakeBrowser({ permission: "granted", subscribed: true, noRegistration: true });
    expect(await push.loadPushState()).toBe("off");
    fakeBrowser({ permission: "default", subscribed: true });
    expect(await push.loadPushState()).toBe("off");
    // 印が無い（許可がブロックされていれば denied のまま）
    push.setReminderOn(false);
    fakeBrowser({ permission: "granted", subscribed: true });
    expect(await push.loadPushState()).toBe("off");
    fakeBrowser({ permission: "default" });
    expect(await push.loadPushState()).toBe("off");
    fakeBrowser({ permission: "denied" });
    expect(await push.loadPushState()).toBe("denied");
  });

  it("取れた公開鍵は覚えておき、取れなかったときは次に取り直す", async () => {
    fakeBrowser();
    const calls = fakeServer({ GET: ["network", { status: 200, body: { publicKey: PUBLIC_KEY } }] });
    expect(await push.loadPushState()).toBe("unavailable");
    expect(await push.loadPushState()).toBe("off");
    expect(await push.loadPushState()).toBe("off");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });
});

describe("有効にする（enablePush）", () => {
  it("許可 → 購読 → 登録 → 印。登録には playerId と購読の toJSON() を送る", async () => {
    const { log, calls, current } = await opened({}, {});
    expect(await push.enablePush(PLAYER)).toEqual({ state: "on" });
    expect(log).toMatchObject({ requested: 1, subscribe: 1, unsubscribe: 0 });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "POST", body: { playerId: PLAYER, subscription: current()!.toJSON() } },
    ]);
    expect(push.reminderOn()).toBe(true);
    expect(await push.loadPushState()).toBe("on");
    // 状態を読んだときに取った公開鍵を使い、押したあとには取りに行かない
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("許可を求めるのは最初の await より前（同期のうちに呼ぶ）", async () => {
    const { log } = await opened({}, {});
    const pending = push.enablePush(PLAYER);
    expect(log.requested).toBe(1);
    await pending;
  });

  it("許可されなければ購読も登録もしない。ブロックされたら denied", async () => {
    const denied = await opened({ grant: "denied" }, {});
    expect(await push.enablePush(PLAYER)).toEqual({ state: "denied" });
    expect(denied.log.subscribe).toBe(0);
    expect(denied.calls.filter((c) => c.method !== "GET")).toEqual([]);
    const dismissed = await opened({ grant: "default" }, {});
    expect(await push.enablePush(PLAYER)).toEqual({ state: "off" });
    expect(dismissed.log.subscribe).toBe(0);
    expect(push.reminderOn()).toBe(false);
  });

  it("409 なら購読を作り直して 1 回だけ登録し直す", async () => {
    const { log, calls, current } = await opened(
      {},
      { POST: [{ status: 409, body: { error: "subscription conflict" } }, { status: 200 }] },
    );
    expect(await push.enablePush(PLAYER)).toEqual({ state: "on" });
    expect(log).toMatchObject({ subscribe: 2, unsubscribe: 1 });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    // 作り直した購読を送る
    expect(posts[1].body).toEqual({ playerId: PLAYER, subscription: current()!.toJSON() });
    expect(posts[0].body).not.toEqual(posts[1].body);
    expect(push.reminderOn()).toBe(true);
  });

  it("サーバーの応答を失敗の種類に写す。失敗したら購読を外し、印を付けない", async () => {
    const cases: [Reply[], { state: string; error: string }, number][] = [
      // 作り直しても 409・作り直した購読の登録が 429 や通信の失敗（409 のあとの失敗は理由によらず failed）
      [[{ status: 409 }, { status: 409 }], { state: "off", error: "failed" }, 2],
      [[{ status: 409 }, { status: 429 }], { state: "off", error: "failed" }, 2],
      [[{ status: 409 }, "network"], { state: "off", error: "failed" }, 2],
      [[{ status: 429, body: { error: "rate limited" } }], { state: "off", error: "rate-limited" }, 1],
      [[{ status: 503, body: { error: "too many subscriptions" } }], { state: "off", error: "failed" }, 1],
      [[{ status: 400, body: { error: "invalid endpoint" } }], { state: "off", error: "failed" }, 1],
      [[{ status: 500, body: { error: "internal error" } }], { state: "off", error: "failed" }, 1],
      [["network"], { state: "off", error: "offline" }, 1],
    ];
    for (const [POST, result, posts] of cases) {
      push = await freshPush();
      const { log, calls, current } = await opened({}, { POST });
      expect([POST, await push.enablePush(PLAYER)]).toEqual([POST, result]);
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(posts);
      expect(current()).toBeNull();
      expect(log.unsubscribe).toBe(posts);
      expect(push.reminderOn()).toBe(false);
    }
  });

  it("購読を作れない・Service Worker が無いときも失敗にして、印を付けない", async () => {
    await opened({ subscribeError: true }, {});
    expect(await push.enablePush(PLAYER)).toEqual({ state: "off", error: "failed" });
    expect(push.reminderOn()).toBe(false);
    push = await freshPush();
    const { calls } = await opened({ noRegistration: true }, {});
    expect(await push.enablePush(PLAYER)).toEqual({ state: "off", error: "failed" });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("別の公開鍵で作った購読が残っていれば、外してから作る。同じ公開鍵ならそのまま使う", async () => {
    const other = fixedKey(2);
    const stale = await opened({ permission: "granted", subscribed: true, subscribedKey: other }, {});
    const old = stale.current()!;
    expect(await push.enablePush(PLAYER)).toEqual({ state: "on" });
    expect(stale.log.unsubscribe).toBe(1);
    expect(stale.current()!.endpoint).not.toBe(old.endpoint);

    push = await freshPush();
    const same = await opened({ permission: "granted", subscribed: true }, {});
    const kept = same.current()!;
    expect(await push.enablePush(PLAYER)).toEqual({ state: "on" });
    expect(same.log.unsubscribe).toBe(0);
    expect(same.current()).toBe(kept);
  });
});

describe("無効にする（disablePush）", () => {
  it("サーバーから消し、購読を外し、印を外す", async () => {
    const { log, calls, current } = enabled();
    const endpoint = current()!.endpoint;
    expect(await push.disablePush(PLAYER)).toEqual({ state: "off" });
    expect(calls).toEqual([{ method: "DELETE", body: { playerId: PLAYER, endpoint } }]);
    expect(log.unsubscribe).toBe(1);
    expect(push.reminderOn()).toBe(false);
  });

  it("サーバーから消せなくても（通信の失敗・503）、購読と印は外す", async () => {
    for (const reply of ["network" as const, { status: 503 }]) {
      const { log, current } = enabled({ DELETE: [reply] });
      expect(await push.disablePush(PLAYER)).toEqual({ state: "off" });
      expect(current()).toBeNull();
      expect(log.unsubscribe).toBe(1);
      expect(push.reminderOn()).toBe(false);
    }
  });
});

describe("開いたときの登録し直し（refreshPush）", () => {
  it("印・許可・購読がそろっていれば、今の購読を 1 回登録する（公開鍵は取りに行かない）", async () => {
    const { calls, current } = enabled();
    await push.refreshPush(PLAYER);
    expect(calls).toEqual([
      { method: "POST", body: { playerId: PLAYER, subscription: current()!.toJSON() } },
    ]);
    expect(push.reminderOn()).toBe(true);
  });

  it("印が無い・使えない端末では何もしない", async () => {
    fakeBrowser({ permission: "granted", subscribed: true });
    const calls = fakeServer({});
    await push.refreshPush(PLAYER);
    store.set(KEYS.reminder, '"true"');
    await push.refreshPush(PLAYER);
    fakeBrowser({ ua: UA.iphone, apis: false });
    push.setReminderOn(true);
    await push.refreshPush(PLAYER);
    expect(calls).toEqual([]);
    expect(push.reminderOn()).toBe(true);
  });

  it("許可が取り消されていた・購読が消えていたら印を外す（登録しない）", async () => {
    for (const browser of [
      { permission: "denied" as const },
      { permission: "default" as const },
      { subscribed: false },
    ]) {
      const { calls } = enabled({}, browser);
      await push.refreshPush(PLAYER);
      expect([browser, calls, push.reminderOn()]).toEqual([browser, [], false]);
    }
  });

  it("一時的な失敗（通信・429・5xx）は購読と印を残し、400 なら外す", async () => {
    for (const [reply, kept] of [
      ["network", true],
      [{ status: 429 }, true],
      [{ status: 503 }, true],
      [{ status: 500 }, true],
      [{ status: 400 }, false],
    ] as [Reply, boolean][]) {
      const { current } = enabled({ POST: [reply] });
      await push.refreshPush(PLAYER);
      expect([reply, push.reminderOn(), current() !== null]).toEqual([reply, kept, kept]);
    }
  });

  it("409 なら公開鍵を取って購読を作り直し、1 回だけ登録し直す。それでも 409 なら購読と印を外す", async () => {
    const ok = enabled({ POST: [{ status: 409 }, { status: 200 }] });
    const old = ok.current()!;
    await push.refreshPush(PLAYER);
    expect(ok.calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
    expect(ok.calls[2].body).toEqual({ playerId: PLAYER, subscription: ok.current()!.toJSON() });
    expect(ok.current()!.endpoint).not.toBe(old.endpoint);
    expect(push.reminderOn()).toBe(true);

    // 作り直した購読の登録が失敗したら、一時的な失敗（429・通信・503）でも購読と印を外す
    for (const second of [{ status: 409 }, { status: 429 }, "network", { status: 503 }] as Reply[]) {
      const ng = enabled({ POST: [{ status: 409 }, second] });
      await push.refreshPush(PLAYER);
      expect([second, ng.calls.filter((c) => c.method === "POST").length]).toEqual([second, 2]);
      expect([second, ng.current(), push.reminderOn()]).toEqual([second, null, false]);
    }
  });

  it("409 のあと公開鍵を取れなければ、作り直さずに購読と印を残す（次に開いたときにまた試す）", async () => {
    const { current, log } = enabled({ POST: [{ status: 409 }], GET: [{ status: 503 }] });
    await push.refreshPush(PLAYER);
    expect(log.unsubscribe).toBe(0);
    expect(current()).not.toBeNull();
    expect(push.reminderOn()).toBe(true);
  });

  it("引き継ぎで変わった playerId で登録する（続けて呼ばれても、まとめずに順に登録する）", async () => {
    const { calls } = enabled();
    const next = "22222222-2222-4222-8222-222222222222";
    await Promise.all([push.refreshPush(PLAYER), push.refreshPush(next)]);
    expect(calls.map((c) => (c.body as { playerId: string }).playerId)).toEqual([PLAYER, next]);
  });
});

describe("登録し直しの途中で無効にしたとき（購読を残さない）", () => {
  it("409 で購読を作り直している途中に無効にしても、購読と印を残さず、作り直した購読をサーバーから消す", async () => {
    const hold = gate();
    const b = enabled({ POST: [{ status: 409 }, { status: 200 }] }, { holdSubscribe: hold.wait });
    const refreshing = push.refreshPush(PLAYER);
    await vi.waitFor(() => expect(b.log.subscribe).toBe(1));
    const disabling = push.disablePush(PLAYER);
    await settle();
    hold.open();
    await refreshing;
    expect(await disabling).toEqual({ state: "off" });
    const [old, fresh] = b.made;
    expect(b.calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "POST", body: { playerId: PLAYER, subscription: old.toJSON() } },
      { method: "POST", body: { playerId: PLAYER, subscription: fresh.toJSON() } },
      { method: "DELETE", body: { playerId: PLAYER, endpoint: fresh.endpoint } },
    ]);
    expect(b.current()).toBeNull();
    expect(push.reminderOn()).toBe(false);
  });

  it("別のタブで、購読を作り直している途中に無効にされたら、作り直した購読を登録した後にサーバーから消して外す", async () => {
    const hold = gate();
    const b = enabled({ POST: [{ status: 409 }, { status: 200 }] }, { holdSubscribe: hold.wait });
    const refreshing = push.refreshPush(PLAYER);
    await vi.waitFor(() => expect(b.log.subscribe).toBe(1));
    // 別のタブ（実行中の操作を共有しない。localStorage・購読・サーバーは同じ）。購読がまだ無いので、印だけ外す
    const otherTab = await freshPush();
    expect(await otherTab.disablePush(PLAYER)).toEqual({ state: "off" });
    expect(b.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    hold.open();
    await refreshing;
    const [old, fresh] = b.made;
    expect(b.calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "POST", body: { playerId: PLAYER, subscription: old.toJSON() } },
      { method: "POST", body: { playerId: PLAYER, subscription: fresh.toJSON() } },
      { method: "DELETE", body: { playerId: PLAYER, endpoint: fresh.endpoint } },
    ]);
    expect(b.current()).toBeNull();
    expect(push.reminderOn()).toBe(false);
  });

  it("別のタブで、購読を作り直す前に無効にされたら、作り直さない", async () => {
    const hold = gate();
    const b = enabled({
      POST: [{ status: 409 }, { status: 200 }],
      GET: [{ status: 200, body: { publicKey: PUBLIC_KEY }, hold: hold.wait }],
    });
    const old = b.current()!;
    const refreshing = push.refreshPush(PLAYER);
    await vi.waitFor(() => expect(b.calls.map((c) => c.method)).toEqual(["POST", "GET"]));
    const otherTab = await freshPush();
    expect(await otherTab.disablePush(PLAYER)).toEqual({ state: "off" });
    hold.open();
    await refreshing;
    expect(b.log.subscribe).toBe(0);
    expect(b.calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "POST", body: { playerId: PLAYER, subscription: old.toJSON() } },
      { method: "DELETE", body: { playerId: PLAYER, endpoint: old.endpoint } },
    ]);
    expect(b.current()).toBeNull();
    expect(push.reminderOn()).toBe(false);
  });
});

describe("操作を重ねない", () => {
  it("有効にしている途中でもう一度有効にしても 1 回だけ行う。終わればまた行える", async () => {
    const hold = gate();
    const { log, calls } = await opened({ holdSubscribe: hold.wait }, {});
    const first = push.enablePush(PLAYER);
    const second = push.enablePush(PLAYER);
    hold.open();
    expect(await first).toEqual({ state: "on" });
    expect(await second).toEqual({ state: "on" });
    expect(log).toMatchObject({ requested: 1, subscribe: 1 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);

    expect(await push.enablePush(PLAYER)).toEqual({ state: "on" });
    expect(log).toMatchObject({ requested: 2, subscribe: 2 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("有効にしている途中で無効にすると、有効にし終えてから無効にする", async () => {
    const hold = gate();
    const { log, calls, made, current } = await opened({ holdSubscribe: hold.wait }, {});
    const enabling = push.enablePush(PLAYER);
    await vi.waitFor(() => expect(log.subscribe).toBe(1));
    const disabling = push.disablePush(PLAYER);
    await settle();
    hold.open();
    expect(await enabling).toEqual({ state: "on" });
    expect(await disabling).toEqual({ state: "off" });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "POST", body: { playerId: PLAYER, subscription: made[0].toJSON() } },
      { method: "DELETE", body: { playerId: PLAYER, endpoint: made[0].endpoint } },
    ]);
    expect(current()).toBeNull();
    expect(push.reminderOn()).toBe(false);
  });

  it("無効にしている途中で有効にすると、許可はすぐに求め、無効にし終えてから有効にする", async () => {
    const hold = gate();
    const { log, calls, made, current } = enabled({ DELETE: [{ status: 200, hold: hold.wait }] });
    const disabling = push.disablePush(PLAYER);
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["DELETE"]));
    const enabling = push.enablePush(PLAYER);
    expect(log.requested).toBe(1);
    await settle();
    hold.open();
    expect(await disabling).toEqual({ state: "off" });
    expect(await enabling).toEqual({ state: "on" });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "DELETE", body: { playerId: PLAYER, endpoint: made[0].endpoint } },
      { method: "POST", body: { playerId: PLAYER, subscription: made[1].toJSON() } },
    ]);
    expect(current()).toBe(made[1]);
    expect(push.reminderOn()).toBe(true);
  });

  it("状態は、実行中の操作が終わってから読む（シートを開き直したとき、途中の状態を出さない）", async () => {
    const hold = gate();
    const { log } = await opened({ holdSubscribe: hold.wait }, {});
    const enabling = push.enablePush(PLAYER);
    let read: PushState | null = null;
    const reading = push.loadPushState().then((s) => (read = s));
    await vi.waitFor(() => expect(log.subscribe).toBe(1));
    expect(read).toBeNull();
    hold.open();
    expect(await reading).toBe("on");
    expect(await enabling).toEqual({ state: "on" });
  });
});

describe("終わらない操作があっても詰まらない（1 つの操作を待つのは 15 秒まで）", () => {
  beforeEach(() => {
    // setImmediate は本物のままにして、flush で待たされていない処理を進める
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 時計を進めずに、待たされていない処理（偽の通信の応答など）を先に進める */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  /** 時計を ms 進めて、その間に進められる処理を進める */
  const elapse = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  };

  /** 解決したか・その値を、待たずに見られるようにする */
  function track<T>(promise: Promise<T>) {
    const t: { settled: boolean; value?: T } = { settled: false };
    void promise.then((value) => {
      t.settled = true;
      t.value = value;
    });
    return t;
  }

  it("登録し直しの登録が返らなくても、15 秒たてば、待っていた無効にする・状態を読むが進み、その後の有効にするは待たない", async () => {
    const hold = gate();
    const b = enabled({ POST: [{ status: 200, hold: hold.wait }, { status: 200 }] });
    const refreshing = track(push.refreshPush(PLAYER));
    await flush();
    const reading = track(push.loadPushState());
    const disabling = track(push.disablePush(PLAYER));
    await elapse(14_999);
    expect([refreshing.settled, reading.settled, disabling.settled]).toEqual([false, false, false]);
    expect(b.calls.map((c) => c.method)).toEqual(["POST"]);

    await elapse(1);
    expect(disabling.value).toEqual({ state: "off" });
    expect(reading.value).toBe("off");
    expect(b.current()).toBeNull();
    expect(push.reminderOn()).toBe(false);

    // 登録し直しはまだ終わっていないが、有効にする操作は待たずに進む
    expect(await push.enablePush(PLAYER)).toEqual({ state: "on" });
    expect(refreshing.settled).toBe(false);
    expect(b.calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "POST", body: { playerId: PLAYER, subscription: b.made[0].toJSON() } },
      { method: "DELETE", body: { playerId: PLAYER, endpoint: b.made[0].endpoint } },
      { method: "POST", body: { playerId: PLAYER, subscription: b.made[1].toJSON() } },
    ]);

    // 遅れて返った登録し直し（成功）は、有効にし直した状態を変えない
    hold.open();
    await flush();
    expect(refreshing.settled).toBe(true);
    expect(b.current()).toBe(b.made[1]);
    expect(push.reminderOn()).toBe(true);
    expect(await push.loadPushState()).toBe("on");
  });

  it("許可のダイアログに答えないままでも、15 秒たてば状態を読める。答えを待つ有効にする操作は打ち切らず、後で許可すれば続ける", async () => {
    const dialog = gate();
    const { log, calls } = await opened({ holdPermission: dialog.wait }, {});
    const enabling = track(push.enablePush(PLAYER));
    expect(log.requested).toBe(1);
    const reading = track(push.loadPushState());
    await elapse(14_999);
    expect(reading.settled).toBe(false);
    await elapse(1);
    expect(reading.value).toBe("off");

    // 何分たっても、答えを待ち続ける（購読も登録もしない）
    await elapse(10 * 60_000);
    expect(enabling.settled).toBe(false);
    expect(log.subscribe).toBe(0);

    dialog.open();
    await flush();
    expect(enabling.value).toEqual({ state: "on" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(push.reminderOn()).toBe(true);
    expect(await push.loadPushState()).toBe("on");
  });

  it("許可のダイアログに答えるまでの時間は期限に数えない（答えてから 15 秒は、後の操作と状態の読み込みを待たせる）", async () => {
    const dialog = gate();
    const hold = gate();
    const { log } = await opened(
      { holdPermission: dialog.wait },
      { POST: [{ status: 200, hold: hold.wait }] },
    );
    const enabling = track(push.enablePush(PLAYER));
    await elapse(10_000);
    dialog.open();
    await flush();
    expect(log.subscribe).toBe(1);
    // 答えたのは順番が来てから 10 秒後。期限はそこから 15 秒（順番が来てから 25 秒）
    const reading = track(push.loadPushState());
    await elapse(14_999);
    expect(reading.settled).toBe(false);
    await elapse(1);
    expect(reading.value).toBe("off");

    hold.open();
    await flush();
    expect(enabling.value).toEqual({ state: "on" });
    expect(push.reminderOn()).toBe(true);
  });

  it("期限を過ぎた登録し直しが後で 409 を受けても、その間に無効にしていれば購読を作り直さない（wanted で確かめる）", async () => {
    const hold = gate();
    const b = enabled({ POST: [{ status: 409, hold: hold.wait }] });
    const old = b.current()!;
    const refreshing = push.refreshPush(PLAYER);
    await flush();
    const disabling = track(push.disablePush(PLAYER));
    await elapse(15_000);
    expect(disabling.value).toEqual({ state: "off" });

    hold.open();
    await refreshing;
    expect(b.log.subscribe).toBe(0);
    expect(b.calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "POST", body: { playerId: PLAYER, subscription: old.toJSON() } },
      { method: "DELETE", body: { playerId: PLAYER, endpoint: old.endpoint } },
    ]);
    expect(b.current()).toBeNull();
    expect(push.reminderOn()).toBe(false);
  });

  it("期限を過ぎた有効にする操作が後で失敗しても、その間に有効にし直した購読と印を外さない（失敗は結果で返す）", async () => {
    const hold = gate();
    const b = await opened({}, { POST: [{ status: 503, hold: hold.wait }, { status: 200 }] });
    const first = track(push.enablePush(PLAYER));
    await elapse(15_000);
    expect(first.settled).toBe(false);

    // 期限を過ぎた操作には相乗りせず、新しく有効にする
    const second = track(push.enablePush(PLAYER));
    await flush();
    expect(second.value).toEqual({ state: "on" });
    expect(b.log).toMatchObject({ requested: 2, subscribe: 2, unsubscribe: 0 });
    expect(b.current()).toBe(b.made[0]);

    hold.open();
    await flush();
    expect(first.value).toEqual({ state: "off", error: "failed" });
    expect(b.log.unsubscribe).toBe(0);
    expect(b.current()).toBe(b.made[0]);
    expect(push.reminderOn()).toBe(true);
    expect(await push.loadPushState()).toBe("on");
  });

  it("期限を過ぎた登録し直しが後で 400 を受けても、その間に無効にして有効にし直した購読と印を外さない", async () => {
    const hold = gate();
    const b = enabled({ POST: [{ status: 400, hold: hold.wait }, { status: 200 }] });
    const refreshing = push.refreshPush(PLAYER);
    await flush();
    await elapse(15_000);
    expect(await push.disablePush(PLAYER)).toEqual({ state: "off" });
    expect(await push.enablePush(PLAYER)).toEqual({ state: "on" });
    const fresh = b.current()!;
    expect(fresh).toBe(b.made[1]);

    hold.open();
    await refreshing;
    expect(b.current()).toBe(fresh);
    expect(push.reminderOn()).toBe(true);
  });
});
