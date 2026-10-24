import { createECDH, createHash, randomBytes } from "node:crypto";
import type dns from "node:dns";
import { EventEmitter } from "node:events";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { parse } from "node:url";
import type { Redis } from "@upstash/redis";
import { afterEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { jstDateKey } from "@/lib/sudoku/generator";
import { readJson } from "./http";
import {
  FAILURE_KINDS,
  PUSH_FAIL_DAYS_TO_REMOVE,
  PUSH_MAX_BODY_BYTES,
  PUSH_MAX_PER_PLAYER,
  PUSH_MAX_TOTAL,
  REMINDER,
  assertEndpoint,
  createGuardedLookup,
  cronAuthorized,
  isBlockedAddress,
  parseSubscription,
  pushService,
  pushSubId,
  reminderTtl,
  requirePushConfig,
  sendReminders,
  subscribePush,
  unsubscribePush,
  webPushSender,
  type FailureKind,
  type PushService,
  type SendPush,
} from "./push";
import { RankingError } from "./ranking";
import { MemoryStore, RedisStore, type PushSub, type RankingStore } from "./store";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-10-15T11:00:00Z"); // JST 20:00
const DAY = 24 * 60 * 60 * 1000;

const p256dh = () => createECDH("prime256v1").generateKeys().toString("base64url");
const auth = () => randomBytes(16).toString("base64url");
const keys = () => ({ p256dh: p256dh(), auth: auth() });
const fcm = (n: number | string) => `https://fcm.googleapis.com/fcm/send/dev${n}:APA91bH-x_y`;
const apple = (n: number | string) => `https://web.push.apple.com/dev${n}-QGuQyavXutnMH`;
const windows = (n: number | string) => `https://wns2-par02p.notify.windows.com/w/?token=dev${n}`;
const mozilla = (n: number | string) => `https://updates.push.services.mozilla.com/wpush/v2/dev${n}`;
const subscription = (endpoint: string) => ({ endpoint, keys: keys() });
const player = (i: number) => `${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
/** 0x04 で始まる 65 バイトだが、P-256 の曲線上に無い点 */
const OFF_CURVE = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x01)]).toString("base64url");

type Counts = {
  targets: number;
  sent: number;
  removed: number;
  failed: number;
  truncated: boolean;
  failures?: Partial<Record<FailureKind, number>>;
};
const NO_FAILURES = Object.fromEntries(FAILURE_KINDS.map((k) => [k, 0])) as Record<FailureKind, number>;
/** cron の応答の期待値（failures は 0 でない種類だけ書く） */
const result = ({ failures = {}, ...counts }: Counts) => ({
  ...counts,
  failures: { ...NO_FAILURES, ...failures },
});

/** 送信して、件数の関係（targets = sent + removed + failed、failures の合計 = failed）を確かめる */
async function remindAll(store: RankingStore, deps: Parameters<typeof sendReminders>[1]) {
  const res = await sendReminders(store, deps);
  expect(Object.keys(res.failures)).toEqual([...FAILURE_KINDS]);
  expect(res.targets).toBe(res.sent + res.removed + res.failed);
  expect(Object.values(res.failures).reduce((a, b) => a + b, 0)).toBe(res.failed);
  return res;
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toBeInstanceOf(RankingError);
  await promise.catch((e: RankingError) => expect(e.status).toBe(status));
}

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof RankingError ? e.status : -1;
  }
}

/** 受け付けたら正規化した URL、拒否したら null（400 invalid endpoint 以外の例外はそのまま投げる） */
function tryEndpoint(value: string): string | null {
  try {
    return assertEndpoint(value);
  } catch (e) {
    if (e instanceof RankingError && e.status === 400 && e.message === "invalid endpoint") return null;
    throw e;
  }
}

/** 許可リストと同じ判定（テスト側で独立に書いたもの） */
const isAllowedHost = (host: string) =>
  host === "fcm.googleapis.com" ||
  host === "updates.push.services.mozilla.com" ||
  ["push.apple.com", "notify.windows.com"].some((d) => host === d || host.endsWith(`.${d}`));

/** web-push が使う url.parse の解釈と、検査した URL（WHATWG）の解釈の食い違い。無ければ null */
function legacyMismatch(href: string): string | null {
  const w = new URL(href);
  const l = parse(href);
  const diffs = [
    l.protocol !== "https:" && `protocol=${l.protocol}`,
    l.hostname !== w.hostname && `hostname=${l.hostname}`,
    l.host !== w.host && `host=${l.host}`,
    l.port !== null && `port=${l.port}`,
    l.auth !== null && `auth=${l.auth}`,
    l.path !== w.pathname + w.search && `path=${l.path}`,
    !isAllowedHost(l.hostname ?? "") && "not allowed",
  ].filter(Boolean);
  return diffs.length > 0 ? diffs.join(" ") : null;
}

/** url.parse ではホストが変わり、許可リストを回避できた URL（修正前は受け付けていた） */
const SSRF_POCS = [
  "https://evil.example.com;.push.apple.com/x",
  "https://169.254.169.254;.push.apple.com/latest",
  "https://internal-svc'.notify.windows.com/x",
  "https://attacker.example'.push.apple.com/x",
  "https://127.0.0.1;.notify.windows.com/y",
  "https://internal.svc%60.push.apple.com/z",
];

/** 文字種の検査で許している記号 */
const HOST_SYMBOLS = [";", "'", "(", ")", "&", "$", "!", "*", "+", ",", "=", "~", "_", "%"];
const pct = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;

/** 決まったシードの乱数（mulberry32） */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_BASES = [
  "https://fcm.googleapis.com",
  "https://web.push.apple.com",
  "https://wns2-par02p.notify.windows.com",
  "https://updates.push.services.mozilla.com",
  "https:fcm.googleapis.com",
  "https:/web.push.apple.com",
];
const FUZZ_PIECES = [
  ..."abcfgmxz09.-:/@?".split(""),
  ...HOST_SYMBOLS,
  ...HOST_SYMBOLS.map(pct),
  ...'./@:?#\\`"<>^{|} \0\t\n'.split("").map(pct),
  "%2e",
  "%fc",
  "evil.example",
  "127.0.0.1",
  "169.254.169.254",
  "[::1]",
  "localhost",
];

/**
 * 3 種類の URL を作る：URL のどこかに記号などを差し込んだもの、許可したドメインの前（サブドメイン）に
 * 差し込んだもの、パス・クエリだけに差し込んだもの
 */
function fuzzUrls(seed: number, count: number): string[] {
  const rand = seeded(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const pieces = (n: number) => Array.from({ length: n }, () => pick(FUZZ_PIECES)).join("");
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const mode = rand();
    let url: string;
    if (mode < 0.3) {
      url = pick(FUZZ_BASES);
      const times = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < times; j++) {
        const at = Math.floor(rand() * (url.length + 1));
        url = url.slice(0, at) + pick(FUZZ_PIECES) + url.slice(at);
      }
      url += `/${pieces(Math.floor(rand() * 3))}`;
    } else if (mode < 0.6) {
      const domain = pick(["push.apple.com", "notify.windows.com"]);
      url = `https://${pieces(1 + Math.floor(rand() * 4))}.${domain}/${pieces(Math.floor(rand() * 3))}`;
    } else {
      url = `${pick(FUZZ_BASES)}/${pieces(1 + Math.floor(rand() * 4))}`;
      if (rand() < 0.3) url += `?${pieces(1 + Math.floor(rand() * 3))}`;
    }
    urls.push(url);
  }
  return urls;
}

/** 修正前の検査（文字種・WHATWG・許可リストだけ）。ファズが穴を突く入力を作れているかの確認に使う */
function acceptedBeforeFix(value: string): string | null {
  if (!/^[A-Za-z0-9\-._~:/?@!$&'()*+,;=%]+$/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const ok =
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    isAllowedHost(url.hostname);
  return ok ? url.href : null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ACCEPTED = [
  "https://fcm.googleapis.com/fcm/send/cXyZ:APA91bE-abc_DEF",
  "https://fcm.googleapis.com/fcm/send/dH3xQ8kRbZ0:APA91bFq7-Lk9mVb2_xYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  "https://web.push.apple.com/QGuQyavXutnMH-abc_DEF",
  "https://api.push.apple.com/x",
  "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk-abc_DEF=",
  "https://wns2-bn3p.notify.windows.com/w/?token=BQYAAAB%2bAbc%3d",
  "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAAk%2fAbc%2bDEF%3d",
];

describe("endpoint の検査", () => {
  it("許可したプッシュサービスの https だけを受け付ける（実在の endpoint の形）", () => {
    for (const url of ACCEPTED) expect(assertEndpoint(url)).toBe(url);
  });

  it("ポート 443 の明示や大文字のホストは正規化して受け付ける", () => {
    expect(assertEndpoint("https://fcm.googleapis.com:443/fcm/send/a")).toBe(
      "https://fcm.googleapis.com/fcm/send/a",
    );
    expect(assertEndpoint("https://FCM.GoogleAPIs.com/fcm/send/a")).toBe(
      "https://fcm.googleapis.com/fcm/send/a",
    );
    expect(assertEndpoint("https://fcm%2Egoogleapis%2Ecom/fcm/send/a")).toBe(
      "https://fcm.googleapis.com/fcm/send/a",
    );
  });

  it("ホストの偽装・別のスキーム・ポート・ユーザー情報・IP・内部ホストは 400", () => {
    const rejected = [
      "https://evil.fcm.googleapis.com.attacker.com/x",
      "https://evilfcm.googleapis.com.attacker.com/x",
      "https://fcm.googleapis.com.evil.com/x",
      "https://fcm.googleapis.com./x",
      "https://sub.fcm.googleapis.com/x",
      "https://xfcm.googleapis.com/x",
      "https://xpush.apple.com/x",
      "https://push.apple.com.evil.com/x",
      "https://evilnotify.windows.com/x",
      "https://notify.windows.com.evil.com/x",
      "https://push.services.mozilla.com.evil.com/x",
      "https://xupdates.push.services.mozilla.com/x",
      "https://autopush.push.services.mozilla.com/x",
      "https://fcm%2egoogleapis%2ecom%2eevil%2ecom/x",
      "http://fcm.googleapis.com/fcm/send/a",
      "wss://fcm.googleapis.com/fcm/send/a",
      "ftp://fcm.googleapis.com/a",
      "javascript:alert(1)",
      "data:text/plain,fcm.googleapis.com",
      "https://fcm.googleapis.com:8443/fcm/send/a",
      "https://fcm.googleapis.com:80/fcm/send/a",
      "https://user@fcm.googleapis.com/fcm/send/a",
      "https://user:pass@fcm.googleapis.com/fcm/send/a",
      "https://fcm.googleapis.com@evil.com/x",
      "https://evil.com\\@fcm.googleapis.com/x",
      "https://fcm.googleapis.com\\@evil.com/x",
      "https://evil.com#@fcm.googleapis.com/x",
      "https://fcm.google\tapis.com/x",
      "https://fcm.googleapis.com/x y",
      "https://fcm.googleapis.com/x\n",
      "https://ｆｃｍ.googleapis.com/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://0x7f000001/x",
      "https://localhost/x",
      "https://localhost:3000/x",
      "https://metadata.google.internal/x",
      "fcm.googleapis.com/fcm/send/a",
      "",
      `https://fcm.googleapis.com/${"a".repeat(2048)}`,
    ];
    for (const url of rejected) expect([url, statusOf(() => assertEndpoint(url))]).toEqual([url, 400]);
    for (const v of [undefined, null, 42, {}, ["https://fcm.googleapis.com/x"]]) {
      expect(statusOf(() => assertEndpoint(v))).toBe(400);
    }
  });

  it("SSRF の再現例（WHATWG では許可リストのホスト、url.parse では別のホスト）は 400", () => {
    for (const url of SSRF_POCS) {
      // 修正前の検査は通り、web-push が使う url.parse では許可リストの外へ繋ぐ URL であること
      const href = acceptedBeforeFix(url);
      expect([url, href !== null && !isAllowedHost(parse(href).hostname ?? "")]).toEqual([url, true]);
      expect([url, tryEndpoint(url)]).toEqual([url, null]);
    }
  });

  it("許可した各ドメインのホスト部に記号を入れた URL は、生のままでも %XX でも 400", () => {
    const hosts = [
      "web.push.apple.com",
      "push.apple.com",
      "wns2-par02p.notify.windows.com",
      "notify.windows.com",
      "updates.push.services.mozilla.com",
      "fcm.googleapis.com",
    ];
    const accepted: string[] = [];
    let count = 0;
    for (const host of hosts) {
      expect(assertEndpoint(`https://${host}/x`)).toBe(`https://${host}/x`);
      for (const symbol of HOST_SYMBOLS) {
        for (const form of [symbol, pct(symbol), pct(symbol).toLowerCase()]) {
          // ラベルの中・`.` の前後・ホストの先頭と末尾のすべての位置
          for (let at = 0; at <= host.length; at++) {
            const url = `https://${host.slice(0, at)}${form}${host.slice(at)}/x`;
            count++;
            if (tryEndpoint(url) !== null) accepted.push(url);
          }
        }
      }
    }
    expect(accepted).toEqual([]);
    expect(count).toBeGreaterThan(5000);
  });

  it("ホスト名は英小文字・数字・ハイフンのラベルだけ（url.parse と食い違わない記号や空のラベルも 400）", () => {
    const ldhOnly = [
      "https://a_b.push.apple.com/x",
      "https://a%5Fb.push.apple.com/x",
      "https://a+b.notify.windows.com/x",
      "https://-a.push.apple.com/x",
      "https://a-.notify.windows.com/x",
      "https://a..push.apple.com/x",
      "https://.push.apple.com/x",
    ];
    for (const url of ldhOnly) {
      // url.parse も同じホスト名に読むので、url.parse との照合だけでは弾けない
      const href = new URL(url).href;
      expect([url, parse(href).hostname]).toEqual([url, new URL(href).hostname]);
      expect([url, tryEndpoint(url)]).toEqual([url, null]);
    }
    for (const url of [`https://${"a".repeat(64)}.push.apple.com/x`, "https://push.apple.com./x"]) {
      expect([url, tryEndpoint(url)]).toEqual([url, null]);
    }
    const longest = `https://${"a".repeat(63)}.push.apple.com/x`;
    expect(assertEndpoint(longest)).toBe(longest);
  });

  it("punycode（xn--）のラベルは、許可したドメインのサブドメインのときだけ受け付ける", () => {
    expect(assertEndpoint("https://XN--BCHER-KVA.push.apple.com/x")).toBe(
      "https://xn--bcher-kva.push.apple.com/x",
    );
    for (const url of [
      "https://xn--bcher-kva.fcm.googleapis.com/x",
      "https://xn--a.push.apple.com/x",
      "https://bücher.push.apple.com/x",
    ]) {
      expect([url, tryEndpoint(url)]).toEqual([url, null]);
    }
  });

  it("url.parse ではパスが変わる URL（パスの生の '）は 400。%27 やクエリの ' は受け付ける", () => {
    const raw = "https://fcm.googleapis.com/fcm/send/a'b";
    // ホストは許可リストのものだが、web-push は %27 に変えたパスへ送る
    expect(new URL(raw).hostname).toBe("fcm.googleapis.com");
    expect(parse(raw).path).toBe("/fcm/send/a%27b");
    expect(new URL(raw).pathname).toBe("/fcm/send/a'b");
    expect(tryEndpoint(raw)).toBeNull();
    expect(assertEndpoint("https://fcm.googleapis.com/fcm/send/a%27b")).toBe(
      "https://fcm.googleapis.com/fcm/send/a%27b",
    );
    expect(assertEndpoint("https://wns2-par02p.notify.windows.com/w/?token=a'b")).toBe(
      "https://wns2-par02p.notify.windows.com/w/?token=a%27b",
    );
  });

  it("受け付けた URL は、web-push が使う url.parse でも同じホスト・ポートになる", () => {
    const urls = [
      ...ACCEPTED,
      "https://fcm.googleapis.com:443/fcm/send/a",
      "https://fcm%2Egoogleapis%2Ecom/fcm/send/a",
      "https://fcm.googleapis.com/fcm/send/a@evil.com",
      "https://fcm.googleapis.com/fcm/send/a?b=@evil.com:1",
    ];
    for (const url of urls) {
      const href = assertEndpoint(url);
      expect([href, legacyMismatch(href)]).toEqual([href, null]);
    }
  });

  it("ランダムに作った URL でも、受け付けたものは url.parse と WHATWG の解釈が一致する", () => {
    let accepted = 0;
    let unsafeBeforeFix = 0;
    const mismatches: string[] = [];
    for (const url of fuzzUrls(20261017, 20_000)) {
      const before = acceptedBeforeFix(url);
      if (before && parse(before).hostname !== new URL(before).hostname) unsafeBeforeFix++;
      const href = tryEndpoint(url);
      if (href === null) continue;
      accepted++;
      const diff = legacyMismatch(href);
      if (diff) mismatches.push(`${url} -> ${diff}`);
      if (!/^[a-z0-9.-]+$/.test(new URL(href).hostname)) mismatches.push(`${url} -> not LDH`);
      if (tryEndpoint(href) !== href) mismatches.push(`${url} -> not idempotent`);
    }
    expect(mismatches).toEqual([]);
    expect(accepted).toBeGreaterThan(5000);
    // 同じ入力で、修正前の検査は url.parse と食い違う URL を受け付けていた（ファズが穴を突けている）
    expect(unsafeBeforeFix).toBeGreaterThan(500);
  });
});

describe("プッシュサービスの分類", () => {
  /** 許可リストに対応する分類（テスト側で独立に書いたもの） */
  const expectedService = (host: string): PushService =>
    host === "fcm.googleapis.com"
      ? "fcm"
      : host === "updates.push.services.mozilla.com"
        ? "mozilla"
        : host === "push.apple.com" || host.endsWith(".push.apple.com")
          ? "apple"
          : host === "notify.windows.com" || host.endsWith(".notify.windows.com")
            ? "windows"
            : "other";

  it("許可した各ホストを、対応するサービスに分ける", () => {
    const cases: [string, PushService][] = [
      ["https://fcm.googleapis.com/fcm/send/cXyZ:APA91bE-abc_DEF", "fcm"],
      ["https://web.push.apple.com/QGuQyavXutnMH-abc_DEF", "apple"],
      ["https://api.push.apple.com/x", "apple"],
      ["https://push.apple.com/x", "apple"],
      ["https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk-abc_DEF=", "mozilla"],
      ["https://wns2-bn3p.notify.windows.com/w/?token=BQYAAAB%2bAbc%3d", "windows"],
      ["https://notify.windows.com/w/?token=x", "windows"],
      [fcm(1), "fcm"],
      [apple(1), "apple"],
      [windows(1), "windows"],
      [mozilla(1), "mozilla"],
    ];
    for (const [endpoint, service] of cases) {
      expect([endpoint, pushService(endpoint)]).toEqual([endpoint, service]);
    }
    for (const url of ACCEPTED) expect([url, pushService(url)]).not.toEqual([url, "other"]);
  });

  it("検査を通らない endpoint（偽装したホスト・許可リストに無いホスト・正規化前の形）は other", () => {
    for (const endpoint of [
      ...SSRF_POCS,
      "https://evil.example/x",
      "https://push.apple.com.evil.example/x",
      "https://evilpush.apple.com/x",
      "https://evilnotify.windows.com/x",
      "https://sub.fcm.googleapis.com/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://push.services.mozilla.com/x",
      "http://fcm.googleapis.com/x",
      "https://FCM.googleapis.com:443/x",
      "https://127.0.0.1/x",
      "not a url",
      "",
    ]) {
      expect([endpoint, pushService(endpoint)]).toEqual([endpoint, "other"]);
    }
  });

  it("登録で受け付けた endpoint は、すべて 4 つのサービスのどれかに分かれる（許可リストと分類の食い違いが無い）", () => {
    let accepted = 0;
    for (const url of fuzzUrls(11, 3000)) {
      const href = tryEndpoint(url);
      if (href === null) continue;
      accepted++;
      const service = pushService(href);
      expect([href, service]).toEqual([href, expectedService(new URL(href).hostname)]);
      expect([href, service]).not.toEqual([href, "other"]);
    }
    expect(accepted).toBeGreaterThan(500);
  });
});

describe("鍵の検査", () => {
  const base = { playerId: ALICE, subscription: subscription(fcm(1)) };
  const withKeys = (keys: unknown) => ({ ...base, subscription: { endpoint: fcm(1), keys } });

  it("正しい購読は受け付け、鍵をパディングなしの base64url にそろえる", () => {
    const key = p256dh();
    const a = auth();
    const parsed = parseSubscription(withKeys({ p256dh: `${key}=`, auth: `${a}==` }));
    expect(parsed).toEqual({ playerId: ALICE, endpoint: fcm(1), p256dh: key, auth: a });
  });

  it("長さ・先頭バイト・base64url でない文字・型が違えば 400", () => {
    const point = Buffer.from(p256dh(), "base64url");
    const compressed = Buffer.concat([Buffer.from([0x02]), point.subarray(1, 33)]);
    const notUncompressed = Buffer.from(point);
    notUncompressed[0] = 0x05;
    // 標準の base64（+ と / を含む）
    const standard = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xfb)]).toString("base64");
    expect(standard).toMatch(/[+/]/);
    const bad = [
      { p256dh: point.subarray(0, 64).toString("base64url"), auth: auth() },
      { p256dh: Buffer.concat([point, Buffer.from([1])]).toString("base64url"), auth: auth() },
      { p256dh: compressed.toString("base64url"), auth: auth() },
      { p256dh: notUncompressed.toString("base64url"), auth: auth() },
      { p256dh: standard, auth: auth() },
      { p256dh: p256dh(), auth: randomBytes(15).toString("base64url") },
      { p256dh: p256dh(), auth: randomBytes(17).toString("base64url") },
      { p256dh: p256dh(), auth: "!!!!!!!!!!!!!!!!!!!!!!" },
      { p256dh: p256dh(), auth: `${auth()}===` },
      { p256dh: p256dh() },
      { p256dh: 1, auth: auth() },
      null,
      "x",
    ];
    for (const keys of bad) expect(statusOf(() => parseSubscription(withKeys(keys)))).toBe(400);
  });

  it("p256dh が P-256 の曲線上の点でなければ 400（0x04 で始まる 65 バイトでも）", () => {
    const random = Buffer.concat([Buffer.from([0x04]), randomBytes(64)]).toString("base64url");
    for (const key of [OFF_CURVE, random]) {
      expect(statusOf(() => parseSubscription(withKeys({ p256dh: key, auth: auth() })))).toBe(400);
    }
  });

  it("プレイヤー ID や購読の形が違えば 400", () => {
    expect(statusOf(() => parseSubscription({ ...base, playerId: "nope" }))).toBe(400);
    expect(statusOf(() => parseSubscription({ ...base, subscription: null }))).toBe(400);
    expect(statusOf(() => parseSubscription({ ...base, subscription: "x" }))).toBe(400);
    expect(statusOf(() => parseSubscription({ ...base, subscription: { endpoint: fcm(1) } }))).toBe(400);
    expect(
      statusOf(() => parseSubscription({ ...base, subscription: { ...subscription(fcm(1)), endpoint: 1 } })),
    ).toBe(400);
  });
});

