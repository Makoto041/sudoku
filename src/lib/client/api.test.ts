import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, describeError, describeIssueError, isTooFast } from "./api";

describe("GET の playerId", () => {
  // ダミーの ID
  const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  /** fetch を差し替え、送った URL とヘッダーを返す */
  function stubFetch(body: unknown) {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body));
    vi.stubGlobal("fetch", fetch);
    return () =>
      fetch.mock.calls.map(([url, init]) => ({
        url,
        headers: new Headers(init?.headers),
        method: init?.method,
      }));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("表と履歴の取得は、playerId をクエリに入れず x-player-id ヘッダーで送る", async () => {
    const sent = stubFetch({ entries: [] });
    await api.leaderboard({ scope: "daily", difficulty: "easy", date: "2026-10-25", playerId: ID });
    await api.history(ID);
    const [board, history] = sent();
    expect(board.url).toBe("/api/leaderboard?scope=daily&difficulty=easy&date=2026-10-25");
    expect(history.url).toBe("/api/player/history");
    for (const req of [board, history]) {
      expect(req.url).not.toContain(ID);
      expect(req.url).not.toContain("playerId");
      expect(req.method).toBeUndefined();
      expect(req.headers.get("x-player-id")).toBe(ID);
    }
  });

  it("playerId の無い表の取得は、ヘッダーを付けない（CDN のキャッシュに載る公開の要求）", async () => {
    const sent = stubFetch({ entries: [] });
    await api.leaderboard({ scope: "best", difficulty: "hard" });
    const [board] = sent();
    expect(board.url).toBe("/api/leaderboard?scope=best&difficulty=hard");
    expect(board.headers.has("x-player-id")).toBe(false);
  });
});

describe("describeError", () => {
  it("回数の上限（429）は時間をおくよう示す。ほかの状態は今までどおり", () => {
    expect(describeError(new ApiError(429, "rate limited"))).toBe("しばらくしてからもう一度試してください");
    expect(describeError(new ApiError(0, "offline"))).toBe("オフラインです");
    expect(describeError(new ApiError(413, "too large"))).toBe("通信に失敗しました");
    expect(describeError(new Error("x"))).toBe("通信に失敗しました");
  });

  it("今日の一問の送信が下限より速い（422 too fast）ときはそう示す。ほかの 422 は今までどおり", () => {
    expect(describeError(new ApiError(422, "too fast"))).toBe("速すぎるため記録できませんでした");
    expect(describeError(new ApiError(422, "incorrect solution"))).toBe("記録できませんでした");
    expect(describeError(new ApiError(422, "incomplete moves"))).toBe("記録できませんでした");
  });
});

describe("isTooFast", () => {
  it("422 too fast だけ（送り直せば記録できる）", () => {
    expect(isTooFast(new ApiError(422, "too fast"))).toBe(true);
    expect(isTooFast(new ApiError(422, "incomplete moves"))).toBe(false);
    expect(isTooFast(new ApiError(400, "too fast"))).toBe(false);
    expect(isTooFast(new Error("too fast"))).toBe(false);
  });
});

describe("describeIssueError", () => {
  it("全体の上限（503 too many codes）は、いまは発行できないと示す。保存先が無い 503 と、ほかの失敗は describeError のまま", () => {
    expect(describeIssueError(new ApiError(503, "too many codes"))).toBe(
      "いまは発行できません。しばらくしてからもう一度試してください",
    );
    expect(describeIssueError(new ApiError(503, "ranking unavailable"))).toBe("ランキングは準備中です");
    expect(describeIssueError(new ApiError(429, "too many codes"))).toBe(
      "しばらくしてからもう一度試してください",
    );
    expect(describeIssueError(new ApiError(429, "rate limited"))).toBe(
      "しばらくしてからもう一度試してください",
    );
    expect(describeIssueError(new ApiError(0, "offline"))).toBe("オフラインです");
    expect(describeIssueError(new Error("too many codes"))).toBe("通信に失敗しました");
  });
});
