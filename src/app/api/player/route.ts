import { handle, readJson } from "@/lib/server/http";
import { renamePlayer } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(async (store) => renamePlayer(store, await readJson(req)));
}
