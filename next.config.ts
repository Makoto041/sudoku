import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { securityHeaders } from "./src/lib/security-headers";

/** phase で next dev かを見る（NODE_ENV は環境変数で変えられるので使わない） */
export default function nextConfig(phase: string): NextConfig {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    poweredByHeader: false,
    // next/image を使っていないので、画像最適化（/_next/image）を止めて攻撃面を減らす
    images: { unoptimized: true },
    async headers() {
      return [
        {
          // 全パス（ページ・API・静的ファイル・/sw.js）。next dev だけ CSP に 'unsafe-eval' を足す
          source: "/:path*",
          headers: securityHeaders({ dev }),
        },
        {
          // 上と同じキーを置くと上書きになるので、ここには /sw.js だけのヘッダーを置く
          source: "/sw.js",
          headers: [
            { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
            { key: "Service-Worker-Allowed", value: "/" },
          ],
        },
      ];
    },
  };
}
