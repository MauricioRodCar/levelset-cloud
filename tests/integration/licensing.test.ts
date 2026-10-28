import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { activations, auditLog, licenses, plans, products, subscriptions } from "@/db/schema";
import {
  activate,
  deactivate,
  DeviceDeactivatedError,
  DeviceLimitError,
  InvalidKeyError,
  LicenseRevokedError,
  type LicensingContext,
  NotEntitledError,
  refresh,
} from "@/server/licensing/activation";
import { issueKey } from "@/server/licensing/keys";
import { InvalidTokenError, loadSigningKeys } from "@/server/licensing/tokens";
import type { SubscriptionState } from "@/server/billing/types";
import { testDb, unique } from "./db";
import { makeCustomer } from "./fixtures";

const db = testDb();
let ctx: LicensingContext;
const actor = { type: "system", id: "test" } as const;
const HOUR = 3_600_000;

beforeAll(async () => {
  ctx = {
    db,
    pepper: "test-pepper",
    keys: await loadSigningKeys({ NODE_ENV: "test", LICENSE_SIGNING_KEYS: undefined, LICENSE_ACTIVE_KID: undefined }),
    config: { TOKEN_TTL_DAYS: 7, TOKEN_REFRESH_HOURS: 24, DEFAULT_DEVICE_LIMIT: 2, TRANSFER_COOLDOWN_HOURS: 24, PRO_FEATURES: ["feature_a", "feature_b"] },
  };
});

const device = (n = 1) => ({
  idHash: createHash("sha256").update(unique(`machine-${n}`)).digest("hex"),
  label: `PC ${n}`,
  os: "Windows 11",
  appVersion: "1.1.0",
});

async function licensed(
  opts: { kind?: "subscription" | "tester" | "manual"; state?: SubscriptionState; expiresAt?: Date; deviceLimitOverride?: number } = {},
) {
  const kind = opts.kind ?? "subscription";
  const customer = await makeCustomer(db);
  const [product] = await db.select().from(products).where(eq(products.slug, "levelset"));
  let subscriptionId: string | null = null;
  if (kind === "subscription") {
    const [plan] = await db.select().from(plans).where(and(eq(plans.productId, product!.id), eq(plans.key, "pro_monthly")));
    const [sub] = await db
      .insert(subscriptions)
      .values({
        customerId: customer.id,
        planId: plan!.id,
        provider: "fake",
        providerSubscriptionId: unique("sub"),
        state: opts.state ?? "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * HOUR),
      })
      .returning();
    subscriptionId = sub!.id;
  }
  const [license] = await db
    .insert(licenses)
    .values({
      customerId: customer.id,
      productId: product!.id,
      kind,
      subscriptionId,
      expiresAt: opts.expiresAt ?? (kind === "tester" ? new Date(Date.now() + 14 * 24 * HOUR) : null),
      deviceLimitOverride: opts.deviceLimitOverride ?? null,
    })
    .returning();
  const { key } = await issueKey(db, { licenseId: license!.id, expectedVersion: 1, actor, pepper: ctx.pepper });
  return { key, license: license!, subscriptionId };
}

