import { existsSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Applies pending migrations from `folder`. Used by jobs/migrate.ts and the integration-test setup. */
export async function runMigrations(url: string, folder: string): Promise<"applied" | "none"> {
  if (!existsSync(path.join(folder, "meta", "_journal.json"))) return "none";
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
    return "applied";
  } finally {
    await client.end();
  }
}
