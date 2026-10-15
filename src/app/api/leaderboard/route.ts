import { handle } from "@/lib/server/http";
import { getLeaderboard } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  return handle((store) =>
    getLeaderboard(store, {
      scope: params.get("scope") ?? "daily",
      date: params.get("date") ?? undefined,
      difficulty: params.get("difficulty"),
      playerId: params.get("playerId") ?? undefined,
    }),
  );
}
