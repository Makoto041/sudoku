import { loginOptions } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ログインのパスキーの options。本文は {} */
export function POST(req: Request) {
  return handleAuth(req, async ({ deps }) => loginOptions(deps), { session: "optional" });
}
