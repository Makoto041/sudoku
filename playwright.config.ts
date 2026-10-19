import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}` },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        port: PORT,
        // 3100 番で既に動いているサーバーがあると、そのサーバー（下の env ではなく、その環境変数）を使う。止めてから実行する
        reuseExistingServer: true,
        env: {
          // アカウント（パスキー）の origin。RP ID は localhost
          WEBAUTHN_ORIGIN: `http://localhost:${PORT}`,
          // 環境や .env の値に関わらず、保存先はメモリにする（本番の Redis に書かない）。
          // 空文字は .env で上書きされず、空の接続先では Redis を使わない（store.ts の redisFromEnv）
          KV_REST_API_URL: "",
          KV_REST_API_TOKEN: "",
          UPSTASH_REDIS_REST_URL: "",
          UPSTASH_REDIS_REST_TOKEN: "",
        },
      },
  projects: [
    { name: "iphone", use: { ...devices["iPhone 15"] } },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 820 },
        // 効果音を鳴らさない
        launchOptions: { args: ["--mute-audio"] },
      },
    },
  ],
});
