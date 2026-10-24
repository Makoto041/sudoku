import { createECDH, createHash, timingSafeEqual } from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { parse as legacyParse } from "node:url";
import webpush from "web-push";
import { jstDateKey } from "@/lib/sudoku/generator";
import { ipRateName, ipv6Words } from "./ip";
import { RankingError, assertPlayerId } from "./ranking";
import type { PushSub, RankingStore } from "./store";

export const PUSH_MAX_BODY_BYTES = 4096;
const PUSH_ENDPOINT_MAX = 2048;
export const PUSH_MAX_PER_PLAYER = 5;
export const PUSH_MAX_TOTAL = 20_000;
/**
 * cron 1 回の送信の同時実行数と時間の上限。関数の上限は 60 秒（cron の route の maxDuration）。
 * 残りが SEND_DEADLINE_MS より短くなったら新しい送信を始めないので、送信は 35 秒までに終わる。
 * 残りの約 25 秒は、回の最後に失敗の日を数えて消す処理（sendReminders の settle。時間の上限の外で動く）にあてる
 */
const REMIND_CONCURRENCY = 20;
const REMIND_BUDGET_MS = 35_000;
/** 1 件の送信の期限。web-push の timeout（SEND_TIMEOUT_MS）は無通信の時間だけなので、全体の期限を別に付ける */
const SEND_DEADLINE_MS = 12_000;
const SEND_TIMEOUT_MS = 10_000;
const REMIND_TTL_SEC = 6 * 60 * 60;
const SCAN_COUNT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 通知の中身（JSON にして送る）。端末の Service Worker がこれを表示する */
export const REMINDER = { title: "ナンプレ", body: "今日の一問はまだです" };

// 送信先として受け付けるプッシュサービス。各社の資料で確かめたものだけ
// - push.apple.com: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
// - notify.windows.com: https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview
// - updates.push.services.mozilla.com: https://mozilla-services.github.io/autopush-rs/
// - fcm.googleapis.com: https://developer.chrome.com/blog/web-push-interop-wins
/** ホスト名が完全に一致するものだけ */
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"];
/** このドメインとサブドメイン（`.` 区切りで末尾が一致するもの） */
const PUSH_DOMAINS = ["push.apple.com", "notify.windows.com"];

