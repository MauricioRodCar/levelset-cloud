import { describe, expect, it } from "vitest";
import { diffChanges } from "@/server/platform/audit";
import { AppError, problemResponse, VersionConflictError } from "@/server/platform/errors";
import { canonicalJson, keyedHash } from "@/server/platform/hashing";
import { requestHash } from "@/server/platform/idempotency";
import { windowStart } from "@/server/platform/rate-limit";

describe("canonicalJson / requestHash", () => {
  it("ignores key order and normalises dates", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: new Date(0) } })).toBe(
      '{"a":{"c":"1970-01-01T00:00:00.000Z","d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("hashes equal requests equally and different ones differently", () => {
    const a = requestHash({ method: "post", path: "/x", body: { a: 1, b: 2 } });
    expect(requestHash({ method: "POST", path: "/x", body: { b: 2, a: 1 } })).toBe(a);
    expect(requestHash({ method: "POST", path: "/x", body: { a: 1, b: 3 } })).not.toBe(a);
    expect(requestHash({ method: "POST", path: "/y", body: { a: 1, b: 2 } })).not.toBe(a);
  });
});

describe("keyedHash", () => {
  it("depends on the pepper", () => {
    expect(keyedHash("p1", "v")).toMatch(/^[0-9a-f]{64}$/);
    expect(keyedHash("p1", "v")).not.toBe(keyedHash("p2", "v"));
  });
});

describe("diffChanges", () => {
  it("lists only changed fields and skips bookkeeping columns", () => {
    const before = { id: "1", status: "active", notes: null, version: 1, updatedAt: new Date(0) };
    const after = { id: "1", status: "revoked", notes: "fraud", version: 2, updatedAt: new Date(1) };
    expect(diffChanges(before, after)).toEqual({
      status: { from: "active", to: "revoked" },
      notes: { from: null, to: "fraud" },
    });
  });

  it("serialises dates and treats a create as from-null", () => {
    expect(diffChanges({}, { expiresAt: new Date(0) })).toEqual({
      expiresAt: { from: null, to: "1970-01-01T00:00:00.000Z" },
    });
  });

  it("hashes PII fields and never stores their raw values", () => {
    const changes = diffChanges({ email: "a@example.com" }, { email: "b@example.com" }, { pii: ["email"], pepper: "p" });
    expect(JSON.stringify(changes)).not.toContain("example.com");
    expect(changes.email?.to).toBe(`hmac:${keyedHash("p", "b@example.com")}`);
  });

  it("refuses to hash PII without a pepper", () => {
    expect(() => diffChanges({}, { email: "a@example.com" }, { pii: ["email"] })).toThrow(/pepper/);
  });
});

describe("windowStart", () => {
  it("floors to the window boundary", () => {
    expect(windowStart(new Date("2026-10-28T10:07:31Z"), 60).toISOString()).toBe("2026-10-28T10:07:00.000Z");
    expect(windowStart(new Date("2026-10-28T10:07:31Z"), 3600).toISOString()).toBe("2026-10-28T10:00:00.000Z");
  });
});

describe("problemResponse", () => {
  it("renders RFC 9457 with a stable code", async () => {
    const res = problemResponse(new VersionConflictError("licenses", "abc", { version: 3 }), "req-1");
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 409, code: "version_conflict", current: { version: 3 }, request_id: "req-1" });
  });

  it("keeps the error name for logs", () => {
    expect(new AppError("x", 400, "m").name).toBe("AppError");
  });
});
