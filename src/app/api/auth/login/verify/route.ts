import { AUTH_VERIFY_MAX_BYTES, loginVerify } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** パスキーでログインし、ログインの Cookie を付ける。本文は { response } */
export function POST(req: Request) {
  return handleAuth(
    req,
    async ({ deps, body, setSession }) => {
      const { account, token } = await loginVerify(deps, body);
      setSession(token);
      return { account };
    },
    { session: "optional", maxBytes: AUTH_VERIFY_MAX_BYTES },
  );
}
