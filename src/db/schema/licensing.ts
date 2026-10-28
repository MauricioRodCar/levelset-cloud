import { isNull, sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { customers } from "./accounts";
import { subscriptions } from "./billing";
import { products } from "./catalog";
import { id, tstz, versioned } from "./columns";
import { licenseKind, licenseStatus } from "./enums";

export const licenses = pgTable(
  "licenses",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    kind: licenseKind("kind").notNull(),
    /** Unique: webhook retries can never create a second licence for a subscription (FR-13). */
    subscriptionId: uuid("subscription_id")
      .unique()
      .references(() => subscriptions.id),
    /** HMAC of the key; the key itself is never stored (FR-16). */
    keyHash: text("key_hash").notNull().unique(),
    keyHint: text("key_hint").notNull(),
    status: licenseStatus("status").notNull().default("active"),
    expiresAt: tstz("expires_at"),
    deviceLimitOverride: integer("device_limit_override"),
    notes: text("notes"),
    ...versioned,
  },
  (t) => [
    index("licenses_customer_idx").on(t.customerId),
    check("licenses_tester_expiry_ck", sql`${t.kind} <> 'tester' or ${t.expiresAt} is not null`),
    check("licenses_device_limit_ck", sql`${t.deviceLimitOverride} is null or ${t.deviceLimitOverride} > 0`),
  ],
);

export const activations = pgTable(
  "activations",
  {
    id: id(),
    licenseId: uuid("license_id")
      .notNull()
      .references(() => licenses.id),
    /** Server-side HMAC of the client's device hash. */
    deviceHash: text("device_hash").notNull(),
    label: text("label").notNull(),
    os: text("os").notNull(),
    appVersion: text("app_version").notNull(),
    firstSeenAt: tstz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    deactivatedAt: tstz("deactivated_at"),
  },
  (t) => [
    // The same device never holds two active slots on one licence (FR-18).
    uniqueIndex("activations_active_device_uq").on(t.licenseId, t.deviceHash).where(isNull(t.deactivatedAt)),
    index("activations_license_idx").on(t.licenseId),
  ],
);
