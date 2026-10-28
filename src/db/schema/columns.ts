import { integer, timestamp, uuid } from "drizzle-orm/pg-core";

export const id = () => uuid("id").primaryKey().defaultRandom();

export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** created_at / updated_at + optimistic-concurrency `version` (ARCHITECTURE §5). */
export const versioned = {
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
};
