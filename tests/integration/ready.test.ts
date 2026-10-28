import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@/server/platform/db";
import { migrationStatus } from "@/server/platform/migrations";

// Runs after `npm run db:migrate` against the same DATABASE_URL (docker compose locally, a service in CI).
const url = process.env.DATABASE_URL;
const db = url ? createDb(url, { max: 1 }) : undefined;

afterAll(async () => {
  await db?.$client.end();
});

describe.runIf(db)("migration status against a real database", () => {
  it("is up to date after migrate", async () => {
    const status = await migrationStatus(db!);
    expect(status.pending).toBe(0);
    expect(status.upToDate).toBe(true);
  });
});
