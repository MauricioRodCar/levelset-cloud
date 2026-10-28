import { and, eq, ne } from "drizzle-orm";
import { customers, licenses, plans, products, subscriptions, subscriptionTransitions, users } from "@/db/schema";
import { PRODUCT } from "@/server/catalog/seed";
import { type AuditActor, diffChanges, writeAudit } from "@/server/platform/audit";
import type { Db, Tx } from "@/server/platform/db";
import { AppError } from "@/server/platform/errors";
import { updateAudited } from "@/server/platform/versioned";
import { IllegalTransitionError, planTransitions, targetState, type Transition } from "./machine";
import type { PaymentProvider, SubscriptionSnapshot, SubscriptionState } from "./types";

/**
 * Brings one local subscription in line with the provider's snapshot, in the
 * caller's transaction. Shared by the webhook pipeline and reconciliation, so
 * both move state only through the transition table (ARCHITECTURE §6.1, §6.4).
 */

export type BillingContext = { db: Db; provider: PaymentProvider; pepper: string };
export type SyncCause = { actor: AuditActor; webhookEventId?: string | null };
export type SyncResult = {
  subscriptionId: string;
  licenseId: string;
  from: SubscriptionState | null;
  to: SubscriptionState;
  events: string[];
  changed: boolean;
  /** The snapshot was older than what we already stored; nothing was applied. */
  stale: boolean;
};

export class UnknownPlanError extends AppError {
  constructor(planKey: string) {
    super("unknown_plan", 422, `No plan '${planKey}' in the catalog (run the seed job)`);
  }
}

export class CustomerRefConflictError extends AppError {
  constructor() {
    super("customer_ref_conflict", 409, "This email is already linked to a different provider customer");
  }
}

export async function syncSubscription(
  tx: Tx,
  ctx: BillingContext,
  snapshot: SubscriptionSnapshot,
  cause: SyncCause,
): Promise<SyncResult> {
  const plan = await findPlan(tx, snapshot.planKey);
  const customer = await resolveCustomer(tx, ctx, snapshot, cause.actor);
  const target = targetState(snapshot);
  const byRef = and(eq(subscriptions.provider, ctx.provider.id), eq(subscriptions.providerSubscriptionId, snapshot.ref));

  let [local] = await tx.select().from(subscriptions).where(byRef).for("update");

  if (!local) {
    const path = planTransitions(null, target);
    const [created] = await tx
      .insert(subscriptions)
      .values({
        customerId: customer.id,
        planId: plan.id,
        provider: ctx.provider.id,
        providerSubscriptionId: snapshot.ref,
        state: target,
        currentPeriodEnd: snapshot.currentPeriodEnd,
        trialEnd: snapshot.trialEnd,
        providerUpdatedAt: snapshot.updatedAt,
      })
      .onConflictDoNothing()
      .returning();

    if (created) {
      await writeAudit(tx, {
        actor: cause.actor,
        action: "subscription.create",
        entityType: "subscriptions",
        entityId: created.id,
        changes: diffChanges({}, created),
        reason: path.map((t) => t.event).join(" + "),
      });
      await recordTransitions(tx, created.id, path, cause);
      const license = await ensureLicense(tx, { customerId: customer.id, productId: plan.productId, subscriptionId: created.id }, cause.actor);
      return { subscriptionId: created.id, licenseId: license.id, from: null, to: target, events: eventsOf(path), changed: true, stale: false };
    }
    // Another event for the same new subscription won the insert; continue as an update.
    [local] = await tx.select().from(subscriptions).where(byRef).for("update");
  }
  const current = local!;

  const base = { subscriptionId: current.id, from: current.state, to: current.state, events: [] as string[], changed: false };
  if (current.providerUpdatedAt && snapshot.updatedAt < current.providerUpdatedAt) {
    const license = await ensureLicense(tx, { customerId: current.customerId, productId: plan.productId, subscriptionId: current.id }, cause.actor);
    return { ...base, licenseId: license.id, stale: true };
  }

  let path: Transition[];
  try {
    path = planTransitions(current.state, target);
  } catch (e) {
    if (e instanceof IllegalTransitionError) throw new IllegalTransitionError(current.state, target, undefined, current.id);
    throw e;
  }

  const desired = {
    state: target,
    planId: plan.id,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    trialEnd: snapshot.trialEnd,
  };
  const material = diffChanges(
    { state: current.state, planId: current.planId, currentPeriodEnd: current.currentPeriodEnd, trialEnd: current.trialEnd },
    desired,
  );

  if (Object.keys(material).length > 0) {
    await updateAudited(tx, {
      table: subscriptions,
      pk: subscriptions.id,
      id: current.id,
      expectedVersion: current.version, // we hold the row lock, so this cannot conflict
      values: { ...desired, providerUpdatedAt: snapshot.updatedAt },
      actor: cause.actor,
      action: path.length ? "subscription.transition" : "subscription.update",
      reason: path.length ? eventsOf(path).join(" + ") : null,
    });
    await recordTransitions(tx, current.id, path, cause);
  }

  const license = await ensureLicense(tx, { customerId: current.customerId, productId: plan.productId, subscriptionId: current.id }, cause.actor);
  return {
    subscriptionId: current.id,
    licenseId: license.id,
    from: current.state,
    to: target,
    events: eventsOf(path),
    changed: Object.keys(material).length > 0,
    stale: false,
  };
}

