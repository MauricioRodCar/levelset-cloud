import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { idempotencyKeys } from "@/db/schema";
import { IdempotencyInProgressError, IdempotencyKeyReusedError } from "@/server/platform/errors";
import {
  beginIdempotent,
  purgeExpiredIdempotencyKeys,
  requestHash,
  STALE_AFTER_MS,
  TTL_MS,
  withIdempotency,
} from "@/server/platform/idempotency";
import { unique, testDb } from "./db";

const db = testDb();
const hashA = requestHash({ method: "POST", path: "/api/v1/licenses/activate", body: { key: "A" } });
const hashB = requestHash({ method: "POST", path: "/api/v1/licenses/activate", body: { key: "B" } });
const ref = (requestHash = hashA) => ({ scope: "test", key: unique("idem"), requestHash });

describe("withIdempotency", () => {
  it("runs the handler once and replays the stored response", async () => {
    const r = ref();
    let calls = 0;
    const handler = async () => ({ status: 201, body: { n: ++calls } });
    expect(await withIdempotency(db, r, handler)).toEqual({ status: 201, body: { n: 1 }, replayed: false });
    expect(await withIdempotency(db, r, handler)).toEqual({ status: 201, body: { n: 1 }, replayed: true });
    expect(calls).toBe(1);
  });

  it("stores and replays error responses too (no double side effects)", async () => {
    const r = ref();
    const handler = async () => ({ status: 409, body: { code: "device_limit_reached" } });
    await withIdempotency(db, r, handler);
    expect(await withIdempotency(db, r, async () => ({ status: 200, body: "different" }))).toMatchObject({
      status: 409,
      replayed: true,
    });
  });

  it("rejects the same key with a different request", async () => {
    const r = ref();
    await withIdempotency(db, r, async () => ({ status: 200, body: null }));
    await expect(withIdempotency(db, { ...r, requestHash: hashB }, async () => ({ status: 200, body: null }))).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
  });

  it("releases the key when the handler throws, so a retry can run", async () => {
    const r = ref();
    await expect(withIdempotency(db, r, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withIdempotency(db, r, async () => ({ status: 200, body: "ok" }))).toMatchObject({ body: "ok", replayed: false });
  });
});

describe("beginIdempotent", () => {
  it("lets exactly one of many concurrent requests proceed", async () => {
    const r = ref();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => beginIdempotent(db, r)));
    const proceeded = results.filter((x) => x.status === "fulfilled" && x.value.kind === "proceed");
    expect(proceeded).toHaveLength(1);
    for (const x of results.filter((x) => x.status === "rejected")) {
      expect((x as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyInProgressError);
    }
  });

  it("lets one caller take over a stale in-flight key", async () => {
    const r = ref();
    const t0 = new Date();
    await beginIdempotent(db, r, t0);
    await expect(beginIdempotent(db, r, new Date(t0.getTime() + 1000))).rejects.toBeInstanceOf(IdempotencyInProgressError);
    const later = new Date(t0.getTime() + STALE_AFTER_MS + 1);
    const results = await Promise.allSettled([beginIdempotent(db, r, later), beginIdempotent(db, r, later)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("treats an expired key as new, and the purge removes expired keys", async () => {
    const r = ref();
    const t0 = new Date();
    await withIdempotency(db, r, async () => ({ status: 200, body: "old" }));
    const afterTtl = new Date(t0.getTime() + TTL_MS + 1000);
    expect(await beginIdempotent(db, { ...r, requestHash: hashB }, afterTtl)).toEqual({ kind: "proceed" });

    const other = ref();
    await beginIdempotent(db, other, t0);
    expect(await purgeExpiredIdempotencyKeys(db, new Date(t0.getTime() + TTL_MS + 1))).toBeGreaterThanOrEqual(1);
    const left = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, other.scope), eq(idempotencyKeys.key, other.key)));
    expect(left).toHaveLength(0);
  });
});