function isPushHost(host: string): boolean {
  return PUSH_HOSTS.includes(host) || PUSH_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** DNS のラベル：英小文字・数字・ハイフンで 63 文字まで。先頭と末尾はハイフン以外 */
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** ラベルを `.` でつないだホスト名か（空のラベル・末尾の `.`・記号は不可）。最後のラベルが数字だけのもの（IP アドレス）も除く */
function isLdhHostname(host: string): boolean {
  const labels = host.split(".");
  return (
    host.length <= 253 &&
    labels.every((label) => LDH_LABEL.test(label)) &&
    !/^[0-9]+$/.test(labels[labels.length - 1])
  );
}

/** web-push が使う url.parse で解釈し直しても、プロトコル・ホスト・ポート・ユーザー情報・パスが同じか */
function sameAsLegacyParse(url: URL): boolean {
  let legacy: ReturnType<typeof legacyParse>;
  try {
    legacy = legacyParse(url.href);
  } catch {
    return false;
  }
  return (
    legacy.protocol === url.protocol &&
    legacy.hostname === url.hostname &&
    legacy.host === url.host &&
    (legacy.port ?? "") === url.port &&
    (legacy.auth ?? "") === "" &&
    legacy.path === url.pathname + url.search
  );
}

/**
 * 購読の endpoint を検査し、正規化した URL を返す（受け付けなければ null）。サーバーがこの URL へ送信するので、
 * 許可したプッシュサービスの https だけを受け付ける（SSRF 対策）。登録・解除・cron の送信前の検査はすべてこれを通す。
 * web-push は WHATWG の URL ではなく古い url.parse で解釈し直して送る。ホスト名に `;` や `'` などがあると両者が
 * 食い違い、許可リストを回避できる（`https://evil.example;.push.apple.com/` は url.parse では evil.example）。
 * そこで次の順に確かめる：
 * 1. 文字種（\・空白・制御文字・非 ASCII などの解釈が分かれる文字を最初に弾く）
 * 2. WHATWG で解釈して、https・ポートなし・ユーザー情報なし・長さ
 * 3. ホスト名が英小文字・数字・ハイフンのラベルだけ（%XX で書いた記号は 2 で戻されるので、ここで弾く）
 * 4. 許可リスト
 * 5. url.parse の解釈との一致（web-push が実際に繋ぐ先と送るパスが、検査した URL と同じか）
 */
function normalizeEndpoint(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > PUSH_ENDPOINT_MAX ||
    !/^[A-Za-z0-9\-._~:/?@!$&'()*+,;=%]+$/.test(value)
  ) {
    return null;
  }
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
    url.href.length <= PUSH_ENDPOINT_MAX &&
    isLdhHostname(url.hostname) &&
    isPushHost(url.hostname) &&
    sameAsLegacyParse(url);
  return ok ? url.href : null;
}

export function assertEndpoint(value: unknown): string {
  const endpoint = normalizeEndpoint(value);
  if (endpoint === null) throw new RankingError(400, "invalid endpoint");
  return endpoint;
}

/** 許可したプッシュサービスの系統（許可リストの 4 つに対応する）。分類できないものは other */
export type PushService = "apple" | "windows" | "mozilla" | "fcm" | "other";

/**
 * 購読の endpoint のプッシュサービス。normalizeEndpoint が通した正規化済みの endpoint だけをホストで分け、
 * 通らないもの（偽装したホスト・正規化前の形・保存後に検査を通らなくなったもの）は other にする。
 * 許可リスト（PUSH_HOSTS・PUSH_DOMAINS）にホストを足したら、ここにも足す
 */
export function pushService(endpoint: string): PushService {
  if (normalizeEndpoint(endpoint) !== endpoint) return "other";
  const host = new URL(endpoint).hostname;
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (under("push.apple.com")) return "apple";
  if (under("notify.windows.com")) return "windows";
  if (host === "updates.push.services.mozilla.com") return "mozilla";
  if (host === "fcm.googleapis.com") return "fcm";
  return "other";
}

/** base64url の鍵を検査してバイト列を返す。往復して同じ文字列に戻るものだけ（別の文字や 3 つ以上の = は戻らない） */
function assertKey(value: unknown, bytes: number): Buffer {
  if (typeof value !== "string") throw new RankingError(400, "invalid keys");
  const buf = Buffer.from(value, "base64url");
  if (buf.length !== bytes || buf.toString("base64url") !== value.replace(/={0,2}$/, "")) {
    throw new RankingError(400, "invalid keys");
  }
  return buf;
}

/** P-256 の曲線上の点か。web-push の暗号化と同じ ECDH の計算で確かめる（曲線上に無い点は例外になる） */
function isP256Point(key: Buffer): boolean {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(key);
    return true;
  } catch {
    return false;
  }
}

type SubscribeInput = { playerId?: unknown; subscription?: unknown };

export function parseSubscription(input: SubscribeInput) {
  const playerId = assertPlayerId(input.playerId);
  const s = input.subscription;
  if (!s || typeof s !== "object") throw new RankingError(400, "invalid subscription");
  const { endpoint, keys } = s as { endpoint?: unknown; keys?: unknown };
  const k = (keys ?? {}) as { p256dh?: unknown; auth?: unknown };
  // p256dh は P-256 の曲線上の点を未圧縮で表したもの（0x04 で始まる 65 バイト）、auth は 16 バイト
  const p256dh = assertKey(k.p256dh, 65);
  if (p256dh[0] !== 0x04 || !isP256Point(p256dh)) throw new RankingError(400, "invalid keys");
  const auth = assertKey(k.auth, 16);
  return {
    playerId,
    endpoint: assertEndpoint(endpoint),
    p256dh: p256dh.toString("base64url"),
    auth: auth.toString("base64url"),
  };
}

