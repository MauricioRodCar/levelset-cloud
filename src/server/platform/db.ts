import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { getConfig } from "./config";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 5, prepare: false, onnotice: () => {} });
  return drizzle(client, { schema });
}

let db: Db | undefined;

/** One pool per process, created on first use (never at build time). */
export function getDb(): Db {
  db ??= createDb(getConfig().DATABASE_URL);
  return db;
}
