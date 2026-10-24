import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeAttestationObject } from "@simplewebauthn/server/helpers";
import { combineStats, type Stats } from "@/lib/client/stats";
import { isPlainObject } from "@/lib/client/storage";
import type { AuthConfig } from "./auth-config";
import {
  AUTH_SESSION_TTL_SEC,
  type Account,
  type AuthSessionRecord,
  type AuthStore,
  type ChallengeRecord,
  type StoredCredential,
} from "./auth-store";
import { withinIpLimit } from "./ip";
import { MAX_STATS_BYTES, RankingError, assertPlayerId } from "./ranking";
import { historyField, type RankingStore } from "./store";

/** 本文の上限（パスキーの応答を受け取る検証 API） */
export const AUTH_VERIFY_MAX_BYTES = 16 * 1024;
/** 本文の上限（記録の同期） */
export const AUTH_STATS_MAX_BYTES = 8 * 1024;
/** 本文の上限（ほかの API） */
export const AUTH_MAX_BODY_BYTES = 1024;
/** challenge の有効期間 */
export const AUTH_CHALLENGE_TTL_SEC = 300;
/** 1 アカウントのセッションの上限。超えたら期限の近い（最後に使ったのが古い）ものから消す */
export const AUTH_MAX_SESSIONS = 20;
/** アカウント全体の上限。超えたら作成を 503 で断る */
export const AUTH_MAX_ACCOUNTS = 20_000;
/** 1 アカウントのパスキーの上限。達していたら追加を 409 で断る */
export const AUTH_MAX_PASSKEYS = 10;

/** 回数制限（固定窓）。超えたら 429 */
export const AUTH_RATE_LIMITS = {
  /** challenge の発行（options の API すべて）。IP ごと */
  chal: { limit: 60, windowSec: 60 * 60 },
  /** アカウントの作成（検証を通ったものだけ数える）。IP ごと */
  signup: { limit: 5, windowSec: 60 * 60 },
  /** 記録の同期。アカウントごと */
  stats: { limit: 120, windowSec: 60 * 60 },
  /** 履歴の取り込み。アカウントごと */
  merge: { limit: 20, windowSec: 24 * 60 * 60 },
} as const;

/**
 * 受け付ける公開鍵のアルゴリズム（EdDSA・ES256・RS256）。登録の options と登録の検証に渡す
 * （ログインの検証には渡す引数が無く、登録で確かめた公開鍵を使う）
 */
const SUPPORTED_ALGORITHM_IDS = [-8, -7, -257];
/** credential ID の上限（仕様の上限 1023 バイトに余裕を持たせた 1024 バイトの base64url の長さ） */
const CREDENTIAL_ID_MAX = 1366;
/**
 * attestationObject の上限（base64url の文字数）。受け付ける none の形は、authData（37 バイト・AAGUID 16 バイト・
 * 長さ 2 バイト・credential ID 最大 1023 バイト・公開鍵 最大 PUBLIC_KEY_MAX_BYTES・拡張）と CBOR の枠だけで、
 * credential ID と公開鍵が上限でも約 2.1KB（base64url で約 2.9KB）。実在のパスキーは数百バイト
 */
const ATTESTATION_OBJECT_MAX = 4096;
/** 保存する公開鍵（COSE）の上限。ES256 は約 77 バイト、RS256（2048 ビット）は約 272 バイト */
const PUBLIC_KEY_MAX_BYTES = 1024;
const TRANSPORTS = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"];
const MAX_TRANSPORTS = 8;
/** userHandle は accountId（UUID 36 文字）の base64url。余裕を見た上限 */
const USER_HANDLE_MAX = 128;
/** challenge とセッションのトークンは、どちらも 32 バイトの乱数の base64url */
const RANDOM_32 = /^[A-Za-z0-9_-]{43}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** パスキーに付ける名前。ランキングの名前が無いとき */
const DEFAULT_NAME = "プレイヤー";
/** 履歴の取り込みで、同時に書く件数 */
const MERGE_BATCH = 50;

/** WebAuthn の処理。テストで差し替えられるようにする */
export type WebAuthnVerifier = {
  registrationOptions: typeof generateRegistrationOptions;
  verifyRegistration: typeof verifyRegistrationResponse;
  authenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthentication: typeof verifyAuthenticationResponse;
};

