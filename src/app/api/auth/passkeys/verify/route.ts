import { AUTH_VERIFY_MAX_BYTES, passkeyVerify } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** パスキーの登録を検証して、ログイン中のアカウントに足す。本文は { response } */
export function POST(req: Request) {
  return handleAuth(req, async ({ deps, body, session }) => passkeyVerify(deps, session, body), {
    session: "required",
    maxBytes: AUTH_VERIFY_MAX_BYTES,
  });
}
