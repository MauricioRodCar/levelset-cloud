import { pgEnum } from "drizzle-orm/pg-core";

export const planTier = pgEnum("plan_tier", ["pro"]);
export const billingInterval = pgEnum("billing_interval", ["month", "year"]);
export const userRole = pgEnum("user_role", ["customer", "support", "owner"]);
export const paymentProvider = pgEnum("payment_provider", ["stripe", "fake"]);

/** ARCHITECTURE §4.1. Entitled: trialing, active, cancel_scheduled, past_due. */
export const subscriptionState = pgEnum("subscription_state", [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "cancel_scheduled",
  "ended",
]);

export const licenseKind = pgEnum("license_kind", ["subscription", "tester", "manual"]);
/** Admin/dispute override only; entitlement is computed (ARCHITECTURE §4.2). */
export const licenseStatus = pgEnum("license_status", ["active", "suspended", "revoked"]);

/** Who freed a device slot. Support frees it immediately; the others wait out the transfer cooldown (FR-20). */
export const deactivationSource = pgEnum("deactivation_source", ["device", "customer", "support", "rotation"]);

export const idempotencyState = pgEnum("idempotency_state", ["in_progress", "done"]);
export const auditActorType = pgEnum("audit_actor_type", ["user", "system", "provider"]);

/** ARCHITECTURE §4.3. */
export const importState = pgEnum("import_state", [
  "uploaded",
  "validated",
  "needs_review",
  "ready",
  "committing",
  "committed",
  "failed",
  "canceled",
]);
export const importClassification = pgEnum("import_classification", [
  "new",
  "existing_customer",
  "duplicate_in_file",
  "conflict",
  "invalid",
]);
export const importGroupKind = pgEnum("import_group_kind", ["duplicate_in_file", "conflict"]);
export const importResolution = pgEnum("import_resolution", ["keep", "merge", "skip"]);
export const importOutcome = pgEnum("import_outcome", ["created", "updated", "skipped", "rejected"]);
