import { isIP } from "node:net";
import { RankingError } from "./ranking";

/** パスキーの登録で端末に見せるサービス名 */
export const RP_NAME = "ナンプレ";

export type AuthConfig = {
  /** パスキーを結びつけるドメイン（origin のホスト名）。変えると登録済みのパスキーが使えなくなる */
  rpID: string;
  rpName: typeof RP_NAME;
  /** パスキーの操作とログインの API を受け付ける origin（`https://example.com` の形） */
  origin: string;
  secureCookie: boolean;
  cookieName: string;
};

/** Vercel 以外で WEBAUTHN_ORIGIN が未設定のとき（`next dev` の既定のポート） */
const LOCAL_ORIGIN = "http://localhost:3000";

/**
 * アカウントの設定。origin は環境変数 WEBAUTHN_ORIGIN で決め、リクエストの Host からは決めない
 * （Host を差し替えた要求で別の RP ID の challenge を作らせない）。
 * 受け付けるのは https（IP アドレス以外のホスト）と http の localhost の origin だけ（末尾の / やパスは不可）。
 * Vercel 上で未設定（プレビューを含む）か、受け付けない形なら 503
 */
export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const value = env.WEBAUTHN_ORIGIN || (env.VERCEL ? "" : LOCAL_ORIGIN);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RankingError(503, "auth unavailable");
  }
  // IPv6 のホスト名は [::1] の形で返るので、括弧を外して確かめる
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const ok =
    url.origin === value &&
    ((url.protocol === "https:" && isIP(host) === 0) || (url.protocol === "http:" && host === "localhost"));
  if (!ok) throw new RankingError(503, "auth unavailable");
  const secureCookie = url.protocol === "https:";
  return {
    rpID: url.hostname,
    rpName: RP_NAME,
    origin: url.origin,
    secureCookie,
    // https では __Secure- を付け、Secure の無い Cookie で上書きさせない
    cookieName: secureCookie ? "__Secure-sdk_auth" : "sdk_auth",
  };
}

/**
 * このリクエストが設定した origin のホスト（ポートを含む）に来たか。ログイン状態の確認（GET）で、
 * 設定と違うホスト（旧 URL・プレビュー）ではアカウントの項目を出させないためだけに使う（origin や RP ID には使わない）。
 * Next.js の req.url のホストは Host ヘッダーではなくサーバーの待ち受け名になることがあるので、Host ヘッダーで比べる
 * （無いとき＝テストで Request を直接作ったときだけ req.url）
 */
export function servedHere(req: Request, config: AuthConfig): boolean {
  try {
    const host = req.headers.get("host") ?? new URL(req.url).host;
    return host.toLowerCase() === new URL(config.origin).host;
  } catch {
    return false;
  }
}
