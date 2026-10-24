import { describe, expect, it } from "vitest";
import { ApiError, describeError, describeIssueError } from "./api";

describe("describeError", () => {
  it("回数の上限（429）は時間をおくよう示す。ほかの状態は今までどおり", () => {
    expect(describeError(new ApiError(429, "rate limited"))).toBe("しばらくしてからもう一度試してください");
    expect(describeError(new ApiError(0, "offline"))).toBe("オフラインです");
    expect(describeError(new ApiError(413, "too large"))).toBe("通信に失敗しました");
    expect(describeError(new Error("x"))).toBe("通信に失敗しました");
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
