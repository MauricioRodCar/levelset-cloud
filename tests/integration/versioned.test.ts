import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, licenses, users } from "@/db/schema";
import { NotFoundError, VersionConflictError } from "@/server/platform/errors";
import { keyedHash } from "@/server/platform/hashing";
import { updateAudited } from "@/server/platform/versioned";
import { unique, testDb } from "./db";
import { makeCustomer, makeProduct, makeUser } from "./fixtures";

const db = testDb();
const owner = { type: "user", id: "00000000-0000-0000-0000-000000000001" } as const;

async function makeLicense() {
  const customer = await makeCustomer(db);
  const product = await makeProduct(db);
  const [license] = await db
    .insert(licenses)
    .values({ customerId: customer.id, productId: product.id, kind: "manual", keyHash: unique("h"), keyHint: "ABCD" })
    .returning();
  return license!;
}

const revoke = (id: string, expectedVersion: number, notes = "chargeback") =>
  updateAudited(db, {
    table: licenses,
    pk: licenses.id,
    id,
    expectedVersion,
    values: { status: "revoked", notes },
    actor: owner,
    action: "license.revoke",
    reason: "test",
    requestId: "req-1",
  });

describe("updateAudited", () => {
  it("bumps the version and writes one audit entry with the diff", async () => {
    const license = await makeLicense();
    const updated = await revoke(license.id, 1);
    expect(updated).toMatchObject({ status: "revoked", notes: "chargeback", version: 2 });

    const entries = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "licenses"), eq(auditLog.entityId, license.id)));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorType: "user",
      actorId: owner.id,
      action: "license.revoke",
      reason: "test",
      requestId: "req-1",
      changes: { status: { from: "active", to: "revoked" }, notes: { from: null, to: "chargeback" } },
    });
  });

  it("rejects a stale version with the current row and changes nothing", async () => {
    const license = await makeLicense();
    await revoke(license.id, 1);
    const err = await revoke(license.id, 1, "second edit").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect((err as VersionConflictError<{ version: number }>).current.version).toBe(2);
    const [row] = await db.select().from(licenses).where(eq(licenses.id, license.id));
    expect(row).toMatchObject({ notes: "chargeback", version: 2 });
  });

  it("lets exactly one of two concurrent edits win", async () => {
    const license = await makeLicense();
    const results = await Promise.allSettled([revoke(license.id, 1, "a"), revoke(license.id, 1, "b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, license.id));
    expect(audits).toHaveLength(1);
  });

  it("reports a missing row as not found", async () => {
    await expect(revoke("00000000-0000-0000-0000-00000000dead", 1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("stores PII fields as keyed hashes in the audit log", async () => {
    const user = await makeUser(db);
    const newEmail = `${unique("new")}@example.test`;
    await updateAudited(db, {
      table: users,
      pk: users.id,
      id: user.id,
      expectedVersion: 1,
      values: { email: newEmail },
      actor: owner,
      action: "user.update_email",
      pii: ["email"],
      pepper: "test-pepper",
    });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.entityId, user.id));
    expect(JSON.stringify(entry!.changes)).not.toContain("example.test");
    expect(entry!.changes).toEqual({ email: { from: `hmac:${keyedHash("test-pepper", user.email)}`, to: `hmac:${keyedHash("test-pepper", newEmail)}` } });
  });
});
