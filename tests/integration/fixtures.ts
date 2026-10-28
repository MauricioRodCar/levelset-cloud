import { customers, products, users } from "@/db/schema";
import type { Db } from "@/server/platform/db";
import { unique } from "./db";

export async function makeUser(db: Db, role: "customer" | "support" | "owner" = "customer") {
  const [user] = await db.insert(users).values({ email: `${unique("user")}@example.test`, role }).returning();
  return user!;
}

export async function makeCustomer(db: Db) {
  const user = await makeUser(db);
  const [customer] = await db.insert(customers).values({ userId: user.id }).returning();
  return customer!;
}

/** A private product per test, so tests never depend on the seeded catalog. */
export async function makeProduct(db: Db) {
  const [product] = await db.insert(products).values({ slug: unique("product"), name: "Test product" }).returning();
  return product!;
}

/** Postgres error from a rejected query (drizzle wraps it in `cause`). */
export async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const err = ((e as { cause?: unknown }).cause ?? e) as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error("expected the query to fail");
}
