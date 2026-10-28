import { sql } from "drizzle-orm";
import { check, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, tstz, versioned } from "./columns";
import { paymentProvider, userRole } from "./enums";

/** Emails are stored lowercased (enforced), so a plain unique index is case-insensitive. */
export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull().unique(),
    role: userRole("role").notNull().default("customer"),
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabledAt: tstz("totp_enabled_at"),
    deletedAt: tstz("deleted_at"),
    ...versioned,
  },
  (t) => [check("users_email_lower_ck", sql`${t.email} = lower(${t.email})`)],
);

/** Billing identity. Provider columns are null for customers who never paid (e.g. imported testers). */
export const customers = pgTable(
  "customers",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id),
    provider: paymentProvider("provider"),
    providerCustomerId: text("provider_customer_id"),
    ...versioned,
  },
  (t) => [
    unique("customers_provider_ref_uq").on(t.provider, t.providerCustomerId),
    check("customers_provider_pair_ck", sql`(${t.provider} is null) = (${t.providerCustomerId} is null)`),
  ],
);

/** Only token hashes are stored. */
export const magicLinks = pgTable(
  "magic_links",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    usedAt: tstz("used_at"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [index("magic_links_email_idx").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    totpVerifiedAt: tstz("totp_verified_at"),
    expiresAt: tstz("expires_at").notNull(),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);
