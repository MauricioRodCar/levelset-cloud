// Applies pending migrations, then exits. Runs as a Container Apps Job before a
// new revision takes traffic (ARCHITECTURE §5, §10). Uses the unpooled URL on Neon.
import { existsSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
const migrationsFolder = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");

async function main(): Promise<void> {
  if (!url) throw new Error("DATABASE_URL (or DATABASE_URL_UNPOOLED) is required");
  if (!existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    console.log(`No migrations in ${migrationsFolder}; nothing to apply.`);
    return;
  }
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
    console.log("Migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  // Print the message only: never the connection URL.
  console.error("Migration failed:", e instanceof Error ? e.message : "unknown error");
  process.exit(1);
});
