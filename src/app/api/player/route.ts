import { handle, readJson } from "@/lib/server/http";
import { RANKING_MAX_BODY_BYTES, renamePlayer } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(async (store) =>
    renamePlayer(store, await readJson(req, { maxBytes: RANKING_MAX_BODY_BYTES })),
  );
}
