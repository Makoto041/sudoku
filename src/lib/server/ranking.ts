import { isDifficulty, isValidSolution, parseGrid, serializeGrid, type Difficulty } from "@/lib/sudoku/core";
import { generateDaily, jstDateKey } from "@/lib/sudoku/generator";
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
  const ok =
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  if (!ok) throw new RankingError(400, "invalid date");
  return value;
}

/**
 * 表示名を整える：NFKC 正規化、制御文字と前後の空白を除き、最大 NAME_MAX 文字。
 * 絵文字の結合（ZWJ・異体字セレクタ）は残し、見た目が空になる名前は受け付けない。
 */
export function sanitizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFKC")
    .replace(/(?![\u200d\ufe0f])\p{C}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = [...cleaned].slice(0, NAME_MAX).join("");
  if (!name || /^[\p{M}\p{Z}\u200d\ufe0f\u115f\u1160\u3164\u2800\uffa0]*$/u.test(name)) return null;
  return name;
}

/**
 * その日の問題（81 文字）。最初に作ったものを保存先に固定するので、
 * 生成のコードを日中に変えてデプロイしても、同じ日は全員が同じ問題になる。
 */
const dailyCaches = new WeakMap<RankingStore, Map<string, string>>();
export async function dailyPuzzle(
  store: RankingStore,
  date: string,
  difficulty: Difficulty,
): Promise<string> {
  let cache = dailyCaches.get(store);
  if (!cache) dailyCaches.set(store, (cache = new Map()));
  const key = `${date}:${difficulty}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const puzzle =
    (await store.getDailyPuzzle(date, difficulty)) ??
    (await store.pinDailyPuzzle(date, difficulty, serializeGrid(generateDaily(date, difficulty).puzzle)));
  cache.set(key, puzzle);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return puzzle;
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
    puzzle: await dailyPuzzle(store, date, difficulty),
  });
  return {
    sessionId: session.id,
    date: session.date,
    difficulty: session.difficulty,
    puzzle: session.puzzle ?? (await dailyPuzzle(store, session.date, session.difficulty)),
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

  const puzzle = session.puzzle ?? (await dailyPuzzle(store, session.date, session.difficulty));
  if (!isValidSolution(parseGrid(puzzle), parseGrid(input.grid))) {
    throw new RankingError(422, "incorrect solution");
  }
  const timeMs = now - session.startedAt;
  if (timeMs < MIN_PLAUSIBLE_MS) throw new RankingError(422, "too fast");

  // 記録は何度書いても同じ結果になる（日次は最初の 1 回、歴代は速いほう）ので先に書き、
  // 完了の印は最後に付ける。途中で失敗しても再送で記録できる
  await store.setName(playerId, name);
  await store.record(session.date, session.difficulty, { playerId, timeMs });
  if (!(await store.finishSession(session.id, now))) throw new RankingError(409, "already submitted");

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