export const simpleWebAuthn: WebAuthnVerifier = {
  registrationOptions: generateRegistrationOptions,
  verifyRegistration: verifyRegistrationResponse,
  authenticationOptions: generateAuthenticationOptions,
  verifyAuthentication: verifyAuthenticationResponse,
};

export type AuthDeps = {
  store: RankingStore;
  auth: AuthStore;
  config: AuthConfig;
  webauthn?: WebAuthnVerifier;
  now?: number;
  ip?: string | null;
};

/** 端末に返すアカウントの中身 */
export type AccountView = { playerId: string; name: string | null; passkeys: number; stats: Stats | null };

/** Cookie のトークンから引いたセッション。hash はトークンの SHA-256 */
export type SessionRef = { hash: string; accountId: string; record: AuthSessionRecord };

const invalidResponse = () => new RankingError(400, "invalid response");

/** パディングなしの base64url で、1〜max 文字か */
function b64url(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || !B64URL.test(value)) throw invalidResponse();
  return value;
}

/** 認証器の接続方法。既知の値だけを残す（重複は 1 つに） */
function parseTransports(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TRANSPORTS) throw invalidResponse();
  return [...new Set(value.filter((t): t is string => typeof t === "string" && TRANSPORTS.includes(t)))];
}

/**
 * ブラウザから届いたパスキーの応答を検査し、検証に使う項目だけで組み直す。
 * id と rawId は同じ base64url（ライブラリも確かめるが、保存先のキーに使う前に長さと文字を確かめる）
 */
function parseCredentialResponse(value: unknown, kind: "create"): RegistrationResponseJSON;
function parseCredentialResponse(value: unknown, kind: "get"): AuthenticationResponseJSON;
function parseCredentialResponse(
  value: unknown,
  kind: "create" | "get",
): RegistrationResponseJSON | AuthenticationResponseJSON {
  if (!isPlainObject(value) || !isPlainObject(value.response)) throw invalidResponse();
  const id = b64url(value.id, CREDENTIAL_ID_MAX);
  if (value.rawId !== id || value.type !== "public-key") throw invalidResponse();
  const r = value.response;
  const base = { id, rawId: id, type: "public-key" as const, clientExtensionResults: {} };
  const clientDataJSON = b64url(r.clientDataJSON, AUTH_VERIFY_MAX_BYTES);
  if (kind === "create") {
    return {
      ...base,
      response: {
        clientDataJSON,
        attestationObject: b64url(r.attestationObject, ATTESTATION_OBJECT_MAX),
        transports: parseTransports(r.transports),
      },
    };
  }
  return {
    ...base,
    response: {
      clientDataJSON,
      authenticatorData: b64url(r.authenticatorData, AUTH_VERIFY_MAX_BYTES),
      signature: b64url(r.signature, AUTH_VERIFY_MAX_BYTES),
      userHandle:
        r.userHandle === undefined || r.userHandle === null
          ? undefined
          : b64url(r.userHandle, USER_HANDLE_MAX),
    },
  };
}

/** clientDataJSON（base64url の JSON）に入っている challenge。こちらが発行した形でなければ 400 */
function challengeOf(clientDataJSON: string): string {
  let challenge: unknown;
  try {
    const data = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as unknown;
    challenge = isPlainObject(data) ? data.challenge : undefined;
  } catch {
    throw invalidResponse();
  }
  if (typeof challenge !== "string" || !RANDOM_32.test(challenge)) throw invalidResponse();
  return challenge;
}

/** challenge を取り出して消す（1 回だけ使える）。無いか期限切れなら 400 */
async function takeChallenge(d: AuthDeps, clientDataJSON: string, now: number) {
  const challenge = challengeOf(clientDataJSON);
  const rec = await d.auth.takeChallenge(challenge);
  // メモリの保存先は期限で消えないので、時刻でも確かめる
  if (!rec || now - rec.createdAt > AUTH_CHALLENGE_TTL_SEC * 1000) {
    throw new RankingError(400, "challenge expired");
  }
  return { challenge, rec };
}

/**
 * attestation の形式が none か。ほかの形式（packed・android-key・tpm など）は、ライブラリが応答の証明書を検証し、
 * 証明書に書かれた CRL の URL を取りに行く（サーバーから任意の URL へ通信させられる）ので、ライブラリに渡す前に断る。
 * 読めない attestationObject も false
 */
