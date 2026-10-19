import { NextResponse } from "next/server";
import { AUTH_MAX_BODY_BYTES, sessionFromToken, type AuthDeps, type SessionRef } from "./auth";
import { authConfig, servedHere, type AuthConfig } from "./auth-config";
import { AUTH_SESSION_TTL_SEC, getAuthStore } from "./auth-store";
import { NO_STORE, clientIp, handle, readJson } from "./http";
import { RankingError } from "./ranking";

export type AuthCtx = {
  deps: AuthDeps;
  body: Record<string, unknown>;
  session: SessionRef | null;
  /** ログインしたセッションのトークンを Cookie に入れる（本文には出さない） */
  setSession(token: string): void;
  /** 今のセッションの Cookie を出し直し、端末側の期限も延ばす */
  renewSession(): void;
  clearSession(): void;
};

/** Cookie を送るのはアカウントの API だけ */
const COOKIE_PATH = "/api/auth";

/** Cookie ヘッダーから名前の一致する値を取り出す */
function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Content-Type が application/json か（大文字小文字と charset などの付け足しは問わない） */
function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0].trim().toLowerCase() === "application/json";
}

function cookieAttrs(config: AuthConfig) {
  return { path: COOKIE_PATH, httpOnly: true, secure: config.secureCookie, sameSite: "strict" as const };
}

/**
 * アカウント API 共通。handle（保存先・エラーの変換・キャッシュ無効化）に次を足す：
 * - 設定（WEBAUTHN_ORIGIN）が使えなければ 503。GET は設定した origin と違うホストでも 503
 * - GET 以外は、Origin が設定した origin と一致しなければ 403、本文が JSON でなければ 415（CSRF 対策）
 * - Cookie のセッションを引く。session が required で無ければ 401 にして Cookie を消す
 * - fn が頼んだ Cookie の書き換えを応答に付ける。想定外のエラーは中身なしで記録する
 * Cookie は応答に直接書く（route の関数をテストから直接呼べるよう、next/headers の cookies() は使わない）
 */
export async function handleAuth<T>(
  req: Request,
  fn: (ctx: AuthCtx) => Promise<T>,
  opts: { session: "required" | "optional"; maxBytes?: number },
): Promise<NextResponse> {
  const auth = getAuthStore();
  if (!auth) {
    return NextResponse.json({ error: "auth unavailable" }, { status: 503, headers: NO_STORE });
  }
  // Cookie の書き換え。最後に頼まれたものだけを、エラーの応答にも付ける
  const cookie: { apply?: (res: NextResponse) => void } = {};
  const res = await handle(
    async (store) => {
      const config = authConfig();
      if (req.method === "GET") {
        if (!servedHere(req, config)) throw new RankingError(503, "auth unavailable");
      } else {
        if (req.headers.get("origin") !== config.origin) throw new RankingError(403, "invalid origin");
        if (!isJson(req.headers.get("content-type"))) throw new RankingError(415, "invalid content type");
      }
      const body =
        req.method === "GET" ? {} : await readJson(req, { maxBytes: opts.maxBytes ?? AUTH_MAX_BODY_BYTES });
      const deps: AuthDeps = { store, auth, config, ip: clientIp(req.headers) };
      const token = cookieValue(req.headers.get("cookie"), config.cookieName);
      const session = await sessionFromToken(deps, token);
      const setCookie = (value: string) => {
        cookie.apply = (r) =>
          r.cookies.set(config.cookieName, value, { ...cookieAttrs(config), maxAge: AUTH_SESSION_TTL_SEC });
      };
      // 消すときも Path と Secure をそろえる（Path が違うと別の Cookie になり、__Secure- は Secure が無いと拒まれる）
      const clearSession = () => {
        cookie.apply = (r) => r.cookies.delete({ name: config.cookieName, ...cookieAttrs(config) });
      };
      if (opts.session === "required" && !session) {
        clearSession();
        throw new RankingError(401, "not signed in");
      }
      return fn({
        deps,
        body,
        session,
        setSession: setCookie,
        renewSession: () => {
          if (session && token) setCookie(token);
        },
        clearSession,
      });
    },
    { redactErrors: true },
  );
  cookie.apply?.(res);
  return res;
}
