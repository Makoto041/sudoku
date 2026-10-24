import { describe, expect, it } from "vitest";
import { ApiError, describeError } from "./api";

describe("describeError", () => {
  it("回数の上限（429）は時間をおくよう示す。ほかの状態は今までどおり", () => {
    expect(describeError(new ApiError(429, "rate limited"))).toBe("しばらくしてからもう一度試してください");
    expect(describeError(new ApiError(0, "offline"))).toBe("オフラインです");
    expect(describeError(new ApiError(413, "too large"))).toBe("通信に失敗しました");
    expect(describeError(new Error("x"))).toBe("通信に失敗しました");
  });
});
