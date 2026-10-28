import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activations, auditLog, customers, licenses, plans, subscriptions, users } from "@/db/schema";
import { writeAudit } from "@/server/platform/audit";
import { unique, testDb } from "./db";
import { makeCustomer, makeProduct, pgError } from "./fixtures";

const db = testDb();

async function makeLicense(overrides: Partial<typeof licenses.$inferInsert> = {}) {
  const customer = await makeCustomer(db);
  const product = await makeProduct(db);
  const [license] = await db
    .insert(licenses)
    .values({ customerId: customer.id, productId: product.id, kind: "manual", keyHash: unique("hash"), keyHint: "ABCD", ...overrides })
    .returning();
  return license!;
}

describe("audit_log is append-only", () => {
  it("accepts inserts but rejects UPDATE, DELETE and TRUNCATE", async () => {
    const entityId = unique("entity");
    await writeAudit(db, { actor: { type: "system", id: "test" }, action: "test.create", entityType: "test", entityId });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
    expect(row?.action).toBe("test.create");

    for (const query of [
      db.update(auditLog).set({ action: "tampered" }).where(eq(auditLog.id, row!.id)),
      db.delete(auditLog).where(eq(auditLog.id, row!.id)),
      db.execute(sql`truncate audit_log`),
    ]) {
      expect((await pgError(query)).message).toMatch(/append-only/);
    }
  });
});

describe("constraints", () => {
  it("stores emails lowercased only", async () => {
    expect((await pgError(db.insert(users).values({ email: "Mixed@Example.test" }))).code).toBe("23514");
  });

  it("requires provider and provider customer ID together", async () => {
    const [user] = await db.insert(users).values({ email: `${unique("u")}@example.test` }).returning();
    expect((await pgError(db.insert(customers).values({ userId: user!.id, provider: "stripe" }))).code).toBe("23514");
  });

  it("requires an expiry on tester licences", async () => {
    expect((await pgError(makeLicense({ kind: "tester" }))).code).toBe("23514");
    expect((await makeLicense({ kind: "tester", expiresAt: new Date(Date.now() + 86_400_000) })).kind).toBe("tester");
  });

  it("allows one licence per subscription (webhook retries can't duplicate it)", async () => {
    const customer = await makeCustomer(db);
    const product = await makeProduct(db);
    const [plan] = await db
      .insert(plans)
      .values({ productId: product.id, key: "pro_monthly", tier: "pro", interval: "month", priceRefEnv: "X", deviceLimit: 2 })
      .returning();
    const [sub] = await db
      .insert(subscriptions)
      .values({ customerId: customer.id, planId: plan!.id, provider: "fake", providerSubscriptionId: unique("sub"), state: "active" })
      .returning();
    const values = { customerId: customer.id, productId: product.id, kind: "subscription" as const, subscriptionId: sub!.id, keyHint: "ABCD" };
    await db.insert(licenses).values({ ...values, keyHash: unique("h") });
    expect((await pgError(db.insert(licenses).values({ ...values, keyHash: unique("h") }))).code).toBe("23505");
  });

  it("lets a device hold only one active slot per licence, and reuse it after deactivation", async () => {
    const license = await makeLicense();
    const device = { licenseId: license.id, deviceHash: unique("device"), label: "PC", os: "Windows 11", appVersion: "1.1.0" };
    const [first] = await db.insert(activations).values(device).returning();
    expect((await pgError(db.insert(activations).values(device))).code).toBe("23505");

    await db.update(activations).set({ deactivatedAt: new Date() }).where(eq(activations.id, first!.id));
    await expect(db.insert(activations).values(device).returning()).resolves.toHaveLength(1);
  });
});