describe("本文の読み取り", () => {
  const req = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/push", {
      method: "POST",
      body,
      headers,
      duplex: "half",
    } as RequestInit);
  const opts = { maxBytes: PUSH_MAX_BODY_BYTES };

  it("上限までの JSON オブジェクトを読む", async () => {
    const body = JSON.stringify({ a: "x".repeat(PUSH_MAX_BODY_BYTES - 20) });
    expect(body.length).toBeLessThanOrEqual(PUSH_MAX_BODY_BYTES);
    await expect(readJson(req(body), opts)).resolves.toHaveProperty("a");
  });

  it("上限を超えたら 413（Content-Length が無くても）", async () => {
    const body = JSON.stringify({ a: "x".repeat(PUSH_MAX_BODY_BYTES) });
    await expectStatus(readJson(req(body), opts), 413);
    await expectStatus(readJson(req("{}", { "content-length": String(PUSH_MAX_BODY_BYTES + 1) }), opts), 413);
    // 多バイト文字はバイト数で数える
    await expectStatus(readJson(req(JSON.stringify({ a: "あ".repeat(1400) })), opts), 413);
  });

  it("終わらない本文も、上限を超えた時点で読むのをやめて 413", async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    await expectStatus(readJson(req(endless), opts), 413);
    // 読み終えるまで待つ実装なら、ここに来ずに時間切れになる
    expect(pulls).toBeLessThanOrEqual(20);
  });

  it("JSON でなければ 400、オブジェクトでなければ {}", async () => {
    for (const body of ["", "x", "{"]) {
      await expectStatus(readJson(req(body), opts), 400);
    }
    for (const body of ["null", "42", '"s"']) {
      await expect(readJson(req(body), opts)).resolves.toEqual({});
    }
    await expect(readJson(req('{"a":1}'), opts)).resolves.toEqual({ a: 1 });
  });

  it("型を外して上限を渡さない・数でない上限を渡した呼び出しは、上限なしで読まずに TypeError にする", async () => {
    // @ts-expect-error maxBytes は必須
    await expect(readJson(req("{}"), {})).rejects.toBeInstanceOf(TypeError);
    for (const maxBytes of [undefined, null, "4096", NaN, Infinity, 0, -1]) {
      await expect(readJson(req("{}"), { maxBytes } as never)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(readJson(req("{}"), undefined as never)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("設定と cron の認証", () => {
  const env = {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub",
    VAPID_PRIVATE_KEY: "priv",
    VAPID_SUBJECT: "mailto:a@example.com",
    CRON_SECRET: "s3cret",
  };

  it("4 つそろえば設定を返し、1 つでも無い・連絡先の形が違えば 503", () => {
    expect(requirePushConfig(env)).toEqual({
      publicKey: "pub",
      privateKey: "priv",
      subject: "mailto:a@example.com",
      cronSecret: "s3cret",
    });
    expect(requirePushConfig({ ...env, VAPID_SUBJECT: "https://example.com" }).subject).toBe(
      "https://example.com",
    );
    for (const key of Object.keys(env)) {
      expect(statusOf(() => requirePushConfig({ ...env, [key]: undefined }))).toBe(503);
      expect(statusOf(() => requirePushConfig({ ...env, [key]: "" }))).toBe(503);
    }
    expect(statusOf(() => requirePushConfig({ ...env, VAPID_SUBJECT: "http://example.com" }))).toBe(503);
    expect(statusOf(() => requirePushConfig({}))).toBe(503);
  });

  it("Bearer とシークレットが完全に一致したときだけ通す", () => {
    expect(cronAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(cronAuthorized(null, "s3cret")).toBe(false);
    expect(cronAuthorized("", "s3cret")).toBe(false);
    expect(cronAuthorized("Bearer s3creT", "s3cret")).toBe(false);
    expect(cronAuthorized("bearer s3cret", "s3cret")).toBe(false);
    expect(cronAuthorized("Bearer s3cret ", "s3cret")).toBe(false);
    expect(cronAuthorized("Bearer s3cre", "s3cret")).toBe(false);
    expect(cronAuthorized("s3cret", "s3cret")).toBe(false);
    expect(cronAuthorized("Bearer ", "")).toBe(true); // 空のシークレットは requirePushConfig が先に 503 にする
  });
});

describe("購読の登録と解除", () => {
  it("同じ endpoint の登録は上書きで、期限を延ばし、登録日時は最初のまま", async () => {
    const store = new MemoryStore();
    const id = pushSubId(fcm(1));
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm(1)) }, T0);
    expect(store.pushExpiresAt(id)).toBe(T0 + 400 * DAY);
    const again = subscription(fcm(1));
    await expect(
      subscribePush(store, { playerId: ALICE, subscription: again }, T0 + 100 * DAY),
    ).resolves.toEqual({ ok: true });
    expect(await store.countPushSubs()).toBe(1);
    expect(store.pushExpiresAt(id)).toBe(T0 + 500 * DAY);
    expect(await store.getPushSub(id)).toEqual({
      endpoint: fcm(1),
      p256dh: again.keys.p256dh,
      auth: again.keys.auth,
      playerId: ALICE,
      createdAt: T0,
    });
    expect(await store.playerPushSubs(ALICE)).toEqual([id]);
  });

  it("1 人あたりの上限を超えたら、更新の古いものから消す", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < PUSH_MAX_PER_PLAYER; i++) {
      await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm(i)) }, T0 + i);
    }
    // いちばん古い 0 を登録し直すと、次に古いのは 1
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm(0)) }, T0 + 10);
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm(9)) }, T0 + 11);
    const ids = await store.playerPushSubs(ALICE);
    expect(ids).toHaveLength(PUSH_MAX_PER_PLAYER);
    expect(ids).not.toContain(pushSubId(fcm(1)));
    expect(ids).toContain(pushSubId(fcm(0)));
    expect(await store.getPushSub(pushSubId(fcm(1)))).toBeNull();
    expect(await store.countPushSubs()).toBe(PUSH_MAX_PER_PLAYER);
  });

  it("全体の上限に達したら新しい購読は 503、登録済みの更新はできる", async () => {
    class Full extends MemoryStore {
      async countPushSubs() {
        return Math.max(PUSH_MAX_TOTAL, await super.countPushSubs());
      }
    }
    const store = new Full();
    await store.putPushSub(
      pushSubId(fcm(1)),
      { ...parseSubscription({ playerId: ALICE, subscription: subscription(fcm(1)) }), createdAt: T0 },
      T0,
    );
    await expectStatus(subscribePush(store, { playerId: BOB, subscription: subscription(fcm(2)) }, T0), 503);
    expect(await store.getPushSub(pushSubId(fcm(2)))).toBeNull();
    await expect(
      subscribePush(store, { playerId: ALICE, subscription: subscription(fcm(1)) }, T0 + 1),
    ).resolves.toEqual({ ok: true });
  });

  it("解除はそのプレイヤーの購読だけを消し、無くても成功する", async () => {
    const store = new MemoryStore();
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm(1)) }, T0);
    await expect(unsubscribePush(store, { playerId: BOB, endpoint: fcm(1) })).resolves.toEqual({ ok: true });
    expect(await store.getPushSub(pushSubId(fcm(1)))).not.toBeNull();
    await expect(unsubscribePush(store, { playerId: ALICE, endpoint: fcm(1) })).resolves.toEqual({
      ok: true,
    });
    expect(await store.getPushSub(pushSubId(fcm(1)))).toBeNull();
    expect(await store.countPushSubs()).toBe(0);
    expect(await store.playerPushSubs(ALICE)).toEqual([]);
    await expect(unsubscribePush(store, { playerId: ALICE, endpoint: fcm(1) })).resolves.toEqual({
      ok: true,
    });
    // 正規化した endpoint で照合する
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm(2)) }, T0);
    await unsubscribePush(store, {
      playerId: ALICE,
      endpoint: fcm(2).replace("fcm.googleapis.com", "fcm.googleapis.com:443"),
    });
    expect(await store.countPushSubs()).toBe(0);
  });

  it("解除の不正な入力は 400", async () => {
    const store = new MemoryStore();
    await expectStatus(unsubscribePush(store, { playerId: "x", endpoint: fcm(1) }), 400);
    await expectStatus(unsubscribePush(store, { playerId: ALICE, endpoint: "https://127.0.0.1/x" }), 400);
    await expectStatus(unsubscribePush(store, { playerId: ALICE }), 400);
  });

  it("同じ endpoint を別のプレイヤーが auth の一致する鍵で登録すると、前のプレイヤーの一覧から移る", async () => {
    const store = new MemoryStore();
    const id = pushSubId(fcm(1));
    const device = subscription(fcm(1));
    await subscribePush(store, { playerId: ALICE, subscription: device }, T0);
    // 引き継ぎで同じ端末のプレイヤーが変わった（auth は同じ。p256dh は変わってもよい）
    const moved = { endpoint: fcm(1), keys: { p256dh: p256dh(), auth: device.keys.auth } };
    await subscribePush(store, { playerId: BOB, subscription: moved }, T0 + 1);
    expect(await store.playerPushSubs(ALICE)).toEqual([]);
    expect(await store.playerPushSubs(BOB)).toEqual([id]);
    expect(await store.getPushSub(id)).toEqual({
      ...moved.keys,
      endpoint: fcm(1),
      playerId: BOB,
      createdAt: T0 + 1,
    });
    expect(await store.countPushSubs()).toBe(1);
    // 前のプレイヤーからは消せない
    await unsubscribePush(store, { playerId: ALICE, endpoint: fcm(1) });
    expect(await store.getPushSub(id)).not.toBeNull();
  });

  it("他人の endpoint を自分のプレイヤー ID と鍵で登録しても 409 で、元の購読は変わらない", async () => {
    const store = new MemoryStore();
    const id = pushSubId(fcm(1));
    const victim = subscription(fcm(1));
    await subscribePush(store, { playerId: ALICE, subscription: victim }, T0);
    const before = await store.getPushSub(id);
    const attempts = [
      subscription(fcm(1)),
      // 正規化すると同じ endpoint
      subscription(fcm(1).replace("fcm.googleapis.com", "FCM.googleapis.com:443")),
      // p256dh だけ同じ
      { endpoint: fcm(1), keys: { p256dh: victim.keys.p256dh, auth: auth() } },
    ];
    for (const attempt of attempts) {
      await expectStatus(subscribePush(store, { playerId: BOB, subscription: attempt }, T0 + DAY), 409);
    }
    expect(await store.getPushSub(id)).toEqual(before);
    expect(store.pushExpiresAt(id)).toBe(T0 + 400 * DAY);
    expect(await store.playerPushSubs(ALICE)).toEqual([id]);
    expect(await store.playerPushSubs(BOB)).toEqual([]);
    // 同じプレイヤーなら鍵を変えて登録し直せる
    const rotated = subscription(fcm(1));
    await subscribePush(store, { playerId: ALICE, subscription: rotated }, T0 + DAY);
    expect(await store.getPushSub(id)).toMatchObject({ ...rotated.keys, playerId: ALICE, createdAt: T0 });
  });

  it("不正な購読は保存しない", async () => {
    const store = new MemoryStore();
    await expectStatus(
      subscribePush(store, { playerId: ALICE, subscription: subscription("https://evil.example/x") }, T0),
      400,
    );
    for (const endpoint of SSRF_POCS) {
      await expectStatus(
        subscribePush(store, { playerId: ALICE, subscription: subscription(endpoint) }, T0),
        400,
      );
    }
    expect(await store.countPushSubs()).toBe(0);
  });
});

