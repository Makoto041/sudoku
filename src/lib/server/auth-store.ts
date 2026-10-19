import type { Redis } from "@upstash/redis";
import { isPlainObject } from "@/lib/client/storage";
import { redisFromEnv } from "./store";

/** アカウント。紐づけた playerId は後から変えない */
export type Account = { id: string; playerId: string; createdAt: number };

/** 登録したパスキー。id と publicKey は base64url */
export type StoredCredential = {
  id: string;
  accountId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number;
};

/** 発行した challenge の用途。signup は作るアカウントの id と紐づける playerId、add は追加先のアカウント */
export type ChallengeRecord =
  | { kind: "signup"; playerId: string; accountId: string; createdAt: number }
  | { kind: "login"; createdAt: number }
  | { kind: "add"; accountId: string; createdAt: number };

/** ログインのセッション。キーはトークンの SHA-256 で、トークンそのものは保存しない */
export type AuthSessionRecord = { accountId: string; createdAt: number; expiresAt: number };

/** アカウント（パスキー）の保存先。本番は Upstash Redis、ローカル開発とテストはメモリ */
export interface AuthStore {
  /** challenge を保存する（ttlSec で消える） */
  putChallenge(challenge: string, rec: ChallengeRecord, ttlSec: number): Promise<void>;
  /** challenge を取り出して消す（1 回だけ使える） */
  takeChallenge(challenge: string): Promise<ChallengeRecord | null>;
  countAccounts(): Promise<number>;
  /**
   * アカウントを作り、最初のパスキーと playerId を紐づける。パスキーが登録済みなら "exists"、
   * playerId が別のアカウントに紐づいていれば、書いたものを消して "linked"
   */
  createAccount(account: Account, cred: StoredCredential): Promise<"ok" | "linked" | "exists">;
  getAccount(id: string): Promise<Account | null>;
  /** playerId を紐づけたアカウントの id */
  accountOfPlayer(playerId: string): Promise<string | null>;
  getCredential(id: string): Promise<StoredCredential | null>;
  /**
   * パスキーを足す。登録済みなら "exists"、アカウントのパスキーが maxPerAccount 件を超えるなら "full"（足さない）。
   * 同時に足しても maxPerAccount 件を超えない（Redis では、足したあとに数えて超えていたら戻す）
   */
  addCredential(cred: StoredCredential, maxPerAccount: number): Promise<"ok" | "exists" | "full">;
  /** パスキーを書き換える（消えていたら何もしない） */
  updateCredential(cred: StoredCredential): Promise<void>;
  listCredentials(accountId: string): Promise<StoredCredential[]>;
  /** セッションを保存する。期限切れは一覧から外し、maxPerAccount を超えたら期限の近い順に消す（今回のものは残す） */
  putSession(hash: string, rec: AuthSessionRecord, now: number, maxPerAccount: number): Promise<void>;
  getSession(hash: string): Promise<AuthSessionRecord | null>;
  /** セッションの期限を延ばす（消えていたら何もしない。ログアウトしたセッションを生き返らせない） */
  touchSession(hash: string, rec: AuthSessionRecord): Promise<void>;
  removeSession(hash: string, accountId: string): Promise<void>;
  /** keepHash 以外のセッションを消す。null ならすべて */
  removeOtherSessions(accountId: string, keepHash: string | null): Promise<void>;
  getStats(accountId: string): Promise<string | null>;
  putStats(accountId: string, json: string): Promise<void>;
  /**
   * アカウントのパスキー・セッション・記録とアカウントを消す。playerId の紐づけは、このアカウントのものだけ消す。
   * 紐づけを最初に消す（途中で失敗しても、その playerId を紐づけられないままにしない。残りはもう一度呼べば消える）
   */
  deleteAccount(accountId: string): Promise<void>;
}

/** セッションの有効期間（ログイン状態の確認のたびに延ばす） */
export const AUTH_SESSION_TTL_SEC = 90 * 24 * 60 * 60;

const PREFIX = "sdk";
const accountKey = (id: string) => `${PREFIX}:acct:${id}`;
const credsKey = (accountId: string) => `${PREFIX}:acct:${accountId}:creds`;
const sessionsKey = (accountId: string) => `${PREFIX}:acct:${accountId}:sess`;
const statsKey = (accountId: string) => `${PREFIX}:acct:${accountId}:stats`;
const playerKey = (playerId: string) => `${PREFIX}:acctp:${playerId}`;
const ACCOUNTS_KEY = `${PREFIX}:accts`;
const credKey = (id: string) => `${PREFIX}:cred:${id}`;
const challengeKey = (challenge: string) => `${PREFIX}:auth:chal:${challenge}`;
const sessionKey = (hash: string) => `${PREFIX}:auth:sess:${hash}`;

