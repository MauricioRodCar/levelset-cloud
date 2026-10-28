import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, featureFlags, plans, products } from "@/db/schema";
import { PLAN_DEFS, PRODUCT, seedCatalog } from "@/server/catalog/seed";
import { loadConfig } from "@/server/platform/config";
import { VersionConflictError } from "@/server/platform/errors";
import { getFlags, isFlagEnabled, setFlag } from "@/server/platform/flags";
import { testDb } from "./db";
import { makeUser } from "./fixtures";

const db = testDb();
const config = (env: Record<string, string> = {}) => loadConfig({ DATABASE_URL: "postgres://unused", ...env });

// Flags are global rows: tests in a file run in order, and each resets what it touches.
describe("feature flags", () => {
  it("fall back to env defaults, then follow an audited, version-checked override", async () => {
    await db.delete(featureFlags).where(eq(featureFlags.key, "trials"));
    const owner = await makeUser(db, "owner");
    const actor = { type: "user", id: owner.id } as const;

    expect(await isFlagEnabled(db, config(), "trials")).toBe(false);
    expect(await isFlagEnabled(db, config({ FLAG_TRIALS: "true", TRIAL_DAYS: "7" }), "trials")).toBe(true);

    const created = await setFlag(db, { key: "trials", enabled: true, expectedVersion: null, actor, reason: "launch test" });
    expect(created).toMatchObject({ enabled: true, version: 1, updatedBy: owner.id });
    expect((await getFlags(db, config())).find((f) => f.key === "trials")).toEqual({ key: "trials", enabled: true, source: "db", version: 1 });

    // A second admin who still saw the env default loses.
    await expect(setFlag(db, { key: "trials", enabled: false, expectedVersion: null, actor })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(setFlag(db, { key: "trials", enabled: false, expectedVersion: 7, actor })).rejects.toBeInstanceOf(VersionConflictError);

    const updated = await setFlag(db, { key: "trials", enabled: false, expectedVersion: 1, actor });
    expect(updated).toMatchObject({ enabled: false, version: 2 });

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "feature_flags"), eq(auditLog.entityId, "trials"), eq(auditLog.actorId, owner.id)));
    expect(entries.map((e) => e.action).sort()).toEqual(["flag.create", "flag.update"]);

    await db.delete(featureFlags).where(eq(featureFlags.key, "trials"));
  });
});

describe("seedCatalog", () => {
  it("creates once, is a no-op when config is unchanged, and audits config drift", async () => {
    const first = await seedCatalog(db, config({ PRO_FEATURES: "feature_a" }));
    // Another run may already have seeded this shared database; either way the end state is the same.
    expect([...first.created, ...first.updated, ...first.unchanged]).toHaveLength(1 + PLAN_DEFS.length);

    expect(await seedCatalog(db, config({ PRO_FEATURES: "feature_a" }))).toEqual({
      created: [],
      updated: [],
      unchanged: [`product:${PRODUCT.slug}`, "plan:pro_monthly", "plan:pro_annual"],
    });

    const changed = await seedCatalog(db, config({ PRO_FEATURES: "feature_a,feature_b", DEFAULT_DEVICE_LIMIT: "3" }));
    expect(changed.updated).toEqual(["plan:pro_monthly", "plan:pro_annual"]);

    const [product] = await db.select().from(products).where(eq(products.slug, PRODUCT.slug));
    const rows = await db.select().from(plans).where(eq(plans.productId, product!.id));
    expect(rows.map((p) => ({ key: p.key, features: p.features, deviceLimit: p.deviceLimit })).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "pro_annual", features: ["feature_a", "feature_b"], deviceLimit: 3 },
      { key: "pro_monthly", features: ["feature_a", "feature_b"], deviceLimit: 3 },
    ]);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "plan.update"), inArray(auditLog.entityId, rows.map((p) => p.id))));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.at(-1)).toMatchObject({ actorType: "system", actorId: "seed", reason: "config changed" });

    // Leave the catalog as the default config would.
    await seedCatalog(db, config());
  });
});
