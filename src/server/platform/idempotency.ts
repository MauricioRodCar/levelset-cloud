import { and, eq, lte } from "drizzle-orm";
import { idempotencyKeys } from "@/db/schema";
import type { DbOrTx } from "./db";
import { IdempotencyInProgressError, IdempotencyKeyReusedError } from "./errors";
import { canonicalJson, sha256 } from "./hashing";

/**
 * `Idempotency-Key` handling (FR-14, ARCHITECTURE §6.2).
 *
 * - same key + same request, finished   → replay the stored response
 * - same key + same request, in flight  → 409 idempotency_in_progress
 * - same key + different request        → 422 idempotency_key_reused
 *
 * The handler's own writes are not in the same transaction as the key, so
 * handlers must also be naturally idempotent (unique constraints, upserts).
 * Then a crash between "handler done" and "key completed" is safe: after
 * STALE_AFTER_MS the key is taken over and the handler re-runs harmlessly.
 */

export const TTL_MS = 24 * 60 * 60 * 1000;
export const STALE_AFTER_MS = 60 * 1000;

export type StoredResponse = { status: number; body: unknown };
export type BeginResult = { kind: "proceed" } | { kind: "replay"; response: StoredResponse };
export type IdempotencyRef = { scope: string; key: string };

export function requestHash(req: { method: string; path: string; body: unknown }): string {
  return sha256(`${req.method.toUpperCase()} ${req.path}\n${canonicalJson(req.body ?? null)}`);
}

export async function beginIdempotent(
  db: DbOrTx,
  ref: IdempotencyRef & { requestHash: string },
  now = new Date(),
): Promise<BeginResult> {
  const where = and(eq(idempotencyKeys.scope, ref.scope), eq(idempotencyKeys.key, ref.key));

  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ ...ref, createdAt: now, expiresAt: new Date(now.getTime() + TTL_MS) })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length) return { kind: "proceed" };

    const [row] = await db.select().from(idempotencyKeys).where(where).limit(1);
    if (!row) continue; // removed between our insert and select: try again

    if (row.expiresAt <= now) {
      await db.delete(idempotencyKeys).where(and(where, eq(idempotencyKeys.expiresAt, row.expiresAt)));
      continue;
    }
    if (row.requestHash !== ref.requestHash) throw new IdempotencyKeyReusedError();
    if (row.state === "done") {
      return { kind: "replay", response: { status: row.responseStatus ?? 200, body: row.responseBody } };
    }
    if (now.getTime() - row.createdAt.getTime() >= STALE_AFTER_MS) {
      // The previous attempt died mid-flight. Exactly one caller wins the takeover.
      const taken = await db
        .update(idempotencyKeys)
        .set({ createdAt: now })
        .where(and(where, eq(idempotencyKeys.state, "in_progress"), eq(idempotencyKeys.createdAt, row.createdAt)))
        .returning({ key: idempotencyKeys.key });
      if (taken.length) return { kind: "proceed" };
    }
    throw new IdempotencyInProgressError();
  }
  throw new IdempotencyInProgressError();
}

export async function completeIdempotent(db: DbOrTx, ref: IdempotencyRef, response: StoredResponse): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ state: "done", responseStatus: response.status, responseBody: response.body ?? null })
    .where(and(eq(idempotencyKeys.scope, ref.scope), eq(idempotencyKeys.key, ref.key)));
}

/** Releases the key after a thrown error so the client can retry with the same key. */
export async function abandonIdempotent(db: DbOrTx, ref: IdempotencyRef): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(
      and(eq(idempotencyKeys.scope, ref.scope), eq(idempotencyKeys.key, ref.key), eq(idempotencyKeys.state, "in_progress")),
    );
}

/** Runs `handler` at most once per (scope, key, request); returned responses (including 4xx) are stored and replayed. */
export async function withIdempotency(
  db: DbOrTx,
  ref: IdempotencyRef & { requestHash: string },
  handler: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const begin = await beginIdempotent(db, ref);
  if (begin.kind === "replay") return { ...begin.response, replayed: true };
  try {
    const response = await handler();
    await completeIdempotent(db, ref, response);
    return { ...response, replayed: false };
  } catch (e) {
    await abandonIdempotent(db, ref);
    throw e;
  }
}

export async function purgeExpiredIdempotencyKeys(db: DbOrTx, now = new Date()): Promise<number> {
  const deleted = await db
    .delete(idempotencyKeys)
    .where(lte(idempotencyKeys.expiresAt, now))
    .returning({ key: idempotencyKeys.key });
  return deleted.length;
}
