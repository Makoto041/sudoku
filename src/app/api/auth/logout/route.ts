import { logout } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ログアウト。本文は { scope?: "this" | "others" }。this（既定）はこの端末の Cookie も消す */
export function POST(req: Request) {
  return handleAuth(
    req,
    async ({ deps, body, session, clearSession }) => {
      const res = await logout(deps, session, body);
      if (body.scope !== "others") clearSession();
      return res;
    },
    { session: "required" },
  );
}
