import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import type { MoveLog } from "@/lib/game/score";
import type { ClearRecord } from "./records";
import type { Stats } from "./stats";
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
  /** スコア制になる前に保存した結果には無い */
  points?: number;
  timeBonus?: number;
  rank: number | null;
  total: number;
};

export type LeaderboardEntry = { rank: number; name: string; points: number; timeMs: number; isMe: boolean };

export type LeaderboardResponse = {
  scope: "daily" | "best";
  date: string | null;
  difficulty: Difficulty;
  total: number;
  entries: LeaderboardEntry[];
  me: { rank: number; points: number; timeMs: number; name: string | null } | null;
};

/** ログイン中のアカウント（GET /api/auth/me などの応答）。stats は同期した記録で、使う前に検証する */
export type AccountView = { playerId: string; name: string | null; passkeys: number; stats: unknown };

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
  submit: (input: { sessionId: string; playerId: string; grid: string; name: string; moves: MoveLog }) =>
    request<SubmitResponse>("/api/daily/submit", { method: "POST", body: JSON.stringify(input) }),
  leaderboard: (q: { scope: "daily" | "best"; difficulty: Difficulty; date?: string; playerId?: string }) => {
    const params = new URLSearchParams({ scope: q.scope, difficulty: q.difficulty });
    if (q.date) params.set("date", q.date);
    if (q.playerId) params.set("playerId", q.playerId);
    return request<LeaderboardResponse>(`/api/leaderboard?${params}`);
  },
  history: (playerId: string) =>
    request<{ entries: ClearRecord[] }>(`/api/player/history?${new URLSearchParams({ playerId })}`),
  transfer: (input: { playerId: string; name: string | null; stats: unknown }) =>
    request<{ code: string; expiresAt: number }>("/api/player/transfer", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  claim: (code: string) =>
    request<{ playerId: string; name: string | null; stats: unknown }>("/api/player/claim", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  rename: (playerId: string, name: string) =>
    request<{ name: string }>("/api/player", { method: "POST", body: JSON.stringify({ playerId, name }) }),
  /** 通知の公開鍵。値は検査してから使う */
  pushKey: () => request<{ publicKey?: unknown }>("/api/push"),
  subscribePush: (playerId: string, subscription: PushSubscriptionJSON) =>
    request<{ ok: true }>("/api/push", { method: "POST", body: JSON.stringify({ playerId, subscription }) }),
  unsubscribePush: (playerId: string, endpoint: string) =>
    request<{ ok: true }>("/api/push", { method: "DELETE", body: JSON.stringify({ playerId, endpoint }) }),
  // アカウント（パスキー）。ログインの状態は Cookie で持つ。GET 以外は本文が JSON でないと受け付けない（本文なしも不可）
  /** ログイン中のアカウント。値は検査してから使う */
  me: () => request<{ account?: unknown }>("/api/auth/me"),
  signupOptions: (playerId: string) =>
    request<{ options: PublicKeyCredentialCreationOptionsJSON }>("/api/auth/signup/options", {
      method: "POST",
      body: JSON.stringify({ playerId }),
    }),
  signupVerify: (response: RegistrationResponseJSON) =>
    request<{ account?: unknown }>("/api/auth/signup/verify", {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
  loginOptions: () =>
    request<{ options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/login/options", {
      method: "POST",
      body: "{}",
    }),
  loginVerify: (response: AuthenticationResponseJSON) =>
    request<{ account?: unknown }>("/api/auth/login/verify", {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
  passkeyOptions: () =>
    request<{ options: PublicKeyCredentialCreationOptionsJSON }>("/api/auth/passkeys/options", {
      method: "POST",
      body: "{}",
    }),
  passkeyVerify: (response: RegistrationResponseJSON) =>
    request<{ account?: unknown }>("/api/auth/passkeys/verify", {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
  logout: (scope: "this" | "others") =>
    request<{ ok: true }>("/api/auth/logout", { method: "POST", body: JSON.stringify({ scope }) }),
  deleteAccount: () => request<{ ok: true }>("/api/auth/account", { method: "DELETE", body: "{}" }),
  putStats: (stats: Stats) =>
    request<{ stats?: unknown }>("/api/auth/stats", { method: "PUT", body: JSON.stringify({ stats }) }),
  merge: (fromPlayerId: string) =>
    request<{ merged: number }>("/api/auth/merge", {
      method: "POST",
      body: JSON.stringify({ fromPlayerId }),
    }),
};

/**
 * 今日の一問の送信が、記録できる最短の時間より前だった（422 too fast）。時間はサーバーが開始から測り、断った送信は
 * 完了にならないので、送り直せば記録できる
 */
export function isTooFast(err: unknown): boolean {
  return err instanceof ApiError && err.status === 422 && err.message === "too fast";
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "オフラインです";
    if (err.status === 503) return "ランキングは準備中です";
    if (err.status === 404) return "記録の期限が切れています";
    if (err.status === 409) return "記録済みです";
    if (isTooFast(err)) return "速すぎるため記録できませんでした";
    if (err.status === 422) return "記録できませんでした";
    if (err.status === 429) return "しばらくしてからもう一度試してください";
  }
  return "通信に失敗しました";
}

/**
 * 引き継ぎコードを発行できなかったときの文言。全体の上限（503 too many codes）は、保存先が無い 503 と応答の error で
 * 見分ける。ほかは describeError
 */
export function describeIssueError(err: unknown): string {
  return err instanceof ApiError && err.status === 503 && err.message === "too many codes"
    ? "いまは発行できません。しばらくしてからもう一度試してください"
    : describeError(err);
}