export function pushSubId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

type PushConfig = { publicKey: string; privateKey: string; subject: string; cronSecret: string };

/** 通知の設定。1 つでも無ければ購読 API も cron も 503 */
export function requirePushConfig(env: Record<string, string | undefined> = process.env): PushConfig {
  const config = {
    publicKey: env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
    privateKey: env.VAPID_PRIVATE_KEY ?? "",
    subject: env.VAPID_SUBJECT ?? "",
    cronSecret: env.CRON_SECRET ?? "",
  };
  const ok =
    config.publicKey &&
    config.privateKey &&
    config.cronSecret &&
    /^(mailto:|https:\/\/)/.test(config.subject);
  if (!ok) throw new RankingError(503, "push unavailable");
  return config;
}

/** base64url の auth を定数時間で比べる */
function sameAuth(stored: string, given: string): boolean {
  const a = Buffer.from(stored, "base64url");
  const b = Buffer.from(given, "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 新規登録（保存済みの購読が無い endpoint の登録）の回数制限。固定窓で数え、超えたら 429。
 * 1 人 PUSH_MAX_PER_PLAYER 件の上限とは別に、使い捨ての登録を繰り返して全体の上限を埋めるのを遅らせる
 */
export const PUSH_RATE_LIMITS = {
  /** 登録元の IP ごと */
  ip: { limit: 20, windowSec: 60 * 60 },
  /** プレイヤーごと */
  player: { limit: 10, windowSec: 24 * 60 * 60 },
} as const;

/** 新規登録を 1 回数え、上限を超えたら 429。IP を先に数え、IP で超えたらプレイヤーの分は数えない */
async function limitNewSubscription(store: RankingStore, ip: string | null, playerId: string, now: number) {
  const { ip: byIp, player: byPlayer } = PUSH_RATE_LIMITS;
  if ((await store.incrRateWindow(ipRateName(ip), byIp.windowSec, now)) > byIp.limit) {
    throw new RankingError(429, "rate limited");
  }
  if ((await store.incrRateWindow(`player:${playerId}`, byPlayer.windowSec, now)) > byPlayer.limit) {
    throw new RankingError(429, "rate limited");
  }
}

/**
 * 購読を登録する。同じ endpoint なら上書きして期限を延ばす（同じプレイヤーなら鍵の更新も受け付ける）。
 * 別のプレイヤーの購読を移すのは、auth（端末と購読の持ち主だけが知る 16 バイト）が一致するとき
 * （引き継ぎで同じ端末のプレイヤーが変わったとき）だけ。endpoint を知っているだけでは他人の購読を奪えない。
 * client を渡すと（購読 API は必ず渡す）、新規登録の回数を PUSH_RATE_LIMITS で制限する。数えるのは、
 * 形式の検査（400）・他人の購読との衝突（409）・全体の上限（503）を通ったあと、保存する直前の新規登録だけ
 * （検査で弾く要求で保存先を余計に叩かず、正規の端末の誤った要求で枠を使わない）。
 * 既存の購読の更新・別のプレイヤーへの移動は、アプリを開くたびに行われるので数えない
 */
export async function subscribePush(
  store: RankingStore,
  input: SubscribeInput,
  now = Date.now(),
  client?: { ip: string | null },
) {
  const { playerId, endpoint, p256dh, auth } = parseSubscription(input);
  const id = pushSubId(endpoint);
  const prev = await store.getPushSub(id);
  if (prev && prev.playerId !== playerId && !sameAuth(prev.auth, auth)) {
    throw new RankingError(409, "subscription conflict");
  }
  if (!prev && (await store.countPushSubs()) >= PUSH_MAX_TOTAL) {
    throw new RankingError(503, "too many subscriptions");
  }
  if (!prev && client) await limitNewSubscription(store, client.ip, playerId, now);
  // 引き継ぎで同じ端末のプレイヤーが変わったら、前のプレイヤーの一覧から外す
  if (prev && prev.playerId !== playerId) await store.removePushSub(id, prev.playerId);
  const createdAt = prev?.playerId === playerId ? prev.createdAt : now;
  await store.putPushSub(id, { endpoint, p256dh, auth, playerId, createdAt }, now);
  // 1 人あたりの上限を超えたら、更新の古いものから消す
  const ids = await store.playerPushSubs(playerId);
  for (const old of ids.slice(0, Math.max(0, ids.length - PUSH_MAX_PER_PLAYER))) {
    await store.removePushSub(old, playerId);
  }
  return { ok: true };
}

/** 購読を解除する。そのプレイヤーの購読だけを消し、無くても成功にする */
export async function unsubscribePush(
  store: RankingStore,
  input: { playerId?: unknown; endpoint?: unknown },
) {
  const playerId = assertPlayerId(input.playerId);
  const endpoint = assertEndpoint(input.endpoint);
  await store.removePushSub(pushSubId(endpoint), playerId);
  return { ok: true };
}

/** cron の Authorization ヘッダーを定数時間で照合する */
export function cronAuthorized(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** 送信先として繋がない IPv4 アドレス */
const BLOCKED_IPV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // この網・未指定
  ["10.0.0.0", 8], // プライベート
  ["100.64.0.0", 10], // キャリアグレード NAT
  ["127.0.0.0", 8], // ループバック
  ["169.254.0.0", 16], // リンクローカル（クラウドのメタデータ 169.254.169.254 を含む）
  ["172.16.0.0", 12], // プライベート
  ["192.0.0.0", 24], // IETF の予約
  ["192.0.2.0", 24], // 文書用（TEST-NET-1）
  ["192.88.99.0", 24], // 6to4 のリレー（廃止）
  ["192.168.0.0", 16], // プライベート
  ["198.18.0.0", 15], // ベンチマーク用
  ["198.51.100.0", 24], // 文書用（TEST-NET-2）
  ["203.0.113.0", 24], // 文書用（TEST-NET-3）
  ["224.0.0.0", 4], // マルチキャスト
  ["240.0.0.0", 4], // 予約・ブロードキャスト
] as const) {
  BLOCKED_IPV4.addSubnet(net, prefix, "ipv4");
}

/** 送信先として繋がない IPv6 アドレス（IPv4 を埋め込む形は、先に IPv4 として判定する） */
const BLOCKED_IPV6 = new BlockList();
for (const [net, prefix] of [
  // IETF の予約。未指定（::）・ループバック（::1）・IPv4 互換（::a.b.c.d）・NAT64 のローカル用（64:ff9b:1::/48）を含む。
  // ローカル用の NAT64 は、IPv4 を埋め込む位置が運用者の選ぶプレフィックス長で変わり（RFC 6052 の 2.2）、
  // アドレスだけでは取り出せないので丸ごと拒む
  ["::", 8],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // 文書用
  ["fc00::", 7], // ユニークローカル
  ["fec0::", 10], // サイトローカル（廃止）
  ["fe80::", 10], // リンクローカル
  ["ff00::", 8], // マルチキャスト
] as const) {
  BLOCKED_IPV6.addSubnet(net, prefix, "ipv6");
}

/**
 * IPv6 アドレスに埋め込まれた IPv4 アドレス。埋め込む形でなければ null
 * - ::ffff:0:0/96（IPv4 射影）・::ffff:0:0:0/96（IPv4 変換）・64:ff9b::/96（NAT64 の既定）：末尾の 32 ビット
 * - 2002::/16（6to4）：16 ビット目からの 32 ビット
 */
function embeddedIPv4(w: number[]): string | null {
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  const ipv4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const mapped = zero(0, 5) && w[5] === 0xffff;
  const translated = zero(0, 4) && w[4] === 0xffff && w[5] === 0;
  const nat64 = w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6);
  if (mapped || translated || nat64) return ipv4(w[6], w[7]);
  if (w[0] === 0x2002) return ipv4(w[1], w[2]);
  return null;
}

