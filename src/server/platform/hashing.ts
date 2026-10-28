import { createHash, createHmac } from "node:crypto";

/** Keyed hash for identifiers we must match but never store raw (licence keys, device IDs, PII in audit rows). */
export function keyedHash(pepper: string, value: string): string {
  return createHmac("sha256", pepper).update(value, "utf8").digest("hex");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic JSON: object keys sorted recursively, so equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
