import { generateAuthenticationOptions, generateRegistrationOptions } from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { expect } from "vitest";
import { SITE_HOST, SITE_ORIGIN } from "@/lib/site";
import {
  loginOptions,
  loginVerify,
  signupOptions,
  signupVerify,
  type AuthDeps,
  type WebAuthnVerifier,
} from "./auth";
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

/** 検証の結果を決められる WebAuthn（options の生成はライブラリのまま） */
export function fakeWebAuthn() {
  const state = {
    verified: true,
    throws: false,
    newCounter: 1,
    /** 登録で認証器のデータから取れる id（null なら応答の id と同じ） */
    authDataId: null as string | null,
    /** 登録で認証器のデータから取れる公開鍵 */
    publicKey: new Uint8Array([1, 2, 3]),
  };
  const calls: { verifyRegistration: unknown[]; verifyAuthentication: unknown[] } = {
    verifyRegistration: [],
    verifyAuthentication: [],
  };
  const webauthn: WebAuthnVerifier = {
    registrationOptions: generateRegistrationOptions,
    authenticationOptions: generateAuthenticationOptions,
    verifyRegistration: (async (opts) => {
      calls.verifyRegistration.push(opts);
      if (state.throws)
        throw new Error(`Unexpected registration response challenge ${opts.expectedChallenge}`);
      if (!state.verified) return { verified: false };
      return {
        verified: true,
        registrationInfo: {
          fmt: "none",
          aaguid: "00000000-0000-0000-0000-000000000000",
          credential: {
            id: state.authDataId ?? opts.response.id,
            publicKey: state.publicKey,
            counter: 0,
            transports: opts.response.response.transports,
          },
          credentialType: "public-key",
          attestationObject: new Uint8Array(),
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: false,
          origin: SITE_ORIGIN,
          rpID: SITE_HOST,
        },
      };
    }) as WebAuthnVerifier["verifyRegistration"],
    verifyAuthentication: (async (opts) => {
      calls.verifyAuthentication.push(opts);
      if (state.throws) throw new Error(`Unexpected authentication response origin ${opts.expectedOrigin}`);
      return {
        verified: state.verified,
        authenticationInfo: {
          credentialID: opts.credential.id,
          newCounter: state.newCounter,
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: SITE_ORIGIN,
          rpID: SITE_HOST,
        },
      };
    }) as WebAuthnVerifier["verifyAuthentication"],
  };
  return { state, calls, webauthn };
}

/** メモリの保存先と、検証の結果を決められる WebAuthn */
export function fakeSetup() {
  const fake = fakeWebAuthn();
  return { ...memorySetup(fake.webauthn), fake };
}

export type FakeSetup = ReturnType<typeof fakeSetup>;

/** 登録の応答（偽の検証用。attestationObject は fmt: none の最小の形） */
export const createResponse = (challenge: string, credId = b64("cred-1")) => ({
  id: credId,
  rawId: credId,
  type: "public-key",
  response: {
    clientDataJSON: clientData("webauthn.create", challenge),
    attestationObject: attestationObject(),
    transports: ["internal", "hybrid"],
  },
  clientExtensionResults: {},
});

/** ログインの応答（偽の検証用） */
export const getResponse = (challenge: string, credId: string, userHandle: string | undefined) => ({
  id: credId,
  rawId: credId,
  type: "public-key",
  response: {
    clientDataJSON: clientData("webauthn.get", challenge),
    authenticatorData: b64("authenticator-data"),
    signature: b64("signature"),
    userHandle,
  },
  clientExtensionResults: {},
});

/** アカウントを作ってログインする */
export async function signup(s: FakeSetup, playerId: string, credId: string, over: Partial<AuthDeps> = {}) {
  const { options } = await signupOptions(s.deps(over), { playerId });
  const res = await signupVerify(s.deps(over), { response: createResponse(options.challenge, credId) });
  return { ...res, accountId: unb64(options.user.id) };
}

export async function login(s: FakeSetup, credId: string, accountId: string, over: Partial<AuthDeps> = {}) {
  const { options } = await loginOptions(s.deps(over));
  return loginVerify(s.deps(over), { response: getResponse(options.challenge, credId, b64(accountId)) });
}
