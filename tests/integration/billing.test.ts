import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, licenses, plans, reconciliationRuns, subscriptions, subscriptionTransitions, users, webhookEvents } from "@/db/schema";
import { FakePaymentProvider, type FakeDelivery } from "@/server/billing/fake-provider";
import { isEntitled } from "@/server/billing/machine";
import { reconcileSubscriptions } from "@/server/billing/reconcile";
import { receiveWebhook, retryPendingWebhooks } from "@/server/billing/webhooks";
import { testDb, unique } from "./db";
import { makeCustomer } from "./fixtures";

const db = testDb();

function setup() {
  const provider = new FakePaymentProvider();
  const ctx = { db, provider, pepper: "test-pepper" };

  const deliver = async (deliveries: FakeDelivery[]) => {
    const results = [];
    for (const d of deliveries) results.push(await receiveWebhook(ctx, d.body, d.headers));
    return results;
  };
  const deliverAll = () => deliver(provider.takeDeliveries());

  const checkout = async (outcome: "paid" | "trial" | "pending" = "paid", opts: { email?: string; planKey?: string } = {}) => {
    const email = opts.email ?? `${unique("buyer")}@example.test`;
    const { sessionId } = await provider.createCheckout({
      planKey: opts.planKey ?? "pro_monthly",
      email,
      successUrl: "http://localhost/ok",
      cancelUrl: "http://localhost/cancel",
      idempotencyKey: unique("checkout"),
    });
    return { ref: provider.completeCheckout(sessionId, outcome), email };
  };

  const local = async (ref: string) => {
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, "fake"), eq(subscriptions.providerSubscriptionId, ref)));
    if (!sub) return undefined;
    const lics = await db.select().from(licenses).where(eq(licenses.subscriptionId, sub.id));
    const transitions = await db
      .select()
      .from(subscriptionTransitions)
      .where(eq(subscriptionTransitions.subscriptionId, sub.id))
      .orderBy(asc(subscriptionTransitions.seq));
    return { sub, licenses: lics, events: transitions.map((t) => t.event) };
  };

  return { provider, ctx, deliver, deliverAll, checkout, local };
}

