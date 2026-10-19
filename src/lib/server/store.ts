import { Redis } from "@upstash/redis";
import { DIFFICULTIES, type Difficulty } from "@/lib/sudoku/core";

export type Session = {
  id: string;
  playerId: string;
  date: string;
  difficulty: Difficulty;
  startedAt: number;
  finishedAt?: number;
  /** 開始時に配った問題（81 文字）。古いセッションには無い */
  puzzle?: string;
};

export type BoardKey =
  { scope: "daily"; date: string; difficulty: Difficulty } | { scope: "best"; difficulty: Difficulty };

export type BoardRow = { playerId: string; timeMs: number; points: number };

/**
 * 並べ順の値。点数が高いほど、同点ならタイムが速いほど小さくなる（小さいほど上位）。
 * timeMs は 10 億 ms（約 11 日）未満なので、点数と時間を 1 つの数に詰めて元に戻せる
 */
const SCALE = 1e9;
export function rankValue(points: number, timeMs: number): number {
  return Math.min(SCALE - 1, Math.max(0, Math.round(timeMs))) - Math.max(0, Math.round(points)) * SCALE;
}
export function fromRankValue(v: number): { points: number; timeMs: number } {
  const points = Math.max(0, Math.ceil(-v / SCALE));
  return { points, timeMs: v + points * SCALE };
}

/** ランキングの保存先。本番は Upstash Redis、ローカル開発とテストはメモリ */
export interface RankingStore {
  /** 同じプレイヤー・日付・難易度で既に始めていればそのセッションを返す（最初の開始だけが有効） */
  startSession(candidate: Session): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  /** セッションを完了にする。既に完了していたら false */
  finishSession(id: string, finishedAt: number): Promise<boolean>;
  /** 記録を追加。日次は最初の 1 回、歴代はより良い（点数が高い、同点なら速い）ときだけ更新する */
  record(date: string, difficulty: Difficulty, row: BoardRow): Promise<void>;
  top(board: BoardKey, limit: number): Promise<BoardRow[]>;
  /** 0 始まりの順位と記録。載っていなければ null */
  position(
    board: BoardKey,
    playerId: string,
  ): Promise<{ index: number; timeMs: number; points: number } | null>;
  size(board: BoardKey): Promise<number>;
  getNames(playerIds: string[]): Promise<Record<string, string>>;
  setName(playerId: string, name: string): Promise<void>;
  getDailyPuzzle(date: string, difficulty: Difficulty): Promise<string | null>;
  /** その日の問題を固定する。既に固定されていればそちらを返す */
  pinDailyPuzzle(date: string, difficulty: Difficulty, puzzle: string): Promise<string>;
  /** 今日の一問のクリア履歴に足す。同じ日・難易度は最初の 1 回だけ */
  addHistory(playerId: string, entry: HistoryEntry): Promise<void>;
  getHistory(playerId: string): Promise<HistoryEntry[]>;
  /** 引き継ぎコードを保存する。コードが既に使われていれば false */
  putTransfer(code: string, payload: string, ttlSec: number): Promise<boolean>;
  /** 引き継ぎコードを取り出して消す（1 回だけ使える） */
  takeTransfer(code: string): Promise<string | null>;
  /** 通知の購読。id は endpoint の SHA-256 */
  getPushSub(id: string): Promise<PushSub | null>;
  /** 購読の数（Redis では、期限切れで中身が消えた購読も cron が読み飛ばすまで数に残る） */
  countPushSubs(): Promise<number>;
  /** 購読を保存して期限を延ばし、プレイヤーの購読一覧に更新時刻で載せる */
  putPushSub(id: string, sub: PushSub, now: number): Promise<void>;
  /** プレイヤーの購読 id。更新の古い順 */
  playerPushSubs(playerId: string): Promise<string[]>;
  /** 購読を消す。保存された購読が別のプレイヤーのものなら、このプレイヤーの一覧から外すだけ */
  removePushSub(id: string, playerId: string): Promise<void>;
  /**
   * 購読を少しずつ読む。cursor は "0" から始め、"0" が返ったら終わり。
   * 同じ購読が 2 回返ることがある。中身が期限切れで消えていた id は一覧から外す
   */
  scanPushSubs(
    cursor: string,
    count: number,
  ): Promise<{ cursor: string; subs: { id: string; sub: PushSub }[] }>;
  /** その日の送信済みの印を付ける。既に付いていれば false */
  markPushSent(date: string, id: string): Promise<boolean>;
  /** 送信済みの印を外す（送れなかった購読を、同じ日の再実行で送り直せるようにする） */
  unmarkPushSent(date: string, id: string): Promise<void>;
  /**
   * cron の送信が失敗した日を記録し、続けて失敗した日数を返す。同じ日は何回記録しても 1 日。
   * 最後の失敗から 3.5 日記録が無ければ消える（数え直し）。購読の登録・解除では変わらない
   */
  addPushFailure(id: string, date: string, now: number): Promise<number>;
  /** 送信できたので、失敗の記録を消す */
  clearPushFailure(id: string): Promise<void>;
  /** その日の今日の一問を、どれか 1 問でもクリアしたか */
  clearedOn(playerId: string, date: string): Promise<boolean>;
  /**
   * 回数制限のカウンタ（固定窓）を 1 増やし、この窓での回数を返す。窓は now を windowSec ごとに区切ったもので、
   * キーに窓の番号を入れる（窓が変われば別のカウンタになる）。カウンタは最後に数えてから windowSec で消える
   */
  incrRateWindow(name: string, windowSec: number, now: number): Promise<number>;
}

