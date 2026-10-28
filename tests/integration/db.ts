import { randomUUID } from "node:crypto";
import { afterAll, inject } from "vitest";
import { createDb } from "@/server/platform/db";

/**
 * One small pool per test file, closed after the file. Tests never truncate:
 * each one creates its own rows with unique values (see `unique`), so files can
 * share the database and the append-only audit log stays append-only.
 */
export function testDb() {
  const db = createDb(inject("databaseUrl"), { max: 8 });
  afterAll(async () => {
    await db.$client.end();
  });
  return db;
}

export const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
