import { NextResponse } from "next/server";
import { RankingError } from "./ranking";
import { getStore, type RankingStore } from "./store";

const NO_STORE = { "Cache-Control": "no-store" };

/** ランキング API 共通：保存先の用意、エラーの HTTP 変換、キャッシュ無効化 */
export async function handle<T>(fn: (store: RankingStore) => Promise<T>) {
  const store = getStore();
  if (!store) {
    return NextResponse.json({ error: "ranking unavailable" }, { status: 503, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await fn(store), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof RankingError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    }
    console.error(err);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: NO_STORE });
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    throw new RankingError(400, "invalid json");
  }
}