function isNoneAttestation(attestationObject: string): boolean {
  try {
    const decoded = decodeAttestationObject(
      new Uint8Array(Buffer.from(attestationObject, "base64url")),
    ) as unknown;
    return decoded instanceof Map && decoded.get("fmt") === "none";
  } catch {
    return false;
  }
}

/** 検証を呼ぶ。例外なら null（エラーの文言には challenge や origin が入るので、返さず記録もしない） */
async function tryVerify<T>(verify: () => Promise<T>): Promise<T | null> {
  try {
    return await verify();
  } catch {
    return null;
  }
}

function newChallenge(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(randomBytes(32));
}

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** セッションの期限（作ったとき・ログイン状態を確かめたときから AUTH_SESSION_TTL_SEC） */
const sessionExpiry = (now: number) => now + AUTH_SESSION_TTL_SEC * 1000;

/** セッションを作り、Cookie に入れるトークンを返す（保存するのはトークンの SHA-256 だけ） */
async function createSession(d: AuthDeps, accountId: string, now: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const record = { accountId, createdAt: now, expiresAt: sessionExpiry(now) };
  await d.auth.putSession(sessionHash(token), record, now, AUTH_MAX_SESSIONS);
  return token;
}

async function limit(d: AuthDeps, name: string, rule: { limit: number; windowSec: number }, now: number) {
  if ((await d.store.incrRateWindow(name, rule.windowSec, now)) > rule.limit) {
    throw new RankingError(429, "rate limited");
  }
}

/** 要求元の IP の枠で数える（IPv6 は /64 と /48。ip.ts の withinIpLimit） */
async function limitIp(d: AuthDeps, prefix: string, rule: { limit: number; windowSec: number }, now: number) {
  if (!(await withinIpLimit(d.store, prefix, d.ip ?? null, rule, now))) {
    throw new RankingError(429, "rate limited");
  }
}

async function accountView(d: AuthDeps, account: Account): Promise<AccountView> {
  const [names, creds, stats] = await Promise.all([
    d.store.getNames([account.playerId]),
    d.auth.listCredentials(account.id),
    d.auth.getStats(account.id),
  ]);
  return {
    playerId: account.playerId,
    name: names[account.playerId] ?? null,
    passkeys: creds.length,
    stats: parseStats(stats),
  };
}

function parseStats(raw: string | null): Stats | null {
  if (!raw) return null;
  try {
    return combineStats({}, JSON.parse(raw));
  } catch {
    return null;
  }
}

const webauthn = (d: AuthDeps) => d.webauthn ?? simpleWebAuthn;

/** パスキーに付ける名前（ランキングの名前、無ければ DEFAULT_NAME） */
async function passkeyName(d: AuthDeps, playerId: string): Promise<string> {
  return (await d.store.getNames([playerId]))[playerId] ?? DEFAULT_NAME;
}

/**
 * パスキーを登録する options（アカウントの作成とパスキーの追加で共通）。user.id は accountId（playerId は入れない）。
 * ログインでは userHandle（= user.id）をパスキーを登録したアカウントの id と照合するので、追加でも同じ accountId にする
 */
function buildRegistrationOptions(
  d: AuthDeps,
  accountId: string,
  name: string,
  exclude: StoredCredential[] = [],
) {
  return webauthn(d).registrationOptions({
    rpName: d.config.rpName,
    rpID: d.config.rpID,
    userID: new TextEncoder().encode(accountId),
    userName: name,
    userDisplayName: name,
    challenge: newChallenge(),
    attestationType: "none",
    // ライブラリが書き足すので、呼ぶたびに作る
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    excludeCredentials: exclude.map((c) => ({ id: c.id, transports: c.transports })),
  });
}

/**
 * パスキーの登録の応答（parseCredentialResponse(…, "create") で検査し、challenge の用途も確かめたもの）を検証し、
 * accountId のアカウントに保存するパスキーを返す。登録（アカウントの作成・パスキーの追加）はすべてここを通す
 * （ライブラリの登録の検証を呼ぶのはここだけ）。通らなければ 400 verification failed
 * - attestation は none だけ（isNoneAttestation。ほかの形式はライブラリに渡さない）
 * - 保存する id は認証器のデータのもの。ログインではブラウザが送る id で引くので、食い違えば受け付けない
 * - 公開鍵が大きすぎるもの（偽の認証器で保存先を埋める）も受け付けない
 */
