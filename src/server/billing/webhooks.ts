import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { licenses, subscriptions, webhookEvents } from "@/db/schema";
import { type AuditActor, writeAudit } from "@/server/platform/audit";
import type { Tx } from "@/server/platform/db";
import { updateAudited } from "@/server/platform/versioned";
import { IllegalTransitionError } from "./machine";
import { type BillingContext, syncSubscription } from "./sync";

/**
 * Webhook pipeline (FR-11–13, ARCHITECTURE §6.1):
 *  1. verify the signature on the raw body           → 400 if bad, nothing stored
 *  2. store the event; (provider, event_id) is unique → a duplicate delivery is a no-op
 *  3. process in one transaction, holding a lock on the event row, from a fresh
 *     provider snapshot (so delivery order doesn't matter)
 *  4. on failure: roll back, count the attempt, return 500 so the provider retries;
 *     the retry job also picks it up
 */

export type WebhookOutcome = "processed" | "duplicate" | "ignored" | "rejected" | "invalid_signature" | "failed";
export type WebhookResult = { status: 200 | 400 | 500; outcome: WebhookOutcome; eventId?: string };

export async function receiveWebhook(ctx: BillingContext, rawBody: string, headers: Headers): Promise<WebhookResult> {
  let payload: unknown;
  try {
    payload = ctx.provider.verifyWebhook(rawBody, headers);
  } catch {
    return { status: 400, outcome: "invalid_signature" };
  }
  const event = ctx.provider.normalizeEvent(payload);

  const [stored] = await ctx.db
    .insert(webhookEvents)
    .values({ provider: ctx.provider.id, eventId: event.eventId, type: event.type, payload: payload as Record<string, unknown> })
    .onConflictDoNothing()
    .returning();
  const row =
    stored ??
    (
      await ctx.db
        .select()
        .from(webhookEvents)
        .where(and(eq(webhookEvents.provider, ctx.provider.id), eq(webhookEvents.eventId, event.eventId)))
        .limit(1)
    )[0]!;

  if (row.processedAt) return { status: 200, outcome: "duplicate", eventId: event.eventId };
  return processStoredEvent(ctx, row.id);
}

/** Processes a stored event at most once; safe to call concurrently and from the retry job. */
export async function processStoredEvent(ctx: BillingContext, webhookEventId: string): Promise<WebhookResult> {
  try {
    return await ctx.db.transaction(async (tx) => {
      const [row] = await tx.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId)).for("update");
      if (!row) throw new Error(`webhook event ${webhookEventId} not found`);
      if (row.processedAt) return { status: 200, outcome: "duplicate", eventId: row.eventId } as const;

      const event = ctx.provider.normalizeEvent(row.payload);
      const actor: AuditActor = { type: "provider", id: `${row.provider}:${row.eventId}` };
      let outcome: WebhookOutcome = "processed";
      let lastError: string | null = null;

      if (event.kind === "subscription" && event.subscriptionRef) {
        const snapshot = await ctx.provider.fetchSubscription(event.subscriptionRef);
        try {
          await syncSubscription(tx, ctx, snapshot, { actor, webhookEventId: row.id });
        } catch (e) {
          if (!(e instanceof IllegalTransitionError)) throw e;
          // Off the table: record it for the admin panel and stop retrying (FR-7).
          await writeAudit(tx, {
            actor,
            action: "subscription.transition_rejected",
            entityType: "subscriptions",
            entityId: e.subscriptionId ?? `${row.provider}:${event.subscriptionRef}`,
            changes: { state: { from: e.from, to: e.to } },
            reason: e.message,
          });
          outcome = "rejected";
          lastError = e.message;
        }
      } else if (event.kind === "dispute" && event.subscriptionRef) {
        outcome = (await suspendForDispute(tx, ctx, event.subscriptionRef, actor)) ? "processed" : "ignored";
      } else {
        outcome = "ignored";
      }

      await tx
        .update(webhookEvents)
        .set({ processedAt: new Date(), attempts: sql`${webhookEvents.attempts} + 1`, lastError })
        .where(eq(webhookEvents.id, row.id));
      return { status: 200, outcome, eventId: row.eventId } as const;
    });
  } catch (e) {
    await ctx.db
      .update(webhookEvents)
      .set({ attempts: sql`${webhookEvents.attempts} + 1`, lastError: errorText(e) })
      .where(eq(webhookEvents.id, webhookEventId));
    return { status: 500, outcome: "failed" };
  }
}

/** A dispute or chargeback suspends the licence until an admin resolves it (FR-10). */
async function suspendForDispute(tx: Tx, ctx: BillingContext, subscriptionRef: string, actor: AuditActor): Promise<boolean> {
  const [row] = await tx
    .select({ license: licenses })
    .from(licenses)
    .innerJoin(subscriptions, eq(licenses.subscriptionId, subscriptions.id))
    .where(and(eq(subscriptions.provider, ctx.provider.id), eq(subscriptions.providerSubscriptionId, subscriptionRef)))
    .for("update", { of: licenses });
  if (!row) return false;
  if (row.license.status !== "active") return true;
  await updateAudited(tx, {
    table: licenses,
    pk: licenses.id,
    id: row.license.id,
    expectedVersion: row.license.version,
    values: { status: "suspended" },
    actor,
    action: "license.suspend",
    reason: "payment dispute opened",
  });
  return true;
}

export type RetryOptions = { now?: Date; maxAttempts?: number; minAgeMs?: number; limit?: number };

/**
 * Retries stored events that failed (or were never processed). Skips very
 * recent ones so it doesn't race a delivery that is still in flight.
 */
export async function retryPendingWebhooks(ctx: BillingContext, opts: RetryOptions = {}) {
  const now = opts.now ?? new Date();
  const pending = await ctx.db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.provider, ctx.provider.id),
        isNull(webhookEvents.processedAt),
        lt(webhookEvents.attempts, opts.maxAttempts ?? 10),
        lt(webhookEvents.receivedAt, new Date(now.getTime() - (opts.minAgeMs ?? 60_000))),
      ),
    )
    .orderBy(asc(webhookEvents.receivedAt))
    .limit(opts.limit ?? 50);

  const results: WebhookResult[] = [];
  for (const { id } of pending) results.push(await processStoredEvent(ctx, id));
  return { attempted: results.length, succeeded: results.filter((r) => r.status === 200).length, results };
}

function errorText(e: unknown): string {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
  return message.slice(0, 500);
}
