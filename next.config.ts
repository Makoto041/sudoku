import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // next/image を使っていないので、画像最適化（/_next/image）を止めて攻撃面を減らす
  images: { unoptimized: true },
  async headers() {
    return [
      {
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