describe("webhook pipeline", () => {
  it("turns a paid checkout into a customer, an active subscription and one keyless licence", async () => {
    const { checkout, deliverAll, local } = setup();
    const { ref, email } = await checkout("paid");
    const results = await deliverAll();
    expect(results.map((r) => r.outcome)).toEqual(["processed", "processed"]);

    const state = await local(ref);
    expect(state?.sub.state).toBe("active");
    expect(state?.events).toEqual(["checkout.completed_paid"]);
    expect(state?.licenses).toHaveLength(1);
    expect(state?.licenses[0]).toMatchObject({ kind: "subscription", status: "active", keyHash: null });

    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect(user?.role).toBe("customer");
    const [created] = await db.select().from(auditLog).where(and(eq(auditLog.action, "user.create"), eq(auditLog.entityId, user!.id)));
    expect(JSON.stringify(created!.changes)).not.toContain("example.test"); // PII hashed
  });

  it("ignores duplicate deliveries", async () => {
    const { checkout, deliver, provider, local } = setup();
    const { ref } = await checkout("paid");
    const deliveries = provider.takeDeliveries();
    await deliver(deliveries);
    const again = await deliver(deliveries);
    expect(again.map((r) => r.outcome)).toEqual(["duplicate", "duplicate"]);
    expect((await local(ref))?.events).toEqual(["checkout.completed_paid"]);
  });

  it("processes one event delivered five times in parallel exactly once", async () => {
    const { checkout, provider, ctx, local } = setup();
    const { ref } = await checkout("paid");
    const [first] = provider.takeDeliveries();
    const results = await Promise.all(Array.from({ length: 5 }, () => receiveWebhook(ctx, first!.body, first!.headers)));
    expect(results.filter((r) => r.outcome === "processed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(4);
    const state = await local(ref);
    expect(state?.licenses).toHaveLength(1);
    expect(state?.events).toEqual(["checkout.completed_paid"]);
  });

  it("creates one subscription when different events for it arrive at once", async () => {
    const { checkout, provider, ctx, local } = setup();
    const { ref } = await checkout("paid");
    const results = await Promise.all(provider.takeDeliveries().map((d) => receiveWebhook(ctx, d.body, d.headers)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const state = await local(ref);
    expect(state?.licenses).toHaveLength(1);
    expect(state?.events).toEqual(["checkout.completed_paid"]);
  });

  it("never moves state backwards when events arrive out of order", async () => {
    const { checkout, provider, deliver, local } = setup();
    const { ref } = await checkout("paid");
    provider.failPayment(ref);
    provider.succeedPayment(ref);
    provider.scheduleCancel(ref);
    const results = await deliver(provider.takeDeliveries().reverse());
    expect(results.every((r) => r.status === 200)).toBe(true);
    const state = await local(ref);
    expect(state?.sub.state).toBe("cancel_scheduled");
    // The first processed event already saw the latest snapshot; later (older) events change nothing.
    expect(state?.events).toEqual(["checkout.completed_paid", "cancel.scheduled"]);
  });

  it("follows the whole lifecycle with the right entitlement at each step", async () => {
    const { checkout, provider, deliverAll, local } = setup();
    const { ref } = await checkout("trial");
    const steps: [() => void, string, boolean][] = [
      [() => {}, "trialing", true],
      [() => provider.succeedPayment(ref), "active", true],
      [() => provider.failPayment(ref), "past_due", true],
      [() => provider.exhaustDunning(ref), "unpaid", false],
      [() => provider.succeedPayment(ref), "active", true],
      [() => provider.scheduleCancel(ref), "cancel_scheduled", true],
      [() => provider.resume(ref), "active", true],
      [() => provider.scheduleCancel(ref), "cancel_scheduled", true],
      [() => provider.endPeriod(ref), "ended", false],
    ];
    for (const [act, expected, entitled] of steps) {
      act();
      await deliverAll();
      const state = (await local(ref))!.sub.state;
      expect(state).toBe(expected);
      expect(isEntitled(state)).toBe(entitled);
    }
    expect((await local(ref))?.events).toEqual([
      "checkout.completed_trial",
      "payment.succeeded",
      "payment.failed",
      "dunning.exhausted",
      "payment.succeeded",
      "cancel.scheduled",
      "cancel.resumed",
      "cancel.scheduled",
      "period.ended",
    ]);
  });

  it("re-links the same licence when a customer resubscribes", async () => {
    const { checkout, provider, deliverAll, local } = setup();
    const { ref, email } = await checkout("paid");
    await deliverAll();
    const first = (await local(ref))!.licenses[0]!;
    provider.cancelNow(ref);
    await deliverAll();

    const second = await checkout("paid", { email });
    await deliverAll();
    const relinked = (await local(second.ref))!.licenses;
    expect(relinked).toHaveLength(1);
    expect(relinked[0]!.id).toBe(first.id);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "license.relink"), eq(auditLog.entityId, first.id)));
    expect(audit?.reason).toBe("customer resubscribed");
  });

  it("updates the plan on a monthly → annual switch without a state change", async () => {
    const { checkout, provider, deliverAll, local } = setup();
    const { ref } = await checkout("paid");
    await deliverAll();
    provider.changePlan(ref, "pro_annual");
    await deliverAll();
    const state = (await local(ref))!;
    const [plan] = await db.select().from(plans).where(eq(plans.id, state.sub.planId));
    expect(plan?.key).toBe("pro_annual");
    expect(state.events).toEqual(["checkout.completed_paid"]);
  });

  it("suspends the licence when a dispute opens", async () => {
    const { checkout, provider, deliverAll, local } = setup();
    const { ref } = await checkout("paid");
    await deliverAll();
    provider.openDispute(ref);
    expect((await deliverAll()).map((r) => r.outcome)).toEqual(["processed"]);
    expect((await local(ref))?.licenses[0]?.status).toBe("suspended");
  });

  it("rejects bad signatures without storing anything", async () => {
    const { checkout, provider, ctx } = setup();
    const { ref } = await checkout("paid");
    const [d] = provider.takeDeliveries();
    const tampered = d!.body.replace(ref, "sub_attacker");
    expect(await receiveWebhook(ctx, tampered, d!.headers)).toEqual({ status: 400, outcome: "invalid_signature" });
    expect(await receiveWebhook(ctx, d!.body, new Headers())).toEqual({ status: 400, outcome: "invalid_signature" });
    expect(await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, d!.eventId))).toHaveLength(0);
  });

  it("returns 500 on a provider outage, records the attempt, and the retry job finishes it", async () => {
    const { checkout, provider, ctx, local } = setup();
    const { ref } = await checkout("paid");
    const [d] = provider.takeDeliveries();
    provider.failNextFetches(1);
    expect(await receiveWebhook(ctx, d!.body, d!.headers)).toEqual({ status: 500, outcome: "failed" });

    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, d!.eventId));
    expect(row).toMatchObject({ attempts: 1, processedAt: null });
    expect(row?.lastError).toMatch(/simulated outage/);
    expect(await local(ref)).toBeUndefined();

    const retried = await retryPendingWebhooks(ctx, { now: new Date(Date.now() + 120_000) });
    expect(retried.results.find((r) => r.eventId === d!.eventId)?.outcome).toBe("processed");
    expect((await local(ref))?.sub.state).toBe("active");
  });

  it("rejects transitions that are not in the table and stops retrying them", async () => {
    const { checkout, provider, deliverAll, local } = setup();
    const { ref } = await checkout("paid");
    provider.cancelNow(ref);
    await deliverAll();
    provider.succeedPayment(ref); // a canceled subscription can't come back to life
    const [result] = await deliverAll();
    expect(result?.outcome).toBe("rejected");

    const state = (await local(ref))!;
    expect(state.sub.state).toBe("ended");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "subscription.transition_rejected"), eq(auditLog.entityId, state.sub.id)));
    expect(audit?.changes).toEqual({ state: { from: "ended", to: "active" } });
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, result!.eventId!));
    expect(row?.processedAt).not.toBeNull();
  });

  it("fails events for unknown plans so they can be retried after a catalog fix", async () => {
    const { checkout, deliverAll } = setup();
    await checkout("paid", { planKey: "no_such_plan" });
    const results = await deliverAll();
    expect(results.every((r) => r.outcome === "failed")).toBe(true);
  });
});

