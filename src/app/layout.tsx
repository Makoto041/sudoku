import type { Metadata, Viewport } from "next";
import { DISPLAY_SCRIPT, THEME_COLORS } from "@/lib/client/display";
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

// ピンチで拡大できるようにする（maximumScale・userScalable は付けない）。
// ダブルタップでの拡大は、ゲームの画面とボタンの touch-action で止める（globals.css）
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // テーマが自動のときの色。テーマを選んだときは、その色の theme-color を先頭に足す（display.ts）
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // <html> の data-theme・data-text-size は、描画の前に下のスクリプトが付ける（サーバーの HTML には無い）
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: DISPLAY_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
