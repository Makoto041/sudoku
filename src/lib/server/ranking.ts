import { isDifficulty, isValidSolution, parseGrid, serializeGrid, type Difficulty } from "@/lib/sudoku/core";
import { generateDaily, jstDateKey } from "@/lib/sudoku/generator";
import { scoreMoves, timeBonus, type MoveLog } from "@/lib/game/score";
import { CODE_ALPHABET, CODE_LENGTH, normalizeCode } from "@/lib/transfer-code";
import { withinIpLimit } from "./ip";
import { rateWindowResetSec, type BoardKey, type RankingStore, type Session } from "./store";

/** 人が解けるとは考えにくい速さ。これより速い送信は記録しない */
export const MIN_PLAUSIBLE_MS = 15_000;
export const LEADERBOARD_LIMIT = 50;
export const NAME_MAX = 12;

/** 本文の上限（今日の一問の開始・名前の変更・引き継ぎコードの使用） */
export const RANKING_MAX_BODY_BYTES = 1024;
/** 本文の上限（引き継ぎコードの発行。保存する中身は MAX_STATS_BYTES まで） */
export const TRANSFER_MAX_BODY_BYTES = 8 * 1024;
/**
 * 本文の上限（今日の一問の送信）。端末は手の時刻を整数の ms で送る。手の記録が MAX_MOVES 手で、時刻がすべて
 * 安全な整数の最も長い形（-9007199254740991）でも、本文は約 50KB に収まる
 */
export const SUBMIT_MAX_BODY_BYTES = 64 * 1024;

/**
 * 回数制限（固定窓）。超えたら 429。IP ごとの枠は通知の購読と同じ（withinIpLimit。IPv6 は /64 と、その 8 倍の /48）。
 * 数えるのは形の検査を通ったあと、保存先を読み書きする前。今日の一問の送信と名前の変更は数えない
 * （数えること自体が保存先のコマンドを使う。送信には有効なセッションが要る）
 */
export const RANKING_RATE_LIMITS = {
  /** 今日の一問の開始。IP ごと */
  start: { limit: 240, windowSec: 60 * 60 },
  /** 引き継ぎコードの発行。IP ごと（正当な利用は 1〜2 回で足りる） */
  transfer: { limit: 10, windowSec: 60 * 60 },
  /** 引き継ぎコードの発行。全体の回数が TRANSFER_BUSY_AT 以上の窓での IP ごと（transfer と同じカウンタで数える） */
  transferBusy: { limit: 2, windowSec: 60 * 60 },
  /** 引き継ぎコードの発行。playerId ごと（playerId は端末が選べるので、主な歯止めは IP ごとの制限） */
  transferPlayer: { limit: 100, windowSec: 24 * 60 * 60 },
  /**
   * 引き継ぎコードの発行。全体（超えたら 429 でなく 503 と Retry-After）。コードは 1 件 約 4KB で 24 時間残るので、
   * 多数の IP からの発行で保存先の容量を埋めさせない（代わりに、超えると窓が変わるまで誰も発行できない）
   */
  transferTotal: { limit: 300, windowSec: 60 * 60 },
  /** 引き継ぎコードの使用（形の正しいコードだけ。見つからないコードも数える）。IP ごと */
  claim: { limit: 100, windowSec: 60 * 60 },
} as const;

/** 全体の発行がこの回数（全体の上限の 7 割）に達した窓では、IP ごとの上限を transferBusy に下げる */
export const TRANSFER_BUSY_AT = 210;
const TRANSFER_TOTAL = "xfer:total";

export class RankingError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 応答の Retry-After（秒）。無ければ付けない */
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** 要求元。route は必ず渡す（渡さなければ回数を数えない） */
export type Client = { ip: string | null };

type Rule = { limit: number; windowSec: number };

async function limit(store: RankingStore, name: string, rule: Rule, now: number) {
  if ((await store.incrRateWindow(name, rule.windowSec, now)) > rule.limit) {
    throw new RankingError(429, "rate limited");
  }
}

