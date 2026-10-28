import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { WebhookSignatureError } from "@/server/billing/fake-provider";
import { checkoutParams, normalizeStripeEvent, priceMap, StripePaymentProvider, toSnapshot } from "@/server/billing/stripe-provider";

const config = {
  STRIPE_SECRET_KEY: "sk_test_unit",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_test_secret",
  STRIPE_PRICE_PRO_MONTHLY: "price_month",
  STRIPE_PRICE_PRO_ANNUAL: "price_year",
};

// Trimmed to the fields the adapter reads, in the shape of API version 2026-09-30.
function subscription(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sub_123",
    object: "subscription",
    status: "active",
    cancel_at_period_end: false,
    trial_end: null,
    customer: { id: "cus_123", object: "customer", email: "buyer@example.test" },
    items: { object: "list", data: [{ id: "si_1", price: { id: "price_month" }, current_period_end: 1_793_000_000 }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

const event = (type: string, object: Record<string, unknown>) => ({ id: "evt_1", object: "event", type, data: { object } });

describe("toSnapshot", () => {
  const { byPrice } = priceMap(config);
  const planKey = (p: string) => byPrice.get(p) ?? `unknown_price:${p}`;
  const fetchedAt = new Date("2026-10-28T12:00:00Z");

  it("maps a Stripe subscription to a provider-neutral snapshot", () => {
    expect(toSnapshot(subscription(), planKey, fetchedAt)).toEqual({
      ref: "sub_123",
      customerRef: "cus_123",
      email: "buyer@example.test",
      planKey: "pro_monthly",
      status: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(1_793_000_000 * 1000),
      trialEnd: null,
      updatedAt: fetchedAt,
    });
  });

  it("maps statuses; paused counts as unpaid; unknown prices stay visible", () => {
    expect(toSnapshot(subscription({ status: "paused" }), planKey, fetchedAt).status).toBe("unpaid");
    expect(toSnapshot(subscription({ status: "incomplete_expired" }), planKey, fetchedAt).status).toBe("incomplete_expired");
    const other = subscription({ items: { data: [{ price: { id: "price_other" }, current_period_end: 1 }] } });
    expect(toSnapshot(other, planKey, fetchedAt).planKey).toBe("unknown_price:price_other");
  });

  it("refuses subscriptions it can't attribute", () => {
    expect(() => toSnapshot(subscription({ customer: "cus_123" }), planKey, fetchedAt)).toThrow(/no email/);
    expect(() => toSnapshot(subscription({ status: "weird" }), planKey, fetchedAt)).toThrow(/unknown status/);
    expect(() => toSnapshot(subscription({ items: { data: [] } }), planKey, fetchedAt)).toThrow(/no items/);
  });
});

describe("normalizeStripeEvent", () => {
  it("finds the subscription in each event family", () => {
    expect(normalizeStripeEvent(event("customer.subscription.updated", { id: "sub_1" }))).toMatchObject({ kind: "subscription", subscriptionRef: "sub_1" });
    expect(normalizeStripeEvent(event("checkout.session.completed", { mode: "subscription", subscription: "sub_2" }))).toMatchObject({
      kind: "subscription",
      subscriptionRef: "sub_2",
    });
    expect(
      normalizeStripeEvent(event("invoice.payment_failed", { parent: { subscription_details: { subscription: "sub_3" } } })),
    ).toMatchObject({ kind: "subscription", subscriptionRef: "sub_3" });
    expect(normalizeStripeEvent(event("charge.dispute.created", { payment_intent: "pi_1" }))).toMatchObject({ kind: "dispute", subscriptionRef: null });
  });

  it("ignores events that don't concern a subscription", () => {
    expect(normalizeStripeEvent(event("checkout.session.completed", { mode: "payment", subscription: null })).kind).toBe("ignored");
    expect(normalizeStripeEvent(event("invoice.paid", { parent: null })).kind).toBe("ignored");
    expect(normalizeStripeEvent(event("customer.created", { id: "cus_1" })).kind).toBe("ignored");
    expect(() => normalizeStripeEvent({})).toThrow(/Malformed/);
  });
});

describe("checkoutParams", () => {
  const input = { planKey: "pro_annual", email: "a@example.test", successUrl: "https://s", cancelUrl: "https://c", idempotencyKey: "k" };

  it("builds a subscription checkout for the plan's price", () => {
    expect(checkoutParams(input, "price_year")).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_year", quantity: 1 }],
      customer_email: "a@example.test",
      metadata: { plan_key: "pro_annual" },
    });
  });

  it("reuses an existing customer and adds a trial only when asked", () => {
    const p = checkoutParams({ ...input, customerRef: "cus_9", trialDays: 7 }, "price_year");
    expect(p).toMatchObject({ customer: "cus_9", subscription_data: { trial_period_days: 7 } });
    expect(p).not.toHaveProperty("customer_email");
    expect(checkoutParams(input, "price_year").subscription_data).not.toHaveProperty("trial_period_days");
  });
});

describe("StripePaymentProvider", () => {
  it("verifies webhook signatures with the configured secret", async () => {
    const provider = new StripePaymentProvider(config);
    const body = JSON.stringify(event("customer.subscription.updated", { id: "sub_1" }));
    const header = await new Stripe("sk_test_x").webhooks.generateTestHeaderStringAsync({ payload: body, secret: config.STRIPE_WEBHOOK_SECRET });
    expect(provider.verifyWebhook(body, new Headers({ "stripe-signature": header }))).toMatchObject({ id: "evt_1" });
    expect(() => provider.verifyWebhook(body.replace("sub_1", "sub_2"), new Headers({ "stripe-signature": header }))).toThrow(WebhookSignatureError);
    expect(() => provider.verifyWebhook(body, new Headers())).toThrow(WebhookSignatureError);
  });

  it("passes our idempotency key to Stripe and resolves the plan's price", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
    const client = { checkout: { sessions: { create } } } as unknown as Stripe;
    const provider = new StripePaymentProvider(config, client);
    const result = await provider.createCheckout({ planKey: "pro_monthly", email: "a@example.test", successUrl: "s", cancelUrl: "c", idempotencyKey: "abc" });
    expect(result).toEqual({ sessionId: "cs_1", url: "https://checkout.stripe.test/cs_1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ line_items: [{ price: "price_month", quantity: 1 }] }), { idempotencyKey: "checkout:abc" });
    await expect(provider.createCheckout({ planKey: "nope", email: "a@example.test", successUrl: "s", cancelUrl: "c", idempotencyKey: "x" })).rejects.toThrow(/No price/);
  });

  it("maps a dispute to its subscription through the invoice payment", async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ invoice: { id: "in_1", parent: { subscription_details: { subscription: "sub_7" } } } }] });
    const provider = new StripePaymentProvider(config, { invoicePayments: { list } } as unknown as Stripe);
    expect(await provider.resolveSubscriptionRef(event("charge.dispute.created", { payment_intent: "pi_1" }))).toBe("sub_7");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ payment: { type: "payment_intent", payment_intent: "pi_1" } }));
    expect(await provider.resolveSubscriptionRef(event("charge.dispute.created", { payment_intent: null }))).toBeNull();
  });

  it("caches display prices read from Stripe", async () => {
    const ARBITRARY = 12345; // a fixture value, not a real price
    const retrieve = vi.fn(async (id: string) => ({ id, currency: "usd", unit_amount: ARBITRARY, recurring: { interval: id === "price_year" ? "year" : "month" } }));
    const provider = new StripePaymentProvider(config, { prices: { retrieve } } as unknown as Stripe);
    const first = await provider.getDisplayPrices(["pro_monthly", "pro_annual"]);
    expect(first.pro_annual).toEqual({ currency: "usd", unitAmount: ARBITRARY, interval: "year" });
    await provider.getDisplayPrices(["pro_monthly"]);
    expect(retrieve).toHaveBeenCalledTimes(2); // one per price, then cached
  });
});
