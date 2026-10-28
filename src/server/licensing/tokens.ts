import { compactVerify, exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK, SignJWT } from "jose";
import { AppError } from "@/server/platform/errors";
import { ConfigError, type Config } from "@/server/platform/config";

/**
 * Signed licence tokens (ARCHITECTURE §7.2): compact JWS, alg EdDSA (Ed25519).
 * The desktop app verifies them offline with public keys embedded at build
 * time (and published at /.well-known/jwks.json). Several keys can be loaded
 * at once so a rotation never breaks tokens already issued.
 */

export const ISSUER = "levelset-cloud";
export const AUDIENCE = "levelset-desktop";

export type Tier = "pro" | "tester";

export type LicenseClaims = {
  sub: string; // licence id
  prd: string; // product slug
  tier: Tier;
  features: string[];
  dev: string; // server-side device hash
  ent: number | null; // entitled until (unix seconds), if known
};

export type VerifiedClaims = LicenseClaims & { iat: number; exp: number; rfa: number; kid: string };

export type SigningKeys = {
  activeKid: string;
  signKey: CryptoKey;
  verifyKeys: Map<string, CryptoKey>;
  publicJwks: JWK[];
  ephemeral: boolean;
};

export class InvalidTokenError extends AppError {
  constructor() {
    super("invalid_token", 403, "Licence token is not valid");
  }
}

type PrivateJwk = JWK & { kid: string; d: string; x: string };

/** Parses LICENSE_SIGNING_KEYS. Outside production a throwaway key is generated if none is configured. */
export async function loadSigningKeys(config: Pick<Config, "NODE_ENV" | "LICENSE_SIGNING_KEYS" | "LICENSE_ACTIVE_KID">): Promise<SigningKeys> {
  if (!config.LICENSE_SIGNING_KEYS) {
    if (config.NODE_ENV === "production") throw new ConfigError(["LICENSE_SIGNING_KEYS: is required"]);
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const kid = "dev-ephemeral";
    return {
      activeKid: kid,
      signKey: privateKey,
      verifyKeys: new Map([[kid, publicKey]]),
      publicJwks: [{ ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" }],
      ephemeral: true,
    };
  }

  let jwks: PrivateJwk[];
  try {
    jwks = JSON.parse(config.LICENSE_SIGNING_KEYS) as PrivateJwk[];
    if (!Array.isArray(jwks) || jwks.length === 0) throw new Error();
  } catch {
    throw new ConfigError(["LICENSE_SIGNING_KEYS: must be a JSON array of Ed25519 private JWKs"]);
  }
  for (const jwk of jwks) {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x || !jwk.kid) {
      throw new ConfigError(["LICENSE_SIGNING_KEYS: every key needs kty OKP, crv Ed25519, d, x and kid"]);
    }
  }
  const activeKid = config.LICENSE_ACTIVE_KID ?? jwks.at(-1)!.kid;
  const active = jwks.find((k) => k.kid === activeKid);
  if (!active) throw new ConfigError(["LICENSE_ACTIVE_KID: does not match any key in LICENSE_SIGNING_KEYS"]);

  const verifyKeys = new Map<string, CryptoKey>();
  const publicJwks: JWK[] = [];
  for (const { kid, x } of jwks) {
    const pub: JWK = { kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" };
    verifyKeys.set(kid, (await importJWK(pub, "EdDSA")) as CryptoKey);
    publicJwks.push(pub);
  }
  return {
    activeKid,
    signKey: (await importJWK(active, "EdDSA")) as CryptoKey,
    verifyKeys,
    publicJwks,
    ephemeral: false,
  };
}

export type SignOptions = {
  now: Date;
  ttlDays: number;
  refreshHours: number;
  /** A hard end (tester or manual expiry): the token never outlives it, even offline. */
  hardExpiry: Date | null;
};

export async function signLicenseToken(keys: SigningKeys, claims: LicenseClaims, opts: SignOptions) {
  const iat = Math.floor(opts.now.getTime() / 1000);
  let exp = iat + opts.ttlDays * 86_400;
  if (opts.hardExpiry) exp = Math.min(exp, Math.floor(opts.hardExpiry.getTime() / 1000));
  const rfa = Math.min(iat + opts.refreshHours * 3600, exp);

  const token = await new SignJWT({ ...claims, rfa })
    .setProtectedHeader({ alg: "EdDSA", kid: keys.activeKid, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(exp)
    .sign(keys.signKey);
  return { token, expiresAt: new Date(exp * 1000), refreshAfter: new Date(rfa * 1000) };
}

/**
 * Verifies signature, issuer and audience. Expiry is checked only when asked:
 * a refresh accepts an expired token (the app was offline too long) as long
 * as the signature, licence and device still match.
 */
export async function verifyLicenseToken(
  keys: SigningKeys,
  token: string,
  opts: { now: Date; checkExpiry: boolean },
): Promise<VerifiedClaims> {
  try {
    const { payload, protectedHeader } = await compactVerify(token, (header) => {
      const key = header.kid ? keys.verifyKeys.get(header.kid) : undefined;
      if (!key || header.alg !== "EdDSA") throw new Error("unknown key");
      return key;
    });
    const claims = JSON.parse(new TextDecoder().decode(payload)) as VerifiedClaims & { iss: string; aud: string };
    if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) throw new Error("wrong issuer or audience");
    if (typeof claims.sub !== "string" || typeof claims.dev !== "string" || typeof claims.exp !== "number") throw new Error("malformed");
    if (opts.checkExpiry && claims.exp <= Math.floor(opts.now.getTime() / 1000)) throw new Error("expired");
    return { ...claims, kid: protectedHeader.kid! };
  } catch {
    throw new InvalidTokenError();
  }
}