/** 通知の購読。endpoint は検査して正規化したもの、鍵は base64url */
export type PushSub = {
  endpoint: string;
  p256dh: string;
  auth: string;
  playerId: string;
  createdAt: number;
};

export type HistoryEntry = {
  date: string;
  difficulty: Difficulty;
  /** スコア制になる前の記録には無い */
  points: number | null;
  timeMs: number;
};

const SESSION_TTL_SEC = 3 * 24 * 60 * 60;
const DAILY_TTL_SEC = 400 * 24 * 60 * 60;
const PREFIX = "sdk";

// スコア制になってからの表（タイム順だった頃の sdk:lb / sdk:best は使わない）
const boardKey = (b: BoardKey) =>
  b.scope === "daily" ? `${PREFIX}:lbs:${b.date}:${b.difficulty}` : `${PREFIX}:bests:${b.difficulty}`;
const startKey = (s: Pick<Session, "playerId" | "date" | "difficulty">) =>
  `${PREFIX}:start:${s.date}:${s.difficulty}:${s.playerId}`;
const sessionKey = (id: string) => `${PREFIX}:sess:${id}`;
const NAMES_KEY = `${PREFIX}:names`;
const puzzleKey = (date: string, difficulty: Difficulty) => `${PREFIX}:puzzle:${date}:${difficulty}`;
const PUZZLE_TTL_SEC = 7 * 24 * 60 * 60;
const historyKey = (playerId: string) => `${PREFIX}:hist:${playerId}`;
/** 履歴のフィールド名（日付と難易度。同じ日・難易度は 1 つ） */
export const historyField = (e: Pick<HistoryEntry, "date" | "difficulty">) => `${e.date}:${e.difficulty}`;
const HISTORY_TTL_SEC = 800 * 24 * 60 * 60;
const transferKey = (code: string) => `${PREFIX}:xfer:${code}`;
// 購読は最後の登録から 400 日で消える（アプリを開くたびに端末が登録し直して延ばす）
const PUSH_TTL_SEC = 400 * 24 * 60 * 60;
const PUSH_TTL_MS = PUSH_TTL_SEC * 1000;
const pushKey = (id: string) => `${PREFIX}:push:${id}`;
const PUSH_SUBS_KEY = `${PREFIX}:push:subs`;
const playerPushKey = (playerId: string) => `${PREFIX}:push:p:${playerId}`;
const pushSentKey = (date: string, id: string) => `${PREFIX}:push:sent:${date}:${id}`;
const PUSH_SENT_TTL_SEC = 2 * 24 * 60 * 60;
// 送信が失敗した日（YYYY-MM-DD の集合）。cron は毎日同じ時刻に動くので、日数ちょうどの期限にすると
// 実行にかかった時間で消えたり残ったりする。半日ずらし、失敗の無い日が 2 日続いても残り、3 日続けば消える
const pushFailKey = (id: string) => `${PREFIX}:push:fail:${id}`;
const PUSH_FAIL_TTL_SEC = 3.5 * 24 * 60 * 60;
const PUSH_FAIL_TTL_MS = PUSH_FAIL_TTL_SEC * 1000;
// 回数制限のカウンタ。name は "ip:{IP の SHA-256}" など（生の IP は入れない）
const rateKey = (name: string, windowSec: number, now: number) =>
  `${PREFIX}:push:rl:${name}:${Math.floor(now / (windowSec * 1000))}`;

