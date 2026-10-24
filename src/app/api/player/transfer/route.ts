import { clientIp, handle, readJson } from "@/lib/server/http";
import { TRANSFER_MAX_BODY_BYTES, createTransfer } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";

/** 引き継ぎコードを発行する。IP ごと・playerId ごとに回数を制限する */
export function POST(req: Request) {
  return handle(async (store) =>
    createTransfer(store, await readJson(req, { maxBytes: TRANSFER_MAX_BODY_BYTES }), Date.now(), {
      ip: clientIp(req.headers),
    }),
  );
}