function parse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

function toAccount(raw: string | null): Account | null {
  const v = parse(raw);
  return v && isStr(v.id) && isStr(v.playerId) && isNum(v.createdAt) ? (v as Account) : null;
}

function toCredential(raw: string | null): StoredCredential | null {
  const v = parse(raw);
  const ok =
    v &&
    isStr(v.id) &&
    isStr(v.accountId) &&
    isStr(v.publicKey) &&
    isNum(v.counter) &&
    Array.isArray(v.transports) &&
    (v.deviceType === "singleDevice" || v.deviceType === "multiDevice") &&
    typeof v.backedUp === "boolean";
  return ok ? (v as StoredCredential) : null;
}

function toChallenge(raw: string | null): ChallengeRecord | null {
  const v = parse(raw);
  if (!v || !isNum(v.createdAt)) return null;
  if (v.kind === "signup") return isStr(v.playerId) && isStr(v.accountId) ? (v as ChallengeRecord) : null;
  if (v.kind === "login") return v as ChallengeRecord;
  if (v.kind === "add") return isStr(v.accountId) ? (v as ChallengeRecord) : null;
  return null;
}

function toSession(raw: string | null): AuthSessionRecord | null {
  const v = parse(raw);
  return v && isStr(v.accountId) && isNum(v.createdAt) && isNum(v.expiresAt)
    ? (v as AuthSessionRecord)
    : null;
}

export class RedisAuthStore implements AuthStore {
  constructor(private redis: Redis) {}

  async putChallenge(challenge: string, rec: ChallengeRecord, ttlSec: number) {
    await this.redis.set(challengeKey(challenge), JSON.stringify(rec), { ex: ttlSec });
  }

  async takeChallenge(challenge: string) {
    return toChallenge(await this.redis.getdel<string>(challengeKey(challenge)));
  }

  countAccounts() {
    return this.redis.scard(ACCOUNTS_KEY);
  }

  async createAccount(account: Account, cred: StoredCredential) {
    // パスキーと playerId はそれぞれ SET NX で先着 1 つにする。playerId を取れなければ、書いたものを消す。
    // 一覧（accts・creds）には、両方を取れてから足す
    if (!(await this.redis.set(credKey(cred.id), JSON.stringify(cred), { nx: true }))) return "exists";
    await this.redis.set(accountKey(account.id), JSON.stringify(account));
    if (!(await this.redis.set(playerKey(account.playerId), account.id, { nx: true }))) {
      await this.redis.del(credKey(cred.id), accountKey(account.id));
      return "linked";
    }
    await this.redis.pipeline().sadd(credsKey(account.id), cred.id).sadd(ACCOUNTS_KEY, account.id).exec();
    return "ok";
  }

  async getAccount(id: string) {
    return toAccount(await this.redis.get<string>(accountKey(id)));
  }

  accountOfPlayer(playerId: string) {
    return this.redis.get<string>(playerKey(playerId));
  }

  async getCredential(id: string) {
    return toCredential(await this.redis.get<string>(credKey(id)));
  }

  async addCredential(cred: StoredCredential, maxPerAccount: number) {
    if (!(await this.redis.set(credKey(cred.id), JSON.stringify(cred), { nx: true }))) return "exists";
    // 足してから数え、超えていたら戻す。どの要求も自分の分を足したあとに数えるので、同時に足しても残るのは上限まで
    // （同時の要求がどれも超えたと見て、全部を戻すことはある）
    const list = credsKey(cred.accountId);
    const [, count] = await this.redis.pipeline().sadd(list, cred.id).scard(list).exec();
    if (Number(count) > maxPerAccount) {
      await this.redis.pipeline().srem(list, cred.id).del(credKey(cred.id)).exec();
      return "full";
    }
    return "ok";
  }

  async updateCredential(cred: StoredCredential) {
    // 同時にアカウントを消していても、パスキーだけを書き戻さない
    await this.redis.set(credKey(cred.id), JSON.stringify(cred), { xx: true });
  }

  async listCredentials(accountId: string) {
    const ids = (await this.redis.smembers<string[]>(credsKey(accountId))).map(String);
    if (ids.length === 0) return [];
    const raw = await this.redis.mget<(string | null)[]>(...ids.map(credKey));
    return raw.map((r) => toCredential(r ?? null)).filter((c): c is StoredCredential => c !== null);
  }

