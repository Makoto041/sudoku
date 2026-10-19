import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { RankingError } from "./ranking";
import { getStore, type RankingStore } from "./store";

export const NO_STORE = { "Cache-Control": "no-store" };

/**
 * ランキング API 共通：保存先の用意、エラーの HTTP 変換、キャッシュ無効化。
 * redactErrors のときは、想定外のエラーを中身なしで記録する（通知の購読は、Upstash のエラーに
 * 送ったコマンド＝endpoint や鍵が含まれうる）
 */
export async function handle<T>(
  fn: (store: RankingStore) => Promise<T>,
  opts: { redactErrors?: boolean } = {},
) {
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
    console.error(
      opts.redactErrors ? `request failed (${err instanceof Error ? err.name : typeof err})` : err,
    );
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * クライアントの IP。x-forwarded-for の最初の要素、無ければ x-real-ip。IP として読めなければ null。
 * Vercel ではエッジがこれらのヘッダーを付け直す（クライアントが送った値は使われない）。それ以外の環境
 * （ヘッダーを付け直すプロキシを通さないとき）では、クライアントが偽装でき、IP ごとの回数制限を回避できるうえ、
 * 他人の IP を指定してその IP の枠を使い切れる
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0].trim();
  for (const value of [forwarded, headers.get("x-real-ip")?.trim()]) {
    if (value && isIP(value)) return value.toLowerCase();
  }
  return null;
}

/** 本文を少しずつ読み、maxBytes を超えた時点で 413 にする（Content-Length が無くても全部は読まない） */
async function readText(req: Request, maxBytes: number): Promise<string> {
  if (Number(req.headers.get("content-length")) > maxBytes) throw new RankingError(413, "too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      throw new RankingError(413, "too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** 本文を JSON として読む。JSON でなければ 400、maxBytes を超えたら 413。オブジェクト以外は {} にする */
export async function readJson(
  req: Request,
  opts: { maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = JSON.parse(await readText(req, opts.maxBytes ?? Infinity));
  } catch (err) {
    if (err instanceof RankingError) throw err;
    throw new RankingError(400, "invalid json");
  }
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}
