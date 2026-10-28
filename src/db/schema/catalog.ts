import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, versioned } from "./columns";
import { billingInterval, planTier } from "./enums";

export const products = pgTable("products", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ...versioned,
});

/**
 * No amounts here (PRD hard rule): `priceRefEnv` names the env var holding the
 * provider's price ID; display prices are read from the provider.
 */
export const plans = pgTable(
  "plans",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    key: text("key").notNull(),
    tier: planTier("tier").notNull(),
    interval: billingInterval("interval").notNull(),
    priceRefEnv: text("price_ref_env").notNull(),
    deviceLimit: integer("device_limit").notNull(),
    features: text("features").array().notNull().default(sql`'{}'::text[]`),
    active: boolean("active").notNull().default(true),
    ...versioned,
  },
  (t) => [unique("plans_product_key_uq").on(t.productId, t.key), check("plans_device_limit_ck", sql`${t.deviceLimit} > 0`)],
);
