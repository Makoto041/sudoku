import { deleteAccount } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ログイン中のアカウントを消し、この端末の Cookie も消す。本文は {} */
export function DELETE(req: Request) {
  return handleAuth(
    req,
    async ({ deps, session, clearSession }) => {
      const res = await deleteAccount(deps, session);
      clearSession();
      return res;
    },
    { session: "required" },
  );
}
