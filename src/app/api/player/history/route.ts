import { handle } from "@/lib/server/http";
import { getHistory } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  return handle((store) => getHistory(store, { playerId: params.get("playerId") }));
}
