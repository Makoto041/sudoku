import { handle } from "@/lib/server/http";
import { getLeaderboard } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

/**
 * playerId の無い要求の成功した応答は、どの端末にも同じ中身なので CDN に 10 秒キャッシュさせる。
 * playerId 付き（自分の順位を含む）とエラーは no-store
 */
const SHARED_CACHE = "public, s-maxage=10, stale-while-revalidate=30";

export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const playerId = params.get("playerId");
  return handle(
    (store) =>
      getLeaderboard(store, {
        scope: params.get("scope") ?? "daily",
        date: params.get("date") ?? undefined,
        difficulty: params.get("difficulty"),
        playerId: playerId ?? undefined,
      }),
    playerId ? {} : { cacheControl: SHARED_CACHE },
  );
}
