import { handle, readJson } from "@/lib/server/http";
import { SUBMIT_MAX_BODY_BYTES, submitDaily } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(async (store) =>
    submitDaily(store, await readJson(req, { maxBytes: SUBMIT_MAX_BODY_BYTES })),
  );
}