/**
 * 送信先として繋がないアドレスか。IPv4 を埋め込む IPv6 は、埋め込まれた IPv4 を IPv4 の規則で判定する
 * （公開のアドレスなら通し、内部のアドレスなら拒む）。読めないものは拒む
 */
export function isBlockedAddress(address: string): boolean {
  try {
    switch (isIP(address)) {
      case 4:
        return BLOCKED_IPV4.check(address, "ipv4");
      case 6: {
        const words = ipv6Words(address);
        if (!words) return true;
        const ipv4 = embeddedIPv4(words);
        return ipv4 === null ? BLOCKED_IPV6.check(address, "ipv6") : BLOCKED_IPV4.check(ipv4, "ipv4");
      }
      default:
        return true;
    }
  } catch {
    return true;
  }
}

type ResolveAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/**
 * 接続時の名前解決。結果から内部のアドレスを除いて返し、残らなければ接続せずにエラーにする（多層防御。
 * 許可リストのホストでも、DNS の応答で内部へ向けられないようにする）。接続先はここで返したアドレスに限られるので、
 * 除いたアドレスへは繋がない。Node 22 の net は all: true で呼ぶので、両方の形で返す
 */
export function createGuardedLookup(resolve: ResolveAll = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const allowed = addresses.filter((a) => !isBlockedAddress(a.address));
      if (allowed.length === 0) {
        const blocked: NodeJS.ErrnoException = new Error("blocked address");
        blocked.code = "ERR_PUSH_BLOCKED_ADDRESS";
        return callback(blocked, []);
      }
      if (options.all) callback(null, allowed);
      else callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

const pushAgent = new https.Agent({ keepAlive: true, lookup: createGuardedLookup() });

/** 送信。失敗したら statusCode を持つエラーで reject する（web-push の WebPushError と同じ） */
export type SendPush = (sub: PushSub, payload: string, ttlSec: number) => Promise<unknown>;

export function webPushSender(config: PushConfig): SendPush {
  const vapidDetails = {
    subject: config.subject,
    publicKey: config.publicKey,
    privateKey: config.privateKey,
  };
  return (sub, payload, ttlSec) =>
    webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      {
        vapidDetails,
        TTL: ttlSec,
        urgency: "normal",
        timeout: SEND_TIMEOUT_MS,
        agent: pushAgent,
      },
    );
}

