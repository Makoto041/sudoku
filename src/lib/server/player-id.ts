import { PLAYER_ID_HEADER } from "@/lib/player-id-header";
import { handle } from "./http";
import { RankingError, assertPlayerId } from "./ranking";
import type { RankingStore } from "./store";

// GET の playerId の受け取り（README の「GET での playerId の受け渡し」）。端末は x-player-id ヘッダーで送る。
// 移行期間として、ヘッダーの無い要求ではクエリの playerId も受け付ける（ヘッダーを送らない古い端末・保存済みのページのため）

/**
 * クエリの playerId を受け付けなくなる時刻（2026-12-20 の日本時間 0 時。この時刻からは 400）。
 * 過ぎたら README の「やること」に従い、クエリを受け付ける分岐（PLAYER_ID_QUERY_DEPRECATED・QUERY_DEPRECATION）を消す
 */
export const PLAYER_ID_QUERY_SUNSET = "2026-12-20T00:00:00+09:00";
/** クエリの playerId を非推奨にした時刻（応答の Deprecation） */
export const PLAYER_ID_QUERY_DEPRECATED = "2026-10-25T00:00:00+09:00";

const SUNSET_MS = Date.parse(PLAYER_ID_QUERY_SUNSET);

/** クエリで受けた応答に付ける。Deprecation は RFC 9745（@ と UNIX 時刻の秒）、Sunset は RFC 8594（HTTP-date） */
const QUERY_DEPRECATION = {
  Deprecation: `@${Date.parse(PLAYER_ID_QUERY_DEPRECATED) / 1000}`,
  Sunset: new Date(SUNSET_MS).toUTCString(),
};

/** playerId（その人の記録）を含む成功した応答。どのキャッシュにも載せない */
export const PRIVATE_NO_STORE = "private, no-store";

export type RequestPlayer = { playerId: string | null; fromQuery: boolean };

/**
 * GET の要求の playerId。ヘッダーがあれば（空でも）その値を検査し、クエリは見ない。ヘッダーが無ければクエリを見る
 * （空なら無いものとする）。形が違えば 400 invalid player id。
 * PLAYER_ID_QUERY_SUNSET からは、クエリに playerId があれば（ヘッダーがあっても、空でも）400 player id in query
 */
export function requestPlayerId(req: Request, now = Date.now()): RequestPlayer {
  const query = new URL(req.url).searchParams.get("playerId");
  if (query !== null && now >= SUNSET_MS) throw new RankingError(400, "player id in query");
  const header = req.headers.get(PLAYER_ID_HEADER);
  if (header !== null) return { playerId: assertPlayerId(header), fromQuery: false };
  if (query) return { playerId: assertPlayerId(query), fromQuery: true };
  return { playerId: null, fromQuery: false };
}

/**
 * GET で playerId を受け取る route の共通処理（handle と requestPlayerId）。playerId のある成功した応答は
 * private, no-store。無い成功した応答は publicCacheControl（渡さなければ no-store）。エラーは no-store。
 * クエリで受けた応答には Deprecation と Sunset を付ける（playerId はログにも応答にも出さない）。
 * publicCacheControl を渡すと、すべての応答に Vary: x-player-id を付ける。アプリの要求は公開の要求と URL が同じなので、
 * 付けないと、CDN がヘッダー付きの要求に、保存した公開の応答（自分の順位が無い）を返す
 */
export function handlePlayerGet<T>(
  req: Request,
  fn: (store: RankingStore, playerId: string | null) => Promise<T>,
  opts: { publicCacheControl?: string } = {},
) {
  const vary: Record<string, string> = opts.publicCacheControl ? { Vary: PLAYER_ID_HEADER } : {};
  let player: RequestPlayer;
  try {
    player = requestPlayerId(req);
  } catch (err) {
    // 形の検査の 400 も、ほかのエラーと同じく handle で応答にする（保存先が無ければ 503）
    return handle(() => Promise.reject(err), { headers: vary });
  }
  return handle((store) => fn(store, player.playerId), {
    cacheControl: player.playerId ? PRIVATE_NO_STORE : opts.publicCacheControl,
    headers: player.fromQuery ? { ...vary, ...QUERY_DEPRECATION } : vary,
  });
}