describe("billing reconciliation", () => {
  it("fixes drift from lost webhooks, reports local orphans and stores the run", async () => {
    const { checkout, provider, deliverAll, ctx, local } = setup();
    const { ref } = await checkout("paid");
    const synced = await checkout("paid");
    await deliverAll();
    provider.silently(() => provider.failPayment(ref)); // the webhook never arrives

    const customer = await makeCustomer(db);
    const [plan] = await db.select().from(plans).limit(1);
    const orphanRef = unique("sub_orphan");
    await db
      .insert(subscriptions)
      .values({ customerId: customer.id, planId: plan!.id, provider: "fake", providerSubscriptionId: orphanRef, state: "active" });

    const report = await reconcileSubscriptions(ctx);
    expect(report.checked).toBe(2);
    expect(report.inSync).toBe(1);
    expect(report.fixed).toEqual([{ ref, from: "active", to: "past_due", events: ["payment.failed"] }]);
    expect(report.orphansLocal).toContain(orphanRef);
    expect(report.orphansLocal).not.toContain(synced.ref);
    expect(report.errors).toEqual([]);

    expect((await local(ref))?.sub.state).toBe("past_due");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "subscription.transition"), eq(auditLog.actorId, "reconcile"), eq(auditLog.entityId, (await local(ref))!.sub.id)));
    expect(audit?.actorType).toBe("system");
    const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, report.runId));
    expect(run?.report).toMatchObject({ checked: 2, inSync: 1 });

    const again = await reconcileSubscriptions(ctx);
    expect(again.fixed).toEqual([]);
    expect(again.inSync).toBe(2);
  });
});
