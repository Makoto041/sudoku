import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_HOST, SITE_ORIGIN } from "@/lib/site";
import { loginOptions, loginVerify, signupOptions, signupVerify, simpleWebAuthn } from "./auth";
import {
  ALICE,
  attestationObject,
  b64,
  clientData,
  expectError,
  memorySetup,
  type CBOR,
} from "./auth-test-helpers";

// ライブラリ（@simplewebauthn/server）の本物の検証を通す。認証器は node:crypto の ES256 鍵で、
// 登録は attestation なし（fmt: none）、ログインは署名付きの応答を組み立てる

const OLD_HOST = "sudoku-xi-five.vercel.app";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();
const u32 = (n: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n);
  return buf;
};

type Opts = { origin?: string; rpId?: string };

/** ES256 の鍵を 1 つ持つ認証器。flags は UP（0x01）と UV（0x04）、登録では AT（0x40）も立てる */
class Authenticator {
  private readonly privateKey: KeyObject;
  private readonly cose: Uint8Array;
  counter = 0;

  constructor(readonly credId: Buffer = randomBytes(16)) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.privateKey = privateKey;
    // COSE_Key: kty=EC2(2), alg=ES256(-7), crv=P-256(1), x, y
    this.cose = isoCBOR.encode(
      new Map<number, CBOR>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
      ]),
    );
  }

  get id() {
    return b64(this.credId);
  }

  create(challenge: string, opts: Opts & { fmt?: string; attStmt?: Map<string, CBOR> } = {}) {
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([
      sha256(opts.rpId ?? SITE_HOST),
      Buffer.from([0x45]),
      u32(this.counter),
      Buffer.alloc(16), // AAGUID
      idLen,
      this.credId,
      this.cose,
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: clientData("webauthn.create", challenge, opts.origin),
        attestationObject: attestationObject(new Uint8Array(authData), opts.fmt, opts.attStmt),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  get(challenge: string, userHandle: string, opts: Opts & { counter?: number } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const clientDataJSON = clientData("webauthn.get", challenge, opts.origin);
    const authData = Buffer.concat([sha256(opts.rpId ?? SITE_HOST), Buffer.from([0x05]), u32(this.counter)]);
    // 署名は authenticatorData と clientDataJSON の SHA-256 をつないだものに対する ECDSA（DER）
    const signed = Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, "base64url"))]);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON,
        authenticatorData: b64(authData),
        signature: b64(sign("sha256", signed, this.privateKey)),
        userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

// webauthn を渡さないので、ライブラリの本物の検証を使う
const setup = () => memorySetup();

