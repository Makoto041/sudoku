import { signupOptions } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** アカウントを作るパスキーの options。本文は { playerId } */
export function POST(req: Request) {
  return handleAuth(req, async ({ deps, body }) => signupOptions(deps, body), { session: "optional" });
}
