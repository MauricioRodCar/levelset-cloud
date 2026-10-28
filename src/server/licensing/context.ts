import { getConfig, hashPepper } from "@/server/platform/config";
import { getDb } from "@/server/platform/db";
import type { LicensingContext } from "./activation";
import { loadSigningKeys, type SigningKeys } from "./tokens";

let keys: Promise<SigningKeys> | undefined;

/** Licensing context for this process; signing keys are imported once. */
export async function getLicensingContext(): Promise<LicensingContext> {
  const config = getConfig();
  keys ??= loadSigningKeys(config).then((k) => {
    if (k.ephemeral) console.warn("LICENSE_SIGNING_KEYS not set: using a throwaway signing key (development only)");
    return k;
  });
  return { db: getDb(), pepper: hashPepper(config), keys: await keys, config };
}

/** Rate limits for the desktop endpoints (ARCHITECTURE §8). */
export const LICENSE_RATE_LIMITS = {
  perIp: { limit: 60, windowSeconds: 600 },
  perKey: { limit: 30, windowSeconds: 3600 },
  invalidKeyPerIp: { limit: 10, windowSeconds: 3600 },
} as const;
