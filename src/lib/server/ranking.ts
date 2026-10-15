import { isDifficulty, isValidSolution, parseGrid, serializeGrid, type Difficulty } from "@/lib/sudoku/core";
import { generateDaily, jstDateKey, type Puzzle } from "@/lib/sudoku/generator";
import type { BoardKey, RankingStore, Session } from "./store";

/** 人が解けるとは考えにくい速さ。これより速い送信は記録しない */
export const MIN_PLAUSIBLE_MS = 15_000;
export const LEADERBOARD_LIMIT = 50;
export const NAME_MAX = 12;

export class RankingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertPlayerId(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new RankingError(400, "invalid player id");
  }
  return value;
}

export function assertDifficulty(value: unknown): Difficulty {
  if (!isDifficulty(value)) throw new RankingError(400, "invalid difficulty");
  return value;
}

export function assertDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RankingError(400, "invalid date");
  }
  return value;
}

/** 表示名を整える：NFKC 正規化、制御文字と前後の空白を除き、最大 NAME_MAX 文字 */
export function sanitizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\p{C}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = [...cleaned].slice(0, NAME_MAX).join("");
  return name.length > 0 ? name : null;
}

// 日次の問題は日付と難易度で決まるので、同じインスタンス内では作り直さない
const dailyCache = new Map<string, Puzzle>();
export function dailyPuzzle(date: string, difficulty: Difficulty): Puzzle {
  const key = `${date}:${difficulty}`;
  let p = dailyCache.get(key);
  if (!p) {
    p = generateDaily(date, difficulty);
    dailyCache.set(key, p);
    if (dailyCache.size > 32) dailyCache.delete(dailyCache.keys().next().value!);
  }
  return p;
}

export async function startDaily(
  store: RankingStore,
  input: { playerId?: unknown; difficulty?: unknown },
  now = Date.now(),
) {
  const playerId = assertPlayerId(input.playerId);
  const difficulty = assertDifficulty(input.difficulty);
  const date = jstDateKey(new Date(now));
  const session = await store.startSession({
    id: crypto.randomUUID(),
    playerId,
    date,
    difficulty,
    startedAt: now,
  });
  const puzzle = dailyPuzzle(session.date, session.difficulty);
  return {
    sessionId: session.id,
    date: session.date,
    difficulty: session.difficulty,
    puzzle: serializeGrid(puzzle.puzzle),
    startedAt: session.startedAt,
    serverNow: now,
    finished: session.finishedAt !== undefined,
  };
}

export async function submitDaily(
  store: RankingStore,
  input: { sessionId?: unknown; playerId?: unknown; grid?: unknown; name?: unknown },
  now = Date.now(),
) {
  const playerId = assertPlayerId(input.playerId);
  if (typeof input.sessionId !== "string" || !UUID_RE.test(input.sessionId)) {
    throw new RankingError(400, "invalid session");
  }
  if (typeof input.grid !== "string" || !/^[1-9]{81}$/.test(input.grid)) {
    throw new RankingError(400, "invalid grid");
  }
  const name = sanitizeName(input.name);
  if (!name) throw new RankingError(400, "invalid name");

  const session: Session | null = await store.getSession(input.sessionId);
  if (!session || session.playerId !== playerId) throw new RankingError(404, "session not found");
  if (session.finishedAt !== undefined) throw new RankingError(409, "already submitted");

  const puzzle = dailyPuzzle(session.date, session.difficulty);
  if (!isValidSolution(puzzle.puzzle, parseGrid(input.grid))) {
    throw new RankingError(422, "incorrect solution");
  }
  const timeMs = now - session.startedAt;
  if (timeMs < MIN_PLAUSIBLE_MS) throw new RankingError(422, "too fast");

  if (!(await store.finishSession(session.id, now))) throw new RankingError(409, "already submitted");
  await store.setName(playerId, name);
  await store.record(session.date, session.difficulty, { playerId, timeMs });

  const board: BoardKey = { scope: "daily", date: session.date, difficulty: session.difficulty };
  const [pos, total] = await Promise.all([store.position(board, playerId), store.size(board)]);
  return {
    date: session.date,
    difficulty: session.difficulty,
    timeMs,
    rank: pos ? pos.index + 1 : null,
    total,
  };
}

export async function getLeaderboard(
  store: RankingStore,
  input: { scope: unknown; date?: unknown; difficulty: unknown; playerId?: unknown },
  now = Date.now(),
) {
  const difficulty = assertDifficulty(input.difficulty);
  const playerId = input.playerId ? assertPlayerId(input.playerId) : null;
  const board: BoardKey =
    input.scope === "best"
      ? { scope: "best", difficulty }
      : { scope: "daily", difficulty, date: input.date ? assertDate(input.date) : jstDateKey(new Date(now)) };

  const [rows, total, mine] = await Promise.all([
    store.top(board, LEADERBOARD_LIMIT),
    store.size(board),
    playerId ? store.position(board, playerId) : Promise.resolve(null),
  ]);
  const names = await store.getNames(rows.map((r) => r.playerId));
  if (playerId && !names[playerId]) Object.assign(names, await store.getNames([playerId]));

  // 同タイムは同順位にする
  let lastTime = -1;
  let lastRank = 0;
  const entries = rows.map((r, i) => {
    const rank = r.timeMs === lastTime ? lastRank : i + 1;
    lastTime = r.timeMs;
    lastRank = rank;
    return {
      rank,
      name: names[r.playerId] ?? "名無し",
      timeMs: r.timeMs,
      isMe: r.playerId === playerId,
    };
  });

  return {
    scope: board.scope,
    date: board.scope === "daily" ? board.date : null,
    difficulty,
    total,
    entries,
    me: mine
      ? { rank: mine.index + 1, timeMs: mine.timeMs, name: playerId ? (names[playerId] ?? null) : null }
      : null,
  };
}

export async function renamePlayer(store: RankingStore, input: { playerId?: unknown; name?: unknown }) {
  const playerId = assertPlayerId(input.playerId);
  const name = sanitizeName(input.name);
  if (!name) throw new RankingError(400, "invalid name");
  await store.setName(playerId, name);
  return { name };
}