/** 送信の期限切れ（こちらが待つのをやめたもの） */
class SendDeadlineError extends Error {}

/** 期限までに終わらなければ reject する。送信そのものは止められないので、期限のあとの結果は捨てる */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SendDeadlineError("send deadline exceeded")), ms);
  });
  // 期限のあとに失敗しても、処理されない reject にしない
  promise.catch(() => {});
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 送信の失敗が、購読がもう使えないことを示すか（すぐに消してよいか）。すぐに消すのは次の 2 つだけ：
 * - プッシュサービスの 404・410（購読が無い・期限切れ。RFC 8030 の 7.3）
 * - 状態コードが無く、code が ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY（購読の公開鍵 p256dh が P-256 の曲線上に無く、
 *   暗号化できない）。web-push は送るたびに自分側の鍵を作り直し、VAPID の署名は ECDH を使わないので、
 *   この例外は購読の鍵からしか起きず、同じ購読では何度送っても失敗する（残すと全体の上限を埋め続ける）
 * ネットワークの失敗（ECONNRESET・ETIMEDOUT など）・タイムアウト・接続先の拒否・設定の誤り・ほかの状態コードは、
 * 一時的なこともあるので 1 回では消さず、PUSH_FAIL_DAYS_TO_REMOVE 日続いたら消す
 * （同じプッシュサービスに送れた購読が無い回の失敗と、429・503 は数えない。sendReminders・isThrottled を参照）
 */
function isGone(err: unknown): boolean {
  const { statusCode, code } = (err ?? {}) as { statusCode?: unknown; code?: unknown };
  if (statusCode === 404 || statusCode === 410) return true;
  return statusCode === undefined && code === "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY";
}

