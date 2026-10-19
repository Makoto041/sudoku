import { isoCBOR } from "@simplewebauthn/server/helpers";
import { expect } from "vitest";
import { SITE_ORIGIN } from "@/lib/site";
import type { AuthDeps, WebAuthnVerifier } from "./auth";
import { authConfig } from "./auth-config";
import { MemoryAuthStore } from "./auth-store";
import { RankingError } from "./ranking";
import { MemoryStore } from "./store";

// アカウント（パスキー）のテストで共通に使うもの。テストからだけ読み込む

export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const T0 = Date.parse("2026-10-19T03:00:00Z");
export const CONFIG = authConfig({ WEBAUTHN_ORIGIN: SITE_ORIGIN });

export const b64 = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");
export const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

/** promise が RankingError（status と、渡したときは message も一致）で失敗することを確かめる */
export async function expectError(promise: Promise<unknown>, status: number, message?: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RankingError);
  expect((err as RankingError).status).toBe(status);
  if (message !== undefined) expect((err as RankingError).message).toBe(message);
}

/** ブラウザが送る clientDataJSON（base64url） */
export const clientData = (type: string, challenge: string, origin = SITE_ORIGIN) =>
  b64(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

export type CBOR = Parameters<typeof isoCBOR.encode>[0];

/** attestationObject（base64url）。既定は attestation なし（fmt: none）で、authData は最小の 37 バイト */
export function attestationObject(
  authData: Uint8Array = new Uint8Array(37),
  fmt: CBOR = "none",
  attStmt: Map<string, CBOR> = new Map(),
) {
  return b64(
    isoCBOR.encode(
      new Map<string, CBOR>([
        ["fmt", fmt],
        ["attStmt", attStmt],
        ["authData", authData],
      ]),
    ),
  );
}

/** メモリの保存先で AuthDeps を作る。webauthn を渡さなければライブラリの本物の検証を使う */
export function memorySetup(webauthn?: WebAuthnVerifier) {
  const store = new MemoryStore();
  const auth = new MemoryAuthStore();
  const deps = (over: Partial<AuthDeps> = {}): AuthDeps => ({
    store,
    auth,
    config: CONFIG,
    webauthn,
    now: T0,
    ip: "203.0.113.1",
    ...over,
  });
  return { store, auth, deps };
}
