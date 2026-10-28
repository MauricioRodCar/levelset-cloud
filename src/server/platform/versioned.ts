import { and, eq, getTableName, sql, type InferSelectModel } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import { type AuditActor, diffChanges, writeAudit } from "./audit";
import type { DbOrTx } from "./db";
import { NotFoundError, VersionConflictError } from "./errors";

/**
 * Optimistic concurrency + audit in one step (FR-26, FR-27):
 *
 *   UPDATE … SET …, version = version + 1 WHERE pk = $id AND version = $expected
 *
 * Zero rows means someone else changed (or deleted) the row since the caller
 * read it: we throw VersionConflictError carrying the current row. Every
 * successful update writes an audit entry in the same transaction.
 */

type VersionedTable = PgTable & { version: PgColumn; updatedAt: PgColumn };

export type UpdateAuditedOptions<T extends VersionedTable> = {
  table: T;
  /** Primary-key column (usually `table.id`). */
  pk: PgColumn;
  id: string;
  expectedVersion: number;
  values: PgUpdateSetSource<T>;
  actor: AuditActor;
  action: string;
  reason?: string | null;
  requestId?: string | null;
  pii?: readonly string[];
  pepper?: string;
};

/** Runs in its own transaction, or a savepoint when `db` is already a transaction. */
export async function updateAudited<T extends VersionedTable>(
  db: DbOrTx,
  opts: UpdateAuditedOptions<T>,
): Promise<InferSelectModel<T>> {
  const { table, pk, id, expectedVersion } = opts;
  const entityType = getTableName(table);
  type Row = InferSelectModel<T>;

  return db.transaction(async (tx) => {
    const selectRow = async () =>
      ((await tx.select().from(table as PgTable).where(eq(pk, id)).limit(1)) as Row[])[0];

    const before = await selectRow();
    if (!before) throw new NotFoundError(entityType, id);
    if ((before as { version: number }).version !== expectedVersion) {
      throw new VersionConflictError(entityType, id, before);
    }

    const set = { ...opts.values, version: sql`${table.version} + 1`, updatedAt: new Date() } as PgUpdateSetSource<T>;
    const [after] = (await tx
      .update(table)
      .set(set)
      .where(and(eq(pk, id), eq(table.version, expectedVersion)))
      .returning()) as Row[];

    if (!after) {
      // Changed between our read and our write: report the winner's version.
      const current = await selectRow();
      if (!current) throw new NotFoundError(entityType, id);
      throw new VersionConflictError(entityType, id, current);
    }

    await writeAudit(tx, {
      actor: opts.actor,
      action: opts.action,
      entityType,
      entityId: id,
      changes: diffChanges(before as Record<string, unknown>, after as Record<string, unknown>, {
        pii: opts.pii,
        pepper: opts.pepper,
      }),
      reason: opts.reason,
      requestId: opts.requestId,
    });
    return after;
  });
}
