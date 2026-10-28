import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./db";

/**
 * Migration reconciliation (ARCHITECTURE §5): compares the migrations bundled in
 * this build with the ones applied to the database. drizzle-kit stamps each
 * migration with its journal `when`; the migrator stores it as `created_at`.
 */

export const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

export type MigrationStatus = {
  bundled: number;
  applied: number;
  /** In this build but not yet applied: the DB is behind, so don't serve traffic. */
  pending: number;
  /** Applied but unknown to this build: an older image against a newer DB (fine during expand/contract). */
  unknown: number;
  upToDate: boolean;
};

export function compareMigrations(bundled: readonly number[], applied: readonly number[]): MigrationStatus {
  const appliedSet = new Set(applied);
  const bundledSet = new Set(bundled);
  const pending = bundled.filter((m) => !appliedSet.has(m)).length;
  const unknown = applied.filter((m) => !bundledSet.has(m)).length;
  return { bundled: bundled.length, applied: applied.length, pending, unknown, upToDate: pending === 0 };
}

type Journal = { entries: { when: number; tag: string }[] };

export async function readBundledMigrations(dir = MIGRATIONS_DIR): Promise<number[]> {
  try {
    const journal = JSON.parse(await readFile(path.join(dir, "meta", "_journal.json"), "utf8")) as Journal;
    return journal.entries.map((e) => e.when);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // no migrations generated yet
    throw e;
  }
}

export async function readAppliedMigrations(db: Db): Promise<number[]> {
  const [table] = await db.execute<{ t: string | null }>(
    sql`select to_regclass('drizzle.__drizzle_migrations')::text as t`,
  );
  if (!table?.t) return [];
  const rows = await db.execute<{ created_at: string }>(sql`select created_at from drizzle.__drizzle_migrations`);
  return rows.map((r) => Number(r.created_at));
}

export async function migrationStatus(db: Db): Promise<MigrationStatus> {
  const [bundled, applied] = await Promise.all([readBundledMigrations(), readAppliedMigrations(db)]);
  return compareMigrations(bundled, applied);
}