function toPushSub(raw: string | null): PushSub | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PushSub>;
    const ok = [v.endpoint, v.p256dh, v.auth, v.playerId].every((s) => typeof s === "string");
    return ok ? (v as PushSub) : null;
  } catch {
    return null;
  }
}

function toHistory(field: string, value: string): HistoryEntry | null {
  const [date, difficulty] = field.split(":");
  try {
    const v = JSON.parse(value) as { points: number | null; timeMs: number };
    return { date, difficulty: difficulty as Difficulty, points: v.points ?? null, timeMs: v.timeMs };
  } catch {
    return null;
  }
}

export class RedisStore implements RankingStore {
  constructor(private redis: Redis) {}

  async startSession(candidate: Session): Promise<Session> {
    const claimed = await this.redis.set(startKey(candidate), candidate.id, {
      nx: true,
      ex: SESSION_TTL_SEC,
    });
    if (claimed) {
      await this.redis.set(sessionKey(candidate.id), JSON.stringify(candidate), { ex: SESSION_TTL_SEC });
      return candidate;
    }
    const existingId = await this.redis.get<string>(startKey(candidate));
    const existing = existingId ? await this.getSession(existingId) : null;
    if (existing) return existing;
    // 開始キーだけ残ってセッションが消えていた場合は作り直す
    await this.redis.set(startKey(candidate), candidate.id, { ex: SESSION_TTL_SEC });
    await this.redis.set(sessionKey(candidate.id), JSON.stringify(candidate), { ex: SESSION_TTL_SEC });
    return candidate;
  }

  async getSession(id: string) {
    const raw = await this.redis.get<string>(sessionKey(id));
    return raw ? (JSON.parse(raw) as Session) : null;
  }

  async finishSession(id: string, finishedAt: number) {
    // 完了フラグは別キーの SET NX で取り、同時送信でも 1 回しか通さない
    const won = await this.redis.set(`${sessionKey(id)}:done`, finishedAt, {
      nx: true,
      ex: SESSION_TTL_SEC,
    });
    if (!won) return false;
    const session = await this.getSession(id);
    if (session) {
      await this.redis.set(sessionKey(id), JSON.stringify({ ...session, finishedAt }), {
        ex: SESSION_TTL_SEC,
      });
    }
    return true;
  }

  async record(date: string, difficulty: Difficulty, row: BoardRow) {
    const daily = boardKey({ scope: "daily", date, difficulty });
    const p = this.redis.pipeline();
    const value = rankValue(row.points, row.timeMs);
    p.zadd(daily, { nx: true }, { score: value, member: row.playerId });
    p.expire(daily, DAILY_TTL_SEC);
    p.zadd(boardKey({ scope: "best", difficulty }), { lt: true }, { score: value, member: row.playerId });
    await p.exec();
  }

