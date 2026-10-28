import { describe, expect, it } from "vitest";
import { migrationStatus } from "@/server/platform/migrations";
import { testDb } from "./db";

const db = testDb();

describe("migration status against a real database", () => {
  it("is up to date after migrate", async () => {
    const status = await migrationStatus(db);
    expect(status.bundled).toBeGreaterThan(0);
    expect(status.pending).toBe(0);
    expect(status.upToDate).toBe(true);
  });
});
