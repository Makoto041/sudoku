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

export type BoardRow = { playerId: string; timeMs: number };

/** ランキングの保存先。本番は Upstash Redis、ローカル開発とテストはメモリ */
export interface RankingStore {
  /** 同じプレイヤー・日付・難易度で既に始めていればそのセッションを返す（最初の開始だけが有効） */
  startSession(candidate: Session): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  /** セッションを完了にする。既に完了していたら false */
  finishSession(id: string, finishedAt: number): Promise<boolean>;
  /** 記録を追加。日次は最初の 1 回、歴代はより速いときだけ更新する */
  record(date: string, difficulty: Difficulty, row: BoardRow): Promise<void>;
  top(board: BoardKey, limit: number): Promise<BoardRow[]>;
  /** 0 始まりの順位と記録。載っていなければ null */
  position(board: BoardKey, playerId: string): Promise<{ index: number; timeMs: number } | null>;
  size(board: BoardKey): Promise<number>;
  getNames(playerIds: string[]): Promise<Record<string, string>>;
  setName(playerId: string, name: string): Promise<void>;
  getDailyPuzzle(date: string, difficulty: Difficulty): Promise<string | null>;
  /** その日の問題を固定する。既に固定されていればそちらを返す */
  pinDailyPuzzle(date: string, difficulty: Difficulty, puzzle: string): Promise<string>;
}

const SESSION_TTL_SEC = 3 * 24 * 60 * 60;
const DAILY_TTL_SEC = 400 * 24 * 60 * 60;
const PREFIX = "sdk";

const boardKey = (b: BoardKey) =>
  b.scope === "daily" ? `${PREFIX}:lb:${b.date}:${b.difficulty}` : `${PREFIX}:best:${b.difficulty}`;
const startKey = (s: Pick<Session, "playerId" | "date" | "difficulty">) =>
  `${PREFIX}:start:${s.date}:${s.difficulty}:${s.playerId}`;
const sessionKey = (id: string) => `${PREFIX}:sess:${id}`;
const NAMES_KEY = `${PREFIX}:names`;
const puzzleKey = (date: string, difficulty: Difficulty) => `${PREFIX}:puzzle:${date}:${difficulty}`;
const PUZZLE_TTL_SEC = 7 * 24 * 60 * 60;

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
    p.zadd(daily, { nx: true }, { score: row.timeMs, member: row.playerId });
    p.expire(daily, DAILY_TTL_SEC);
    p.zadd(
      boardKey({ scope: "best", difficulty }),
      { lt: true },
      { score: row.timeMs, member: row.playerId },
    );
    await p.exec();
  }

  async top(board: BoardKey, limit: number): Promise<BoardRow[]> {
    const flat = await this.redis.zrange<(string | number)[]>(boardKey(board), 0, limit - 1, {
      withScores: true,
    });
    const rows: BoardRow[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      rows.push({ playerId: String(flat[i]), timeMs: Number(flat[i + 1]) });
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
    return { index, timeMs: Number(score) };
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
}

/** ローカル開発・テスト用。プロセスが落ちると消える */
export class MemoryStore implements RankingStore {
  private starts = new Map<string, string>();
  private sessions = new Map<string, Session>();
  private boards = new Map<string, Map<string, number>>();
  private names = new Map<string, string>();
  private puzzles = new Map<string, string>();

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
      .map(([playerId, timeMs]) => ({ playerId, timeMs }))
      .sort((x, y) => x.timeMs - y.timeMs || (x.playerId < y.playerId ? -1 : 1));
  }

  async record(date: string, difficulty: Difficulty, row: BoardRow) {
    const daily = this.board({ scope: "daily", date, difficulty });
    if (!daily.has(row.playerId)) daily.set(row.playerId, row.timeMs);
    const best = this.board({ scope: "best", difficulty });
    const prev = best.get(row.playerId);
    if (prev === undefined || row.timeMs < prev) best.set(row.playerId, row.timeMs);
  }

  async top(b: BoardKey, limit: number) {
    return this.sorted(b).slice(0, limit);
  }

  async position(b: BoardKey, playerId: string) {
    const rows = this.sorted(b);
    const index = rows.findIndex((r) => r.playerId === playerId);
    return index === -1 ? null : { index, timeMs: rows[index].timeMs };
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
