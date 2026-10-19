import { currentAccount } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ログイン中のアカウント（ログインしていなければ null）。確認するたびにセッションと Cookie の期限を延ばす。
 * 設定した origin と違うホスト（旧 URL・プレビュー）では 503 で、端末はアカウントの項目を出さない
 */
export function GET(req: Request) {
  return handleAuth(
    req,
    async ({ deps, session, renewSession }) => {
      const res = await currentAccount(deps, session);
      if (res.account) renewSession();
      return res;
    },
    { session: "optional" },
  );
}
