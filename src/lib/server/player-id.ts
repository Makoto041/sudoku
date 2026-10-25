import { PLAYER_ID_HEADER } from "@/lib/player-id-header";
import { handle } from "./http";
import { RankingError, assertPlayerId } from "./ranking";
import type { RankingStore } from "./store";

// GET の playerId の受け取り（README の「GET での playerId の受け渡し」）。端末は x-player-id ヘッダーで送る。
// 移行期間として、ヘッダーの無い要求ではクエリの playerId も受け付ける（ヘッダーを送らない古い端末のため）

/**
 * クエリの playerId を受け付けなくなる時刻（2026-12-20 の日本時間 0 時。この時刻からは 400）。
 * 過ぎたら README の「やること」に従い、移行期間の分岐を消す
 */
export const PLAYER_ID_QUERY_SUNSET = "2026-12-20T00:00:00+09:00";
/** クエリの playerId を非推奨にした時刻（応答の Deprecation） */
export const PLAYER_ID_QUERY_DEPRECATED = "2026-10-25T00:00:00+09:00";

const SUNSET_MS = Date.parse(PLAYER_ID_QUERY_SUNSET);

/** クエリで受けた成功した応答に付ける。Deprecation は RFC 9745（@ と UNIX 時刻の秒）、Sunset は RFC 8594（HTTP-date） */
const QUERY_DEPRECATION = {
  Deprecation: `@${Date.parse(PLAYER_ID_QUERY_DEPRECATED) / 1000}`,
  Sunset: new Date(SUNSET_MS).toUTCString(),
};

/**
 * GET の要求の playerId（検査の前の値）。ヘッダーがあれば（空でも）その値で、クエリは見ない。ヘッダーが無ければ
 * クエリの値（空なら無いもの）。fromQuery はクエリの値を使うか、inQuery はクエリに playerId があるか（空でも）
 */
function requestPlayerId(req: Request) {
  const header = req.headers.get(PLAYER_ID_HEADER);
  const query = new URL(req.url).searchParams.get("playerId");
  return { raw: header ?? (query || null), fromQuery: header === null && !!query, inQuery: query !== null };
}

/**
 * GET で playerId を受け取る route の共通処理（handle）。playerId の形が違えば 400 invalid player id。
 * PLAYER_ID_QUERY_SUNSET からは、クエリに playerId があれば（ヘッダーがあっても、空でも）400 player id in query。
 * playerId のある成功した応答は private, no-store。無い成功した応答は publicCacheControl（渡さなければ no-store）。
 * エラーは no-store。クエリで受けた成功した応答には Deprecation と Sunset を付ける（playerId はログにも応答にも出さない）。
 * publicCacheControl を渡すと、すべての応答に Vary: x-player-id を付ける。アプリの要求は公開の要求と URL が同じなので、
 * 付けないと、CDN がヘッダー付きの要求に、保存した公開の応答（自分の順位が無い）を返す
 */
export async function handlePlayerGet<T>(
  req: Request,
  fn: (store: RankingStore, playerId: string | null) => Promise<T>,
  opts: { publicCacheControl?: string } = {},
) {
  const { raw, fromQuery, inQuery } = requestPlayerId(req);
  const res = await handle(
    (store) => {
      if (inQuery && Date.now() >= SUNSET_MS) throw new RankingError(400, "player id in query");
      return fn(store, raw === null ? null : assertPlayerId(raw));
    },
    { cacheControl: raw === null ? opts.publicCacheControl : "private, no-store" },
  );
  if (opts.publicCacheControl) res.headers.set("Vary", PLAYER_ID_HEADER);
  if (fromQuery && res.ok) {
    for (const [key, value] of Object.entries(QUERY_DEPRECATION)) res.headers.set(key, value);
  }
  return res;
}
