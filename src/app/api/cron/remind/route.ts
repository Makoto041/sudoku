import { handle } from "@/lib/server/http";
import { cronAuthorized, requirePushConfig, sendReminders, webPushSender } from "@/lib/server/push";
import { RankingError } from "@/lib/server/ranking";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel Cron から呼ばれる。CRON_SECRET が Authorization: Bearer で付いてくる */
export function GET(req: Request) {
  return handle(
    async (store) => {
      const config = requirePushConfig();
      if (!cronAuthorized(req.headers.get("authorization"), config.cronSecret)) {
        throw new RankingError(401, "unauthorized");
      }
      return sendReminders(store, { send: webPushSender(config) });
    },
    { redactErrors: true },
  );
}