async function limitIp(store: RankingStore, prefix: string, client: Client, rule: Rule, now: number) {
  if (!(await withinIpLimit(store, prefix, client.ip, rule, now))) {
    throw new RankingError(429, "rate limited");
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

/** 今日の一問を始める。client を渡すと（route は必ず渡す）、IP ごとの回数を RANKING_RATE_LIMITS.start で制限する */
export async function startDaily(
  store: RankingStore,
  input: { playerId?: unknown; difficulty?: unknown },
  now = Date.now(),
  client?: Client,
) {
  const playerId = assertPlayerId(input.playerId);
  const difficulty = assertDifficulty(input.difficulty);
  // 問題の固定（dailyPuzzle）も保存先に書くので、その前に数える
  if (client) await limitIp(store, "daily:", client, RANKING_RATE_LIMITS.start, now);
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
  input: { sessionId?: unknown; playerId?: unknown; grid?: unknown; name?: unknown; moves?: unknown },
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
  const moves = parseMoves(input.moves);

  const session: Session | null = await store.getSession(input.sessionId);
  if (!session || session.playerId !== playerId) throw new RankingError(404, "session not found");
  if (session.finishedAt !== undefined) throw new RankingError(409, "already submitted");

  const puzzle = parseGrid(session.puzzle ?? (await dailyPuzzle(store, session.date, session.difficulty)));
  const solution = parseGrid(input.grid);
  if (!isValidSolution(puzzle, solution)) {
    throw new RankingError(422, "incorrect solution");
  }
  const timeMs = now - session.startedAt;
  if (timeMs < MIN_PLAUSIBLE_MS) throw new RankingError(422, "too fast");
  // 点数は送られてきた手の記録をサーバーで計算し直す（端末の点数は使わない）。
  // 解は 1 つなので、正しいと確かめた盤面がそのまま解答になる
  const bonus = timeBonus(session.difficulty, puzzle, timeMs);
  const points = scoreMoves(puzzle, solution, session.difficulty, moves, timeMs).points + bonus;

  // 記録は何度書いても同じ結果になる（日次は最初の 1 回、歴代は良いほう）ので先に書き、
  // 完了の印は最後に付ける。途中で失敗しても再送で記録できる
  await store.setName(playerId, name);
  await store.record(session.date, session.difficulty, { playerId, timeMs, points });
  await store.addHistory(playerId, { date: session.date, difficulty: session.difficulty, points, timeMs });
  if (!(await store.finishSession(session.id, now))) throw new RankingError(409, "already submitted");

  const board: BoardKey = { scope: "daily", date: session.date, difficulty: session.difficulty };
  const [pos, total] = await Promise.all([store.position(board, playerId), store.size(board)]);
  return {
    date: session.date,
    difficulty: session.difficulty,
    timeMs,
    points,
    timeBonus: bonus,
    rank: pos ? pos.index + 1 : null,
    total,
  };
}

export const MAX_MOVES = 2000;

/** 手の記録 [開始からの ms, マス, 数字][] を検査する。無ければ空（古い端末から） */
function parseMoves(value: unknown): MoveLog {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_MOVES) throw new RankingError(400, "invalid moves");
  return value.map((m) => {
    if (!Array.isArray(m) || m.length !== 3) throw new RankingError(400, "invalid moves");
    const [t, cell, digit] = m;
    const ok =
      typeof t === "number" &&
      Number.isFinite(t) &&
      Number.isInteger(cell) &&
      cell >= 0 &&
      cell < 81 &&
      Number.isInteger(digit) &&
      digit >= 1 &&
      digit <= 9;
    if (!ok) throw new RankingError(400, "invalid moves");
    return [t, cell, digit] as [number, number, number];
  });
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

  // 点数もタイムも同じなら同順位にする
  let last = "";
  let lastRank = 0;
  const entries = rows.map((r, i) => {
    const key = `${r.points}:${r.timeMs}`;
    const rank = key === last ? lastRank : i + 1;
    last = key;
    lastRank = rank;
    return {
      rank,
      name: names[r.playerId] ?? "名無し",
      points: r.points,
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
      ? {
          rank: mine.index + 1,
          points: mine.points,
          timeMs: mine.timeMs,
          name: playerId ? (names[playerId] ?? null) : null,
        }
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

/** 今日の一問のクリア履歴（記録画面用） */
export async function getHistory(store: RankingStore, input: { playerId?: unknown }) {
  const playerId = assertPlayerId(input.playerId);
  const entries = await store.getHistory(playerId);
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { entries };
}

const TRANSFER_TTL_SEC = 24 * 60 * 60;
export const MAX_STATS_BYTES = 4096;

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/**
 * 引き継ぎコードを発行する。24 時間有効で、1 回だけ使える。保存する中身は UTF-8 で MAX_STATS_BYTES まで。
 * client を渡すと（route は必ず渡す）、IP ごと・playerId ごと・全体の回数を制限する。この順に数え、先の制限で
 * 断った分は後の回数に数えない（1 つの IP が 429 を受けながら全体の枠を使い切れないように）。全体が TRANSFER_BUSY_AT
 * に達した窓では、IP ごとの上限を下げる（少ない IP で全体の枠の残りを使い切らせない）
 */
export async function createTransfer(
  store: RankingStore,
  input: { playerId?: unknown; name?: unknown; stats?: unknown },
  now = Date.now(),
  client?: Client,
) {
  const playerId = assertPlayerId(input.playerId);
  const name = input.name === null || input.name === undefined ? null : sanitizeName(input.name);
  const stats = input.stats ?? null;
  const payload = JSON.stringify({ playerId, name, stats });
  if (Buffer.byteLength(payload) > MAX_STATS_BYTES) throw new RankingError(400, "too large");
  if (client) {
    const { transfer, transferBusy, transferPlayer, transferTotal: total } = RANKING_RATE_LIMITS;
    // 全体は読むだけ（数えるのは IP・playerId を通ったあと）
    const busy = (await store.peekRateWindow(TRANSFER_TOTAL, total.windowSec, now)) >= TRANSFER_BUSY_AT;
    await limitIp(store, "xfer:", client, busy ? transferBusy : transfer, now);
    await limit(store, `xfer:player:${playerId}`, transferPlayer, now);
    if ((await store.incrRateWindow(TRANSFER_TOTAL, total.windowSec, now)) > total.limit) {
      throw new RankingError(503, "too many codes", rateWindowResetSec(total.windowSec, now));
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    if (await store.putTransfer(code, payload, TRANSFER_TTL_SEC)) {
      return { code, expiresAt: now + TRANSFER_TTL_SEC * 1000 };
    }
  }
  throw new RankingError(500, "could not create code");
}

/**
 * 引き継ぎコードを使う。プレイヤー ID・名前・端末の記録を返し、コードは消える。
 * client を渡すと（route は必ず渡す）、形の正しいコードの使用を IP ごとに制限する（見つからないコードも数える）
 */
export async function claimTransfer(
  store: RankingStore,
  input: { code?: unknown },
  now = Date.now(),
  client?: Client,
) {
  const code = normalizeCode(input.code);
  if (!code) throw new RankingError(400, "invalid code");
  if (client) await limitIp(store, "claim:", client, RANKING_RATE_LIMITS.claim, now);
  const raw = await store.takeTransfer(code);
  if (!raw) throw new RankingError(404, "code not found");
  const data = JSON.parse(raw) as { playerId: string; name: string | null; stats: unknown };
  return { playerId: data.playerId, name: data.name, stats: data.stats ?? null };
}
