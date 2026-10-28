import { bigserial, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { customers } from "./accounts";
import { plans } from "./catalog";
import { id, tstz, versioned } from "./columns";
import { paymentProvider, subscriptionState } from "./enums";

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    provider: paymentProvider("provider").notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    state: subscriptionState("state").notNull(),
    currentPeriodEnd: tstz("current_period_end"),
    trialEnd: tstz("trial_end"),
    /** Snapshots older than this are ignored, so out-of-order events never move state backwards. */
    providerUpdatedAt: tstz("provider_updated_at"),
    ...versioned,
  },
  (t) => [
    unique("subscriptions_provider_ref_uq").on(t.provider, t.providerSubscriptionId),
    index("subscriptions_customer_idx").on(t.customerId),
  ],
);

/** Stored before processing; (provider, event_id) unique = delivery dedupe (FR-11). */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: paymentProvider("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: tstz("received_at").notNull().defaultNow(),
    processedAt: tstz("processed_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [unique("webhook_events_provider_event_uq").on(t.provider, t.eventId)],
);

export const subscriptionTransitions = pgTable(
  "subscription_transitions",
  {
    id: id(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    fromState: subscriptionState("from_state"),
    toState: subscriptionState("to_state").notNull(),
    event: text("event").notNull(),
    webhookEventId: uuid("webhook_event_id").references(() => webhookEvents.id),
    at: tstz("at").notNull().defaultNow(),
    /** Insertion order: several transitions from one event share the same `at`. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (t) => [
    index("subscription_transitions_sub_idx").on(t.subscriptionId, t.at),
    index("subscription_transitions_sub_seq_idx").on(t.subscriptionId, t.seq),
  ],
);

/** One row per billing reconciliation run (FR-15); the report is shown in the admin panel. */
export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: id(),
    provider: paymentProvider("provider").notNull(),
    startedAt: tstz("started_at").notNull(),
    finishedAt: tstz("finished_at").notNull(),
    report: jsonb("report").notNull(),
  },
  (t) => [index("reconciliation_runs_started_idx").on(t.startedAt)],
);
