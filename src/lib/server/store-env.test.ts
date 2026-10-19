import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 保存先は最初の判定を覚えるので、環境変数を変えたら読み込み直す */
async function freshStores() {
  vi.resetModules();
  const store = await import("./store");
  const auth = await import("./auth-store");
  return { store, auth };
}

describe("保存先の判定", () => {
  it("接続先の環境変数が空文字なら Redis を使わず、メモリに保存する（e2e のサーバーが本番の Redis に繋がないように）", async () => {
    // e2e の webServer の設定と同じ。KV_* が空文字なら、UPSTASH_* に値があっても使わない
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "not-a-token");
    vi.stubEnv("VERCEL", "");
    const { store, auth } = await freshStores();
    expect(store.redisFromEnv()).toBeNull();
    expect(store.getStore()).toBeInstanceOf(store.MemoryStore);
    expect(auth.getAuthStore()).toBeInstanceOf(auth.MemoryAuthStore);
  });

  it("4 つとも空文字でもメモリに保存する", async () => {
    for (const name of [
      "KV_REST_API_URL",
      "KV_REST_API_TOKEN",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "VERCEL",
    ]) {
      vi.stubEnv(name, "");
    }
    const { store, auth } = await freshStores();
    expect(store.redisFromEnv()).toBeNull();
    expect(store.getStore()).toBeInstanceOf(store.MemoryStore);
    expect(auth.getAuthStore()).toBeInstanceOf(auth.MemoryAuthStore);
  });
});
