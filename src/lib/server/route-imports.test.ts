import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

// web-push が読み込まれたら印を付ける（モックの中身は読み込まれたときに作られる）
const loaded = vi.hoisted(() => ({ webPush: false }));
vi.mock("web-push", () => {
  loaded.webPush = true;
  return { default: {} };
});

const API_DIR = join(import.meta.dirname, "../../app/api");
/** 通知を送る route（web-push を読み込んでよいもの） */
const PUSH_ROUTES = ["push/route.ts", "cron/remind/route.ts"];

describe("route の読み込み", () => {
  it("通知の route 以外（ランキング・アカウント）は、通知の送信（web-push）を読み込まない", async () => {
    const routes = readdirSync(API_DIR, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith("route.ts"))
      .map((f) => relative(API_DIR, join(API_DIR, f)))
      .sort();
    const others = routes.filter((r) => !PUSH_ROUTES.includes(r));
    expect(others).toEqual(expect.arrayContaining(["daily/start/route.ts", "auth/me/route.ts"]));
    for (const route of others) {
      await import(join(API_DIR, route));
      expect([route, loaded.webPush]).toEqual([route, false]);
    }
    // 通知の route では印が付く（印の付け方が効いていることの確かめ。読み込むと戻せないので最後に）
    expect(routes).toEqual(expect.arrayContaining(PUSH_ROUTES));
    await import(join(API_DIR, PUSH_ROUTES[0]));
    expect(loaded.webPush).toBe(true);
  });
});