  async putSession(hash: string, rec: AuthSessionRecord, now: number, maxPerAccount: number) {
    const list = sessionsKey(rec.accountId);
    await this.redis
      .pipeline()
      .set(sessionKey(hash), JSON.stringify(rec), { ex: AUTH_SESSION_TTL_SEC })
      .zadd(list, { score: rec.expiresAt, member: hash })
      // 期限が過ぎて中身の消えたセッションを一覧から外す
      .zremrangebyscore(list, "-inf", now)
      .expire(list, AUTH_SESSION_TTL_SEC)
      .exec();
    const hashes = (await this.redis.zrange<(string | number)[]>(list, 0, -1)).map(String);
    const old = hashes.filter((h) => h !== hash).slice(0, Math.max(0, hashes.length - maxPerAccount));
    if (old.length > 0) {
      await this.redis
        .pipeline()
        .del(...old.map(sessionKey))
        .zrem(list, ...old)
        .exec();
    }
  }

  async getSession(hash: string) {
    return toSession(await this.redis.get<string>(sessionKey(hash)));
  }

  async touchSession(hash: string, rec: AuthSessionRecord) {
    const list = sessionsKey(rec.accountId);
    await this.redis
      .pipeline()
      .set(sessionKey(hash), JSON.stringify(rec), { ex: AUTH_SESSION_TTL_SEC, xx: true })
      .zadd(list, { xx: true }, { score: rec.expiresAt, member: hash })
      .expire(list, AUTH_SESSION_TTL_SEC)
      .exec();
  }

  async removeSession(hash: string, accountId: string) {
    await this.redis.pipeline().del(sessionKey(hash)).zrem(sessionsKey(accountId), hash).exec();
  }

  async removeOtherSessions(accountId: string, keepHash: string | null) {
    const list = sessionsKey(accountId);
    const hashes = (await this.redis.zrange<(string | number)[]>(list, 0, -1))
      .map(String)
      .filter((h) => h !== keepHash);
    if (hashes.length === 0) return;
    await this.redis
      .pipeline()
      .del(...hashes.map(sessionKey))
      .zrem(list, ...hashes)
      .exec();
  }

  getStats(accountId: string) {
    return this.redis.get<string>(statsKey(accountId));
  }

  async putStats(accountId: string, json: string) {
    await this.redis.set(statsKey(accountId), json);
  }

  async deleteAccount(accountId: string) {
    // 紐づけは SET NX で取り、消すのはここだけなので、読んでから消すまでに別のアカウントのものに変わることはない
    const account = await this.getAccount(accountId);
    if (account && (await this.redis.get<string>(playerKey(account.playerId))) === accountId) {
      await this.redis.del(playerKey(account.playerId));
    }
    const [credIds, hashes] = await Promise.all([
      this.redis.smembers<string[]>(credsKey(accountId)),
      this.redis.zrange<(string | number)[]>(sessionsKey(accountId), 0, -1),
    ]);
    const keys = [
      ...credIds.map((id) => credKey(String(id))),
      ...hashes.map((h) => sessionKey(String(h))),
      credsKey(accountId),
      sessionsKey(accountId),
      statsKey(accountId),
      accountKey(accountId),
    ];
    await this.redis
      .pipeline()
      .del(...keys)
      .srem(ACCOUNTS_KEY, accountId)
      .exec();
  }
}

/** ローカル開発・テスト用。プロセスが落ちると消える。期限（TTL）は持たない（呼び出し側が時刻で確かめる） */
export class MemoryAuthStore implements AuthStore {
  private challenges = new Map<string, string>();
  private accounts = new Map<string, string>();
  private players = new Map<string, string>();
  private credentials = new Map<string, string>();
  private accountCreds = new Map<string, Set<string>>();
  private sessions = new Map<string, string>();
  private accountSessions = new Map<string, Map<string, number>>();
  private stats = new Map<string, string>();

  async putChallenge(challenge: string, rec: ChallengeRecord) {
    this.challenges.set(challenge, JSON.stringify(rec));
  }

  async takeChallenge(challenge: string) {
    const raw = this.challenges.get(challenge) ?? null;
    this.challenges.delete(challenge);
    return toChallenge(raw);
  }

  async countAccounts() {
    return this.accounts.size;
  }

  async createAccount(account: Account, cred: StoredCredential) {
    if (this.credentials.has(cred.id)) return "exists";
    if (this.players.has(account.playerId)) return "linked";
    this.credentials.set(cred.id, JSON.stringify(cred));
    this.accounts.set(account.id, JSON.stringify(account));
    this.players.set(account.playerId, account.id);
    this.accountCreds.set(account.id, new Set([cred.id]));
    return "ok";
  }

