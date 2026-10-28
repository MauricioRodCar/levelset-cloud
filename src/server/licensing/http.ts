import { z } from "zod";
import { type ApiRequest, clientIp, enforceRateLimits } from "@/server/http/api";
import { RateLimitedError } from "@/server/platform/errors";
import { keyedHash } from "@/server/platform/hashing";
import { hitRateLimit, peekRateLimit } from "@/server/platform/rate-limit";
import { InvalidKeyError, type LicensingContext, type TokenGrant } from "./activation";
import { LICENSE_RATE_LIMITS } from "./context";
import { normalizeKey } from "./keys";

/** Request schemas for the desktop contract (docs/api/openapi.yaml). */
const deviceIdHash = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256");
const key = z.string().min(1).max(64);

export const ActivateBody = z.object({
  key,
  device: z.object({
    id_hash: deviceIdHash,
    label: z.string().trim().min(1).max(64),
    os: z.string().trim().min(1).max(64),
    app_version: z.string().trim().min(1).max(32),
  }),
});
export const RefreshBody = z.object({ key, token: z.string().min(1).max(4096) });
export const DeactivateBody = z.object({ key, device_id_hash: deviceIdHash });

export function grantBody(g: TokenGrant) {
  return {
    token: g.token,
    refresh_after: g.refreshAfter.toISOString(),
    expires_at: g.expiresAt.toISOString(),
    tier: g.tier,
    features: g.features,
  };
}

/**
 * Rate limits around a licence call (FR-23): per IP and per key on every call,
 * plus a stricter budget for invalid keys per IP to slow down key guessing.
 */
export async function withLicenseLimits<T>(ctx: LicensingContext, api: ApiRequest, rawKey: string, fn: () => Promise<T>): Promise<T> {
  const now = new Date();
  const ip = clientIp(api.req);
  const invalidBucket = `lic-invalid-ip:${keyedHash(ctx.pepper, ip)}`;
  const rule = LICENSE_RATE_LIMITS.invalidKeyPerIp;

  const invalid = await peekRateLimit(ctx.db, invalidBucket, rule, now);
  if (!invalid.allowed) throw new RateLimitedError(secondsUntil(invalid.resetAt, now));

  await enforceRateLimits(
    ctx.db,
    ctx.pepper,
    [
      { name: "lic-ip", identifier: ip, rule: LICENSE_RATE_LIMITS.perIp },
      { name: "lic-key", identifier: normalizeKey(rawKey) ?? rawKey, rule: LICENSE_RATE_LIMITS.perKey },
    ],
    now,
  );

  try {
    return await fn();
  } catch (e) {
    if (e instanceof InvalidKeyError) await hitRateLimit(ctx.db, invalidBucket, rule, now);
    throw e;
  }
}

const secondsUntil = (t: Date, now: Date) => Math.max(1, Math.ceil((t.getTime() - now.getTime()) / 1000));
