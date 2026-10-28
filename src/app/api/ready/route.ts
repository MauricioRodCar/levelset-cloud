import { sql } from "drizzle-orm";
import { ConfigError } from "@/server/platform/config";
import { getDb } from "@/server/platform/db";
import { migrationStatus } from "@/server/platform/migrations";

// Readiness: the database answers and every bundled migration is applied.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    const migrations = await migrationStatus(db);
    return Response.json(
      { status: migrations.upToDate ? "ready" : "migrations_pending", migrations },
      { status: migrations.upToDate ? 200 : 503 },
    );
  } catch (e) {
    // Details stay in the server log; the response never includes config or connection info.
    if (e instanceof ConfigError) {
      console.error(e.message); // variable names only, never values
      return Response.json({ status: "config_invalid" }, { status: 503 });
    }
    console.error("readiness check failed:", e instanceof Error ? e.name : "unknown");
    return Response.json({ status: "database_unavailable" }, { status: 503 });
  }
}
