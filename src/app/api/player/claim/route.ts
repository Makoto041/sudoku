import { handle, readJson } from "@/lib/server/http";
import { claimTransfer } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(async (store) => claimTransfer(store, await readJson(req)));
}