describe("新規登録の回数制限", () => {
  const HOUR = 60 * 60 * 1000;
  const IP = "203.0.113.7";
  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
  /** 回数制限のカウンタのキー（テスト側で独立に書いたもの） */
  const ipKey = (bucket: string, now: number) =>
    `sdk:push:rl:ip:${bucket === "unknown" ? "unknown" : sha256(bucket)}:${Math.floor(now / HOUR)}`;
  const playerKey = (playerId: string, now: number) =>
    `sdk:push:rl:player:${playerId}:${Math.floor(now / DAY)}`;
  const register = (
    store: RankingStore,
    playerId: string,
    endpoint: string,
    now: number,
    ip: string | null = IP,
  ) => subscribePush(store, { playerId, subscription: subscription(endpoint) }, now, { ip });

  it("同じ IP からの新規登録は 1 時間の窓に 20 件までで、21 件目は 429 で保存しない。次の窓ではまた受け付ける", async () => {
    const store = new MemoryStore();
    const t = Math.floor(T0 / HOUR) * HOUR;
    for (let i = 0; i < 20; i++) {
      await expect(register(store, player(i), fcm(`ip${i}`), t + i)).resolves.toEqual({ ok: true });
    }
    await expectStatus(register(store, player(20), fcm("ip20"), t + 20), 429);
    expect(await store.getPushSub(pushSubId(fcm("ip20")))).toBeNull();
    expect(await store.playerPushSubs(player(20))).toEqual([]);
    expect(await store.countPushSubs()).toBe(20);
    // 別の IP は別に数える
    await expect(register(store, player(21), fcm("ip21"), t + 21, "198.51.100.1")).resolves.toEqual({
      ok: true,
    });
    // 窓の終わりまでは 429、次の窓で受け付ける
    await expectStatus(register(store, player(20), fcm("ip20"), t + HOUR - 1), 429);
    await expect(register(store, player(20), fcm("ip20"), t + HOUR)).resolves.toEqual({ ok: true });
    expect(await store.getPushSub(pushSubId(fcm("ip20")))).not.toBeNull();
  });

  it("同じプレイヤーの新規登録は 24 時間の窓に 10 件まで（IP を変えても）。次の窓ではまた受け付ける", async () => {
    const store = new MemoryStore();
    const t = Math.floor(T0 / DAY) * DAY;
    for (let i = 0; i < 10; i++) {
      await expect(register(store, ALICE, fcm(`p${i}`), t + i, `198.51.100.${i}`)).resolves.toEqual({
        ok: true,
      });
    }
    await expectStatus(register(store, ALICE, fcm("p10"), t + 10, "198.51.100.10"), 429);
    expect(await store.getPushSub(pushSubId(fcm("p10")))).toBeNull();
    // 1 人の上限で古いものは消えている（回数は残っている件数ではなく、新規登録の回数で数える）
    expect(await store.playerPushSubs(ALICE)).toHaveLength(PUSH_MAX_PER_PLAYER);
    // 別のプレイヤーは同じ IP からでも受け付ける
    await expect(register(store, BOB, fcm("b0"), t + 11, "198.51.100.10")).resolves.toEqual({ ok: true });
    await expectStatus(register(store, ALICE, fcm("p10"), t + DAY - 1, "198.51.100.99"), 429);
    await expect(register(store, ALICE, fcm("p10"), t + DAY, "198.51.100.99")).resolves.toEqual({
      ok: true,
    });
  });

  it("既存の購読の更新（鍵の更新を含む）・別のプレイヤーへの移動は数えず、上限に達したあとも受け付ける", async () => {
    const store = new MemoryStore();
    const devices = Array.from({ length: 20 }, (_, i) => ({
      playerId: player(i),
      endpoint: fcm(`u${i}`),
      auth: auth(),
    }));
    const put = (playerId: string, d: (typeof devices)[number], now: number) =>
      subscribePush(
        store,
        { playerId, subscription: { endpoint: d.endpoint, keys: { p256dh: p256dh(), auth: d.auth } } },
        now,
        { ip: IP },
      );
    for (const [i, d] of devices.entries()) await put(d.playerId, d, T0 + i);
    await expectStatus(register(store, player(99), fcm("new"), T0 + 100), 429);
    // アプリを開くたびの登録し直し。同じプレイヤーで 10 回を超えても数えない
    for (let k = 0; k < 12; k++) {
      for (const [i, d] of devices.entries()) {
        await expect(put(d.playerId, d, T0 + 200 + k * 100 + i)).resolves.toEqual({ ok: true });
      }
    }
    // 引き継ぎで別のプレイヤーへ移す（auth が同じ）
    for (const [i, d] of devices.entries()) {
      await expect(put(player(50 + i), d, T0 + 2000 + i)).resolves.toEqual({ ok: true });
    }
    expect(await store.countPushSubs()).toBe(20);
    await expectStatus(register(store, player(99), fcm("new"), T0 + 3000), 429);
    // 移した先のプレイヤーも、新規登録の回数は 0 のまま
    expect(store.rateWindowKeys().filter((k) => k.includes(player(50)))).toEqual([]);
  });

  it("検査で弾いた要求（400・409・全体の上限の 503）は数えない", async () => {
    class Full extends MemoryStore {
      full = false;
      async countPushSubs() {
        return this.full ? PUSH_MAX_TOTAL : super.countPushSubs();
      }
    }
    const store = new Full();
    const victim = fcm("victim");
    await register(store, BOB, victim, T0, "198.51.100.1");
    for (let k = 0; k < 30; k++) {
      const attempts: [{ playerId: unknown; subscription: unknown }, number][] = [
        [{ playerId: "nope", subscription: subscription(fcm(`x${k}`)) }, 400],
        [{ playerId: ALICE, subscription: subscription("https://127.0.0.1/x") }, 400],
        [{ playerId: ALICE, subscription: subscription(SSRF_POCS[0]) }, 400],
        [
          {
            playerId: ALICE,
            subscription: { endpoint: fcm(`k${k}`), keys: { p256dh: OFF_CURVE, auth: auth() } },
          },
          400,
        ],
        [{ playerId: ALICE, subscription: subscription(victim) }, 409],
      ];
      for (const [input, status] of attempts) {
        await expectStatus(subscribePush(store, input, T0 + k, { ip: IP }), status);
      }
    }
    store.full = true;
    for (let k = 0; k < 30; k++) await expectStatus(register(store, ALICE, fcm(`f${k}`), T0 + k), 503);
    store.full = false;
    // BOB の新規登録の分だけ
    expect(store.rateWindowKeys()).toEqual([ipKey("198.51.100.1", T0), playerKey(BOB, T0)].sort());
    for (let i = 0; i < 20; i++) {
      const playerId = i < 10 ? ALICE : player(i);
      await expect(register(store, playerId, fcm(`ok${i}`), T0 + 100 + i)).resolves.toEqual({ ok: true });
    }
    await expectStatus(register(store, player(20), fcm("ok20"), T0 + 200), 429);
  });

  it("IP の上限で弾いた要求は、プレイヤーの回数に数えない", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 20; i++) await register(store, player(i), fcm(`f${i}`), T0 + i);
    for (let k = 0; k < 15; k++) await expectStatus(register(store, ALICE, fcm(`a${k}`), T0 + 100 + k), 429);
    for (let i = 0; i < 10; i++) {
      await expect(register(store, ALICE, fcm(`a${i}`), T0 + 200 + i, `198.51.100.${i}`)).resolves.toEqual({
        ok: true,
      });
    }
    await expectStatus(register(store, ALICE, fcm("a10"), T0 + 300, "198.51.100.10"), 429);
  });

  it("IP が取れない要求は、固定のキー（unknown）でまとめて制限する", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 20; i++) await register(store, player(i), fcm(`n${i}`), T0 + i, null);
    await expectStatus(register(store, player(20), fcm("n20"), T0 + 20, null), 429);
    // IP として読めない値も同じ
    await expectStatus(register(store, player(21), fcm("n21"), T0 + 21, "not-an-ip"), 429);
    expect(store.rateWindowKeys()).toContain(ipKey("unknown", T0));
    await expect(register(store, player(22), fcm("n22"), T0 + 22, IP)).resolves.toEqual({ ok: true });
  });

  it("カウンタのキーは IP の SHA-256 で、生の IP を保存しない", async () => {
    const store = new MemoryStore();
    const ips = ["203.0.113.7", "2001:db8:1:2:aaaa:bbbb:cccc:1", "::ffff:198.51.100.9"];
    for (const [i, ip] of ips.entries()) await register(store, player(i), fcm(`h${i}`), T0, ip);
    expect(store.rateWindowKeys()).toEqual(
      [
        ipKey("203.0.113.7", T0),
        ipKey("2001:db8:1:2::/64", T0),
        ipKey("2001:db8:1::/48", T0),
        ipKey("198.51.100.9", T0),
        ...[0, 1, 2].map((i) => playerKey(player(i), T0)),
      ].sort(),
    );
    const text = store.rateWindowKeys().join(" ");
    for (const s of [...ips, "198.51.100.9", "2001:db8"]) expect(text).not.toContain(s);
  });

  it("IPv6 は同じ /64 のアドレス（書き方が違っても）を 20 件までまとめて数え、同じ /48 の別の /64 は通す。IPv4 射影は IPv4 として数える", async () => {
    // /48 の枠（/64 の 8 倍）の数え方は ip.test.ts で確かめる
    const store = new MemoryStore();
    for (let i = 0; i < 20; i++) {
      const ip = i % 2 === 0 ? `2001:db8:1:2::${i.toString(16)}` : `2001:0DB8:0001:0002:ffff:0:0:${i}`;
      await expect(register(store, player(i), fcm(`v${i}`), T0 + i, ip)).resolves.toEqual({ ok: true });
    }
    await expectStatus(
      register(store, player(20), fcm("v20"), T0 + 20, "2001:db8:1:2:ffff:ffff:ffff:ffff"),
      429,
    );
    await expect(register(store, player(21), fcm("v21"), T0 + 21, "2001:db8:1:3::1")).resolves.toEqual({
      ok: true,
    });
    for (let i = 0; i < 20; i++)
      await register(store, player(30 + i), fcm(`w${i}`), T0 + 30 + i, "198.51.100.9");
    await expectStatus(register(store, player(50), fcm("w20"), T0 + 50, "::ffff:198.51.100.9"), 429);
  });

  it("route から client を渡さないときは制限しない（テスト・内部用）", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 30; i++) {
      await subscribePush(store, { playerId: player(i), subscription: subscription(fcm(`z${i}`)) }, T0);
    }
    expect(await store.countPushSubs()).toBe(30);
    expect(store.rateWindowKeys()).toEqual([]);
  });

  it("MemoryStore のカウンタは窓ごとに数え、最後に数えてから窓の長さで消える", async () => {
    const store = new MemoryStore();
    const t = Math.floor(T0 / HOUR) * HOUR;
    expect(await store.incrRateWindow("ip:abc", 3600, t)).toBe(1);
    expect(await store.incrRateWindow("ip:abc", 3600, t + HOUR - 1)).toBe(2);
    expect(await store.incrRateWindow("ip:abc", 3600, t + HOUR)).toBe(1);
    expect(await store.incrRateWindow("ip:other", 3600, t + HOUR)).toBe(1);
    expect(store.rateWindowKeys()).toEqual([
      `sdk:push:rl:ip:abc:${t / HOUR}`,
      `sdk:push:rl:ip:abc:${t / HOUR + 1}`,
      `sdk:push:rl:ip:other:${t / HOUR + 1}`,
    ]);
    await store.incrRateWindow("ip:abc", 3600, t + 3 * HOUR);
    expect(store.rateWindowKeys()).toEqual([`sdk:push:rl:ip:abc:${t / HOUR + 3}`]);
  });

  it("RedisStore は INCR と EXPIRE を 1 回の pipeline で送り、窓の番号の入った同じキーで数えて回数を返す（Redis にはつながない）", async () => {
    const commands: unknown[][] = [];
    let pipelines = 0;
    let reply: unknown[] = ["3", 1];
    const pipeline = {
      incr(...args: unknown[]) {
        commands.push(["incr", ...args]);
        return this;
      },
      expire(...args: unknown[]) {
        commands.push(["expire", ...args]);
        return this;
      },
      exec: async () => reply,
    };
    const redis = {
      pipeline: () => {
        pipelines++;
        return pipeline;
      },
    };
    const store = new RedisStore(redis as unknown as Redis);
    const now = T0 + 5;
    const key = `sdk:push:rl:ip:abc:${Math.floor(now / HOUR)}`;
    expect(await store.incrRateWindow("ip:abc", 3600, now)).toBe(3);
    expect(commands).toEqual([
      ["incr", key],
      ["expire", key, 3600],
    ]);
    expect(pipelines).toBe(1);
    reply = [21, 1];
    expect(await store.incrRateWindow("player:x", 86400, now)).toBe(21);
    expect(commands.slice(2)).toEqual([
      ["incr", `sdk:push:rl:player:x:${Math.floor(now / DAY)}`],
      ["expire", `sdk:push:rl:player:x:${Math.floor(now / DAY)}`, 86400],
    ]);
  });

  it("数えた 1 回を戻すときは、同じキーに DECR と EXPIRE を 1 回の pipeline で送る（RedisStore は Redis にはつながない。MemoryStore は次の回数が 1 減る）", async () => {
    const commands: unknown[][] = [];
    let pipelines = 0;
    const pipeline = {
      decr(...args: unknown[]) {
        commands.push(["decr", ...args]);
        return this;
      },
      expire(...args: unknown[]) {
        commands.push(["expire", ...args]);
        return this;
      },
      exec: async () => [2, 1],
    };
    const redis = {
      pipeline: () => {
        pipelines++;
        return pipeline;
      },
    };
    const store = new RedisStore(redis as unknown as Redis);
    const now = T0 + 5;
    const key = `sdk:push:rl:xfer:total:${Math.floor(now / HOUR)}`;
    await store.decrRateWindow("xfer:total", 3600, now);
    expect(commands).toEqual([
      ["decr", key],
      ["expire", key, 3600],
    ]);
    expect(pipelines).toBe(1);

    const memory = new MemoryStore();
    await memory.incrRateWindow("ip:abc", 3600, now);
    await memory.incrRateWindow("ip:abc", 3600, now);
    await memory.decrRateWindow("ip:abc", 3600, now);
    expect(await memory.incrRateWindow("ip:abc", 3600, now)).toBe(2);
    // 数えていない窓のカウンタは作らない
    await memory.decrRateWindow("ip:abc", 3600, now + HOUR);
    expect(await memory.incrRateWindow("ip:abc", 3600, now + HOUR)).toBe(1);
  });
});