  async top(board: BoardKey, limit: number): Promise<BoardRow[]> {
    const flat = await this.redis.zrange<(string | number)[]>(boardKey(board), 0, limit - 1, {
      withScores: true,
    });
    const rows: BoardRow[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      rows.push({ playerId: String(flat[i]), ...fromRankValue(Number(flat[i + 1])) });
    }
    return rows;
  }

  async position(board: BoardKey, playerId: string) {
    const key = boardKey(board);
    const [index, score] = await Promise.all([
      this.redis.zrank(key, playerId),
      this.redis.zscore(key, playerId),
    ]);
    if (index === null || score === null) return null;
    return { index, ...fromRankValue(Number(score)) };
  }

  size(board: BoardKey) {
    return this.redis.zcard(boardKey(board));
  }

  async getNames(playerIds: string[]) {
    if (playerIds.length === 0) return {};
    // 自動変換を切っているので、HMGET はフィールド順の配列のまま返る
    const raw = (await this.redis.hmget(NAMES_KEY, ...playerIds)) as unknown;
    const out: Record<string, string> = {};
    playerIds.forEach((id, i) => {
      const name = Array.isArray(raw) ? raw[i] : (raw as Record<string, unknown> | null)?.[id];
      if (typeof name === "string" && name) out[id] = name;
    });
    return out;
  }

  async setName(playerId: string, name: string) {
    await this.redis.hset(NAMES_KEY, { [playerId]: name });
  }

  getDailyPuzzle(date: string, difficulty: Difficulty) {
    return this.redis.get<string>(puzzleKey(date, difficulty));
  }

  async pinDailyPuzzle(date: string, difficulty: Difficulty, puzzle: string) {
    const key = puzzleKey(date, difficulty);
    const set = await this.redis.set(key, puzzle, { nx: true, ex: PUZZLE_TTL_SEC });
    return set ? puzzle : ((await this.redis.get<string>(key)) ?? puzzle);
  }

  async addHistory(playerId: string, entry: HistoryEntry) {
    const key = historyKey(playerId);
    const p = this.redis.pipeline();
    p.hsetnx(key, historyField(entry), JSON.stringify({ points: entry.points, timeMs: entry.timeMs }));
    p.expire(key, HISTORY_TTL_SEC);
    await p.exec();
  }

  async getHistory(playerId: string) {
    // 自動変換を切っているので、HGETALL はフィールドと値が交互に並んだ配列で返る
    const raw = (await this.redis.hgetall(historyKey(playerId))) as unknown;
    const pairs: [string, string][] = Array.isArray(raw)
      ? raw.flatMap((v, i, a) => (i % 2 === 0 ? [[String(v), String(a[i + 1])] as [string, string]] : []))
      : Object.entries((raw as Record<string, unknown> | null) ?? {}).map(([k, v]) => [k, String(v)]);
    return pairs.map(([k, v]) => toHistory(k, v)).filter((e): e is HistoryEntry => e !== null);
  }

  async putTransfer(code: string, payload: string, ttlSec: number) {
    return (await this.redis.set(transferKey(code), payload, { nx: true, ex: ttlSec })) !== null;
  }

  async takeTransfer(code: string) {
    return this.redis.getdel<string>(transferKey(code));
  }

  async getPushSub(id: string) {
    return toPushSub(await this.redis.get<string>(pushKey(id)));
  }

  countPushSubs() {
    return this.redis.scard(PUSH_SUBS_KEY);
  }

  async putPushSub(id: string, sub: PushSub, now: number) {
    const list = playerPushKey(sub.playerId);
    const p = this.redis.pipeline();
    p.set(pushKey(id), JSON.stringify(sub), { ex: PUSH_TTL_SEC });
    p.sadd(PUSH_SUBS_KEY, id);
    p.zadd(list, { score: now, member: id });
    // 400 日更新されずに中身が消えた購読を一覧から外す
    p.zremrangebyscore(list, "-inf", now - PUSH_TTL_MS);
    p.expire(list, PUSH_TTL_SEC);
    await p.exec();
  }

  async playerPushSubs(playerId: string) {
    const ids = await this.redis.zrange<(string | number)[]>(playerPushKey(playerId), 0, -1);
    return ids.map(String);
  }