async function verifyNewCredential(
  d: AuthDeps,
  response: RegistrationResponseJSON,
  challenge: string,
  accountId: string,
  now: number,
): Promise<StoredCredential> {
  const failed = () => new RankingError(400, "verification failed");
  if (!isNoneAttestation(response.response.attestationObject)) throw failed();
  const result = await tryVerify(() =>
    webauthn(d).verifyRegistration({
      response,
      expectedChallenge: challenge,
      expectedOrigin: d.config.origin,
      expectedRPID: d.config.rpID,
      requireUserVerification: false,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    }),
  );
  const info = result?.verified ? result.registrationInfo : null;
  if (
    !info ||
    info.credential.id !== response.id ||
    info.credential.publicKey.byteLength > PUBLIC_KEY_MAX_BYTES
  ) {
    throw failed();
  }
  return {
    id: info.credential.id,
    accountId,
    publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
    counter: info.credential.counter,
    transports: response.response.transports ?? [],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    createdAt: now,
    lastUsedAt: now,
  };
}

/** ログイン中のアカウント。セッションが無いか、アカウントが消えていれば 401 */
async function requireAccount(d: AuthDeps, s: SessionRef | null): Promise<Account> {
  const account = s ? await d.auth.getAccount(s.accountId) : null;
  if (!account) throw new RankingError(401, "not signed in");
  return account;
}

/**
 * アカウントを作る options。回数を数えてから、playerId がもう紐づいていれば 409、アカウントが上限に達していれば 503
 * （紐づいているかを回数の制限なしに調べさせない）。パスキーの user.id は新しい accountId、名前はランキングの名前
 */
export async function signupOptions(
  d: AuthDeps,
  input: { playerId?: unknown },
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON }> {
  const now = d.now ?? Date.now();
  const playerId = assertPlayerId(input.playerId);
  await limitIp(d, "auth:chal:", AUTH_RATE_LIMITS.chal, now);
  if (await d.auth.accountOfPlayer(playerId)) throw new RankingError(409, "already linked");
  if ((await d.auth.countAccounts()) >= AUTH_MAX_ACCOUNTS) throw new RankingError(503, "too many accounts");
  const accountId = randomUUID();
  const options = await buildRegistrationOptions(d, accountId, await passkeyName(d, playerId));
  const rec: ChallengeRecord = { kind: "signup", playerId, accountId, createdAt: now };
  await d.auth.putChallenge(options.challenge, rec, AUTH_CHALLENGE_TTL_SEC);
  return { options };
}

/**
 * パスキーの登録を検証してアカウントを作り、ログインする。
 * 同じ playerId で同時に作ったときは、先に作ったほうだけが残る（後のほうは 409 で、何も残さない）
 */
export async function signupVerify(
  d: AuthDeps,
  input: { response?: unknown },
): Promise<{ account: AccountView; token: string }> {
  const now = d.now ?? Date.now();
  const response = parseCredentialResponse(input.response, "create");
  const { challenge, rec } = await takeChallenge(d, response.response.clientDataJSON, now);
  if (rec.kind !== "signup") throw new RankingError(400, "invalid challenge");
  const cred = await verifyNewCredential(d, response, challenge, rec.accountId, now);
  if ((await d.auth.countAccounts()) >= AUTH_MAX_ACCOUNTS) throw new RankingError(503, "too many accounts");
  if (await d.auth.accountOfPlayer(rec.playerId)) throw new RankingError(409, "already linked");
  await limitIp(d, "auth:signup:", AUTH_RATE_LIMITS.signup, now);
  const account: Account = { id: rec.accountId, playerId: rec.playerId, createdAt: now };
  const created = await d.auth.createAccount(account, cred);
  if (created === "linked") throw new RankingError(409, "already linked");
  if (created === "exists") throw new RankingError(409, "credential exists");
  const token = await createSession(d, account.id, now);
  return { account: await accountView(d, account), token };
}

/** ログインの options。パスキーを指定せず、端末に保存されたパスキーから選ばせる */
export async function loginOptions(d: AuthDeps): Promise<{ options: PublicKeyCredentialRequestOptionsJSON }> {
  const now = d.now ?? Date.now();
  await limitIp(d, "auth:chal:", AUTH_RATE_LIMITS.chal, now);
  const options = await webauthn(d).authenticationOptions({
    rpID: d.config.rpID,
    allowCredentials: [],
    userVerification: "preferred",
    challenge: newChallenge(),
  });
  await d.auth.putChallenge(options.challenge, { kind: "login", createdAt: now }, AUTH_CHALLENGE_TTL_SEC);
  return { options };
}