describe("リマインドの送信", () => {
  type Call = { endpoint: string; payload: string; ttl: number };

  function recorder(fail: (sub: PushSub) => unknown = () => null) {
    const calls: Call[] = [];
    const send: SendPush = async (sub, payload, ttl) => {
      calls.push({ endpoint: sub.endpoint, payload, ttl });
      const err = fail(sub);
      if (err) throw err;
    };
    return { calls, send };
  }

  async function setup() {
    const store = new MemoryStore();
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm("a1")) }, T0 - DAY);
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm("a2")) }, T0 - DAY);
    await subscribePush(store, { playerId: BOB, subscription: subscription(fcm("b1")) }, T0 - DAY);
    return store;
  }

  /** 修正前に保存された想定で、検査を通さずに購読を置く */
  async function putRaw(store: MemoryStore, endpoint: string, playerId: string, p256dhKey = p256dh()) {
    const id = pushSubId(endpoint);
    await store.putPushSub(id, { endpoint, p256dh: p256dhKey, auth: auth(), playerId, createdAt: T0 }, T0);
    return id;
  }

  it("今日の一問をまだクリアしていないプレイヤーにだけ、決まった文面を送る", async () => {
    const store = await setup();
    // ボブは今日クリア済み、アリスは昨日だけ
    await store.addHistory(BOB, { date: "2026-10-15", difficulty: "master", points: 1, timeMs: 1 });
    await store.addHistory(ALICE, { date: "2026-10-14", difficulty: "easy", points: 1, timeMs: 1 });
    const { calls, send } = recorder();
    const res = await remindAll(store, { send, now: T0 });
    expect(res).toEqual(result({ targets: 2, sent: 2, removed: 0, failed: 0, truncated: false }));
    expect(calls.map((c) => c.endpoint).sort()).toEqual([fcm("a1"), fcm("a2")]);
    expect(JSON.parse(calls[0].payload)).toEqual(REMINDER);
    expect(calls[0].payload).not.toContain("数独");
    expect(calls[0].ttl).toBe(4 * 60 * 60); // JST 20:00 から 0 時まで
  });

  it("購読が無ければ何も送らない", async () => {
    const { calls, send } = recorder();
    const res = await remindAll(new MemoryStore(), { send, now: T0 });
    expect(res).toEqual(result({ targets: 0, sent: 0, removed: 0, failed: 0, truncated: false }));
    expect(calls).toHaveLength(0);
  });

  it("同じ日に再実行しても、送った購読には送らない", async () => {
    const store = await setup();
    const first = recorder();
    await remindAll(store, { send: first.send, now: T0 });
    expect(first.calls).toHaveLength(3);
    const second = recorder();
    const res = await remindAll(store, { send: second.send, now: T0 + 60_000 });
    expect(second.calls).toHaveLength(0);
    expect(res).toMatchObject({ targets: 0, sent: 0 });
    // 次の日はまた送る
    const third = recorder();
    await remindAll(store, { send: third.send, now: T0 + DAY });
    expect(third.calls).toHaveLength(3);
  });

  it("404・410 の購読は 3 か所から消し、ほかのエラーは消さずに再実行で送り直す", async () => {
    const store = await setup();
    const status: Record<string, number> = { [fcm("a1")]: 410, [fcm("a2")]: 404, [fcm("b1")]: 500 };
    const failing = recorder((sub) =>
      Object.assign(new Error(`Received unexpected response code ${sub.endpoint}`), {
        statusCode: status[sub.endpoint],
        endpoint: sub.endpoint,
      }),
    );
    const res = await remindAll(store, { send: failing.send, now: T0 });
    expect(res).toEqual(
      result({ targets: 3, sent: 0, removed: 2, failed: 1, truncated: false, failures: { http5xx: 1 } }),
    );
    for (const e of [fcm("a1"), fcm("a2")]) expect(await store.getPushSub(pushSubId(e))).toBeNull();
    expect(await store.playerPushSubs(ALICE)).toEqual([]);
    expect(await store.playerPushSubs(BOB)).toEqual([pushSubId(fcm("b1"))]);
    expect(await store.countPushSubs()).toBe(1);

    const retry = recorder();
    await expect(remindAll(store, { send: retry.send, now: T0 + 60_000 })).resolves.toMatchObject({
      sent: 1,
    });
    expect(retry.calls.map((c) => c.endpoint)).toEqual([fcm("b1")]);
  });

  it("ネットワークのエラー（状態コードなし）も失敗として数え、購読は残す", async () => {
    const store = await setup();
    const { send } = recorder(() => new Error("socket hang up"));
    const res = await remindAll(store, { send, now: T0 });
    expect(res).toEqual(
      result({ targets: 3, sent: 0, removed: 0, failed: 3, truncated: false, failures: { other: 3 } }),
    );
    expect(await store.countPushSubs()).toBe(3);
  });

  it("購読の鍵で暗号化できない失敗だけは購読を消し、一時的な失敗や設定の誤りでは消さない", async () => {
    const store = new MemoryStore();
    const errors: [unknown, boolean][] = [
      [{ code: "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", message: "Public key is not valid" }, true],
      // 状態コードがあれば、プッシュサービスの応答なので消さない
      [{ code: "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", statusCode: 500 }, false],
      [{ code: "ECONNRESET" }, false],
      [{ code: "ETIMEDOUT" }, false],
      [{ code: "ENOTFOUND" }, false],
      [{ code: "EAI_AGAIN" }, false],
      [{ code: "ERR_PUSH_BLOCKED_ADDRESS" }, false],
      [new Error("Socket timeout"), false],
      [new Error("Vapid private key should be 32 bytes long when decoded."), false],
      [{ statusCode: 403 }, false],
      [{ statusCode: 429 }, false],
    ];
    const byEndpoint = new Map<string, unknown>();
    for (const [i, [err]] of errors.entries()) {
      byEndpoint.set(fcm(`e${i}`), err);
      await subscribePush(store, { playerId: player(i), subscription: subscription(fcm(`e${i}`)) }, T0);
    }
    const { send } = recorder((sub) => byEndpoint.get(sub.endpoint));
    const res = await remindAll(store, { send, now: T0 });
    expect(res).toEqual(
      result({
        targets: errors.length,
        sent: 0,
        removed: 1,
        failed: errors.length - 1,
        truncated: false,
        failures: { http5xx: 1, other: 2, timeout: 2, dns: 2, blocked: 1, http4xx: 2 },
      }),
    );
    for (const [i, [, gone]] of errors.entries()) {
      expect([i, (await store.getPushSub(pushSubId(fcm(`e${i}`)))) === null]).toEqual([i, gone]);
    }
  });

  it("応答は件数だけで、endpoint・鍵・プレイヤー ID・id を含まない", async () => {
    const store = await setup();
    const { send } = recorder((sub) => (sub.endpoint === fcm("b1") ? { statusCode: 410 } : null));
    const res = await remindAll(store, { send, now: T0 });
    expect(Object.keys(res).sort()).toEqual([
      "failed",
      "failures",
      "removed",
      "sent",
      "targets",
      "truncated",
    ]);
    const text = JSON.stringify(res);
    for (const s of [fcm("a1"), "fcm.googleapis.com", ALICE, BOB, pushSubId(fcm("a1"))]) {
      expect(text).not.toContain(s);
    }
  });

  it("同時に送るのは concurrency 件まで", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 12; i++) {
      await subscribePush(store, { playerId: player(i), subscription: subscription(fcm(i)) }, T0);
    }
    let active = 0;
    let peak = 0;
    const send: SendPush = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    const res = await remindAll(store, { send, now: T0, concurrency: 3 });
    expect(res.sent).toBe(12);
    expect(peak).toBe(3);
  });

  it("時間の上限を超えたら打ち切り、残りは同じ日の再実行で送る", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 10; i++) {
      await subscribePush(
        store,
        { playerId: ALICE.replace("1111111", `${i}111111`), subscription: subscription(fcm(i)) },
        T0,
      );
    }
    let fakeNow = 0;
    const clock = () => fakeNow;
    const first = recorder();
    const send: SendPush = async (sub, payload, ttl) => {
      await first.send(sub, payload, ttl);
      fakeNow += 1000; // 1 件 1 秒かかる
    };
    // 残り時間が 1 件の期限（1 秒）より短くなったら、新しい送信を始めない
    const res = await remindAll(store, {
      send,
      now: T0,
      clock,
      concurrency: 1,
      budgetMs: 4000,
      sendDeadlineMs: 1000,
    });
    expect(res).toEqual(result({ targets: 4, sent: 4, removed: 0, failed: 0, truncated: true }));
    expect(first.calls).toHaveLength(4);

    const rest = recorder();
    const res2 = await remindAll(store, { send: rest.send, now: T0 + 60_000 });
    expect(res2).toMatchObject({ targets: 6, sent: 6, truncated: false });
    expect(new Set([...first.calls, ...rest.calls].map((c) => c.endpoint)).size).toBe(10);
  });

  it("応答が返らない送信は期限で打ち切って失敗に数え、ほかの送信と全体を待たせない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const store = await setup();
    const hung = fcm("a2");
    const send: SendPush = (sub) => (sub.endpoint === hung ? new Promise(() => {}) : Promise.resolve());
    let settled = false;
    const run = remindAll(store, { send, now: T0, sendDeadlineMs: 1000 }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toEqual(
      result({ targets: 3, sent: 2, removed: 0, failed: 1, truncated: false, failures: { deadline: 1 } }),
    );
    expect(await store.countPushSubs()).toBe(3);
    vi.useRealTimers();
    // 期限切れの購読は印が外れていて、同じ日の再実行で送れる
    const retry = recorder();
    expect(await remindAll(store, { send: retry.send, now: T0 + 60_000 })).toMatchObject({
      targets: 1,
      sent: 1,
    });
    expect(retry.calls.map((c) => c.endpoint)).toEqual([hung]);
  });

  it("残り時間が送信の期限より短くなったら、新しい送信を始めずに打ち切る", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const store = await setup();
    const calls: string[] = [];
    const send: SendPush = (sub) => {
      calls.push(sub.endpoint);
      return new Promise(() => {});
    };
    const run = remindAll(store, { send, now: T0, concurrency: 1, budgetMs: 2500, sendDeadlineMs: 1000 });
    // 0 秒と 1 秒に始めた送信が期限切れになり、2 秒の時点で残り 0.5 秒なので次を始めない
    await vi.advanceTimersByTimeAsync(5000);
    expect(await run).toEqual(
      result({ targets: 2, sent: 0, removed: 0, failed: 2, truncated: true, failures: { deadline: 2 } }),
    );
    expect(calls).toHaveLength(2);
    vi.useRealTimers();
    const retry = recorder();
    expect(await remindAll(store, { send: retry.send, now: T0 + 60_000 })).toMatchObject({
      targets: 3,
      sent: 3,
      truncated: false,
    });
  });

  it("保存済みの endpoint が今の検査を通らなければ送らない（修正前に保存された SSRF の例を含む）", async () => {
    const store = new MemoryStore();
    const endpoints = ["https://169.254.169.254/latest", ...SSRF_POCS];
    for (const [i, endpoint] of endpoints.entries()) await putRaw(store, endpoint, player(i));
    const { calls, send } = recorder();
    const res = await remindAll(store, { send, now: T0 });
    expect(calls).toHaveLength(0);
    expect(res).toEqual(
      result({
        targets: endpoints.length,
        sent: 0,
        removed: 0,
        failed: endpoints.length,
        truncated: false,
        failures: { invalid: endpoints.length },
      }),
    );
  });

  it("登録で受け付けた endpoint はすべて cron でも送り、受け付けなかったものは保存されていても送らない", async () => {
    // 登録と cron の送信前の検査が同じであること（登録を通って cron で弾かれる購読が残らない）
    const store = new MemoryStore();
    const registered = new Set<string>();
    const rejected = new Set<string>();
    for (const url of fuzzUrls(7, 3000)) {
      const href = tryEndpoint(url);
      if (href === null) {
        rejected.add(url);
      } else if (!registered.has(href)) {
        await subscribePush(
          store,
          { playerId: player(registered.size), subscription: subscription(url) },
          T0,
        );
        registered.add(href);
      }
    }
    for (const url of rejected) await putRaw(store, url, player(registered.size + 1));
    expect(registered.size).toBeGreaterThan(500);
    expect(rejected.size).toBeGreaterThan(500);
    const { calls, send } = recorder();
    const res = await remindAll(store, { send, now: T0 });
    expect(new Set(calls.map((c) => c.endpoint))).toEqual(registered);
    expect(res).toMatchObject({
      sent: registered.size,
      failed: rejected.size,
      removed: 0,
      failures: { ...NO_FAILURES, invalid: rejected.size },
    });
  });

  it("失敗の内訳は決まった語だけで、エラーの中身（endpoint・本文・code の文字列）を出さない", async () => {
    const store = await setup();
    const { send } = recorder((sub) =>
      Object.assign(new Error(`boom ${sub.endpoint} ${ALICE}`), {
        statusCode: sub.endpoint === fcm("a1") ? 400 : undefined,
        // code に任意の文字列が入っていても、そのままは出さない
        code: sub.endpoint === fcm("a2") ? `E${sub.endpoint}` : sub.endpoint === fcm("b1") ? BOB : undefined,
        body: `{"reason":"${sub.endpoint}"}`,
        headers: { "x-player": ALICE },
        endpoint: sub.endpoint,
      }),
    );
    const res = await remindAll(store, { send, now: T0 });
    expect(res.failures).toEqual({ ...NO_FAILURES, http4xx: 1, other: 2 });
    const text = JSON.stringify(res);
    for (const s of [
      fcm("a1"),
      fcm("a2"),
      "googleapis",
      ALICE,
      BOB,
      "reason",
      "boom",
      pushSubId(fcm("a1")),
    ]) {
      expect(text).not.toContain(s);
    }
  });

  it("保存先のエラーは other として 1 回だけ数える", async () => {
    class Broken extends MemoryStore {
      async addPushFailure(): Promise<number> {
        throw new Error("command was: sadd sdk:push:fail:x");
      }
    }
    const store = new Broken();
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm("ok")) }, T0 - DAY);
    await subscribePush(store, { playerId: BOB, subscription: subscription(fcm("ng")) }, T0 - DAY);
    const { send } = recorder((sub) => (sub.endpoint === fcm("ng") ? { code: "ENOTFOUND" } : null));
    expect(await remindAll(store, { send, now: T0 })).toEqual(
      result({ targets: 2, sent: 1, removed: 0, failed: 1, truncated: false, failures: { other: 1 } }),
    );
  });

  it("送れたあとに失敗の記録を消せなくても（保存先のエラー）、送れた購読として数え、同じサービスの失敗も数える", async () => {
    class BrokenClear extends MemoryStore {
      async clearPushFailure(): Promise<void> {
        throw new Error("command was: del sdk:push:fail:x");
      }
    }
    const store = new BrokenClear();
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm("ok")) }, T0 - DAY);
    await subscribePush(store, { playerId: BOB, subscription: subscription(fcm("ng")) }, T0 - DAY);
    const { send } = recorder((sub) => (sub.endpoint === fcm("ng") ? { statusCode: 403 } : null));
    expect(await remindAll(store, { send, now: T0 })).toEqual(
      result({ targets: 2, sent: 1, removed: 0, failed: 1, truncated: false, failures: { http4xx: 1 } }),
    );
    // 403 は同じプッシュサービスに送れた回だけ数えるので、数えられていれば FCM への成功が残っている
    expect(store.pushFailureDates(pushSubId(fcm("ng")))).toEqual([jstDateKey(new Date(T0))]);
  });

  describe("送れない日が続いた購読の削除", () => {
    const N = PUSH_FAIL_DAYS_TO_REMOVE;
    const day = (n: number) => T0 + n * DAY;
    const notFound = () =>
      Object.assign(new Error("getaddrinfo ENOTFOUND x.push.apple.com"), { code: "ENOTFOUND" });
    /**
     * 毎日送れる購読（今日の一問をクリアしないプレイヤーのもの）。送れた購読が 1 件も無い回は失敗の日を数えないので、
     * 失敗の日を数えることを確かめるテストではこれを置く
     */
    const HEALTHY = fcm("healthy");
    const CAROL = "33333333-3333-4333-8333-333333333333";
    const addHealthy = (store: RankingStore) =>
      subscribePush(store, { playerId: CAROL, subscription: subscription(HEALTHY) }, T0 - DAY);

    it("消すまでの日数は 5 日", () => {
      expect(N).toBe(5);
    });

    it("1 日の失敗では消さず、5 日続けて送れなかった購読を 3 か所から消す", async () => {
      const store = await setup();
      const junk = fcm("a1");
      const { send } = recorder((sub) => (sub.endpoint === junk ? notFound() : null));
      for (let d = 0; d < N - 1; d++) {
        const res = await remindAll(store, { send, now: day(d) });
        expect([d, res]).toEqual([
          d,
          result({ targets: 3, sent: 2, removed: 0, failed: 1, truncated: false, failures: { dns: 1 } }),
        ]);
        expect(await store.getPushSub(pushSubId(junk))).not.toBeNull();
      }
      expect(store.pushFailureDates(pushSubId(junk))).toHaveLength(N - 1);
      // 5 日目は消した件数に入れ、failed には入れない
      expect(await remindAll(store, { send, now: day(N - 1) })).toEqual(
        result({ targets: 3, sent: 2, removed: 1, failed: 0, truncated: false }),
      );
      expect(await store.getPushSub(pushSubId(junk))).toBeNull();
      expect(await store.playerPushSubs(ALICE)).toEqual([pushSubId(fcm("a2"))]);
      expect(await store.countPushSubs()).toBe(2);
      // 送れている購読には失敗の記録が無い
      expect(store.pushFailureDates(pushSubId(fcm("a2")))).toEqual([]);
    });

    it("途中で送れた日があれば数え直す", async () => {
      const store = await setup();
      const flaky = fcm("b1");
      let down = true;
      const { send } = recorder((sub) => (sub.endpoint === flaky && down ? { statusCode: 500 } : null));
      for (let d = 0; d < N - 1; d++) await remindAll(store, { send, now: day(d) });
      expect(store.pushFailureDates(pushSubId(flaky))).toHaveLength(N - 1);
      down = false;
      expect(await remindAll(store, { send, now: day(N - 1) })).toMatchObject({ sent: 3, removed: 0 });
      expect(store.pushFailureDates(pushSubId(flaky))).toEqual([]);
      down = true;
      for (let d = N; d < 2 * N - 1; d++) {
        expect([d, await remindAll(store, { send, now: day(d) })]).toMatchObject([
          d,
          { failed: 1, removed: 0 },
        ]);
      }
      expect(await store.getPushSub(pushSubId(flaky))).not.toBeNull();
      expect(await remindAll(store, { send, now: day(2 * N - 1) })).toMatchObject({ failed: 0, removed: 1 });
      expect(await store.getPushSub(pushSubId(flaky))).toBeNull();
    });

    it("同じ日の再実行・送り直しでは、何回失敗しても 1 日として数える", async () => {
      const store = await setup();
      const junk = fcm("a1");
      const { calls, send } = recorder((sub) => (sub.endpoint === junk ? notFound() : null));
      for (let d = 0; d < N - 1; d++) {
        // 失敗した購読は印が外れるので、同じ日の再実行で送り直す（そのたびに失敗する）
        for (let k = 0; k < 3; k++) {
          const res = await remindAll(store, { send, now: day(d) + k * 60_000 });
          expect([d, k, res]).toMatchObject([d, k, { failed: 1, removed: 0 }]);
        }
      }
      expect(calls.filter((c) => c.endpoint === junk)).toHaveLength(3 * (N - 1));
      expect(store.pushFailureDates(pushSubId(junk))).toHaveLength(N - 1);
      expect(await store.getPushSub(pushSubId(junk))).not.toBeNull();
      expect(await remindAll(store, { send, now: day(N - 1) })).toMatchObject({ removed: 1 });
    });

    it("送信の期限切れは数えず、数え直しもしない", async () => {
      const target = fcm("a1");
      let hang = true;
      const send: SendPush = (sub) =>
        sub.endpoint !== target
          ? Promise.resolve()
          : hang
            ? new Promise(() => {})
            : Promise.reject(notFound());
      // 期限切れだけなら何日続いても消さない
      const store = await setup();
      for (let d = 0; d < N + 2; d++) {
        const res = await remindAll(store, { send, now: day(d), sendDeadlineMs: 5 });
        expect([d, res]).toEqual([
          d,
          result({ targets: 3, sent: 2, removed: 0, failed: 1, truncated: false, failures: { deadline: 1 } }),
        ]);
      }
      expect(store.pushFailureDates(pushSubId(target))).toEqual([]);
      expect(await store.getPushSub(pushSubId(target))).not.toBeNull();
      // 失敗の間に期限切れの日があっても、記録は消えない（3・4 日目は期限切れ）
      const other = await setup();
      for (const [d, h] of [
        [0, false],
        [1, false],
        [2, false],
        [3, true],
        [4, false],
      ] as const) {
        hang = h;
        await remindAll(other, { send, now: day(d), sendDeadlineMs: 5 });
      }
      expect(other.pushFailureDates(pushSubId(target))).toHaveLength(N - 1);
      hang = false;
      expect(await remindAll(other, { send, now: day(5), sendDeadlineMs: 5 })).toMatchObject({ removed: 1 });
    });

    it("時間の上限で送らなかった購読は数えない", async () => {
      const store = new MemoryStore();
      const endpoints = [fcm("t0"), fcm("t1"), fcm("t2"), fcm("t3")];
      for (const [i, e] of endpoints.entries()) {
        await subscribePush(store, { playerId: player(i), subscription: subscription(e) }, T0 - DAY);
      }
      // MemoryStore は id の順に読む。2 番目は毎日送れる購読（送れた購読が無い回は数えないため）
      const [first, healthy, second, third] = endpoints.map(pushSubId).sort();
      // 1 件 1 秒かかり、時間の上限で 1 回に 2 件だけ送る
      let fakeNow = 0;
      const send: SendPush = async (sub) => {
        fakeNow += 1000;
        if (pushSubId(sub.endpoint) !== healthy) throw notFound();
      };
      const deps = { send, clock: () => fakeNow, concurrency: 1, budgetMs: 2500, sendDeadlineMs: 1000 };
      for (let d = 0; d < N + 2; d++) {
        const res = await remindAll(store, { ...deps, now: day(d) });
        expect([d, res]).toMatchObject([d, { targets: 2, sent: 1, truncated: true }]);
      }
      // 先頭は 5 日で消え、次は消えたあとの 2 日だけ数え、最後は一度も送っていないので数えない
      expect(await store.getPushSub(first)).toBeNull();
      expect(store.pushFailureDates(second)).toHaveLength(2);
      expect(store.pushFailureDates(third)).toEqual([]);
      expect(await store.getPushSub(third)).not.toBeNull();
    });

    it("一時的なこともある失敗（名前解決・タイムアウト・接続先の拒否・400・403・500・502・504 など）は、5 日続いたら消す", async () => {
      const store = new MemoryStore();
      const errors: [unknown, FailureKind][] = [
        [{ code: "ENOTFOUND" }, "dns"],
        [{ code: "EAI_AGAIN" }, "dns"],
        [{ code: "EAI_FAIL" }, "dns"],
        [{ code: "ETIMEDOUT" }, "timeout"],
        [new Error("Socket timeout"), "timeout"],
        [{ code: "ERR_PUSH_BLOCKED_ADDRESS" }, "blocked"],
        [{ statusCode: 400 }, "http4xx"],
        [{ statusCode: 403 }, "http4xx"],
        [{ statusCode: 413 }, "http4xx"],
        [{ statusCode: 500 }, "http5xx"],
        [{ statusCode: 502 }, "http5xx"],
        [{ statusCode: 504 }, "http5xx"],
        [{ statusCode: 301 }, "other"],
        [{ code: "ECONNRESET" }, "other"],
        [{ code: "ECONNREFUSED" }, "other"],
        [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "other"],
        [new Error("socket hang up"), "other"],
        ["not an object", "other"],
      ];
      const byEndpoint = new Map<string, unknown>();
      const expected: Partial<Record<FailureKind, number>> = {};
      for (const [i, [err, kind]] of errors.entries()) {
        byEndpoint.set(fcm(`k${i}`), err);
        expected[kind] = (expected[kind] ?? 0) + 1;
        await subscribePush(
          store,
          { playerId: player(i), subscription: subscription(fcm(`k${i}`)) },
          T0 - DAY,
        );
      }
      await addHealthy(store);
      const { send } = recorder((sub) => byEndpoint.get(sub.endpoint));
      const n = errors.length;
      for (let d = 0; d < N - 1; d++) {
        expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
          d,
          result({ targets: n + 1, sent: 1, removed: 0, failed: n, truncated: false, failures: expected }),
        ]);
        expect(await store.countPushSubs()).toBe(n + 1);
      }
      expect(await remindAll(store, { send, now: day(N - 1) })).toEqual(
        result({ targets: n + 1, sent: 1, removed: n, failed: 0, truncated: false }),
      );
      expect(await store.countPushSubs()).toBe(1);
      for (const i of errors.keys()) expect(await store.playerPushSubs(player(i))).toEqual([]);
    });

    it("回の途中から送信を絞られても（429）負荷で断られても（503）、失敗の日は数えず、同じサービスに送れた回が何日続いても消さない", async () => {
      // 正規の購読 50 件。各回の最初の 10 件だけ送れ、残りは断られる（毎回同じ後半の 40 件が失敗する）
      const cases = [
        ["FCM・429", fcm, 429, "http4xx"],
        ["Apple・503", apple, 503, "http5xx"],
      ] as const;
      for (const [label, endpointOf, statusCode, kind] of cases) {
        const store = new MemoryStore();
        const endpoints = Array.from({ length: 50 }, (_, i) => endpointOf(`t${i}`));
        for (const [i, e] of endpoints.entries()) {
          await subscribePush(store, { playerId: player(i), subscription: subscription(e) }, T0 - DAY);
        }
        const addPushFailure = vi.spyOn(store, "addPushFailure");
        let calls = 0;
        let refused = new Set<string>();
        const send: SendPush = async (sub) => {
          if (calls++ < 10) return;
          refused.add(sub.endpoint);
          throw Object.assign(new Error("Received unexpected response code"), { statusCode });
        };
        let firstRefused: Set<string> | undefined;
        for (let d = 0; d < N + 1; d++) {
          calls = 0;
          refused = new Set();
          expect([label, d, await remindAll(store, { send, now: day(d) })]).toEqual([
            label,
            d,
            result({
              targets: 50,
              sent: 10,
              removed: 0,
              failed: 40,
              truncated: false,
              failures: { [kind]: 40 },
            }),
          ]);
          firstRefused ??= refused;
          expect([label, d, refused]).toEqual([label, d, firstRefused]);
        }
        expect([label, await store.countPushSubs()]).toEqual([label, 50]);
        expect([label, addPushFailure.mock.calls.length]).toEqual([label, 0]);
        for (const e of endpoints) {
          expect([label, store.pushFailureDates(pushSubId(e))]).toEqual([label, []]);
        }
      }
    });

    it("429・503 は送信済みの印を外し、同じ日の再実行で送り直す", async () => {
      const store = await setup();
      const status: Record<string, number> = { [fcm("a1")]: 429, [fcm("a2")]: 503 };
      const first = recorder((sub) => (status[sub.endpoint] ? { statusCode: status[sub.endpoint] } : null));
      expect(await remindAll(store, { send: first.send, now: T0 })).toEqual(
        result({
          targets: 3,
          sent: 1,
          removed: 0,
          failed: 2,
          truncated: false,
          failures: { http4xx: 1, http5xx: 1 },
        }),
      );
      for (const e of [fcm("a1"), fcm("a2")]) expect(store.pushFailureDates(pushSubId(e))).toEqual([]);
      const retry = recorder();
      expect(await remindAll(store, { send: retry.send, now: T0 + 60_000 })).toEqual(
        result({ targets: 2, sent: 2, removed: 0, failed: 0, truncated: false }),
      );
      expect(retry.calls.map((c) => c.endpoint).sort()).toEqual([fcm("a1"), fcm("a2")]);
    });

    it("保存済みの endpoint が今の検査を通らなければ、送らずに失敗として数え、5 日続いたら消す", async () => {
      const store = new MemoryStore();
      for (const [i, endpoint] of SSRF_POCS.entries()) await putRaw(store, endpoint, player(i));
      await addHealthy(store);
      const n = SSRF_POCS.length;
      const { calls, send } = recorder();
      for (let d = 0; d < N - 1; d++) {
        expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
          d,
          result({
            targets: n + 1,
            sent: 1,
            removed: 0,
            failed: n,
            truncated: false,
            failures: { invalid: n },
          }),
        ]);
        // 印は外さないので、同じ日の再実行では対象にならない
        expect(await remindAll(store, { send, now: day(d) + 60_000 })).toMatchObject({ targets: 0 });
      }
      expect(await store.countPushSubs()).toBe(n + 1);
      expect(await remindAll(store, { send, now: day(N - 1) })).toEqual(
        result({ targets: n + 1, sent: 1, removed: n, failed: 0, truncated: false }),
      );
      // 検査を通らない購読へは一度も送らない
      expect(calls.map((c) => c.endpoint)).toEqual(Array(N).fill(HEALTHY));
      expect(await store.countPushSubs()).toBe(1);
      for (const i of SSRF_POCS.keys()) expect(await store.playerPushSubs(player(i))).toEqual([]);
    });

    it("登録し直し・解除して登録し直し・別のプレイヤーへの移動では、失敗の日数は戻らない", async () => {
      // ゴミの購読を作った者は auth を知っているので、これらを毎日できる。戻せると上限を埋め続けられる
      const store = new MemoryStore();
      const endpoint = fcm("junk");
      const id = pushSubId(endpoint);
      const device = subscription(endpoint);
      await subscribePush(store, { playerId: ALICE, subscription: device }, T0 - DAY);
      await addHealthy(store);
      const { send } = recorder((sub) => (sub.endpoint === endpoint ? notFound() : null));
      const owners = [ALICE, BOB];
      for (let d = 0; d < N - 1; d++) {
        await remindAll(store, { send, now: day(d) });
        const [owner, next] = [owners[d % 2], owners[(d + 1) % 2]];
        await subscribePush(store, { playerId: owner, subscription: device }, day(d) + 1);
        await unsubscribePush(store, { playerId: owner, endpoint });
        await subscribePush(store, { playerId: owner, subscription: device }, day(d) + 2);
        const moved = { endpoint, keys: { p256dh: p256dh(), auth: device.keys.auth } };
        await subscribePush(store, { playerId: next, subscription: moved }, day(d) + 3);
        expect((await store.getPushSub(id))?.playerId).toBe(next);
      }
      expect(store.pushFailureDates(id)).toHaveLength(N - 1);
      expect(await remindAll(store, { send, now: day(N - 1) })).toMatchObject({ removed: 1 });
      expect(await store.getPushSub(id)).toBeNull();
      expect(await store.countPushSubs()).toBe(1);
    });

    it("他人の購読の失敗の記録は、登録・解除の API からは変わらない", async () => {
      const store = new MemoryStore();
      const victim = fcm("victim");
      const id = pushSubId(victim);
      await subscribePush(store, { playerId: ALICE, subscription: subscription(victim) }, T0 - DAY);
      await addHealthy(store);
      let down = true;
      const { send } = recorder((sub) => (down && sub.endpoint === victim ? { statusCode: 500 } : null));
      await remindAll(store, { send, now: day(0) });
      const before = store.pushFailureDates(id);
      expect(before).toHaveLength(1);
      // 他人が同じ endpoint を別の鍵で登録しようとする（409）・解除しようとする（何もしない）
      for (let k = 0; k < 10; k++) {
        await expectStatus(
          subscribePush(store, { playerId: BOB, subscription: subscription(victim) }, day(0) + k),
          409,
        );
        await unsubscribePush(store, { playerId: BOB, endpoint: victim });
      }
      expect(store.pushFailureDates(id)).toEqual(before);
      down = false;
      for (let d = 1; d < 2 * N; d++) await remindAll(store, { send, now: day(d) });
      expect(store.pushFailureDates(id)).toEqual([]);
      expect(await store.getPushSub(id)).not.toBeNull();
    });

    it("失敗の無い日（送る対象でない日）が 2 日続いても数え続け、3 日続いたら数え直す", async () => {
      const store = new MemoryStore();
      const endpoints = { [ALICE]: fcm("alice"), [BOB]: fcm("bob") };
      for (const [p, e] of Object.entries(endpoints)) {
        await subscribePush(store, { playerId: p, subscription: subscription(e) }, T0 - DAY);
      }
      await addHealthy(store);
      const { send } = recorder((sub) => (sub.endpoint === HEALTHY ? null : notFound()));
      // 今日の一問をクリアした日は送らない（成功でも失敗でもない）
      const skip: Record<string, number[]> = { [ALICE]: [2, 3], [BOB]: [4, 5, 6] };
      const removedOn: Record<string, number> = {};
      for (let d = 0; d < 12; d++) {
        for (const p of [ALICE, BOB]) {
          if (!skip[p].includes(d)) continue;
          const date = jstDateKey(new Date(day(d)));
          await store.addHistory(p, { date, difficulty: "easy", points: 1, timeMs: 1 });
        }
        await remindAll(store, { send, now: day(d) });
        for (const [p, e] of Object.entries(endpoints)) {
          if (removedOn[p] === undefined && !(await store.getPushSub(pushSubId(e)))) removedOn[p] = d;
        }
      }
      // アリス：0・1・4・5・6 日目で 5 日。ボブ：0〜3 日目のあと 3 日空いたので、7〜11 日目で 5 日
      expect(removedOn).toEqual({ [ALICE]: 6, [BOB]: 11 });
    });

    describe("送れた購読が 1 件も無い回（設定の誤りや障害の疑い）", () => {
      const dateOf = (d: number) => jstDateKey(new Date(day(d)));

      it("失敗の日を数えないので、何日続いても購読を消さない", async () => {
        // VAPID の鍵や連絡先の誤り（401・403）・プッシュサービスの障害（5xx）・ネットワークの断・名前解決の失敗・
        // DNS64 で全アドレスが内部と判定される・設定の読み込みの誤り
        const systemic: [unknown, FailureKind][] = [
          [{ statusCode: 401 }, "http4xx"],
          [{ statusCode: 403 }, "http4xx"],
          [{ statusCode: 500 }, "http5xx"],
          [{ code: "ECONNRESET" }, "other"],
          [{ code: "ENOTFOUND" }, "dns"],
          [{ code: "ERR_PUSH_BLOCKED_ADDRESS" }, "blocked"],
          [new Error("Socket timeout"), "timeout"],
          [new Error("Vapid private key should be 32 bytes long when decoded."), "other"],
        ];
        for (const [err, kind] of systemic) {
          const store = await setup();
          // 検査を通らない購読も、送れた購読が無い回は数えない（検査を誤って厳しくしたときも消さない）
          const invalid = await putRaw(store, SSRF_POCS[0], player(7));
          const ids = [fcm("a1"), fcm("a2"), fcm("b1")].map(pushSubId);
          const { calls, send } = recorder(() => err);
          for (let d = 0; d < 2 * N; d++) {
            expect([kind, d, await remindAll(store, { send, now: day(d) })]).toEqual([
              kind,
              d,
              result({
                targets: 4,
                sent: 0,
                removed: 0,
                failed: 4,
                truncated: false,
                failures: { [kind]: 3, invalid: 1 },
              }),
            ]);
          }
          expect([kind, calls.length]).toEqual([kind, 3 * 2 * N]);
          expect([kind, await store.countPushSubs()]).toEqual([kind, 4]);
          for (const id of [...ids, invalid]) {
            expect([kind, store.pushFailureDates(id)]).toEqual([kind, []]);
          }
        }
      });

      it("送れた購読が 1 件でもあれば、その回の失敗は数え、5 日続いたら消す（成功が最後に送った 1 件でも）", async () => {
        const store = new MemoryStore();
        const endpoints = [fcm("o0"), fcm("o1"), fcm("o2"), fcm("o3")];
        for (const [i, e] of endpoints.entries()) {
          await subscribePush(store, { playerId: player(i), subscription: subscription(e) }, T0 - DAY);
        }
        // 1 件ずつ id の順に送り、送れるのは最後の 1 件だけ（失敗はすべて、成功より先に起きる）
        const ids = endpoints.map(pushSubId).sort();
        const healthy = ids[ids.length - 1];
        const failing = ids.slice(0, -1);
        const { send } = recorder((sub) =>
          pushSubId(sub.endpoint) === healthy ? null : { statusCode: 403 },
        );
        for (let d = 0; d < N - 1; d++) {
          expect([d, await remindAll(store, { send, now: day(d), concurrency: 1 })]).toEqual([
            d,
            result({
              targets: 4,
              sent: 1,
              removed: 0,
              failed: 3,
              truncated: false,
              failures: { http4xx: 3 },
            }),
          ]);
          for (const id of failing) expect(store.pushFailureDates(id)).toHaveLength(d + 1);
        }
        expect(await remindAll(store, { send, now: day(N - 1), concurrency: 1 })).toEqual(
          result({ targets: 4, sent: 1, removed: 3, failed: 0, truncated: false }),
        );
        for (const id of failing) expect(await store.getPushSub(id)).toBeNull();
        expect(await store.getPushSub(healthy)).not.toBeNull();
        expect(store.pushFailureDates(healthy)).toEqual([]);
      });

      it("そのあと送れた回があれば、失敗の日数は戻らずに続きから数える", async () => {
        const store = await setup();
        const junk = fcm("a1");
        const junkId = pushSubId(junk);
        let outage = false;
        const { send } = recorder((sub) =>
          outage ? { statusCode: 403 } : sub.endpoint === junk ? notFound() : null,
        );
        // 0・1 日目と 4〜6 日目はジャンクだけが失敗し、2・3 日目は全件が失敗する（鍵の誤りなど）
        const outageDays = [2, 3];
        for (let d = 0; d < 6; d++) {
          outage = outageDays.includes(d);
          expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
            d,
            outage
              ? result({
                  targets: 3,
                  sent: 0,
                  removed: 0,
                  failed: 3,
                  truncated: false,
                  failures: { http4xx: 3 },
                })
              : result({
                  targets: 3,
                  sent: 2,
                  removed: 0,
                  failed: 1,
                  truncated: false,
                  failures: { dns: 1 },
                }),
          ]);
          // 全件が失敗した日は数えず、それまでの日数も消さない
          const counted = [0, 1, 4, 5].filter((c) => c <= d).map(dateOf);
          expect([d, store.pushFailureDates(junkId)]).toEqual([d, counted]);
          // 送れている購読は、全件が失敗した日も数えない
          for (const e of [fcm("a2"), fcm("b1")]) {
            expect([d, store.pushFailureDates(pushSubId(e))]).toEqual([d, []]);
          }
        }
        outage = false;
        expect(await remindAll(store, { send, now: day(6) })).toEqual(
          result({ targets: 3, sent: 2, removed: 1, failed: 0, truncated: false }),
        );
        expect(await store.getPushSub(junkId)).toBeNull();
        expect(await store.countPushSubs()).toBe(2);
      });

      it("時間の上限で打ち切った回も、送れた購読があれば、集めた失敗を回の最後に数える", async () => {
        const store = new MemoryStore();
        const endpoints = [fcm("u0"), fcm("u1"), fcm("u2")];
        for (const [i, e] of endpoints.entries()) {
          await subscribePush(store, { playerId: player(i), subscription: subscription(e) }, T0 - DAY);
        }
        // MemoryStore は id の順に読む。失敗する購読を、送れる購読より先に送る
        const [failing, healthy, unsent] = endpoints.map(pushSubId).sort();
        let fakeNow = 0;
        let down = true;
        const send: SendPush = async (sub) => {
          fakeNow += 1000;
          if (down || pushSubId(sub.endpoint) !== healthy) throw notFound();
        };
        // 1 件 1 秒かかり、1 回に 2 件だけ送る
        const deps = { send, clock: () => fakeNow, concurrency: 1, budgetMs: 2500, sendDeadlineMs: 1000 };
        // 打ち切った回で全件が失敗したら数えない
        expect(await remindAll(store, { ...deps, now: day(0) })).toEqual(
          result({ targets: 2, sent: 0, removed: 0, failed: 2, truncated: true, failures: { dns: 2 } }),
        );
        for (const id of [failing, healthy, unsent]) expect(store.pushFailureDates(id)).toEqual([]);
        down = false;
        for (let d = 1; d < N; d++) {
          expect([d, await remindAll(store, { ...deps, now: day(d) })]).toEqual([
            d,
            result({ targets: 2, sent: 1, removed: 0, failed: 1, truncated: true, failures: { dns: 1 } }),
          ]);
          expect([d, store.pushFailureDates(failing)]).toEqual([
            d,
            Array.from({ length: d }, (_, i) => dateOf(i + 1)),
          ]);
        }
        expect(await remindAll(store, { ...deps, now: day(N) })).toEqual(
          result({ targets: 2, sent: 1, removed: 1, failed: 0, truncated: true }),
        );
        expect(await store.getPushSub(failing)).toBeNull();
        expect(store.pushFailureDates(unsent)).toEqual([]);
        expect(await store.getPushSub(unsent)).not.toBeNull();
      });

      it("404・410・鍵の誤りの購読は、送れた購読が 1 件も無い回でもその場で消す", async () => {
        const store = new MemoryStore();
        const errors: [unknown, boolean][] = [
          [{ statusCode: 404 }, true],
          [{ statusCode: 410 }, true],
          [{ code: "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", message: "Public key is not valid" }, true],
          [{ statusCode: 403 }, false],
          [{ code: "ENOTFOUND" }, false],
        ];
        const byEndpoint = new Map<string, unknown>();
        for (const [i, [err]] of errors.entries()) {
          byEndpoint.set(fcm(`g${i}`), err);
          await subscribePush(store, { playerId: player(i), subscription: subscription(fcm(`g${i}`)) }, T0);
        }
        const { send } = recorder((sub) => byEndpoint.get(sub.endpoint));
        expect(await remindAll(store, { send, now: T0 })).toEqual(
          result({
            targets: 5,
            sent: 0,
            removed: 3,
            failed: 2,
            truncated: false,
            failures: { http4xx: 1, dns: 1 },
          }),
        );
        for (const [i, [, gone]] of errors.entries()) {
          const id = pushSubId(fcm(`g${i}`));
          expect([i, (await store.getPushSub(id)) === null]).toEqual([i, gone]);
          expect([i, await store.playerPushSubs(player(i))]).toEqual([i, gone ? [] : [id]]);
          expect([i, store.pushFailureDates(id)]).toEqual([i, []]);
        }
      });

      it("数えるのを回の最後にしても、件数の振り分けと関係（targets = sent + removed + failed）は変わらない", async () => {
        const store = new MemoryStore();
        await addHealthy(store);
        const junk = fcm("junk");
        await subscribePush(store, { playerId: player(1), subscription: subscription(junk) }, T0 - DAY);
        const gone = fcm("gone");
        const hung = fcm("hung");
        const flaky = fcm("flaky");
        const send: SendPush = (sub) =>
          sub.endpoint === junk
            ? Promise.reject(notFound())
            : sub.endpoint === gone
              ? Promise.reject({ statusCode: 410 })
              : sub.endpoint === hung
                ? new Promise(() => {})
                : sub.endpoint === flaky
                  ? Promise.reject({ statusCode: 500 })
                  : Promise.resolve();
        for (let d = 0; d < N - 1; d++) {
          expect([d, await remindAll(store, { send, now: day(d), sendDeadlineMs: 5 })]).toEqual([
            d,
            result({ targets: 2, sent: 1, removed: 0, failed: 1, truncated: false, failures: { dns: 1 } }),
          ]);
        }
        // 5 日目：ジャンクは 5 日目で消え、410 はその場で消え、期限切れ・検査を通らないもの・5xx は残る
        for (const [i, e] of [gone, hung, flaky].entries()) {
          await subscribePush(store, { playerId: player(2 + i), subscription: subscription(e) }, day(N - 1));
        }
        const invalid = await putRaw(store, SSRF_POCS[0], player(5));
        expect(await remindAll(store, { send, now: day(N - 1), sendDeadlineMs: 5 })).toEqual(
          result({
            targets: 6,
            sent: 1,
            removed: 2,
            failed: 3,
            truncated: false,
            failures: { deadline: 1, invalid: 1, http5xx: 1 },
          }),
        );
        expect(await store.getPushSub(pushSubId(junk))).toBeNull();
        expect(await store.getPushSub(pushSubId(gone))).toBeNull();
        expect(store.pushFailureDates(pushSubId(flaky))).toEqual([dateOf(N - 1)]);
        expect(store.pushFailureDates(invalid)).toEqual([dateOf(N - 1)]);
        expect(store.pushFailureDates(pushSubId(hung))).toEqual([]);
      });

      it("購読を読む保存先のエラーで回が途中で終わったら、集めた失敗は数えない", async () => {
        class BrokenScan extends MemoryStore {
          scans = 0;
          async scanPushSubs(cursor: string, count: number) {
            // 1 ページ目は続きがあるように返し、2 ページ目で失敗する
            if (++this.scans > 1) throw new Error("command was: sscan sdk:push:subs");
            return { ...(await super.scanPushSubs(cursor, count)), cursor: "more" };
          }
        }
        const store = new BrokenScan();
        await addHealthy(store);
        const junk = fcm("junk");
        await subscribePush(store, { playerId: ALICE, subscription: subscription(junk) }, T0 - DAY);
        const { calls, send } = recorder((sub) => (sub.endpoint === junk ? notFound() : null));
        await expect(sendReminders(store, { send, now: T0 })).rejects.toThrow("sscan");
        // 送れた購読はあったが、回が終わっていないので数えない
        expect(calls.map((c) => c.endpoint).sort()).toEqual([HEALTHY, junk].sort());
        expect(store.pushFailureDates(pushSubId(junk))).toEqual([]);
        expect(await store.getPushSub(pushSubId(junk))).not.toBeNull();
      });
    });

    describe("失敗の日を数えるのに必要な成功（プッシュサービスごと）", () => {
      const register = (store: RankingStore, endpoint: string, playerId: string) =>
        subscribePush(store, { playerId, subscription: subscription(endpoint) }, T0 - DAY);
      /** 同じサービスに成功が無ければ数えない種類（dns・invalid 以外） */
      const PER_SERVICE: [unknown, FailureKind][] = [
        [{ statusCode: 500 }, "http5xx"],
        [{ statusCode: 502 }, "http5xx"],
        [{ statusCode: 504 }, "http5xx"],
        [{ statusCode: 400 }, "http4xx"],
        [{ statusCode: 403 }, "http4xx"],
        [{ code: "ETIMEDOUT" }, "timeout"],
        [{ code: "ERR_PUSH_BLOCKED_ADDRESS" }, "blocked"],
        [{ code: "ECONNRESET" }, "other"],
      ];
      const tally = (errors: [unknown, FailureKind][]) => {
        const out: Partial<Record<FailureKind, number>> = {};
        for (const [, kind] of errors) out[kind] = (out[kind] ?? 0) + 1;
        return out;
      };

      it("(a) Apple だけが毎日失敗し（500・403・タイムアウトなど）、FCM には送れる回では、Apple の失敗を数えず何日続いても消さない", async () => {
        const store = new MemoryStore();
        const byEndpoint = new Map<string, unknown>();
        for (const [i, [err]] of PER_SERVICE.entries()) {
          byEndpoint.set(apple(i), err);
          await register(store, apple(i), player(i));
        }
        await addHealthy(store);
        const { send } = recorder((sub) => byEndpoint.get(sub.endpoint));
        const n = PER_SERVICE.length;
        for (let d = 0; d < 2 * N; d++) {
          expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
            d,
            result({
              targets: n + 1,
              sent: 1,
              removed: 0,
              failed: n,
              truncated: false,
              failures: tally(PER_SERVICE),
            }),
          ]);
        }
        for (const i of PER_SERVICE.keys()) {
          expect([i, store.pushFailureDates(pushSubId(apple(i)))]).toEqual([i, []]);
          expect([i, await store.getPushSub(pushSubId(apple(i)))]).not.toEqual([i, null]);
        }
      });

      it("(b) 同じ回に Apple へ 1 件でも送れていれば、Apple の失敗は数え、5 日続いたら消す", async () => {
        const store = new MemoryStore();
        const byEndpoint = new Map<string, unknown>();
        for (const [i, [err]] of PER_SERVICE.entries()) {
          byEndpoint.set(apple(i), err);
          await register(store, apple(i), player(i));
        }
        await register(store, apple("ok"), player(90));
        await addHealthy(store);
        const { send } = recorder((sub) => byEndpoint.get(sub.endpoint));
        const n = PER_SERVICE.length;
        for (let d = 0; d < N - 1; d++) {
          expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
            d,
            result({
              targets: n + 2,
              sent: 2,
              removed: 0,
              failed: n,
              truncated: false,
              failures: tally(PER_SERVICE),
            }),
          ]);
          for (const i of PER_SERVICE.keys()) {
            expect([d, i, store.pushFailureDates(pushSubId(apple(i)))]).toEqual([
              d,
              i,
              Array.from({ length: d + 1 }, (_, k) => jstDateKey(new Date(day(k)))),
            ]);
          }
        }
        expect(await remindAll(store, { send, now: day(N - 1) })).toEqual(
          result({ targets: n + 2, sent: 2, removed: n, failed: 0, truncated: false }),
        );
        for (const i of PER_SERVICE.keys()) expect(await store.getPushSub(pushSubId(apple(i)))).toBeNull();
        expect(await store.countPushSubs()).toBe(2);
      });

      it("(c) 利用者のいないサービス（Windows）の配下のゴミも、名前解決の失敗（dns）なら他のサービスの成功だけで数え、5 日で消す", async () => {
        const store = new MemoryStore();
        const junk = [
          "https://junk0.notify.windows.com/w/?token=x",
          "https://junk1.notify.windows.com/w/?token=x",
          "https://junk2.push.apple.com/x",
        ];
        const errors = [{ code: "ENOTFOUND" }, { code: "EAI_AGAIN" }, { code: "ENOTFOUND" }];
        for (const [i, e] of junk.entries()) await register(store, e, player(i));
        // 送れるのは Mozilla だけ（Windows にも Apple にも送れた購読は無い）
        await register(store, mozilla("ok"), player(9));
        const { send } = recorder((sub) => errors[junk.indexOf(sub.endpoint)] ?? null);
        for (let d = 0; d < N - 1; d++) {
          expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
            d,
            result({ targets: 4, sent: 1, removed: 0, failed: 3, truncated: false, failures: { dns: 3 } }),
          ]);
        }
        expect(await remindAll(store, { send, now: day(N - 1) })).toEqual(
          result({ targets: 4, sent: 1, removed: 3, failed: 0, truncated: false }),
        );
        for (const e of junk) expect(await store.getPushSub(pushSubId(e))).toBeNull();
      });

      it("(c') 既知の限界：dns は回全体で数えるので、Apple の正規のホストだけの名前解決の失敗が 5 日続くと、FCM に送れていれば Apple の購読は消える", async () => {
        const store = new MemoryStore();
        await register(store, apple(1), ALICE);
        await addHealthy(store);
        const { send } = recorder((sub) => (sub.endpoint === apple(1) ? { code: "EAI_AGAIN" } : null));
        for (let d = 0; d < N - 1; d++) await remindAll(store, { send, now: day(d) });
        expect(await remindAll(store, { send, now: day(N - 1) })).toMatchObject({ removed: 1 });
        expect(await store.getPushSub(pushSubId(apple(1)))).toBeNull();
      });

      it("(d) 既知の限界：利用者のいないサービス（Windows）の配下のゴミが 403 などを返すだけなら、そのサービスに送れた購読が無い限り数えない", async () => {
        const store = new MemoryStore();
        const junk = windows("junk");
        await register(store, junk, ALICE);
        await addHealthy(store);
        const { send } = recorder((sub) => (sub.endpoint === junk ? { statusCode: 403 } : null));
        for (let d = 0; d < 2 * N; d++) {
          expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
            d,
            result({
              targets: 2,
              sent: 1,
              removed: 0,
              failed: 1,
              truncated: false,
              failures: { http4xx: 1 },
            }),
          ]);
        }
        expect(store.pushFailureDates(pushSubId(junk))).toEqual([]);
        expect(await store.getPushSub(pushSubId(junk))).not.toBeNull();
        // Windows に送れる購読が現れれば、その日から数えて 5 日で消す
        await register(store, windows("ok"), BOB);
        for (let d = 2 * N; d < 3 * N - 1; d++) {
          expect([d, await remindAll(store, { send, now: day(d) })]).toMatchObject([d, { removed: 0 }]);
        }
        expect(await remindAll(store, { send, now: day(3 * N - 1) })).toMatchObject({ removed: 1 });
        expect(await store.getPushSub(pushSubId(junk))).toBeNull();
      });

      it("(e) 今の検査を通らない保存済みの購読（invalid）は、どのサービスでも 1 件送れていれば数え、5 日で消す", async () => {
        const store = new MemoryStore();
        // Apple・Windows の形のホストと、正規化前の FCM の形。送れるのは Mozilla だけ
        const stored = [SSRF_POCS[0], SSRF_POCS[2], "https://FCM.googleapis.com:443/fcm/send/x"];
        const ids: string[] = [];
        for (const [i, endpoint] of stored.entries()) ids.push(await putRaw(store, endpoint, player(i)));
        await register(store, mozilla("ok"), player(9));
        const { calls, send } = recorder();
        for (let d = 0; d < N - 1; d++) {
          expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
            d,
            result({
              targets: 4,
              sent: 1,
              removed: 0,
              failed: 3,
              truncated: false,
              failures: { invalid: 3 },
            }),
          ]);
        }
        expect(await remindAll(store, { send, now: day(N - 1) })).toEqual(
          result({ targets: 4, sent: 1, removed: 3, failed: 0, truncated: false }),
        );
        for (const id of ids) expect(await store.getPushSub(id)).toBeNull();
        expect(calls.map((c) => c.endpoint)).toEqual(Array(N).fill(mozilla("ok")));
      });

      it("(f) 名前解決が全体で失敗した回（どのサービスにも送れない）は、dns も invalid も数えない", async () => {
        const store = new MemoryStore();
        const endpoints = [apple(1), windows(1), mozilla(1), fcm(1)];
        for (const [i, e] of endpoints.entries()) await register(store, e, player(i));
        const invalid = await putRaw(store, SSRF_POCS[0], player(8));
        const { send } = recorder((sub) => ({ code: sub.endpoint === fcm(1) ? "EAI_AGAIN" : "ENOTFOUND" }));
        for (let d = 0; d < 2 * N; d++) {
          expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
            d,
            result({
              targets: 5,
              sent: 0,
              removed: 0,
              failed: 5,
              truncated: false,
              failures: { dns: 4, invalid: 1 },
            }),
          ]);
        }
        for (const id of [...endpoints.map(pushSubId), invalid]) {
          expect(store.pushFailureDates(id)).toEqual([]);
          expect(await store.getPushSub(id)).not.toBeNull();
        }
      });

      it("(g) 同じ回に Apple へ送れていても、Apple の 429・503 は失敗に数えるだけで失敗の日は数えず、400・403・5xx などは数える", async () => {
        const store = new MemoryStore();
        const THROTTLED: [unknown, FailureKind][] = [
          [{ statusCode: 429 }, "http4xx"],
          [{ statusCode: 503 }, "http5xx"],
        ];
        const byEndpoint = new Map<string, unknown>();
        for (const [i, [err]] of PER_SERVICE.entries()) {
          byEndpoint.set(apple(`c${i}`), err);
          await register(store, apple(`c${i}`), player(i));
        }
        for (const [i, [err]] of THROTTLED.entries()) {
          byEndpoint.set(apple(`t${i}`), err);
          await register(store, apple(`t${i}`), player(50 + i));
        }
        await register(store, apple("ok"), player(90));
        const { send } = recorder((sub) => byEndpoint.get(sub.endpoint));
        const n = PER_SERVICE.length;
        const m = THROTTLED.length;
        for (let d = 0; d < N - 1; d++) {
          expect([d, await remindAll(store, { send, now: day(d) })]).toEqual([
            d,
            result({
              targets: n + m + 1,
              sent: 1,
              removed: 0,
              failed: n + m,
              truncated: false,
              failures: tally([...PER_SERVICE, ...THROTTLED]),
            }),
          ]);
        }
        expect(await remindAll(store, { send, now: day(N - 1) })).toEqual(
          result({
            targets: n + m + 1,
            sent: 1,
            removed: n,
            failed: m,
            truncated: false,
            failures: tally(THROTTLED),
          }),
        );
        for (const i of PER_SERVICE.keys()) {
          expect([i, await store.getPushSub(pushSubId(apple(`c${i}`)))]).toEqual([i, null]);
        }
        for (const i of THROTTLED.keys()) {
          expect([i, store.pushFailureDates(pushSubId(apple(`t${i}`)))]).toEqual([i, []]);
          expect([i, await store.getPushSub(pushSubId(apple(`t${i}`)))]).not.toEqual([i, null]);
        }
      });

      it("(h) サービスごとに数えても、件数の振り分けと関係（targets = sent + removed + failed、failures の合計 = failed）は変わらない", async () => {
        const store = new MemoryStore();
        await addHealthy(store);
        const plan: Record<string, unknown> = {
          [fcm("flaky")]: { statusCode: 500 }, // FCM には送れているので数える
          [apple("down")]: { statusCode: 500 }, // Apple には送れていないので数えない
          [windows("junk")]: { code: "ENOTFOUND" }, // 回全体で数える
          [mozilla("gone")]: { statusCode: 410 }, // その場で消す
          [apple("hung")]: "hang", // 期限切れは数えない
        };
        for (const [i, e] of Object.keys(plan).entries()) await register(store, e, player(i));
        const invalid = await putRaw(store, SSRF_POCS[1], player(8));
        const send: SendPush = (sub) => {
          const err = plan[sub.endpoint];
          if (err === "hang") return new Promise(() => {});
          return err ? Promise.reject(err) : Promise.resolve();
        };
        expect(await remindAll(store, { send, now: day(0), sendDeadlineMs: 5 })).toEqual(
          result({
            targets: 7,
            sent: 1,
            removed: 1,
            failed: 5,
            truncated: false,
            failures: { http5xx: 2, dns: 1, deadline: 1, invalid: 1 },
          }),
        );
        for (let d = 1; d < N - 1; d++) {
          expect([d, await remindAll(store, { send, now: day(d), sendDeadlineMs: 5 })]).toEqual([
            d,
            result({
              targets: 6,
              sent: 1,
              removed: 0,
              failed: 5,
              truncated: false,
              failures: { http5xx: 2, dns: 1, deadline: 1, invalid: 1 },
            }),
          ]);
        }
        expect(await remindAll(store, { send, now: day(N - 1), sendDeadlineMs: 5 })).toEqual(
          result({
            targets: 6,
            sent: 1,
            removed: 3,
            failed: 2,
            truncated: false,
            failures: { http5xx: 1, deadline: 1 },
          }),
        );
        for (const e of [fcm("flaky"), windows("junk"), mozilla("gone")]) {
          expect(await store.getPushSub(pushSubId(e))).toBeNull();
        }
        expect(await store.getPushSub(invalid)).toBeNull();
        expect(store.pushFailureDates(pushSubId(apple("down")))).toEqual([]);
        expect(store.pushFailureDates(pushSubId(apple("hung")))).toEqual([]);
        expect(await store.countPushSubs()).toBe(3);
      });
    });
  });

  it("通知の期限は日本時間の 0 時まで、最長 6 時間", () => {
    expect(reminderTtl(Date.parse("2026-10-15T11:00:00Z"))).toBe(4 * 3600); // 20:00
    expect(reminderTtl(Date.parse("2026-10-15T11:59:30Z"))).toBe(3 * 3600 + 30); // 20:59:30
    expect(reminderTtl(Date.parse("2026-10-15T14:59:59Z"))).toBe(1); // 23:59:59
    expect(reminderTtl(Date.parse("2026-10-15T03:00:00Z"))).toBe(6 * 3600); // 12:00
  });
});

