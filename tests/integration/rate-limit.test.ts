import { describe, expect, it } from "vitest";
import { hitRateLimit, purgeRateLimits } from "@/server/platform/rate-limit";
import { unique, testDb } from "./db";

const db = testDb();
const rule = { limit: 5, windowSeconds: 60 };

describe("hitRateLimit", () => {
  it("allows up to the limit, then denies until the next window", async () => {
    const bucket = unique("bucket");
    const now = new Date("2026-10-28T10:00:10Z");
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await hitRateLimit(db, bucket, rule, now));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    expect(results[5]!.resetAt.toISOString()).toBe("2026-10-28T10:01:00.000Z");

    expect((await hitRateLimit(db, bucket, rule, new Date("2026-10-28T10:01:00Z"))).allowed).toBe(true);
  });

  it("counts concurrent hits exactly (no lost updates)", async () => {
    const bucket = unique("bucket");
    const now = new Date("2026-10-28T11:00:00Z");
    const results = await Promise.all(Array.from({ length: 20 }, () => hitRateLimit(db, bucket, rule, now)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(new Set(results.map((r) => r.count)).size).toBe(20);
  });

  it("purges old windows", async () => {
    const bucket = unique("bucket");
    await hitRateLimit(db, bucket, rule, new Date("2000-01-01T00:00:00Z"));
    expect(await purgeRateLimits(db, new Date("2000-01-02T00:00:00Z"))).toBeGreaterThanOrEqual(1);
  });
});