const eventsOf = (path: Transition[]) => path.map((t) => t.event);

async function recordTransitions(tx: Tx, subscriptionId: string, path: Transition[], cause: SyncCause) {
  if (!path.length) return;
  await tx.insert(subscriptionTransitions).values(
    path.map((t) => ({
      subscriptionId,
      fromState: t.from,
      toState: t.to,
      event: t.event,
      webhookEventId: cause.webhookEventId ?? null,
    })),
  );
}

async function findPlan(tx: Tx, planKey: string) {
  const [row] = await tx
    .select({ plan: plans })
    .from(plans)
    .innerJoin(products, eq(plans.productId, products.id))
    .where(and(eq(products.slug, PRODUCT.slug), eq(plans.key, planKey)))
    .limit(1);
  if (!row) throw new UnknownPlanError(planKey);
  return row.plan;
}

/** Finds the customer by provider reference, else by email (linking or creating as needed). */
async function resolveCustomer(tx: Tx, ctx: BillingContext, snapshot: SubscriptionSnapshot, actor: AuditActor) {
  const byRef = and(eq(customers.provider, ctx.provider.id), eq(customers.providerCustomerId, snapshot.customerRef));
  const [linked] = await tx.select().from(customers).where(byRef).limit(1);
  if (linked) return linked;

  const email = snapshot.email.trim().toLowerCase();
  const [newUser] = await tx.insert(users).values({ email }).onConflictDoNothing().returning();
  if (newUser) {
    await writeAudit(tx, {
      actor,
      action: "user.create",
      entityType: "users",
      entityId: newUser.id,
      changes: diffChanges({}, newUser, { pii: ["email"], pepper: ctx.pepper }),
    });
  }
  const [user] = newUser ? [newUser] : await tx.select().from(users).where(eq(users.email, email)).limit(1);

  const [existing] = await tx.select().from(customers).where(eq(customers.userId, user!.id)).for("update");
  if (existing) {
    if (existing.provider === ctx.provider.id && existing.providerCustomerId === snapshot.customerRef) return existing;
    if (existing.provider !== null) throw new CustomerRefConflictError();
    return updateAudited(tx, {
      table: customers,
      pk: customers.id,
      id: existing.id,
      expectedVersion: existing.version,
      values: { provider: ctx.provider.id, providerCustomerId: snapshot.customerRef },
      actor,
      action: "customer.link_provider",
    });
  }

  const [created] = await tx
    .insert(customers)
    .values({ userId: user!.id, provider: ctx.provider.id, providerCustomerId: snapshot.customerRef })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    // Created concurrently by another event for the same customer.
    const [again] = await tx.select().from(customers).where(byRef).limit(1);
    if (!again) throw new CustomerRefConflictError();
    return again;
  }
  await writeAudit(tx, { actor, action: "customer.create", entityType: "customers", entityId: created.id, changes: diffChanges({}, created) });
  return created;
}

/**
 * One licence per subscription (unique constraint). A returning customer gets
 * their previous subscription licence re-linked, so the same key keeps working.
 * The key itself is generated on first reveal, so new licences have no key yet.
 */
async function ensureLicense(
  tx: Tx,
  ref: { customerId: string; productId: string; subscriptionId: string },
  actor: AuditActor,
) {
  const [existing] = await tx.select().from(licenses).where(eq(licenses.subscriptionId, ref.subscriptionId)).limit(1);
  if (existing) return existing;

  const previous = await tx
    .select({ license: licenses, subState: subscriptions.state })
    .from(licenses)
    .leftJoin(subscriptions, eq(licenses.subscriptionId, subscriptions.id))
    .where(
      and(
        eq(licenses.customerId, ref.customerId),
        eq(licenses.productId, ref.productId),
        eq(licenses.kind, "subscription"),
        ne(licenses.status, "revoked"),
      ),
    )
    .for("update", { of: licenses });
  const reusable = previous.find((p) => p.subState === null || p.subState === "ended");
  if (reusable) {
    return updateAudited(tx, {
      table: licenses,
      pk: licenses.id,
      id: reusable.license.id,
      expectedVersion: reusable.license.version,
      values: { subscriptionId: ref.subscriptionId },
      actor,
      action: "license.relink",
      reason: "customer resubscribed",
    });
  }

  const [created] = await tx
    .insert(licenses)
    .values({ customerId: ref.customerId, productId: ref.productId, kind: "subscription", subscriptionId: ref.subscriptionId })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const [again] = await tx.select().from(licenses).where(eq(licenses.subscriptionId, ref.subscriptionId)).limit(1);
    return again!;
  }
  await writeAudit(tx, { actor, action: "license.create", entityType: "licenses", entityId: created.id, changes: diffChanges({}, created) });
  return created;
}
