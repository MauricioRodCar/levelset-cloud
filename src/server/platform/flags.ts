import { eq } from "drizzle-orm";
import { featureFlags } from "@/db/schema";
import { type AuditActor, diffChanges, writeAudit } from "./audit";
import type { Config } from "./config";
import type { Db, DbOrTx } from "./db";
import { VersionConflictError } from "./errors";
import { updateAudited } from "./versioned";

/**
 * Feature flags (FR-37): the env var is the default; an Owner's toggle in the
 * admin panel is stored as a row, audited and version-checked like any edit.
 */

export const FLAG_ENV = {
  trials: "FLAG_TRIALS",
  self_serve_transfer: "FLAG_SELF_SERVE_TRANSFER",
} as const satisfies Record<string, keyof Config>;

export type FlagKey = keyof typeof FLAG_ENV;
export const FLAG_KEYS = Object.keys(FLAG_ENV) as FlagKey[];

export type FlagState = { key: FlagKey; enabled: boolean; source: "db" | "env"; version: number | null };

export async function getFlags(db: DbOrTx, config: Config): Promise<FlagState[]> {
  const rows = await db.select().from(featureFlags);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return FLAG_KEYS.map((key) => {
    const row = byKey.get(key);
    return row
      ? { key, enabled: row.enabled, source: "db", version: row.version }
      : { key, enabled: config[FLAG_ENV[key]], source: "env", version: null };
  });
}

export async function isFlagEnabled(db: DbOrTx, config: Config, key: FlagKey): Promise<boolean> {
  const [row] = await db.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
  return row ? row.enabled : config[FLAG_ENV[key]];
}

export type SetFlagInput = {
  key: FlagKey;
  enabled: boolean;
  /** Version the admin saw; `null` when the flag was still on its env default. */
  expectedVersion: number | null;
  actor: AuditActor;
  reason?: string | null;
  requestId?: string | null;
};

export async function setFlag(db: Db, input: SetFlagInput) {
  const updatedBy = input.actor.type === "user" ? input.actor.id : null;

  if (input.expectedVersion !== null) {
    return updateAudited(db, {
      table: featureFlags,
      pk: featureFlags.key,
      id: input.key,
      expectedVersion: input.expectedVersion,
      values: { enabled: input.enabled, updatedBy },
      actor: input.actor,
      action: "flag.update",
      reason: input.reason,
      requestId: input.requestId,
    });
  }

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(featureFlags)
      .values({ key: input.key, enabled: input.enabled, updatedBy })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      // Someone else overrode the env default first.
      const [current] = await tx.select().from(featureFlags).where(eq(featureFlags.key, input.key));
      throw new VersionConflictError("feature_flags", input.key, current);
    }
    await writeAudit(tx, {
      actor: input.actor,
      action: "flag.create",
      entityType: "feature_flags",
      entityId: input.key,
      changes: diffChanges({}, created),
      reason: input.reason,
      requestId: input.requestId,
    });
    return created;
  });
}
