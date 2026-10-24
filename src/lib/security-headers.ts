/**
 * 全パスに付けるセキュリティヘッダー（next.config.ts の headers()）。方針は README の「セキュリティヘッダー」。
 * next.config.ts から読むので、`@/` の別名は使わない
 */

type Header = { key: string; value: string };

/**
 * CSP。nonce は使わず、インラインの <script>（Next の __next_f）とスタイル（style 属性）は 'unsafe-inline' で許す
 * （nonce にすると毎回サーバーで描画することになる）。通信・読み込み先は同じ origin だけ。
 * 旧 URL も同じデプロイが配るので、'self' は開いている origin（新旧どちらか）になる。
 * 'unsafe-eval' は next dev だけ（React が開発時のエラー表示に eval を使う。本番のビルドには要らない）
 */
export function contentSecurityPolicy({ dev }: { dev: boolean }): string {
  const directives: string[][] = [
    ["default-src", "'self'"],
    ["script-src", "'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    // onclick="…" などの属性のハンドラは使っていない（React は addEventListener で付ける）ので止める
    ["script-src-attr", "'none'"],
    ["style-src", "'self'", "'unsafe-inline'"],
    // 画像はアイコンだけ（同じ origin の相対 URL）。data: と blob: の画像・フォントは使っていないので許さない
    ["img-src", "'self'"],
    // 置く音の録音は fetch で読む（connect-src）。<audio> は使っていない
    ["media-src", "'self'"],
    ["font-src", "'self'"],
    // /api/* と /sounds/clack.mp3。通知の購読（PushManager）は connect-src によらない
    ["connect-src", "'self'"],
    // public/sw.js
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    // iframe への埋め込み（クリックジャッキング）を止める。古いブラウザ向けに X-Frame-Options も付ける
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["object-src", "'none'"],
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

/**
 * Strict-Transport-Security は Vercel が *.vercel.app に付けるので、ここでは付けない
 */
export function securityHeaders({ dev }: { dev: boolean }): Header[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy({ dev }) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // no-referrer にしない: 新しい URL は document.referrer の origin で旧 URL から開かれたかを見る（README の「URL の移行」）
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // 使わない機能だけを止める。触覚（vibrate）・通知・パスキー・共有・クリップボードは止めない
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    // ほかの origin のウィンドウとの参照（window.opener など）を切る。ポップアップ・window.open は使っておらず、
    // パスキーはポップアップを使わない。旧 URL から新しい URL へは同じタブで移る（location.assign）
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
}
