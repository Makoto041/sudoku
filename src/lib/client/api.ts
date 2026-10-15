import type { Difficulty } from "@/lib/sudoku/core";

export type StartResponse = {
  sessionId: string;
  date: string;
  difficulty: Difficulty;
  puzzle: string;
  startedAt: number;
  serverNow: number;
  finished: boolean;
};

export type SubmitResponse = {
  date: string;
  difficulty: Difficulty;
  timeMs: number;
  rank: number | null;
  total: number;
};

export type LeaderboardEntry = { rank: number; name: string; timeMs: number; isMe: boolean };

export type LeaderboardResponse = {
  scope: "daily" | "best";
  date: string | null;
  difficulty: Difficulty;
  total: number;
  entries: LeaderboardEntry[];
  me: { rank: number; timeMs: number; name: string | null } | null;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "offline");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  start: (playerId: string, difficulty: Difficulty) =>
    request<StartResponse>("/api/daily/start", {
      method: "POST",
      body: JSON.stringify({ playerId, difficulty }),
    }),
  submit: (input: { sessionId: string; playerId: string; grid: string; name: string }) =>
    request<SubmitResponse>("/api/daily/submit", { method: "POST", body: JSON.stringify(input) }),
  leaderboard: (q: { scope: "daily" | "best"; difficulty: Difficulty; date?: string; playerId?: string }) => {
    const params = new URLSearchParams({ scope: q.scope, difficulty: q.difficulty });
    if (q.date) params.set("date", q.date);
    if (q.playerId) params.set("playerId", q.playerId);
    return request<LeaderboardResponse>(`/api/leaderboard?${params}`);
  },
  rename: (playerId: string, name: string) =>
    request<{ name: string }>("/api/player", { method: "POST", body: JSON.stringify({ playerId, name }) }),
};

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "オフラインのため接続できませんでした";
    if (err.status === 503) return "ランキングは準備中です";
    if (err.status === 409) return "この問題は記録済みです";
    if (err.status === 422) return "記録できませんでした";
  }
  return "通信に失敗しました。もう一度お試しください";
}
