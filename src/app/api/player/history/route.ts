import { handlePlayerGet } from "@/lib/server/player-id";
import { getHistory } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

/** playerId は x-player-id ヘッダー（移行期間はクエリでも可）。応答は private, no-store */
export function GET(req: Request) {
  return handlePlayerGet(req, (store, playerId) => getHistory(store, { playerId }));
}