/**
 * パスキーでログインする。知らないパスキー・userHandle の食い違い・検証の失敗は、どれも同じ 401
 * （登録されているパスキーかを見分けさせない）
 */
export async function loginVerify(
  d: AuthDeps,
  input: { response?: unknown },
): Promise<{ account: AccountView; token: string }> {
  const now = d.now ?? Date.now();
  const response = parseCredentialResponse(input.response, "get");
  const { challenge, rec } = await takeChallenge(d, response.response.clientDataJSON, now);
  if (rec.kind !== "login") throw new RankingError(400, "invalid challenge");
  const failed = () => new RankingError(401, "login failed");
  const cred = await d.auth.getCredential(response.id);
  const account = cred ? await d.auth.getAccount(cred.accountId) : null;
  if (!cred || !account) throw failed();
  // ライブラリは userHandle を確かめないので、パスキーを登録したアカウントの id と照合する
  if (response.response.userHandle !== Buffer.from(cred.accountId).toString("base64url")) throw failed();
  const result = await tryVerify(() =>
    webauthn(d).verifyAuthentication({
      response,
      expectedChallenge: challenge,
      expectedOrigin: d.config.origin,
      expectedRPID: d.config.rpID,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
        counter: cred.counter,
        transports: cred.transports,
      },
      requireUserVerification: false,
    }),
  );
  const info = result?.verified ? result.authenticationInfo : null;
  if (!info) throw failed();
  await d.auth.updateCredential({
    ...cred,
    counter: info.newCounter,
    backedUp: info.credentialBackedUp,
    lastUsedAt: now,
  });
  const token = await createSession(d, account.id, now);
  return { account: await accountView(d, account), token };
}

/** Cookie のトークンからセッションを引く。形が違う・無い・期限切れなら null */
export async function sessionFromToken(d: AuthDeps, token: string | null): Promise<SessionRef | null> {
  if (!token || !RANDOM_32.test(token)) return null;
  const now = d.now ?? Date.now();
  const hash = sessionHash(token);
  const record = await d.auth.getSession(hash);
  // メモリの保存先は期限で消えないので、時刻でも確かめる
  if (!record || record.expiresAt <= now) return null;
  return { hash, accountId: record.accountId, record };
}

/** ログイン中のアカウント。セッションが有効なら期限を延ばす */
export async function currentAccount(
  d: AuthDeps,
  s: SessionRef | null,
): Promise<{ account: AccountView | null }> {
  if (!s) return { account: null };
  const account = await d.auth.getAccount(s.accountId);
  if (!account) return { account: null };
  const now = d.now ?? Date.now();
  await d.auth.touchSession(s.hash, { ...s.record, expiresAt: sessionExpiry(now) });
  return { account: await accountView(d, account) };
}

/** ログアウト。this はこの端末のセッション、others はこの端末以外のセッションを消す */
export async function logout(
  d: AuthDeps,
  s: SessionRef | null,
  input: { scope?: unknown },
): Promise<{ ok: true }> {
  const scope = input.scope === undefined ? "this" : input.scope;
  if (scope !== "this" && scope !== "others") throw new RankingError(400, "invalid scope");
  if (!s) throw new RankingError(401, "not signed in");
  if (scope === "this") await d.auth.removeSession(s.hash, s.accountId);
  else await d.auth.removeOtherSessions(s.accountId, s.hash);
  return { ok: true };
}

/**
 * ログイン中のアカウントにパスキーを足す options。登録済みのパスキーは excludeCredentials に入れ
 * （同じ認証器で二重に作らせない）、AUTH_MAX_PASSKEYS 件に達していれば 409
 */
export async function passkeyOptions(
  d: AuthDeps,
  s: SessionRef | null,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON }> {
  const now = d.now ?? Date.now();
  const account = await requireAccount(d, s);
  const creds = await d.auth.listCredentials(account.id);
  if (creds.length >= AUTH_MAX_PASSKEYS) throw new RankingError(409, "too many passkeys");
  await limitIp(d, "auth:chal:", AUTH_RATE_LIMITS.chal, now);
  const options = await buildRegistrationOptions(
    d,
    account.id,
    await passkeyName(d, account.playerId),
    creds,
  );
  const rec: ChallengeRecord = { kind: "add", accountId: account.id, createdAt: now };
  await d.auth.putChallenge(options.challenge, rec, AUTH_CHALLENGE_TTL_SEC);
  return { options };
}