/**
 * プッシュサービスに送信を絞られた（429）か、負荷で断られた（503）か。RFC 8030 では 429 はこちらが送信の上限を
 * 超えた印で、どちらも購読の故障ではない。回の途中から返り始めると、同じ回にそのサービスへ送れた購読があっても
 * 毎回同じ後半の購読が失敗するので、送信の期限切れと同じく失敗の日として数えない（件数は failed と failures に入れる）
 */
function isThrottled(err: unknown): boolean {
  const { statusCode } = (err ?? {}) as { statusCode?: unknown };
  return statusCode === 429 || statusCode === 503;
}

/** cron の応答に出す失敗の種類。エラーの中身（endpoint・応答の本文・code の文字列）は出さず、この語に写す */
export const FAILURE_KINDS = [
  "blocked", // 接続先が内部のアドレスだけだった
  "dns", // 名前解決の失敗
  "timeout", // 接続・通信のタイムアウト
  "deadline", // 送信の期限切れ（こちらが待つのをやめた）
  "http4xx", // プッシュサービスの 4xx（404・410 を除く）
  "http5xx", // プッシュサービスの 5xx
  "invalid", // 保存済みの endpoint が今の検査を通らない（送らなかった）
  "other", // そのほか（接続の切断・設定の誤り・保存先のエラーなど）
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

function failureKind(err: unknown): FailureKind {
  if (err instanceof SendDeadlineError) return "deadline";
  const { statusCode, code, message } = (err ?? {}) as {
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (typeof statusCode === "number") {
    if (statusCode >= 400 && statusCode < 500) return "http4xx";
    if (statusCode >= 500 && statusCode < 600) return "http5xx";
    return "other";
  }
  if (code === "ERR_PUSH_BLOCKED_ADDRESS") return "blocked";
  if (code === "ENOTFOUND" || (typeof code === "string" && code.startsWith("EAI_"))) return "dns";
  // web-push は無通信のタイムアウトを code の無い Error("Socket timeout") で返す
  if (code === "ETIMEDOUT" || (code === undefined && message === "Socket timeout")) return "timeout";
  return "other";
}

/** この日数続けて送れなかった購読は消す（1 日の失敗は一時的なこともあるので消さない） */
export const PUSH_FAIL_DAYS_TO_REMOVE = 5;

/** 通知の有効期限。日付が変わると中身が正しくなくなるので、日本時間の 0 時まで（最長 6 時間） */
export function reminderTtl(now: number): number {
  const untilMidnight = DAY_MS - ((now + JST_OFFSET_MS) % DAY_MS);
  return Math.min(REMIND_TTL_SEC, Math.floor(untilMidnight / 1000));
}

/**
 * cron の応答。件数は targets = sent + removed + failed、failures の合計 = failed になる。
 * removed は消した購読（404・410・鍵の誤り、PUSH_FAIL_DAYS_TO_REMOVE 日続いた失敗）、
 * failed は送れずに残した購読で、failures はその種類別の件数（すべての種類を 0 から数える）
 */
type RemindResult = {
  targets: number;
  sent: number;
  removed: number;
  failed: number;
  failures: Record<FailureKind, number>;
  truncated: boolean;
};

/** 1 件の結果 */
type Outcome = "sent" | "removed" | FailureKind;

/** 失敗の日として数える失敗。回の最後まで数えるのを待ち、件数にもまだ入れない */
const DEFERRED = "deferred";

/**
 * 回全体で 1 件でも送れていれば、失敗の日を数える失敗の種類。どちらも購読ごとに決まる強い印なので、
 * 正規の利用者がいないプッシュサービス（*.notify.windows.com など）の配下に作られた購読も数えて消せる
 * - dns：存在しないサブドメインなど（名前解決が全体で失敗したときは、送れた購読が 1 件も無いので数えない）
 * - invalid：保存済みの endpoint が今の検査を通らない
 * ほかの種類（http4xx・http5xx・timeout・blocked・other）は、同じプッシュサービスに送れた購読があるときだけ数える
 * （そのサービスだけの障害・VAPID の拒否などで、そのサービスの正規の購読を消さない）。deadline と 429・503 は数えない
 */
const COUNTED_ON_ANY_SUCCESS: readonly FailureKind[] = ["dns", "invalid"];

/**
 * 今日（日本時間）の今日の一問をまだ 1 問もクリアしていないプレイヤーの購読に通知を送る。
 * 送る前にその日の送信済みの印を付けるので、cron を再実行しても同じ購読には 1 日 1 回だけ送る
 * （送信が失敗したり期限を過ぎたりしたら印を外し、再実行で送り直せるようにする）。
 * 1 件の送信は sendDeadlineMs で打ち切り、残り時間がそれより短くなったら新しい送信を始めずに終える。
 * 残りは印が無いので、同じ日に再実行すれば続きから送る。
 * 送れなかった日は購読ごとに記録し、PUSH_FAIL_DAYS_TO_REMOVE 日続いたら購読を消す（送れた日に数え直す）。
 * 送信の期限切れと、時間の上限で送らなかった購読は、こちらの都合なので数えない。
 * 429・503（送信を絞られた・サービスの一時的な負荷）も購読の故障ではないので数えない（isThrottled を参照）。
 * 失敗の日は、その回に同じプッシュサービスへ送れた購読があるときだけ数える（dns・invalid は回全体で 1 件でよい。
 * COUNTED_ON_ANY_SUCCESS を参照）。VAPID の鍵や連絡先の誤り・鍵の入れ替え・プッシュサービスの障害・
 * ネットワークの断など、購読ではなくこちらや経路の誤りで失敗したときに、正規の購読を消さないため。
 * 成功があったかは回が終わるまで分からないので、失敗は集めておき、回の最後にまとめて数える
 * （時間の上限で打ち切った回も同じ）。404・410・鍵の誤りで消すのは、その場で行う。
 * 途中で例外が出て回が終わったとき（購読を読む保存先のエラー）は、集めた失敗を数えない（消す側に倒さない）
 */
export async function sendReminders(
  store: RankingStore,
  deps: {
    send: SendPush;
    now?: number;
    clock?: () => number;
    concurrency?: number;
    budgetMs?: number;
    sendDeadlineMs?: number;
  },
): Promise<RemindResult> {
  const {
    send,
    now = Date.now(),
    clock = Date.now,
    concurrency = REMIND_CONCURRENCY,
    budgetMs = REMIND_BUDGET_MS,
    sendDeadlineMs = SEND_DEADLINE_MS,
  } = deps;
  const startedAt = clock();
  const outOfTime = () => budgetMs - (clock() - startedAt) < sendDeadlineMs;
  const date = jstDateKey(new Date(now));
  const ttl = reminderTtl(now);
  const payload = JSON.stringify(REMINDER);
  const result: RemindResult = {
    targets: 0,
    sent: 0,
    removed: 0,
    failed: 0,
    failures: Object.fromEntries(FAILURE_KINDS.map((k) => [k, 0])) as Record<FailureKind, number>,
    truncated: false,
  };
  const cleared = new Map<string, Promise<boolean>>();
  /** 失敗の日として数える失敗。回の最後に数える */
  const deferred: { id: string; sub: PushSub; kind: FailureKind; service: PushService }[] = [];
  /** その回に送れた購読のあるプッシュサービス（result.sent に数えたものだけ） */
  const sentTo = new Set<PushService>();

  /** 送れなかった購読を、回の最後に数えるために集める。期限切れは数えないので、そのまま失敗にする */
  const fail = (
    id: string,
    sub: PushSub,
    kind: FailureKind,
    service: PushService,
  ): Outcome | typeof DEFERRED => {
    if (kind === "deadline") return kind;
    deferred.push({ id, sub, kind, service });
    return DEFERRED;
  };

  /**
   * 集めた失敗を数える。数えるのに必要な成功（COUNTED_ON_ANY_SUCCESS の種類は回全体、ほかは同じプッシュサービス）が
   * 無ければ数えず、失敗の種類のまま件数に入れる。数えるときは送れなかった日を記録し、続けて送れなかった日が上限に達したら消す
   */
  const settle = async ({ id, sub, kind, service }: (typeof deferred)[number]): Promise<Outcome> => {
    const counted = COUNTED_ON_ANY_SUCCESS.includes(kind) ? result.sent > 0 : sentTo.has(service);
    if (!counted) return kind;
    if ((await store.addPushFailure(id, date, now)) < PUSH_FAIL_DAYS_TO_REMOVE) return kind;
    await store.removePushSub(id, sub.playerId);
    return "removed";
  };

  /** 1 件を送る。送る対象でなければ null、失敗の日として数える失敗なら DEFERRED */
  const remind = async ({
    id,
    sub,
  }: {
    id: string;
    sub: PushSub;
  }): Promise<Outcome | typeof DEFERRED | null> => {
    let done = cleared.get(sub.playerId);
    if (!done) cleared.set(sub.playerId, (done = store.clearedOn(sub.playerId, date)));
    if (await done) return null;
    if (!(await store.markPushSent(date, id))) return null;
    // 保存済みの endpoint も、登録と同じ検査で確かめ直す（検査を厳しくする前に保存されたもの）。
    // すぐには消さずに失敗の日として数える（検査を誤って厳しくしても、消える前に気づいて戻せる）
    if (normalizeEndpoint(sub.endpoint) !== sub.endpoint) return fail(id, sub, "invalid", "other");
    const service = pushService(sub.endpoint);
    try {
      await withDeadline(send(sub, payload, ttl), sendDeadlineMs);
    } catch (err) {
      // エラーには endpoint や応答の本文が入っているので、状態コードと code の種類だけを見る
      if (isGone(err)) {
        await store.removePushSub(id, sub.playerId);
        return "removed";
      }
      await store.unmarkPushSent(date, id);
      // 429・503 は期限切れと同じく数えないので、そのまま失敗にする
      return isThrottled(err) ? failureKind(err) : fail(id, sub, failureKind(err), service);
    }
    try {
      await store.clearPushFailure(id);
    } catch {
      // 送れた事実を優先し、失敗の記録を消せなくても送れた購読として数える（sentTo にも入れる）
    }
    sentTo.add(service);
    return "sent";
  };

  /** 件数は 1 件につき 1 回だけ足す（保存先のエラーで二重に数えない） */
  const tally = (outcome: Outcome) => {
    result.targets++;
    if (outcome === "sent") result.sent++;
    else if (outcome === "removed") result.removed++;
    else {
      result.failed++;
      result.failures[outcome]++;
    }
  };

  let cursor = "0";
  do {
    if (outOfTime()) {
      result.truncated = true;
      break;
    }
    const page = await store.scanPushSubs(cursor, SCAN_COUNT);
    cursor = page.cursor;
    let next = 0;
    const worker = async () => {
      while (next < page.subs.length) {
        if (outOfTime()) {
          result.truncated = true;
          return;
        }
        const item = page.subs[next++];
        let outcome: Outcome | typeof DEFERRED | null;
        try {
          outcome = await remind(item);
        } catch {
          // 保存先のエラーなど
          outcome = "other";
        }
        if (outcome !== null && outcome !== DEFERRED) tally(outcome);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, page.subs.length) }, worker));
  } while (cursor !== "0" && !result.truncated);

  // 回の最後に、集めた失敗を数える（送信はすべて終わっているので、result.sent と sentTo はもう変わらない）
  let nextDeferred = 0;
  const settleWorker = async () => {
    while (nextDeferred < deferred.length) {
      const item = deferred[nextDeferred++];
      let outcome: Outcome;
      try {
        outcome = await settle(item);
      } catch {
        // 保存先のエラーなど
        outcome = "other";
      }
      tally(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, deferred.length) }, settleWorker));
  return result;
}
