import { handle, readJson } from "@/lib/server/http";
import { createTransfer } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(async (store) => createTransfer(store, await readJson(req)));
}
