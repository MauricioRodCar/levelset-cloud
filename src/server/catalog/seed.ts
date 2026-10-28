import { and, eq } from "drizzle-orm";
import { plans, products } from "@/db/schema";
import { diffChanges, writeAudit } from "@/server/platform/audit";
import type { Config } from "@/server/platform/config";
import type { Db } from "@/server/platform/db";
import { updateAudited } from "@/server/platform/versioned";

/**
 * Brings the catalog in line with config (PRD FR-1). Safe to run on every
 * deploy: rows are created once, then only updated when config differs, and
 * every change is audited as `system:seed`. No amounts: plans reference the
 * env var that holds the provider's price ID.
 */

export const PRODUCT = { slug: "levelset", name: "Levelset" } as const;

export const PLAN_DEFS = [
  { key: "pro_monthly", tier: "pro", interval: "month", priceRefEnv: "STRIPE_PRICE_PRO_MONTHLY" },
  { key: "pro_annual", tier: "pro", interval: "year", priceRefEnv: "STRIPE_PRICE_PRO_ANNUAL" },
] as const;

const actor = { type: "system", id: "seed" } as const;

export type SeedResult = { created: string[]; updated: string[]; unchanged: string[] };

export async function seedCatalog(db: Db, config: Config): Promise<SeedResult> {
  const result: SeedResult = { created: [], updated: [], unchanged: [] };

  const product = await db.transaction(async (tx) => {
    const [created] = await tx.insert(products).values(PRODUCT).onConflictDoNothing().returning();
    if (created) {
      await writeAudit(tx, {
        actor,
        action: "product.create",
        entityType: "products",
        entityId: created.id,
        changes: diffChanges({}, created),
      });
      result.created.push(`product:${PRODUCT.slug}`);
      return created;
    }
    const [existing] = await tx.select().from(products).where(eq(products.slug, PRODUCT.slug));
    result.unchanged.push(`product:${PRODUCT.slug}`);
    return existing!;
  });

  for (const def of PLAN_DEFS) {
    const desired = { ...def, productId: product.id, deviceLimit: config.DEFAULT_DEVICE_LIMIT, features: config.PRO_FEATURES };
    const label = `plan:${def.key}`;

    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(plans).values(desired).onConflictDoNothing().returning();
      if (row) {
        await writeAudit(tx, { actor, action: "plan.create", entityType: "plans", entityId: row.id, changes: diffChanges({}, row) });
      }
      return row;
    });
    if (created) {
      result.created.push(label);
      continue;
    }

    const [existing] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.productId, product.id), eq(plans.key, def.key)));
    const drift = diffChanges(existing!, { ...existing!, ...desired });
    if (Object.keys(drift).length === 0) {
      result.unchanged.push(label);
      continue;
    }
    await updateAudited(db, {
      table: plans,
      pk: plans.id,
      id: existing!.id,
      expectedVersion: existing!.version,
      values: desired,
      actor,
      action: "plan.update",
      reason: "config changed",
    });
    result.updated.push(label);
  }

  return result;
}
