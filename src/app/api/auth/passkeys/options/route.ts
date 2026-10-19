import { passkeyOptions } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ログイン中のアカウントにパスキーを足す options。本文は {} */
export function POST(req: Request) {
  return handleAuth(req, async ({ deps, session }) => passkeyOptions(deps, session), { session: "required" });
}
