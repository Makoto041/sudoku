import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { contentSecurityPolicy, securityHeaders } from "./security-headers";

/** CSP を { 指令: 値の一覧 } にする */
function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

const header = (dev: boolean, key: string) => securityHeaders({ dev }).find((h) => h.key === key)?.value;

describe("CSP", () => {
  const prod = directives(contentSecurityPolicy({ dev: false }));

  it("本番では 'unsafe-eval' を許さず、next dev だけ許す", () => {
    expect(contentSecurityPolicy({ dev: false })).not.toContain("'unsafe-eval'");
    expect(directives(contentSecurityPolicy({ dev: true }))["script-src"]).toContain("'unsafe-eval'");
  });

  it("onclick などの属性のハンドラは、インラインの <script> を許していても止める（dev も）", () => {
    expect(prod["script-src-attr"]).toEqual(["'none'"]);
    expect(directives(contentSecurityPolicy({ dev: true }))["script-src-attr"]).toEqual(["'none'"]);
  });

  it("iframe への埋め込み・<base>・<object> を止める", () => {
    expect(prod["frame-ancestors"]).toEqual(["'none'"]);
    expect(prod["base-uri"]).toEqual(["'self'"]);
    expect(prod["object-src"]).toEqual(["'none'"]);
    expect(prod["form-action"]).toEqual(["'self'"]);
  });

  it("読み込み・通信の先は同じ origin だけ（ほかのホスト・スキームを許さない）", () => {
    const allowed = new Set(["'self'", "'none'", "'unsafe-inline'"]);
    for (const [name, values] of Object.entries(prod)) {
      for (const v of values) expect(allowed.has(v), `${name} ${v}`).toBe(true);
    }
    expect(prod["default-src"]).toEqual(["'self'"]);
    expect(prod["connect-src"]).toEqual(["'self'"]);
    expect(prod["worker-src"]).toEqual(["'self'"]);
    // インラインを許すのはスクリプトとスタイルだけ
    expect(Object.keys(prod).filter((name) => prod[name].includes("'unsafe-inline'"))).toEqual([
      "script-src",
      "style-src",
    ]);
  });
});

describe("ほかのヘッダー", () => {
  it("旧 URL から開いたかを document.referrer で見るので、ほかの origin へも origin を送る", () => {
    expect(header(false, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("埋め込みを止め、MIME の推測をさせない", () => {
    expect(header(false, "X-Frame-Options")).toBe("DENY");
    expect(header(false, "X-Content-Type-Options")).toBe("nosniff");
    expect(header(false, "Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("Permissions-Policy はカメラ・マイク・位置情報だけを止め、触覚・通知・パスキー・共有は止めない", () => {
    const policy = header(false, "Permissions-Policy")!;
    expect(policy.split(", ").sort()).toEqual(["camera=()", "geolocation=()", "microphone=()"]);
    for (const feature of ["vibrate", "notifications", "publickey-credentials", "web-share", "clipboard"]) {
      expect(policy).not.toContain(feature);
    }
  });

  it("Strict-Transport-Security は付けない（Vercel が付ける）", () => {
    expect(header(false, "Strict-Transport-Security")).toBeUndefined();
  });

  it("dev と本番で違うのは CSP だけ", () => {
    const withoutCsp = (dev: boolean) =>
      securityHeaders({ dev }).filter((h) => h.key !== "Content-Security-Policy");
    expect(withoutCsp(true)).toEqual(withoutCsp(false));
  });
});

describe("next.config.ts の headers()", () => {
  // next build の phase で読む（unstable_getResponseFromNextConfig は PHASE_PRODUCTION_BUILD を渡す）
  const responseOf = (path: string) =>
    unstable_getResponseFromNextConfig({ url: `https://nanpure-game.vercel.app${path}`, nextConfig });

  /** phase で読んだ設定の、全パスの項目の CSP */
  async function cspOf(phase: string) {
    const rules = await nextConfig(phase).headers!();
    return rules
      .find((r) => r.source === "/:path*")!
      .headers.find((h) => h.key === "Content-Security-Policy")!.value;
  }

  it("'unsafe-eval' を足すのは next dev の phase だけ（NODE_ENV によらない）", async () => {
    expect(await cspOf(PHASE_DEVELOPMENT_SERVER)).toBe(contentSecurityPolicy({ dev: true }));
    expect(await cspOf(PHASE_PRODUCTION_BUILD)).toBe(contentSecurityPolicy({ dev: false }));
    expect(await cspOf(PHASE_PRODUCTION_SERVER)).toBe(contentSecurityPolicy({ dev: false }));
  });

  it.each(["/", "/sw.js", "/api/leaderboard?scope=daily&difficulty=easy", "/_next/static/chunks/a.js"])(
    "%s にセキュリティヘッダーを付ける（本番の CSP）",
    async (path) => {
      const res = await responseOf(path);
      for (const { key, value } of securityHeaders({ dev: false })) {
        expect(res.headers.get(key), key).toBe(value);
      }
    },
  );

  it("/sw.js には、これまでどおりキャッシュさせないヘッダーと Service-Worker-Allowed も付ける", async () => {
    const res = await responseOf("/sw.js");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers.get("Service-Worker-Allowed")).toBe("/");
    expect((await responseOf("/")).headers.get("Service-Worker-Allowed")).toBeNull();
  });
});
