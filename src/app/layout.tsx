import type { Metadata, Viewport } from "next";
import { SITE_ORIGIN } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  // 旧 URL も同じページを配るので、正規の URL は新しい URL にする
  metadataBase: new URL(SITE_ORIGIN),
  alternates: { canonical: "/" },
  title: "ナンプレ",
  description: "置くたびに気持ちいい音が鳴る、シンプルなナンプレ。毎日の一問で点数を競えます。",
  applicationName: "ナンプレ",
  appleWebApp: { capable: true, title: "ナンプレ", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f4f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f11" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
