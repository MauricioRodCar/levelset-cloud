import { and, eq, lt, sql } from "drizzle-orm";
import { rateLimits } from "@/db/schema";
import type { DbOrTx } from "./db";

/**
 * Postgres-backed fixed-window rate limits (ARCHITECTURE §8). Works across
 * replicas without Redis; one atomic upsert per hit. Buckets must contain
 * hashed identifiers only, e.g. `activate:ip:<keyedHash(ip)>`.
 */

export type RateLimitRule = { limit: number; windowSeconds: number };
export type RateLimitResult = { allowed: boolean; count: number; limit: number; resetAt: Date };

export function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export async function hitRateLimit(
  db: DbOrTx,
  bucket: string,
  rule: RateLimitRule,
  now = new Date(),
): Promise<RateLimitResult> {
  const start = windowStart(now, rule.windowSeconds);
  const [row] = await db
    .insert(rateLimits)
    .values({ bucket, windowStart: start, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.bucket, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  const count = row?.count ?? 1;
  return {
    allowed: count <= rule.limit,
    count,
    limit: rule.limit,
    resetAt: new Date(start.getTime() + rule.windowSeconds * 1000),
  };
}

/** Reads the current window without counting a hit (e.g. "too many failures from this IP?"). */
export async function peekRateLimit(
  db: DbOrTx,
  bucket: string,
  rule: RateLimitRule,
  now = new Date(),
): Promise<RateLimitResult> {
  const start = windowStart(now, rule.windowSeconds);
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.bucket, bucket), eq(rateLimits.windowStart, start)));
  const count = row?.count ?? 0;
  return { allowed: count < rule.limit, count, limit: rule.limit, resetAt: new Date(start.getTime() + rule.windowSeconds * 1000) };
}

/** Called by the purge job; windows older than `before` no longer matter. */
export async function purgeRateLimits(db: DbOrTx, before: Date): Promise<number> {
  const deleted = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, before))
    .returning({ bucket: rateLimits.bucket });
  return deleted.length;
}
