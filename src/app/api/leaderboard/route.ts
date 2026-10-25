import { handlePlayerGet } from "@/lib/server/player-id";
import { getLeaderboard } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

/**
 * playerId の無い要求の成功した応答は、どの端末にも同じ中身なので CDN に 10 秒キャッシュさせる。
 * playerId 付き（x-player-id ヘッダーか、移行期間のクエリ。自分の順位を含む）は private, no-store、エラーは no-store。
 * どの応答にも Vary: x-player-id を付ける（handlePlayerGet）
 */
const SHARED_CACHE = "public, s-maxage=10, stale-while-revalidate=30";

export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  return handlePlayerGet(
    req,
    (store, playerId) =>
      getLeaderboard(store, {
        scope: params.get("scope") ?? "daily",
        date: params.get("date") ?? undefined,
        difficulty: params.get("difficulty"),
        playerId: playerId ?? undefined,
      }),
    { publicCacheControl: SHARED_CACHE },
  );
}
