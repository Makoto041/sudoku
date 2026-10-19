import { AUTH_VERIFY_MAX_BYTES, signupVerify } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** パスキーの登録を検証してアカウントを作り、ログインの Cookie を付ける。本文は { response } */
export function POST(req: Request) {
  return handleAuth(
    req,
    async ({ deps, body, setSession }) => {
      const { account, token } = await signupVerify(deps, body);
      setSession(token);
      return { account };
    },
    { session: "optional", maxBytes: AUTH_VERIFY_MAX_BYTES },
  );
}
