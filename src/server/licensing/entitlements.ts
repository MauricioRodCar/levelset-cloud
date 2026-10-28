import { ENTITLED_STATES } from "@/server/billing/machine";
import type { SubscriptionState } from "@/server/billing/types";

/**
 * Effective entitlement of a licence (ARCHITECTURE §4.2). Computed, never
 * stored: the licence status is only an admin/dispute override, and paid
 * access follows the subscription state. Pure, so the desktop flow, the
 * customer area and future server features (AI proxy, data relay) agree.
 */

export type EntitlementInput = {
  license: {
    kind: "subscription" | "tester" | "manual";
    status: "active" | "suspended" | "revoked";
    expiresAt: Date | null;
    deviceLimitOverride: number | null;
  };
  subscription: { state: SubscriptionState; currentPeriodEnd: Date | null } | null;
  plan: { deviceLimit: number; features: string[] } | null;
};

export type EntitlementSettings = { proFeatures: string[]; defaultDeviceLimit: number };

export type NotEntitledReason = "revoked" | "suspended" | "expired" | "subscription_inactive" | "no_subscription";

export type Entitlement =
  | {
      entitled: true;
      tier: "pro" | "tester";
      features: string[];
      /** Best-known end of paid access (period end or expiry); informational. */
      entitledUntil: Date | null;
      /** Tokens never outlive this, even offline (tester and manual expiries). */
      hardExpiry: Date | null;
      deviceLimit: number;
    }
  | { entitled: false; reason: NotEntitledReason; deviceLimit: number };

export function computeEntitlement(input: EntitlementInput, settings: EntitlementSettings, now: Date): Entitlement {
  const { license, subscription, plan } = input;
  const deviceLimit = license.deviceLimitOverride ?? plan?.deviceLimit ?? settings.defaultDeviceLimit;
  const no = (reason: NotEntitledReason): Entitlement => ({ entitled: false, reason, deviceLimit });

  if (license.status === "revoked") return no("revoked");
  if (license.status === "suspended") return no("suspended");

  switch (license.kind) {
    case "tester":
    case "manual": {
      // Testers get full access; a tester licence always has an expiry (DB check constraint).
      if (license.expiresAt && license.expiresAt <= now) return no("expired");
      return {
        entitled: true,
        tier: license.kind === "tester" ? "tester" : "pro",
        features: settings.proFeatures,
        entitledUntil: license.expiresAt,
        hardExpiry: license.expiresAt,
        deviceLimit,
      };
    }
    case "subscription": {
      if (!subscription || !plan) return no("no_subscription");
      if (!ENTITLED_STATES.has(subscription.state)) return no("subscription_inactive");
      return {
        entitled: true,
        tier: "pro",
        features: plan.features,
        entitledUntil: subscription.currentPeriodEnd,
        hardExpiry: null, // renewals happen online; the offline grace covers the gap
        deviceLimit,
      };
    }
  }
}
