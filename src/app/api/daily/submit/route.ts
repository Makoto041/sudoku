import { handle, readJson } from "@/lib/server/http";
import { submitDaily } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(async (store) => submitDaily(store, await readJson(req)));
}
