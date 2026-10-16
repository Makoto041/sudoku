import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ナンプレ",
    short_name: "ナンプレ",
    description: "置くたびに気持ちいい音が鳴る、シンプルなナンプレ。毎日の一問で点数を競えます。",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f5f4f0",
    theme_color: "#f5f4f0",
    lang: "ja",
    categories: ["games", "puzzle"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