/** 登録してアカウントを作る。userHandle（user.id の base64url）を返す */
async function register(s: ReturnType<typeof setup>, a: Authenticator) {
  const { options } = await signupOptions(s.deps(), { playerId: ALICE });
  const res = await signupVerify(s.deps(), { response: a.create(options.challenge) });
  expect(res.account).toMatchObject({ playerId: ALICE, passkeys: 1 });
  return options.user.id;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebAuthn の検証（ライブラリの本物）", () => {
  it("登録してアカウントを作り、そのパスキーでログインできる", async () => {
    const s = setup();
    const a = new Authenticator();
    const userHandle = await register(s, a);
    expect(await s.auth.getCredential(a.id)).toMatchObject({
      id: a.id,
      counter: 0,
      transports: ["internal"],
      deviceType: "singleDevice",
      backedUp: false,
    });
    const { options } = await loginOptions(s.deps());
    const res = await loginVerify(s.deps(), { response: a.get(options.challenge, userHandle) });
    expect(res.account).toMatchObject({ playerId: ALICE, passkeys: 1 });
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await s.auth.getCredential(a.id))?.counter).toBe(1);
  });

  it.each<[string, Opts]>([
    ["origin", { origin: `https://${OLD_HOST}` }],
    ["RP ID（rpIdHash）", { rpId: OLD_HOST }],
  ])("%s が違えば、登録は 400 verification failed、ログインは 401 login failed", async (_, bad) => {
    const s = setup();
    const a = new Authenticator();
    const signup = await signupOptions(s.deps(), { playerId: ALICE });
    await expectError(
      signupVerify(s.deps(), { response: a.create(signup.options.challenge, bad) }),
      400,
      "verification failed",
    );
    const userHandle = await register(s, a);
    const { options } = await loginOptions(s.deps());
    await expectError(
      loginVerify(s.deps(), { response: a.get(options.challenge, userHandle, bad) }),
      401,
      "login failed",
    );
  });

  it("attestation が none 以外（証明書の連鎖を検証させる形式）は、ライブラリに渡さず外部へも通信せずに 400", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    const verifyRegistration = vi.fn(simpleWebAuthn.verifyRegistration);
    const s = memorySetup({ ...simpleWebAuthn, verifyRegistration });
    const a = new Authenticator();
    // 自作の証明書（中身は問わない）を x5c に入れた attStmt
    const attStmt = new Map<string, CBOR>([
      ["alg", -7],
      ["sig", new Uint8Array(randomBytes(64))],
      ["x5c", [new Uint8Array(randomBytes(300)), new Uint8Array(randomBytes(300))]],
    ]);
    for (const fmt of ["android-key", "packed", "tpm", "fido-u2f", "apple", "android-safetynet"]) {
      const { options } = await signupOptions(s.deps(), { playerId: ALICE });
      await expectError(
        signupVerify(s.deps(), { response: a.create(options.challenge, { fmt, attStmt }) }),
        400,
        "verification failed",
      );
    }
    expect(verifyRegistration).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(s.auth.counts()).toMatchObject({ accounts: 0, credentials: 0 });
    // none ならライブラリで検証して作れる
    await register(s, a);
    expect(verifyRegistration).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("counter が前回以下（巻き戻り）なら 401", async () => {
    const s = setup();
    const a = new Authenticator();
    const userHandle = await register(s, a);
    const attempt = async (counter: number) => {
      const { options } = await loginOptions(s.deps());
      return loginVerify(s.deps(), { response: a.get(options.challenge, userHandle, { counter }) });
    };
    await attempt(5);
    await expectError(attempt(3), 401, "login failed");
    await expectError(attempt(5), 401, "login failed");
    expect((await s.auth.getCredential(a.id))?.counter).toBe(5);
    await attempt(6);
  });

  it("同じ応答を送り直すと、登録もログインも 400 challenge expired", async () => {
    const s = setup();
    const a = new Authenticator();
    const { options: signup } = await signupOptions(s.deps(), { playerId: ALICE });
    const created = a.create(signup.challenge);
    await signupVerify(s.deps(), { response: created });
    await expectError(signupVerify(s.deps(), { response: created }), 400, "challenge expired");
    const { options } = await loginOptions(s.deps());
    const response = a.get(options.challenge, signup.user.id);
    await loginVerify(s.deps(), { response });
    await expectError(loginVerify(s.deps(), { response }), 400, "challenge expired");
  });

  it("署名を書き換えた応答と、別の鍵で署名した応答（同じ credential ID）は 401", async () => {
    const s = setup();
    const a = new Authenticator();
    const userHandle = await register(s, a);
    const attempt = async (make: (challenge: string) => ReturnType<Authenticator["get"]>) => {
      const { options } = await loginOptions(s.deps());
      return loginVerify(s.deps(), { response: make(options.challenge) });
    };
    const tampered = (challenge: string) => {
      const r = a.get(challenge, userHandle);
      const sig = Buffer.from(r.response.signature, "base64url");
      sig[sig.length - 1] ^= 1;
      return { ...r, response: { ...r.response, signature: b64(sig) } };
    };
    await expectError(attempt(tampered), 401, "login failed");
    const forged = new Authenticator(a.credId);
    await expectError(
      attempt((c) => forged.get(c, userHandle, { counter: 100 })),
      401,
      "login failed",
    );
    expect((await s.auth.getCredential(a.id))?.counter).toBe(0);
  });
});