describe("activate", () => {
  it("activates a paid licence and returns a token bound to this device", async () => {
    const { key, license } = await licensed();
    const now = new Date();
    const grant = await activate(ctx, { key, device: device() }, now);
    const claims = decodeJwt(grant.token);
    expect(claims).toMatchObject({ sub: license.id, prd: "levelset", tier: "pro", aud: "levelset-desktop" });
    expect(grant.expiresAt.getTime() - now.getTime()).toBeLessThan(7 * 24 * HOUR + 1000);
    expect(grant.refreshAfter.getTime() - now.getTime()).toBeLessThan(24 * HOUR + 1000);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "activation.create")).limit(1);
    expect(JSON.stringify(audit!.changes)).not.toContain("PC 1"); // device label hashed
  });

  it("accepts the key however the user types it", async () => {
    const { key } = await licensed();
    await expect(activate(ctx, { key: key.toLowerCase().replace(/-/g, " "), device: device() })).resolves.toHaveProperty("token");
  });

  it("reuses the slot when the same device activates again", async () => {
    const { key, license } = await licensed();
    const pc = device();
    await activate(ctx, { key, device: pc });
    await activate(ctx, { key, device: { ...pc, label: "Renamed PC" } });
    const rows = await db.select().from(activations).where(eq(activations.licenseId, license.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("Renamed PC");
  });

  it("stops at the device limit and lists the active devices", async () => {
    const { key } = await licensed();
    await activate(ctx, { key, device: device(1) });
    await activate(ctx, { key, device: device(2) });
    const err = await activate(ctx, { key, device: device(3) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceLimitError);
    expect((err as DeviceLimitError).extra).toMatchObject({ device_limit: 2, devices: [{ label: "PC 1" }, { label: "PC 2" }] });
    expect((err as DeviceLimitError).extra).not.toHaveProperty("retry_after");
  });

  it("holds the limit when four devices activate at the same moment", async () => {
    const { key, license } = await licensed();
    const results = await Promise.allSettled([1, 2, 3, 4].map((n) => activate(ctx, { key, device: device(n) })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof DeviceLimitError)).toBe(true);
    const rows = await db.select().from(activations).where(eq(activations.licenseId, license.id));
    expect(rows).toHaveLength(2);
  });

  it("honours a per-licence device limit override", async () => {
    const { key } = await licensed({ deviceLimitOverride: 1 });
    await activate(ctx, { key, device: device(1) });
    await expect(activate(ctx, { key, device: device(2) })).rejects.toBeInstanceOf(DeviceLimitError);
  });

  it("keeps a freed slot during the transfer cooldown, except for the same device", async () => {
    const { key } = await licensed();
    const t0 = new Date();
    const [pc1, pc2, pc3] = [device(1), device(2), device(3)];
    await activate(ctx, { key, device: pc1 }, t0);
    await activate(ctx, { key, device: pc2 }, t0);
    await deactivate(ctx, { key, deviceIdHash: pc1.idHash }, t0);

    const err = await activate(ctx, { key, device: pc3 }, new Date(t0.getTime() + HOUR)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceLimitError);
    expect((err as DeviceLimitError).extra.retry_after).toBe(new Date(t0.getTime() + 24 * HOUR).toISOString());

    await expect(activate(ctx, { key, device: pc1 }, new Date(t0.getTime() + HOUR))).resolves.toHaveProperty("token");
    await deactivate(ctx, { key, deviceIdHash: pc1.idHash }, new Date(t0.getTime() + 2 * HOUR));
    await expect(activate(ctx, { key, device: pc3 }, new Date(t0.getTime() + 27 * HOUR))).resolves.toHaveProperty("token");
  });

  it("frees the slot immediately when support deactivates a device", async () => {
    const { key, license } = await licensed();
    const [pc1, pc2] = [device(1), device(2)];
    await activate(ctx, { key, device: pc1 });
    await activate(ctx, { key, device: pc2 });
    await db
      .update(activations)
      .set({ deactivatedAt: new Date(), deactivatedBy: "support" })
      .where(and(eq(activations.licenseId, license.id), eq(activations.label, "PC 1")));
    await expect(activate(ctx, { key, device: device(3) })).resolves.toHaveProperty("token");
  });

  it("refuses unknown, revoked, suspended and unpaid licences", async () => {
    await expect(activate(ctx, { key: "LSET-00000-00000-00000-00000", device: device() })).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(activate(ctx, { key: "not a key", device: device() })).rejects.toBeInstanceOf(InvalidKeyError);

    const revoked = await licensed();
    await db.update(licenses).set({ status: "revoked" }).where(eq(licenses.id, revoked.license.id));
    await expect(activate(ctx, { key: revoked.key, device: device() })).rejects.toBeInstanceOf(LicenseRevokedError);

    const suspended = await licensed();
    await db.update(licenses).set({ status: "suspended" }).where(eq(licenses.id, suspended.license.id));
    const err = await activate(ctx, { key: suspended.key, device: device() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotEntitledError);
    expect((err as NotEntitledError).extra.reason).toBe("suspended");

    const unpaid = await licensed({ state: "unpaid" });
    await expect(activate(ctx, { key: unpaid.key, device: device() })).rejects.toMatchObject({ extra: { reason: "subscription_inactive" } });
  });

  it("gives testers full access and caps the token at their expiry", async () => {
    const expiresAt = new Date(Date.now() + 2 * 24 * HOUR);
    const { key } = await licensed({ kind: "tester", expiresAt });
    const grant = await activate(ctx, { key, device: device() });
    expect(grant).toMatchObject({ tier: "tester", features: ["feature_a", "feature_b"] });
    expect(grant.expiresAt.getTime()).toBe(Math.floor(expiresAt.getTime() / 1000) * 1000);
    await expect(activate(ctx, { key, device: device(2) }, new Date(expiresAt.getTime() + 1000))).rejects.toMatchObject({
      extra: { reason: "expired" },
    });
  });
});

describe("refresh", () => {
  it("issues a fresh token, even from an expired one, while the device stays active", async () => {
    const { key } = await licensed();
    const t0 = new Date();
    const first = await activate(ctx, { key, device: device() }, t0);
    const later = new Date(t0.getTime() + 10 * 24 * HOUR); // offline longer than the grace period
    const next = await refresh(ctx, { key, token: first.token }, later);
    expect(next.expiresAt > later).toBe(true);
    expect(decodeJwt(next.token).dev).toBe(decodeJwt(first.token).dev);
  });

  it("reports cancellation and deactivation on the next refresh", async () => {
    const { key, subscriptionId } = await licensed();
    const pc = device();
    const grant = await activate(ctx, { key, device: pc });
    await db.update(subscriptions).set({ state: "ended" }).where(eq(subscriptions.id, subscriptionId!));
    await expect(refresh(ctx, { key, token: grant.token })).rejects.toMatchObject({ extra: { reason: "subscription_inactive" } });

    await db.update(subscriptions).set({ state: "active" }).where(eq(subscriptions.id, subscriptionId!));
    await deactivate(ctx, { key, deviceIdHash: pc.idHash });
    await expect(refresh(ctx, { key, token: grant.token })).rejects.toBeInstanceOf(DeviceDeactivatedError);
  });

  it("rejects a token from another licence or a forged one", async () => {
    const a = await licensed();
    const b = await licensed();
    const tokenA = (await activate(ctx, { key: a.key, device: device() })).token;
    await expect(refresh(ctx, { key: b.key, token: tokenA })).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(refresh(ctx, { key: a.key, token: `${tokenA.slice(0, -4)}AAAA` })).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe("key rotation", () => {
  it("invalidates the old key and signs out every device", async () => {
    const { key, license } = await licensed();
    const grant = await activate(ctx, { key, device: device() });
    const [current] = await db.select().from(licenses).where(eq(licenses.id, license.id));
    const rotated = await issueKey(db, { licenseId: license.id, expectedVersion: current!.version, actor, pepper: ctx.pepper });
    expect(rotated).toMatchObject({ rotated: true, devicesSignedOut: 1 });

    await expect(activate(ctx, { key, device: device() })).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(refresh(ctx, { key: rotated.key, token: grant.token })).rejects.toBeInstanceOf(DeviceDeactivatedError);
    await expect(activate(ctx, { key: rotated.key, device: device() })).resolves.toHaveProperty("token");

    const actions = (await db.select().from(auditLog).where(eq(auditLog.entityId, license.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["license.key_issue", "license.key_rotate", "activation.deactivate_all"]));
  });
});
