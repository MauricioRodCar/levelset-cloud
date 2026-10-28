// Syncs the product catalog with config. Runs after migrate on every deploy (ARCHITECTURE §10).
import { seedCatalog } from "@/server/catalog/seed";
import { ConfigError, loadConfig } from "@/server/platform/config";
import { createDb } from "@/server/platform/db";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDb(config.DATABASE_URL_UNPOOLED ?? config.DATABASE_URL, { max: 1 });
  try {
    const result = await seedCatalog(db, config);
    console.log(
      `Catalog: created [${result.created.join(", ")}], updated [${result.updated.join(", ")}], unchanged [${result.unchanged.join(", ")}]`,
    );
  } finally {
    await db.$client.end();
  }
}

main().catch((e: unknown) => {
  console.error("Seed failed:", e instanceof ConfigError ? e.message : e instanceof Error ? e.message : "unknown error");
  process.exit(1);
});
