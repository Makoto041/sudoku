import { clientIp, handle, readJson } from "@/lib/server/http";
import { RANKING_MAX_BODY_BYTES, startDaily } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

/** 今日の一問を始める。IP ごとに回数を制限する */
export function POST(req: Request) {
  return handle(async (store) =>
    startDaily(store, await readJson(req, { maxBytes: RANKING_MAX_BODY_BYTES }), Date.now(), {
      ip: clientIp(req.headers),
    }),
  );
}
