import { handle, readJson } from "@/lib/server/http";
import { startDaily } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(async (store) => startDaily(store, await readJson(req)));
}
