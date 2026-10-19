import { AUTH_STATS_MAX_BYTES, putStats } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 端末の記録をアカウントの記録と合わせて保存し、合わせた記録を返す。本文は { stats } */
export function PUT(req: Request) {
  return handleAuth(req, async ({ deps, body, session }) => putStats(deps, session, body), {
    session: "required",
    maxBytes: AUTH_STATS_MAX_BYTES,
  });
}
