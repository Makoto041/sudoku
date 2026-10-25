import { describe, expect, it } from "vitest";
import { ApiError, describeError, describeIssueError, isTooFast } from "./api";

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
