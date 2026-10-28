// Applies pending migrations, then exits. Runs as a Container Apps Job before a
// new revision takes traffic (ARCHITECTURE §5, §10). Uses the unpooled URL on Neon.
import path from "node:path";
import { runMigrations } from "@/server/platform/migrate-runner";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
const migrationsFolder = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");

async function main(): Promise<void> {
  if (!url) throw new Error("DATABASE_URL (or DATABASE_URL_UNPOOLED) is required");
  const result = await runMigrations(url, migrationsFolder);
  console.log(result === "applied" ? "Migrations applied." : `No migrations in ${migrationsFolder}; nothing to apply.`);
}

main().catch((e: unknown) => {
  // Print the message only: never the connection URL.
  console.error("Migration failed:", e instanceof Error ? e.message : "unknown error");
  process.exit(1);
});