describe("web-push での送信（https.request を差し替え、実際には送らない）", () => {
  const vapid = webpush.generateVAPIDKeys();
  const config = requirePushConfig({
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: "mailto:test@example.com",
    CRON_SECRET: "x",
  });

  function interceptHttps() {
    const calls: https.RequestOptions[] = [];
    vi.spyOn(https, "request").mockImplementation(((
      options: https.RequestOptions,
      callback: (res: EventEmitter) => void,
    ) => {
      calls.push(options);
      const req = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => {
          const res = Object.assign(new EventEmitter(), { statusCode: 201, headers: {} });
          callback(res);
          res.emit("end");
        },
      });
      return req;
    }) as unknown as typeof https.request);
    return calls;
  }

  it("内部のアドレスを拒む agent を web-push が https.request に渡す", async () => {
    const store = new MemoryStore();
    await subscribePush(store, { playerId: ALICE, subscription: subscription(fcm("agent")) }, T0);
    const calls = interceptHttps();
    const res = await remindAll(store, { send: webPushSender(config), now: T0 });
    expect(res).toEqual(result({ targets: 1, sent: 1, removed: 0, failed: 0, truncated: false }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      hostname: "fcm.googleapis.com",
      port: null,
      path: "/fcm/send/devagent:APA91bH-x_y",
    });
    const agent = calls[0].agent;
    expect(agent).toBeInstanceOf(https.Agent);
    const lookup = (agent as https.Agent).options.lookup!;
    const err = await new Promise((resolve) => lookup("169.254.169.254", { all: true }, resolve));
    expect(err).toMatchObject({ code: "ERR_PUSH_BLOCKED_ADDRESS" });
  });

  it("修正前に保存された SSRF の例へは https.request を呼ばない", async () => {
    const store = new MemoryStore();
    for (const [i, endpoint] of SSRF_POCS.entries()) {
      await store.putPushSub(
        pushSubId(endpoint),
        { endpoint, ...keys(), playerId: player(i), createdAt: T0 },
        T0,
      );
    }
    const calls = interceptHttps();
    const res = await remindAll(store, { send: webPushSender(config), now: T0 });
    expect(calls).toEqual([]);
    expect(res).toEqual(
      result({
        targets: SSRF_POCS.length,
        sent: 0,
        removed: 0,
        failed: SSRF_POCS.length,
        truncated: false,
        failures: { invalid: SSRF_POCS.length },
      }),
    );
  });

  it("保存済みの p256dh が曲線上の点でなければ、送らずに購読を消す", async () => {
    const store = new MemoryStore();
    const id = pushSubId(fcm("bad"));
    await store.putPushSub(
      id,
      { endpoint: fcm("bad"), p256dh: OFF_CURVE, auth: auth(), playerId: ALICE, createdAt: T0 },
      T0,
    );
    const calls = interceptHttps();
    const res = await remindAll(store, { send: webPushSender(config), now: T0 });
    expect(calls).toEqual([]);
    expect(res).toEqual(result({ targets: 1, sent: 0, removed: 1, failed: 0, truncated: false }));
    expect(await store.getPushSub(id)).toBeNull();
    expect(await store.playerPushSubs(ALICE)).toEqual([]);
  });
});