  async getAccount(id: string) {
    return toAccount(this.accounts.get(id) ?? null);
  }

  async accountOfPlayer(playerId: string) {
    return this.players.get(playerId) ?? null;
  }

  async getCredential(id: string) {
    return toCredential(this.credentials.get(id) ?? null);
  }

  async addCredential(cred: StoredCredential, maxPerAccount: number) {
    if (this.credentials.has(cred.id)) return "exists";
    let set = this.accountCreds.get(cred.accountId);
    if (!set) this.accountCreds.set(cred.accountId, (set = new Set()));
    if (set.size >= maxPerAccount) return "full";
    this.credentials.set(cred.id, JSON.stringify(cred));
    set.add(cred.id);
    return "ok";
  }

  async updateCredential(cred: StoredCredential) {
    if (this.credentials.has(cred.id)) this.credentials.set(cred.id, JSON.stringify(cred));
  }

  async listCredentials(accountId: string) {
    return [...(this.accountCreds.get(accountId) ?? [])]
      .map((id) => toCredential(this.credentials.get(id) ?? null))
      .filter((c): c is StoredCredential => c !== null);
  }

  /** Redis の ZRANGE と同じ順（期限、同じなら hash の順） */
  private sessionHashes(accountId: string) {
    return [...(this.accountSessions.get(accountId) ?? [])]
      .sort(([a, ta], [b, tb]) => ta - tb || (a < b ? -1 : 1))
      .map(([h]) => h);
  }

  async putSession(hash: string, rec: AuthSessionRecord, now: number, maxPerAccount: number) {
    this.sessions.set(hash, JSON.stringify(rec));
    let list = this.accountSessions.get(rec.accountId);
    if (!list) this.accountSessions.set(rec.accountId, (list = new Map()));
    list.set(hash, rec.expiresAt);
    for (const [h, t] of list) if (t <= now) list.delete(h);
    const hashes = this.sessionHashes(rec.accountId);
    const old = hashes.filter((h) => h !== hash).slice(0, Math.max(0, hashes.length - maxPerAccount));
    for (const h of old) {
      this.sessions.delete(h);
      list.delete(h);
    }
  }

  async getSession(hash: string) {
    return toSession(this.sessions.get(hash) ?? null);
  }

  async touchSession(hash: string, rec: AuthSessionRecord) {
    if (!this.sessions.has(hash)) return;
    this.sessions.set(hash, JSON.stringify(rec));
    const list = this.accountSessions.get(rec.accountId);
    if (list?.has(hash)) list.set(hash, rec.expiresAt);
  }

  async removeSession(hash: string, accountId: string) {
    this.sessions.delete(hash);
    this.accountSessions.get(accountId)?.delete(hash);
  }

  async removeOtherSessions(accountId: string, keepHash: string | null) {
    for (const h of this.sessionHashes(accountId)) {
      if (h !== keepHash) await this.removeSession(h, accountId);
    }
  }

  async getStats(accountId: string) {
    return this.stats.get(accountId) ?? null;
  }

  async putStats(accountId: string, json: string) {
    this.stats.set(accountId, json);
  }

  async deleteAccount(accountId: string) {
    const account = await this.getAccount(accountId);
    if (account && this.players.get(account.playerId) === accountId) this.players.delete(account.playerId);
    for (const id of this.accountCreds.get(accountId) ?? []) this.credentials.delete(id);
    for (const h of this.accountSessions.get(accountId)?.keys() ?? []) this.sessions.delete(h);
    this.accountCreds.delete(accountId);
    this.accountSessions.delete(accountId);
    this.stats.delete(accountId);
    this.accounts.delete(accountId);
  }

  /** テスト用：保存しているものの数（消し残しの確認） */
  counts() {
    return {
      challenges: this.challenges.size,
      accounts: this.accounts.size,
      players: this.players.size,
      credentials: this.credentials.size,
      sessions: this.sessions.size,
      stats: this.stats.size,
    };
  }
}

let cached: AuthStore | null | undefined;

/** getStore と同じ判定で保存先を決める（Redis、Vercel 上で未設定なら null、ほかはメモリ） */
export function getAuthStore(): AuthStore | null {
  if (cached !== undefined) return cached;
  const redis = redisFromEnv();
  if (redis) {
    cached = new RedisAuthStore(redis);
  } else if (process.env.VERCEL) {
    cached = null;
  } else {
    cached = new MemoryAuthStore();
  }
  return cached;
}
