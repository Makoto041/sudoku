import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // next/image を使っていないので、画像最適化（/_next/image）を止めて攻撃面を減らす
  images: { unoptimized: true },
  async headers() {
    return [
      {
        // 全パス（ページ・API・静的ファイル・/sw.js）。next dev だけ CSP に 'unsafe-eval' を足す
        source: "/:path*",
        headers: securityHeaders({ dev: process.env.NODE_ENV === "development" }),
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

export default nextConfig;