describe("接続先のアドレスの検査", () => {
  type Result = { err: NodeJS.ErrnoException | null; address: unknown; family: unknown };
  const run = (lookup: LookupFunction, all: boolean) =>
    new Promise<Result>((resolve) =>
      lookup("push.example", { all }, (err, address, family) => resolve({ err, address, family })),
    );
  const fixed =
    (addresses: dns.LookupAddress[]) =>
    (_host: string, _options: dns.LookupAllOptions, cb: (e: null, a: dns.LookupAddress[]) => void) =>
      cb(null, addresses);

  it("プライベート・ループバック・リンクローカル・ユニークローカル・未指定・メタデータなどを内部と判定する", () => {
    const blocked = [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "169.254.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::127.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::ffff:10.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "fc00::1",
      "fd00:ec2::254",
      "fe80::1",
      "ff02::1",
      "not-an-ip",
      "",
    ];
    const allowed = [
      "142.250.196.106",
      "17.57.144.10",
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "::ffff:8.8.8.8",
      "2607:f8b0:4004:c1b::5f",
      "2a01:111:f100:3000::a83e:1b0e",
    ];
    for (const a of blocked) expect([a, isBlockedAddress(a)]).toEqual([a, true]);
    for (const a of allowed) expect([a, isBlockedAddress(a)]).toEqual([a, false]);
  });

  it("文書用・6to4 のリレー・Teredo・サイトローカル・IETF の予約（::/8）も内部と判定する", () => {
    const blocked = [
      "192.0.2.1", // TEST-NET-1
      "198.51.100.7", // TEST-NET-2
      "203.0.113.255", // TEST-NET-3
      "192.88.99.1", // 6to4 のリレー
      "2001:db8::1",
      "2001:DB8:FFFF::1",
      "fec0::1",
      "feff::1",
      "2001::1", // Teredo
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "::",
      "0:0:0:0:0:0:0:0",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::8.8.8.8", // IPv4 互換（廃止）は埋め込みを見ずに拒む
      "64:ff9b:1::808:808", // NAT64 のローカル用（埋め込む位置が決まらない）
      "64:ff9b:1:abcd:0:8:808:800",
      "64:ff9b:2::1",
      "ff::1", // ::/8 の中（00ff::）
      "fe80::1%eth0", // ゾーン ID 付き（BlockList はゾーン ID 付きの公開アドレスを内部と判定しないので、先に拒む）
      "2607:f8b0:4004:c1b::5f%eth0",
    ];
    const allowed = [
      "192.0.3.1",
      "192.88.98.1",
      "198.51.101.1",
      "203.0.114.1",
      "2001:4860:4860::8888", // Teredo（2001:0::/32）の外
      "2001:dB9::1",
      "2002:808:808::1", // 6to4 の 8.8.8.8
      "2600::1",
    ];
    for (const a of blocked) expect([a, isBlockedAddress(a)]).toEqual([a, true]);
    for (const a of allowed) expect([a, isBlockedAddress(a)]).toEqual([a, false]);
  });

  it("IPv4 を埋め込む IPv6 は、埋め込まれた IPv4 で判定する（公開なら通し、内部なら拒む。表記は問わない）", () => {
    // [IPv4, それを埋め込んだ IPv6 の表記]
    const forms = (v4: string) => {
      const [a, b, c, d] = v4.split(".").map(Number);
      const hi = ((a << 8) | b).toString(16);
      const lo = ((c << 8) | d).toString(16);
      return [
        // IPv4 射影
        `::ffff:${v4}`,
        `::ffff:${hi}:${lo}`,
        `0:0:0:0:0:FFFF:${hi.toUpperCase()}:${lo.toUpperCase()}`,
        // IPv4 変換
        `::ffff:0:${v4}`,
        `::ffff:0:${hi}:${lo}`,
        `0:0:0:0:ffff:0:${v4}`,
        // NAT64 の既定のプレフィックス
        `64:ff9b::${v4}`,
        `64:ff9b::${hi}:${lo}`,
        `0064:FF9B:0000:0000:0000:0000:${hi}:${lo}`,
        // 6to4（埋め込むのは末尾ではなく 16 ビット目から）
        `2002:${hi}:${lo}::1`,
        `2002:${hi}:${lo}:1:2:3:4:5`,
      ];
    };
    const publicV4 = ["8.8.8.8", "17.57.144.10", "142.250.196.106", "172.32.0.1", "100.128.0.1"];
    const privateV4 = [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "192.0.2.1",
      "192.88.99.1",
      "224.0.0.1",
      "255.255.255.255",
    ];
    for (const v4 of publicV4) {
      expect([v4, isBlockedAddress(v4)]).toEqual([v4, false]);
      for (const a of forms(v4)) expect([a, isBlockedAddress(a)]).toEqual([a, false]);
    }
    for (const v4 of privateV4) {
      expect([v4, isBlockedAddress(v4)]).toEqual([v4, true]);
      for (const a of forms(v4)) expect([a, isBlockedAddress(a)]).toEqual([a, true]);
    }
    // 埋め込む形に似ているが違うもの：プレフィックスの途中に 0 でない語があれば、IPv6 の規則で判定する
    expect(isBlockedAddress("64:ff9b:0:0:0:1:808:808")).toBe(true); // ::/8 の中
    expect(isBlockedAddress("2003::a00:1")).toBe(false); // 6to4 ではない公開のアドレス
  });

  it("名前解決の結果から内部のアドレスを除いて返し、残らなければ接続させない（all の有無どちらの形でも）", async () => {
    const pub4 = { address: "142.250.196.106", family: 4 };
    const pub6 = { address: "2607:f8b0:4004:c1b::5f", family: 6 };
    const nat64 = { address: "64:ff9b::8efa:c46a", family: 6 }; // 142.250.196.106
    const priv4 = { address: "10.0.0.1", family: 4 };
    const priv6 = { address: "fd00::1", family: 6 };
    const privNat64 = { address: "64:ff9b::a9fe:a9fe", family: 6 }; // 169.254.169.254
    const mapped = { address: "::ffff:127.0.0.1", family: 6 };
    expect(await run(createGuardedLookup(fixed([pub4, pub6])), true)).toEqual({
      err: null,
      address: [pub4, pub6],
      family: undefined,
    });
    expect(await run(createGuardedLookup(fixed([pub6, pub4])), false)).toEqual({
      err: null,
      address: pub6.address,
      family: 6,
    });
    // 混ざっていれば、内部のアドレスだけを除き、順序は保つ
    const mixed: [dns.LookupAddress[], dns.LookupAddress[]][] = [
      [
        [priv4, pub4, priv6, pub6],
        [pub4, pub6],
      ],
      [[privNat64, nat64, mapped], [nat64]],
      [[pub6, priv4], [pub6]],
    ];
    for (const [addresses, expected] of mixed) {
      expect(await run(createGuardedLookup(fixed(addresses)), true)).toEqual({
        err: null,
        address: expected,
        family: undefined,
      });
      expect(await run(createGuardedLookup(fixed(addresses)), false)).toEqual({
        err: null,
        address: expected[0].address,
        family: expected[0].family,
      });
    }
    // 内部のアドレスだけ・空なら接続させない
    const bad = [[priv4], [mapped], [priv4, priv6, privNat64, mapped], []];
    for (const addresses of bad) {
      for (const all of [true, false]) {
        const { err } = await run(createGuardedLookup(fixed(addresses)), all);
        expect([addresses, all, err?.code]).toEqual([addresses, all, "ERR_PUSH_BLOCKED_ADDRESS"]);
      }
    }
    // 名前解決の失敗はそのまま返す
    const notFound = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    const failing = createGuardedLookup((_host, _options, cb) => cb(notFound, []));
    expect((await run(failing, true)).err).toBe(notFound);
  });

  it("除いたアドレスは、どの並びでも all の有無どちらの形でも返らない", async () => {
    const internal = [
      "10.0.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:192.168.0.1",
      "64:ff9b::7f00:1",
      "2002:a00:1::1",
      "2001::1",
    ];
    const external = ["8.8.8.8", "2607:f8b0:4004:c1b::5f", "64:ff9b::808:808", "2002:808:808::1"];
    const pool = [...internal, ...external].map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
    const rand = seeded(42);
    let mixed = 0;
    for (let i = 0; i < 300; i++) {
      const addresses = pool.filter(() => rand() < 0.5).sort(() => rand() - 0.5);
      const expected = addresses.filter((a) => external.includes(a.address));
      const many = await run(createGuardedLookup(fixed(addresses)), true);
      const one = await run(createGuardedLookup(fixed(addresses)), false);
      if (expected.length === 0) {
        expect([many.err?.code, one.err?.code]).toEqual([
          "ERR_PUSH_BLOCKED_ADDRESS",
          "ERR_PUSH_BLOCKED_ADDRESS",
        ]);
        continue;
      }
      if (expected.length < addresses.length) mixed++;
      expect([addresses, many.address]).toEqual([addresses, expected]);
      expect([addresses, one.address]).toEqual([addresses, expected[0].address]);
    }
    expect(mixed).toBeGreaterThan(100);
  });

  it("既定の名前解決でも IP アドレスのループバック・メタデータを拒む", async () => {
    const lookup = createGuardedLookup();
    for (const host of ["127.0.0.1", "::1", "169.254.169.254"]) {
      const err = await new Promise((resolve) => lookup(host, { all: true }, resolve));
      expect([host, err]).toMatchObject([host, { code: "ERR_PUSH_BLOCKED_ADDRESS" }]);
    }
  });

  it("https の接続はこの名前解決を通り、内部のアドレスならソケットを開く前に失敗する", async () => {
    const resolved: string[] = [];
    const agent = new https.Agent({
      lookup: createGuardedLookup((host, _options, cb) => {
        resolved.push(host);
        cb(null, [{ address: "169.254.169.254", family: 4 }]);
      }),
    });
    // 名前解決がこの関数を通らなければ、手元の localhost:9 へ繋ごうとして別のエラーになる（外へは出ない）
    const err = await new Promise((resolve) => {
      const req = https.request({ hostname: "localhost", port: 9, path: "/", method: "POST", agent }, () =>
        resolve(null),
      );
      req.on("error", resolve);
      req.end();
    });
    agent.destroy();
    expect(err).toMatchObject({ code: "ERR_PUSH_BLOCKED_ADDRESS" });
    expect(resolved).toEqual(["localhost"]);
  });
});
