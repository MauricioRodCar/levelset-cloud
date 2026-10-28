import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { activations, licenses, plans, products, subscriptions } from "@/db/schema";
import { type AuditActor, diffChanges, writeAudit } from "@/server/platform/audit";
import type { Config } from "@/server/platform/config";
import type { Db, Tx } from "@/server/platform/db";
import { AppError } from "@/server/platform/errors";
import { keyedHash } from "@/server/platform/hashing";
import { computeEntitlement, type Entitlement, type NotEntitledReason } from "./entitlements";
import { hashKey, normalizeKey } from "./keys";
import { InvalidTokenError, type SigningKeys, signLicenseToken, verifyLicenseToken } from "./tokens";

/**
 * Desktop licence API (FR-18–21, ARCHITECTURE §7): activate a device, refresh
 * its token, deactivate it. Every call locks the licence row, so the device
 * limit holds under concurrent activations (ARCHITECTURE §6.3).
 */

export type LicensingContext = {
  db: Db;
  pepper: string;
  keys: SigningKeys;
  config: Pick<
    Config,
    "TOKEN_TTL_DAYS" | "TOKEN_REFRESH_HOURS" | "DEFAULT_DEVICE_LIMIT" | "TRANSFER_COOLDOWN_HOURS" | "PRO_FEATURES"
  >;
};

export type DeviceInfo = { idHash: string; label: string; os: string; appVersion: string };

export type TokenGrant = {
  token: string;
  refreshAfter: Date;
  expiresAt: Date;
  tier: "pro" | "tester";
  features: string[];
};

export type DeviceSummary = { label: string; os: string; last_seen_at: string };

// Same error for malformed and unknown keys, so responses don't reveal which keys exist.
export class InvalidKeyError extends AppError {
  constructor() {
    super("invalid_key", 404, "Licence key not recognised");
  }
}

export class LicenseRevokedError extends AppError {
  constructor() {
    super("license_revoked", 403, "This licence has been revoked");
  }
}

export class NotEntitledError extends AppError {
  constructor(reason: NotEntitledReason) {
    super("license_not_entitled", 403, "This licence does not currently include Pro", { reason });
  }
}

export class DeviceLimitError extends AppError {
  constructor(devices: DeviceSummary[], deviceLimit: number, retryAfter: Date | null) {
    super("device_limit_reached", 409, "This licence is active on the maximum number of devices", {
      device_limit: deviceLimit,
      devices,
      ...(retryAfter ? { retry_after: retryAfter.toISOString() } : {}),
    });
  }
}

export class DeviceDeactivatedError extends AppError {
  constructor() {
    super("device_deactivated", 403, "This device is no longer activated for this licence");
  }
}

const API_ACTOR: AuditActor = { type: "system", id: "licensing-api" };

/** Sources that count against the transfer cooldown; support and key rotation free slots immediately. */
const COOLDOWN_SOURCES = ["device", "customer"] as const;

const deviceHashOf = (ctx: LicensingContext, idHash: string) => keyedHash(ctx.pepper, `device:${idHash}`);