/**
 * パスキーの登録を検証して、ログイン中のアカウントに足す。challenge はこのアカウントの追加用に発行したものだけ。
 * 登録済みのパスキー（どのアカウントのものでも）なら 409 credential exists、
 * 上限に達していれば 409 too many passkeys（保存先が数えて足すので、同時に足しても上限を超えない）
 */
export async function passkeyVerify(
  d: AuthDeps,
  s: SessionRef | null,
  input: { response?: unknown },
): Promise<{ account: AccountView }> {
  const now = d.now ?? Date.now();
  const account = await requireAccount(d, s);
  const response = parseCredentialResponse(input.response, "create");
  const { challenge, rec } = await takeChallenge(d, response.response.clientDataJSON, now);
  if (rec.kind !== "add" || rec.accountId !== account.id) throw new RankingError(400, "invalid challenge");
  const cred = await verifyNewCredential(d, response, challenge, account.id, now);
  const added = await d.auth.addCredential(cred, AUTH_MAX_PASSKEYS);
  if (added === "exists") throw new RankingError(409, "credential exists");
  if (added === "full") throw new RankingError(409, "too many passkeys");
  return { account: await accountView(d, account) };
}

/**
 * アカウントを消す（パスキー・セッション・同期した記録・playerId の紐づけ）。何度呼んでも成功にする。
 * ランキング・今日の一問の履歴・名前・通知の購読は playerId のものなので残し、端末はその playerId のまま遊べる
 */
export async function deleteAccount(d: AuthDeps, s: SessionRef | null): Promise<{ ok: true }> {
  if (!s) throw new RankingError(401, "not signed in");
  await d.auth.deleteAccount(s.accountId);
  return { ok: true };
}

/**
 * 端末の記録をアカウントの記録と合わせて保存し、合わせた記録を返す。難易度ごとに良い方・多い方を残す
 * （combineStats）ので、何度送っても同じ結果になる。読んでから書くので、同時の同期で片方の分が消えても、
 * その端末が次に同期したときに戻る
 */
export async function putStats(
  d: AuthDeps,
  s: SessionRef | null,
  input: { stats?: unknown },
): Promise<{ stats: Stats }> {
  const now = d.now ?? Date.now();
  const account = await requireAccount(d, s);
  if (!isPlainObject(input.stats)) throw new RankingError(400, "invalid stats");
  await limit(d, `auth:stats:${account.id}`, AUTH_RATE_LIMITS.stats, now);
  const stats = combineStats(parseStats(await d.auth.getStats(account.id)) ?? {}, input.stats);
  const json = JSON.stringify(stats);
  // combineStats の値は難易度 6 つ × 上限のある数 8 項目（2KB 程度）なので届かない（守りのための上限）
  if (Buffer.byteLength(json) > MAX_STATS_BYTES) throw new RankingError(400, "too large");
  await d.auth.putStats(account.id, json);
  return { stats };
}

/** 別の playerId の今日の一問の履歴を、アカウントの playerId に写す（同じ日・難易度はアカウント側を残し、ランキングの行は移さない） */
export async function mergePlayer(
  d: AuthDeps,
  s: SessionRef | null,
  input: { fromPlayerId?: unknown },
): Promise<{ merged: number }> {
  const now = d.now ?? Date.now();
  const account = await requireAccount(d, s);
  const from = assertPlayerId(input.fromPlayerId);
  if (from === account.playerId) return { merged: 0 };
  // 紐づき済みの playerId は写さない。数えてから確かめる（紐づいているかを回数の制限なしに調べさせない）
  await limit(d, `auth:merge:${account.id}`, AUTH_RATE_LIMITS.merge, now);
  if (await d.auth.accountOfPlayer(from)) return { merged: 0 };
  const have = new Set((await d.store.getHistory(account.playerId)).map(historyField));
  const fresh = (await d.store.getHistory(from)).filter((e) => !have.has(historyField(e)));
  // addHistory は同じ日・難易度を上書きしない（HSETNX）ので、同時に記録しても先に書いたものが残る
  for (let i = 0; i < fresh.length; i += MERGE_BATCH) {
    await Promise.all(fresh.slice(i, i + MERGE_BATCH).map((e) => d.store.addHistory(account.playerId, e)));
  }
  return { merged: fresh.length };
}
