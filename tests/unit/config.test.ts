import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@/server/platform/config";

const base = { DATABASE_URL: "postgres://localhost/levelset" };
const stripe = {
  ...base,
  PAYMENT_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: "sk_test_abc",
  STRIPE_WEBHOOK_SECRET: "whsec_abc",
  STRIPE_PRICE_PRO_MONTHLY: "price_m",
  STRIPE_PRICE_PRO_ANNUAL: "price_a",
};

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      PAYMENT_PROVIDER: "fake",
      TOKEN_TTL_DAYS: 7,
      TOKEN_REFRESH_HOURS: 24,
      DEFAULT_DEVICE_LIMIT: 2,
      AUDIT_RETENTION_YEARS: 5,
      DEVICE_PURGE_MONTHS: 12,
      FLAG_TRIALS: false,
      FLAG_SELF_SERVE_TRANSFER: true,
      OWNER_EMAILS: [],
    });
  });

  it("requires DATABASE_URL and treats empty strings as unset", () => {
    expect(problems({ DATABASE_URL: "" })).toEqual(["DATABASE_URL: is required"]);
  });

  it("coerces numbers and booleans", () => {
    const c = loadConfig({ ...base, DEFAULT_DEVICE_LIMIT: "3", FLAG_TRIALS: "true", TRIAL_DAYS: "7" });
    expect(c.DEFAULT_DEVICE_LIMIT).toBe(3);
    expect(c.FLAG_TRIALS).toBe(true);
  });

  it("normalises and validates owner emails", () => {
    expect(loadConfig({ ...base, OWNER_EMAILS: " Owner@Example.com, ,b@example.com" }).OWNER_EMAILS).toEqual([
      "owner@example.com",
      "b@example.com",
    ]);
    expect(problems({ ...base, OWNER_EMAILS: "not-an-email" })[0]).toMatch(/^OWNER_EMAILS/);
  });

  it("requires every Stripe variable when the provider is stripe", () => {
    expect(loadConfig(stripe).PAYMENT_PROVIDER).toBe("stripe");
    expect(problems({ ...base, PAYMENT_PROVIDER: "stripe" })).toHaveLength(4);
  });

  it("refuses live Stripe keys unless explicitly allowed", () => {
    const live = { ...stripe, STRIPE_SECRET_KEY: "sk_live_abc" };
    expect(problems(live)).toEqual([expect.stringMatching(/^STRIPE_SECRET_KEY: must be a test-mode key/)]);
    expect(loadConfig({ ...live, STRIPE_ALLOW_LIVE: "true" }).STRIPE_ALLOW_LIVE).toBe(true);
  });

  it("refuses the fake provider in production and requires the hash pepper there", () => {
    expect(problems({ ...base, NODE_ENV: "production" })).toEqual([
      "PAYMENT_PROVIDER: cannot be 'fake' in production",
      "KEY_HASH_PEPPER: is required",
    ]);
  });

  it("parses the Pro feature list", () => {
    expect(loadConfig({ ...base, PRO_FEATURES: "feature_a, feature_b," }).PRO_FEATURES).toEqual(["feature_a", "feature_b"]);
    expect(problems({ ...base, PRO_FEATURES: "Bad Name" })[0]).toMatch(/^PRO_FEATURES/);
  });

  it("checks cross-field rules", () => {
    expect(problems({ ...base, FLAG_TRIALS: "true" })).toEqual(["TRIAL_DAYS: must be > 0 when FLAG_TRIALS=true"]);
    expect(problems({ ...base, TOKEN_TTL_DAYS: "1", TOKEN_REFRESH_HOURS: "24" })[0]).toMatch(/^TOKEN_REFRESH_HOURS/);
    expect(problems({ ...base, EMAIL_PROVIDER: "resend" })).toHaveLength(2);
  });

  it("never echoes secret values in errors", () => {
    const value = "short-but-secret-value";
    const err = (() => {
      try {
        loadConfig({ ...base, SESSION_SECRET: value, STRIPE_SECRET_KEY: "sk_live_leak", PAYMENT_PROVIDER: "stripe" });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.message).not.toContain(value);
    expect(err?.message).not.toContain("sk_live_leak");
    expect(err?.message).toContain("SESSION_SECRET");
  });
});