export async function activate(
  ctx: LicensingContext,
  input: { key: string; device: DeviceInfo; requestId?: string },
  now = new Date(),
): Promise<TokenGrant> {
  const keyHash = hashKeyOrThrow(ctx, input.key);
  const deviceHash = deviceHashOf(ctx, input.device.idHash);

  return ctx.db.transaction(async (tx) => {
    const found = await lockLicense(tx, keyHash);
    const entitlement = assertEntitled(ctx, found, now);

    const active = await tx
      .select()
      .from(activations)
      .where(and(eq(activations.licenseId, found.license.id), isNull(activations.deactivatedAt)))
      .orderBy(asc(activations.firstSeenAt), asc(activations.id));

    const mine = active.find((a) => a.deviceHash === deviceHash);
    if (mine) {
      // Same device again (reinstall, retry): same slot, fresh details.
      await tx
        .update(activations)
        .set({ lastSeenAt: now, label: input.device.label, os: input.device.os, appVersion: input.device.appVersion })
        .where(eq(activations.id, mine.id));
      return grant(ctx, found.license.id, found.productSlug, entitlement, deviceHash, now);
    }

    // Slots freed recently by the customer or the device stay taken until the cooldown passes (FR-20).
    const cooldownStart = new Date(now.getTime() - ctx.config.TRANSFER_COOLDOWN_HOURS * 3_600_000);
    const recentlyFreed = await tx
      .select({ deviceHash: activations.deviceHash, deactivatedAt: activations.deactivatedAt })
      .from(activations)
      .where(
        and(
          eq(activations.licenseId, found.license.id),
          inArray(activations.deactivatedBy, [...COOLDOWN_SOURCES]),
          gt(activations.deactivatedAt, cooldownStart),
        ),
      );
    const activeHashes = new Set(active.map((a) => a.deviceHash));
    const cooling = recentlyFreed.filter((r) => r.deviceHash !== deviceHash && !activeHashes.has(r.deviceHash));
    const coolingSlots = new Set(cooling.map((r) => r.deviceHash)).size;

    if (active.length + coolingSlots >= entitlement.deviceLimit) {
      const freesAt = cooling.length
        ? new Date(Math.min(...cooling.map((r) => r.deactivatedAt!.getTime())) + ctx.config.TRANSFER_COOLDOWN_HOURS * 3_600_000)
        : null;
      throw new DeviceLimitError(
        active.map((a) => ({ label: a.label, os: a.os, last_seen_at: a.lastSeenAt.toISOString() })),
        entitlement.deviceLimit,
        active.length < entitlement.deviceLimit ? freesAt : null,
      );
    }

    const [created] = await tx
      .insert(activations)
      .values({
        licenseId: found.license.id,
        deviceHash,
        label: input.device.label,
        os: input.device.os,
        appVersion: input.device.appVersion,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning();
    await writeAudit(tx, {
      actor: API_ACTOR,
      action: "activation.create",
      entityType: "activations",
      entityId: created!.id,
      changes: diffChanges({}, { licenseId: created!.licenseId, label: created!.label, os: created!.os, appVersion: created!.appVersion }, {
        pii: ["label"],
        pepper: ctx.pepper,
      }),
      requestId: input.requestId,
    });
    return grant(ctx, found.license.id, found.productSlug, entitlement, deviceHash, now);
  });
}

export async function refresh(
  ctx: LicensingContext,
  input: { key: string; token: string },
  now = new Date(),
): Promise<TokenGrant> {
  const keyHash = hashKeyOrThrow(ctx, input.key);
  const claims = await verifyLicenseToken(ctx.keys, input.token, { now, checkExpiry: false });

  return ctx.db.transaction(async (tx) => {
    const found = await lockLicense(tx, keyHash);
    if (claims.sub !== found.license.id) throw new InvalidTokenError();
    const entitlement = assertEntitled(ctx, found, now);

    const [device] = await tx
      .update(activations)
      .set({ lastSeenAt: now })
      .where(and(eq(activations.licenseId, found.license.id), eq(activations.deviceHash, claims.dev), isNull(activations.deactivatedAt)))
      .returning({ id: activations.id });
    if (!device) throw new DeviceDeactivatedError();
    return grant(ctx, found.license.id, found.productSlug, entitlement, claims.dev, now);
  });
}

/** Frees this device's slot. Succeeds quietly if it was already free. */
export async function deactivate(
  ctx: LicensingContext,
  input: { key: string; deviceIdHash: string; requestId?: string },
  now = new Date(),
): Promise<void> {
  const keyHash = hashKeyOrThrow(ctx, input.key);
  await ctx.db.transaction(async (tx) => {
    const found = await lockLicense(tx, keyHash);
    const freed = await tx
      .update(activations)
      .set({ deactivatedAt: now, deactivatedBy: "device" })
      .where(
        and(
          eq(activations.licenseId, found.license.id),
          eq(activations.deviceHash, deviceHashOf(ctx, input.deviceIdHash)),
          isNull(activations.deactivatedAt),
        ),
      )
      .returning({ id: activations.id });
    if (freed[0]) {
      await writeAudit(tx, {
        actor: API_ACTOR,
        action: "activation.deactivate",
        entityType: "activations",
        entityId: freed[0].id,
        changes: { deactivatedBy: { from: null, to: "device" } },
        requestId: input.requestId,
      });
    }
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

function hashKeyOrThrow(ctx: LicensingContext, key: string): string {
  const canonical = normalizeKey(key);
  if (!canonical) throw new InvalidKeyError();
  return hashKey(ctx.pepper, canonical);
}

type LockedLicense = Awaited<ReturnType<typeof lockLicense>>;

async function lockLicense(tx: Tx, keyHash: string) {
  const [row] = await tx
    .select({ license: licenses, subscription: subscriptions, plan: plans, productSlug: products.slug })
    .from(licenses)
    .innerJoin(products, eq(licenses.productId, products.id))
    .leftJoin(subscriptions, eq(licenses.subscriptionId, subscriptions.id))
    .leftJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(licenses.keyHash, keyHash))
    .for("update", { of: licenses });
  if (!row) throw new InvalidKeyError();
  return row;
}

function assertEntitled(ctx: LicensingContext, found: LockedLicense, now: Date): Extract<Entitlement, { entitled: true }> {
  const entitlement = computeEntitlement(
    { license: found.license, subscription: found.subscription, plan: found.plan },
    { proFeatures: ctx.config.PRO_FEATURES, defaultDeviceLimit: ctx.config.DEFAULT_DEVICE_LIMIT },
    now,
  );
  if (!entitlement.entitled) {
    if (entitlement.reason === "revoked") throw new LicenseRevokedError();
    throw new NotEntitledError(entitlement.reason);
  }
  return entitlement;
}

async function grant(
  ctx: LicensingContext,
  licenseId: string,
  productSlug: string,
  entitlement: Extract<Entitlement, { entitled: true }>,
  deviceHash: string,
  now: Date,
): Promise<TokenGrant> {
  const { token, expiresAt, refreshAfter } = await signLicenseToken(
    ctx.keys,
    {
      sub: licenseId,
      prd: productSlug,
      tier: entitlement.tier,
      features: entitlement.features,
      dev: deviceHash,
      ent: entitlement.entitledUntil ? Math.floor(entitlement.entitledUntil.getTime() / 1000) : null,
    },
    { now, ttlDays: ctx.config.TOKEN_TTL_DAYS, refreshHours: ctx.config.TOKEN_REFRESH_HOURS, hardExpiry: entitlement.hardExpiry },
  );
  return { token, expiresAt, refreshAfter, tier: entitlement.tier, features: entitlement.features };
}
