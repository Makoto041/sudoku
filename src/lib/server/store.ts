import { Redis } from "@upstash/redis";
import type { Difficulty } from "@/lib/sudoku/core";

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
}

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
const HISTORY_TTL_SEC = 800 * 24 * 60 * 60;
const transferKey = (code: string) => `${PREFIX}:xfer:${code}`;

function toHistory(field: string, value: string): HistoryEntry | null {
  const [date, difficulty] = field.split(":");
  try {
    const v = JSON.parse(value) as { points: number | null; timeMs: number };
    return { date, difficulty: difficulty as Difficulty, points: v.points ?? null, timeMs: v.timeMs };
  } catch {
    return null;
  }
}

class RedisStore implements RankingStore {
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
    p.hsetnx(
      key,
      `${entry.date}:${entry.difficulty}`,
      JSON.stringify({ points: entry.points, timeMs: entry.timeMs }),
    );
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
    const field = `${entry.date}:${entry.difficulty}`;
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
}

let cached: RankingStore | null | undefined;

/**
 * 環境変数から保存先を決める。Vercel 上で Redis が未設定なら null（API は 503 を返す）。
 * サーバーレスではメモリ保存は呼び出しごとに消えるので、本番では使わない。
 */
export function getStore(): RankingStore | null {
  if (cached !== undefined) return cached;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    // 名前が "123" や "null" でも文字列のまま扱えるよう、値の自動 JSON 変換は使わない
    cached = new RedisStore(new Redis({ url, token, automaticDeserialization: false }));
  } else if (process.env.VERCEL) {
    cached = null;
  } else {
    cached = new MemoryStore();
  }
  return cached;
}