  async removePushSub(id: string, playerId: string) {
    const sub = await this.getPushSub(id);
    const p = this.redis.pipeline();
    p.zrem(playerPushKey(playerId), id);
    if (!sub || sub.playerId === playerId) {
      p.del(pushKey(id));
      p.srem(PUSH_SUBS_KEY, id);
    }
    await p.exec();
  }

  async scanPushSubs(cursor: string, count: number) {
    const [next, members] = await this.redis.sscan(PUSH_SUBS_KEY, cursor, { count });
    const ids = members.map(String);
    const subs: { id: string; sub: PushSub }[] = [];
    if (ids.length === 0) return { cursor: String(next), subs };
    const raw = await this.redis.mget<(string | null)[]>(...ids.map(pushKey));
    const gone: string[] = [];
    ids.forEach((id, i) => {
      const sub = toPushSub(raw[i] ?? null);
      if (sub) subs.push({ id, sub });
      else gone.push(id);
    });
    if (gone.length > 0) await this.redis.srem(PUSH_SUBS_KEY, ...gone);
    return { cursor: String(next), subs };
  }

  async markPushSent(date: string, id: string) {
    return (await this.redis.set(pushSentKey(date, id), 1, { nx: true, ex: PUSH_SENT_TTL_SEC })) !== null;
  }

  async unmarkPushSent(date: string, id: string) {
    await this.redis.del(pushSentKey(date, id));
  }

  async addPushFailure(id: string, date: string) {
    // 日付の集合に足すので、同じ日の再実行や同時の実行でも 1 日のまま（読んでから書くときの競合が無い）
    const key = pushFailKey(id);
    const [, , days] = await this.redis
      .pipeline()
      .sadd(key, date)
      .expire(key, PUSH_FAIL_TTL_SEC)
      .scard(key)
      .exec();
    return Number(days);
  }

  async clearPushFailure(id: string) {
    await this.redis.del(pushFailKey(id));
  }

  async clearedOn(playerId: string, date: string) {
    // 全部読まずに、その日の 6 難易度のフィールドだけを見る
    const fields = DIFFICULTIES.map((difficulty) => historyField({ date, difficulty }));
    const raw = (await this.redis.hmget(historyKey(playerId), ...fields)) as unknown;
    const values = Array.isArray(raw) ? raw : Object.values((raw as Record<string, unknown> | null) ?? {});
    return values.some((v) => v !== null && v !== undefined);
  }

  async incrRateWindow(name: string, windowSec: number, now: number) {
    // キーに窓の番号が入るので、期限は使い終わったキーを消すためだけのもの。数えるたびに付け直しても窓は延びない
    // （初回だけ付ける EXPIRE の NX は Redis 7 からなので使わない）
    const key = rateKey(name, windowSec, now);
    const [count] = await this.redis.pipeline().incr(key).expire(key, windowSec).exec();
    return Number(count);
  }
}

/** ローカル開発・テスト用。プロセスが落ちると消える */
export class MemoryStore implements RankingStore {
  private starts = new Map<string, string>();
  private sessions = new Map<string, Session>();
  private boards = new Map<string, Map<string, number>>();
  private names = new Map<string, string>();
  private puzzles = new Map<string, string>();
  private history = new Map<string, Map<string, string>>();
  private transfers = new Map<string, string>();
  private pushSubs = new Map<string, { sub: PushSub; expiresAt: number }>();
  private playerPush = new Map<string, Map<string, number>>();
  private pushSent = new Set<string>();
  private pushFailures = new Map<string, { dates: Set<string>; expiresAt: number }>();
  private rateWindows = new Map<string, { count: number; expiresAt: number }>();

