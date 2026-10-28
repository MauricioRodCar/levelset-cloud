import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { computeEntitlement, type EntitlementInput } from "@/server/licensing/entitlements";
import { ALPHABET, checkSymbol, generateKey, keyHint, normalizeKey } from "@/server/licensing/keys";
import { InvalidTokenError, loadSigningKeys, signLicenseToken, verifyLicenseToken } from "@/server/licensing/tokens";
import { ConfigError } from "@/server/platform/config";

describe("licence keys", () => {
  it("generates well-formed, unique keys that pass their own check", () => {
    const keys = Array.from({ length: 200 }, generateKey);
    for (const k of keys) {
      expect(k).toMatch(/^LSET(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
      expect(normalizeKey(k)).toBe(k);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("catches every single-symbol typo", () => {
    const key = generateKey();
    const symbols = key.replace(/^LSET-/, "").replace(/-/g, "");
    for (let i = 0; i < symbols.length; i++) {
      for (const c of ALPHABET) {
        if (c === symbols[i]) continue;
        const typo = symbols.slice(0, i) + c + symbols.slice(i + 1);
        expect(normalizeKey(typo)).toBeNull();
      }
    }
  });

  it("catches most swapped neighbours", () => {
    let caught = 0;
    let total = 0;
    for (let n = 0; n < 50; n++) {
      const symbols = generateKey().replace(/^LSET-/, "").replace(/-/g, "");
      for (let i = 0; i < symbols.length - 1; i++) {
        if (symbols[i] === symbols[i + 1]) continue;
        const swapped = symbols.slice(0, i) + symbols[i + 1] + symbols[i] + symbols.slice(i + 2);
        total++;
        if (normalizeKey(swapped) === null) caught++;
      }
    }
    expect(caught / total).toBeGreaterThan(0.95);
  });

  it("forgives case, spacing, dashes and Crockford look-alikes", () => {
    const body = "0123456789ABCDEFGHJ";
    const key = `LSET-${(body + checkSymbol(body)).match(/.{5}/g)!.join("-")}`;
    expect(normalizeKey(key.toLowerCase())).toBe(key);
    expect(normalizeKey(key.replace(/-/g, " "))).toBe(key);
    expect(normalizeKey(key.replace("LSET-0", "lset-o").replace("1", "I"))).toBe(key);
    expect(normalizeKey(key.replace(/^LSET-/, ""))).toBe(key);
    expect(normalizeKey("LSET-ABCDE")).toBeNull();
    expect(normalizeKey("")).toBeNull();
    expect(keyHint(key)).toBe(key.slice(-4));
  });
});

describe("licence tokens", () => {
  const dev = { NODE_ENV: "test" as const, LICENSE_SIGNING_KEYS: undefined, LICENSE_ACTIVE_KID: undefined };
  const claims = { sub: "lic-1", prd: "levelset", tier: "pro" as const, features: ["feature_a"], dev: "dev-hash", ent: null };
  const now = new Date("2026-10-28T12:00:00Z");
  const opts = { now, ttlDays: 7, refreshHours: 24, hardExpiry: null };

  async function configuredKeys(kids: string[], active?: string) {
    const jwks = [];
    for (const kid of kids) {
      const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
      jwks.push({ ...(await exportJWK(privateKey)), kid });
    }
    return { NODE_ENV: "production" as const, LICENSE_SIGNING_KEYS: JSON.stringify(jwks), LICENSE_ACTIVE_KID: active, jwks };
  }

  it("signs EdDSA tokens with the documented claims", async () => {
    const keys = await loadSigningKeys(dev);
    const { token, expiresAt, refreshAfter } = await signLicenseToken(keys, claims, opts);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", kid: "dev-ephemeral", typ: "JWT" });
    const payload = decodeJwt(token);
    expect(payload).toMatchObject({ ...claims, iss: "levelset-cloud", aud: "levelset-desktop" });
    expect(payload.exp! - payload.iat!).toBe(7 * 86_400);
    expect(payload.rfa).toBe(payload.iat! + 24 * 3600);
    expect(expiresAt.toISOString()).toBe("2026-11-04T12:00:00.000Z");
    expect(refreshAfter.toISOString()).toBe("2026-10-29T12:00:00.000Z");
    expect(await verifyLicenseToken(keys, token, { now, checkExpiry: true })).toMatchObject(claims);
  });

  it("never lets a token outlive a hard expiry", async () => {
    const keys = await loadSigningKeys(dev);
    const hardExpiry = new Date("2026-10-30T00:00:00Z");
    const { expiresAt, refreshAfter } = await signLicenseToken(keys, claims, { ...opts, hardExpiry });
    expect(expiresAt).toEqual(hardExpiry);
    expect(refreshAfter <= expiresAt).toBe(true);
  });

  it("rejects tampered, foreign and (when asked) expired tokens", async () => {
    const keys = await loadSigningKeys(dev);
    const { token } = await signLicenseToken(keys, claims, opts);
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...decodeJwt(token), tier: "tester" })).toString("base64url");
    await expect(verifyLicenseToken(keys, `${h}.${forged}.${s}`, { now, checkExpiry: false })).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifyLicenseToken(await loadSigningKeys(dev), token, { now, checkExpiry: false })).rejects.toBeInstanceOf(InvalidTokenError);
    expect(p).toBeTruthy();

    const later = new Date(now.getTime() + 8 * 86_400_000);
    await expect(verifyLicenseToken(keys, token, { now: later, checkExpiry: true })).rejects.toBeInstanceOf(InvalidTokenError);
    expect((await verifyLicenseToken(keys, token, { now: later, checkExpiry: false })).sub).toBe("lic-1");
  });

  it("keeps verifying tokens signed with the previous key after a rotation", async () => {
    const before = await configuredKeys(["2026-09"]);
    const oldKeys = await loadSigningKeys(before);
    const { token } = await signLicenseToken(oldKeys, claims, opts);

    const newKey = await configuredKeys(["2026-10"]);
    const both = await loadSigningKeys({
      NODE_ENV: "production",
      LICENSE_SIGNING_KEYS: JSON.stringify([...before.jwks, ...newKey.jwks]),
      LICENSE_ACTIVE_KID: "2026-10",
    });
    expect(both.publicJwks.map((k) => k.kid)).toEqual(["2026-09", "2026-10"]);
    expect(both.publicJwks.every((k) => !("d" in k))).toBe(true);
    expect((await verifyLicenseToken(both, token, { now, checkExpiry: true })).kid).toBe("2026-09");
    expect(decodeProtectedHeader((await signLicenseToken(both, claims, opts)).token).kid).toBe("2026-10");
  });

  it("validates the key configuration", async () => {
    await expect(loadSigningKeys({ ...dev, NODE_ENV: "production" })).rejects.toBeInstanceOf(ConfigError);
    await expect(loadSigningKeys({ ...dev, LICENSE_SIGNING_KEYS: "not json" })).rejects.toThrow(/JSON array/);
    await expect(loadSigningKeys({ ...dev, LICENSE_SIGNING_KEYS: '[{"kty":"RSA"}]' })).rejects.toThrow(/Ed25519/);
    const one = await configuredKeys(["a"]);
    await expect(loadSigningKeys({ ...one, LICENSE_ACTIVE_KID: "b" })).rejects.toThrow(/LICENSE_ACTIVE_KID/);
  });
});

describe("computeEntitlement", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const settings = { proFeatures: ["feature_a", "feature_b"], defaultDeviceLimit: 2 };
  const plan = { deviceLimit: 3, features: ["feature_a"] };
  const base = (overrides: Partial<EntitlementInput["license"]> = {}): EntitlementInput["license"] => ({
    kind: "subscription",
    status: "active",
    expiresAt: null,
    deviceLimitOverride: null,
    ...overrides,
  });

  it("follows the subscription state for subscription licences", () => {
    for (const state of ["trialing", "active", "cancel_scheduled", "past_due"] as const) {
      expect(computeEntitlement({ license: base(), subscription: { state, currentPeriodEnd: now }, plan }, settings, now)).toMatchObject({
        entitled: true,
        tier: "pro",
        features: ["feature_a"],
        deviceLimit: 3,
        hardExpiry: null,
      });
    }
    for (const state of ["incomplete", "unpaid", "ended"] as const) {
      expect(computeEntitlement({ license: base(), subscription: { state, currentPeriodEnd: now }, plan }, settings, now)).toEqual({
        entitled: false,
        reason: "subscription_inactive",
        deviceLimit: 3,
      });
    }
    expect(computeEntitlement({ license: base(), subscription: null, plan: null }, settings, now)).toMatchObject({ reason: "no_subscription" });
  });

  it("gives testers full access until their expiry", () => {
    const expiresAt = new Date(now.getTime() + 86_400_000);
    expect(computeEntitlement({ license: base({ kind: "tester", expiresAt }), subscription: null, plan: null }, settings, now)).toEqual({
      entitled: true,
      tier: "tester",
      features: ["feature_a", "feature_b"],
      entitledUntil: expiresAt,
      hardExpiry: expiresAt,
      deviceLimit: 2,
    });
    expect(computeEntitlement({ license: base({ kind: "tester", expiresAt: now }), subscription: null, plan: null }, settings, now)).toMatchObject({
      reason: "expired",
    });
  });

  it("lets overrides win: revoked, suspended, device limit", () => {
    const sub = { state: "active" as const, currentPeriodEnd: now };
    expect(computeEntitlement({ license: base({ status: "revoked" }), subscription: sub, plan }, settings, now)).toMatchObject({ reason: "revoked" });
    expect(computeEntitlement({ license: base({ status: "suspended" }), subscription: sub, plan }, settings, now)).toMatchObject({ reason: "suspended" });
    expect(computeEntitlement({ license: base({ deviceLimitOverride: 5 }), subscription: sub, plan }, settings, now).deviceLimit).toBe(5);
    expect(computeEntitlement({ license: base({ kind: "manual" }), subscription: null, plan: null }, settings, now)).toMatchObject({
      entitled: true,
      tier: "pro",
      hardExpiry: null,
    });
  });
});
