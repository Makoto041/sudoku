import { clientIp, handle, readJson } from "@/lib/server/http";
import { PUSH_MAX_BODY_BYTES, requirePushConfig, subscribePush, unsubscribePush } from "@/lib/server/push";

export const dynamic = "force-dynamic";

/** 新規の登録は、登録元の IP とプレイヤーごとに回数を制限する（既存の購読の更新は制限しない） */
export function POST(req: Request) {
  return handle(
    async (store) => {
      requirePushConfig();
      const input = await readJson(req, { maxBytes: PUSH_MAX_BODY_BYTES });
      return subscribePush(store, input, Date.now(), { ip: clientIp(req.headers) });
    },
    { redactErrors: true },
  );
}

export function DELETE(req: Request) {
  return handle(
    async (store) => {
      requirePushConfig();
      return unsubscribePush(store, await readJson(req, { maxBytes: PUSH_MAX_BODY_BYTES }));
    },
    { redactErrors: true },
  );
}
