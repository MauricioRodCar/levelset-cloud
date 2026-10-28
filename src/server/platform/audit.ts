import { auditLog } from "@/db/schema";
import type { DbOrTx } from "./db";
import { keyedHash } from "./hashing";

/**
 * Append-only audit log (FR-26). Every change by anyone is written in the same
 * transaction as the change itself. Raw PII never lands here: fields listed in
 * `pii` are stored as keyed hashes, so an ARCO deletion doesn't need to touch audit rows.
 */

export type AuditActor =
  | { type: "user"; id: string }
  | { type: "system"; id: string } // job or process name, e.g. "seed", "reconcile"
  | { type: "provider"; id: string }; // payment provider + event id

export type Changes = Record<string, { from: unknown; to: unknown }>;

export type AuditEntry = {
  actor: AuditActor;
  action: string; // dotted verb, e.g. "license.revoke", "flag.update"
  entityType: string;
  entityId: string;
  changes?: Changes;
  reason?: string | null;
  requestId?: string | null;
};

const NEVER_DIFFED = new Set(["createdAt", "updatedAt", "version"]);

export type DiffOptions = {
  /** Fields whose values are replaced by keyed hashes. */
  pii?: readonly string[];
  pepper?: string;
};

/** Field-level diff of two row snapshots. Pass `{}` as `before` for a create. */
export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  { pii = [], pepper }: DiffOptions = {},
): Changes {
  const changes: Changes = {};
  const piiSet = new Set(pii);
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NEVER_DIFFED.has(field)) continue;
    const from = normalize(before[field]);
    const to = normalize(after[field]);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    if (piiSet.has(field)) {
      if (!pepper) throw new Error(`diffChanges: a pepper is required to hash PII field '${field}'`);
      changes[field] = { from: hashed(pepper, from), to: hashed(pepper, to) };
    } else {
      changes[field] = { from, to };
    }
  }
  return changes;
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function hashed(pepper: string, v: unknown): string | null {
  return v === null ? null : `hmac:${keyedHash(pepper, String(v))}`;
}

export async function writeAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    changes: entry.changes ?? {},
    reason: entry.reason ?? null,
    requestId: entry.requestId ?? null,
  });
}
