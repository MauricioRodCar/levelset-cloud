import { sql } from "drizzle-orm";
import { bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { users } from "./accounts";
import { tstz } from "./columns";
import { auditActorType, idempotencyState } from "./enums";

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: idempotencyState("state").notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    expiresAt: tstz("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] }), index("idempotency_keys_expires_idx").on(t.expiresAt)],
);

/**
 * Append-only: a trigger (migration 0001) rejects UPDATE, DELETE and TRUNCATE.
 * `changes` never holds raw PII; such fields are stored as keyed hashes.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: tstz("at").notNull().defaultNow(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    changes: jsonb("changes").notNull().default(sql`'{}'::jsonb`),
    reason: text("reason"),
    requestId: text("request_id"),
  },
  (t) => [index("audit_log_entity_idx").on(t.entityType, t.entityId, t.at), index("audit_log_at_idx").on(t.at)],
);

export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
});

/** Fixed-window counters; buckets contain hashed IPs/keys only. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    bucket: text("bucket").notNull(),
    windowStart: tstz("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] }), index("rate_limits_window_idx").on(t.windowStart)],
);