  async startSession(candidate: Session) {
    const existingId = this.starts.get(startKey(candidate));
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) return { ...existing };
    this.starts.set(startKey(candidate), candidate.id);
    this.sessions.set(candidate.id, { ...candidate });
    return { ...candidate };
  }

  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }

  async finishSession(id: string, finishedAt: number) {
    const s = this.sessions.get(id);
    if (!s || s.finishedAt !== undefined) return false;
    s.finishedAt = finishedAt;
    return true;
  }

  private board(b: BoardKey) {
    const key = boardKey(b);
    let map = this.boards.get(key);
    if (!map) this.boards.set(key, (map = new Map()));
    return map;
  }

  private sorted(b: BoardKey): BoardRow[] {
    return [...this.board(b)]
      .sort(([pa, a], [pb, b2]) => a - b2 || (pa < pb ? -1 : 1))
      .map(([playerId, v]) => ({ playerId, ...fromRankValue(v) }));
  }

  async record(date: string, difficulty: Difficulty, row: BoardRow) {
    const value = rankValue(row.points, row.timeMs);
    const daily = this.board({ scope: "daily", date, difficulty });
    if (!daily.has(row.playerId)) daily.set(row.playerId, value);
    const best = this.board({ scope: "best", difficulty });
    const prev = best.get(row.playerId);
    if (prev === undefined || value < prev) best.set(row.playerId, value);
  }

  async top(b: BoardKey, limit: number) {
    return this.sorted(b).slice(0, limit);
  }

  async position(b: BoardKey, playerId: string) {
    const rows = this.sorted(b);
    const index = rows.findIndex((r) => r.playerId === playerId);
    return index === -1 ? null : { index, timeMs: rows[index].timeMs, points: rows[index].points };
  }

  async size(b: BoardKey) {
    return this.board(b).size;
  }

  async getNames(playerIds: string[]) {
    const out: Record<string, string> = {};
    for (const id of playerIds) {
      const name = this.names.get(id);
      if (name) out[id] = name;
    }
    return out;
  }

  async setName(playerId: string, name: string) {
    this.names.set(playerId, name);
  }

  async getDailyPuzzle(date: string, difficulty: Difficulty) {
    return this.puzzles.get(puzzleKey(date, difficulty)) ?? null;
  }

  async pinDailyPuzzle(date: string, difficulty: Difficulty, puzzle: string) {
    const key = puzzleKey(date, difficulty);
    if (!this.puzzles.has(key)) this.puzzles.set(key, puzzle);
    return this.puzzles.get(key)!;
  }

  async addHistory(playerId: string, entry: HistoryEntry) {
    let h = this.history.get(playerId);
    if (!h) this.history.set(playerId, (h = new Map()));
    const field = historyField(entry);
    if (!h.has(field)) h.set(field, JSON.stringify({ points: entry.points, timeMs: entry.timeMs }));
  }

  async getHistory(playerId: string) {
    const h = this.history.get(playerId) ?? new Map<string, string>();
    return [...h].map(([k, v]) => toHistory(k, v)).filter((e): e is HistoryEntry => e !== null);
  }

  async putTransfer(code: string, payload: string) {
    if (this.transfers.has(code)) return false;
    this.transfers.set(code, payload);
    return true;
  }

  async takeTransfer(code: string) {
    const v = this.transfers.get(code) ?? null;
    this.transfers.delete(code);
    return v;
  }

  async getPushSub(id: string) {
    const v = this.pushSubs.get(id);
    return v ? { ...v.sub } : null;
  }

  async countPushSubs() {
    return this.pushSubs.size;
  }

  async putPushSub(id: string, sub: PushSub, now: number) {
    this.pushSubs.set(id, { sub: { ...sub }, expiresAt: now + PUSH_TTL_MS });
    let list = this.playerPush.get(sub.playerId);
    if (!list) this.playerPush.set(sub.playerId, (list = new Map()));
    list.set(id, now);
    for (const [k, t] of list) if (t <= now - PUSH_TTL_MS) list.delete(k);
  }

  /** テスト用：購読が消える時刻 */
  pushExpiresAt(id: string) {
    return this.pushSubs.get(id)?.expiresAt ?? null;
  }

  async playerPushSubs(playerId: string) {
    // Redis の ZRANGE と同じ順（時刻、同じなら id の順）
    return [...(this.playerPush.get(playerId) ?? [])]
      .sort(([a, ta], [b, tb]) => ta - tb || (a < b ? -1 : 1))
      .map(([id]) => id);
  }

  async removePushSub(id: string, playerId: string) {
    this.playerPush.get(playerId)?.delete(id);
    const v = this.pushSubs.get(id);
    if (!v || v.sub.playerId === playerId) this.pushSubs.delete(id);
  }

  async scanPushSubs(cursor: string, count: number) {
    // id の順に読み、最後に返した id を次の cursor にする（途中で消しても読み飛ばさない）
    const rest = [...this.pushSubs.keys()].sort().filter((id) => cursor === "0" || id > cursor);
    const page = rest.slice(0, count);
    const subs = page.map((id) => ({ id, sub: { ...this.pushSubs.get(id)!.sub } }));
    return { cursor: rest.length > count ? page[page.length - 1] : "0", subs };
  }

  async markPushSent(date: string, id: string) {
    const key = pushSentKey(date, id);
    if (this.pushSent.has(key)) return false;
    this.pushSent.add(key);
    return true;
  }

  async unmarkPushSent(date: string, id: string) {
    this.pushSent.delete(pushSentKey(date, id));
  }

  async addPushFailure(id: string, date: string, now: number) {
    // Redis の期限（記録するたびに延ばす）と同じにする
    let v = this.pushFailures.get(id);
    if (!v || v.expiresAt <= now) this.pushFailures.set(id, (v = { dates: new Set(), expiresAt: 0 }));
    v.dates.add(date);
    v.expiresAt = now + PUSH_FAIL_TTL_MS;
    return v.dates.size;
  }

  async clearPushFailure(id: string) {
    this.pushFailures.delete(id);
  }

  /** テスト用：失敗を記録した日（期限は見ない） */
  pushFailureDates(id: string) {
    return [...(this.pushFailures.get(id)?.dates ?? [])].sort();
  }

  async clearedOn(playerId: string, date: string) {
    const h = this.history.get(playerId);
    return DIFFICULTIES.some((difficulty) => h?.has(historyField({ date, difficulty })) ?? false);
  }

  async incrRateWindow(name: string, windowSec: number, now: number) {
    // Redis の期限（数えるたびに windowSec で付け直す）と同じにする。期限の過ぎたカウンタは消す
    for (const [k, v] of this.rateWindows) if (v.expiresAt <= now) this.rateWindows.delete(k);
    const key = rateKey(name, windowSec, now);
    const v = this.rateWindows.get(key) ?? { count: 0, expiresAt: 0 };
    v.count++;
    v.expiresAt = now + windowSec * 1000;
    this.rateWindows.set(key, v);
    return v.count;
  }

  /** テスト用：回数制限のカウンタのキー */
  rateWindowKeys() {
    return [...this.rateWindows.keys()].sort();
  }
}

let cachedRedis: Redis | null | undefined;

/** 環境変数に Redis の接続先があれば、その Redis クライアント（1 つを使い回す）。無ければ null */
export function redisFromEnv(): Redis | null {
  if (cachedRedis !== undefined) return cachedRedis;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  // 名前が "123" や "null" でも文字列のまま扱えるよう、値の自動 JSON 変換は使わない
  cachedRedis = url && token ? new Redis({ url, token, automaticDeserialization: false }) : null;
  return cachedRedis;
}

let cached: RankingStore | null | undefined;

/**
 * 環境変数から保存先を決める。Vercel 上で Redis が未設定なら null（API は 503 を返す）。
 * サーバーレスではメモリ保存は呼び出しごとに消えるので、本番では使わない。
 */
export function getStore(): RankingStore | null {
  if (cached !== undefined) return cached;
  const redis = redisFromEnv();
  if (redis) {
    cached = new RedisStore(redis);
  } else if (process.env.VERCEL) {
    cached = null;
  } else {
    cached = new MemoryStore();
  }
  return cached;
}
