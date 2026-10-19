import { mergePlayer } from "@/lib/server/auth";
import { handleAuth } from "@/lib/server/auth-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 別の playerId の今日の一問の履歴を、アカウントの playerId に写す。本文は { fromPlayerId } */
export function POST(req: Request) {
  return handleAuth(req, async ({ deps, body, session }) => mergePlayer(deps, session, body), {
    session: "required",
  });
}
