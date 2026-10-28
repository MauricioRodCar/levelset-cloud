import Stripe from "stripe";
import { PLAN_DEFS } from "@/server/catalog/seed";
import type { Config } from "@/server/platform/config";
import { AppError } from "@/server/platform/errors";
import { WebhookSignatureError } from "./fake-provider";
import type {
  CheckoutInput,
  CheckoutStatus,
  DisplayPrice,
  NormalizedWebhook,
  PaymentProvider,
  SnapshotStatus,
  SubscriptionSnapshot,
} from "./types";

/**
 * Stripe adapter (PRD D3; test mode in v1, live keys refused by config unless
 * STRIPE_ALLOW_LIVE). Mapping code is exported as pure functions so it is
 * unit-tested against recorded payload shapes without network access.
 *
 * API version: the one pinned by the stripe SDK (2026-09-30). In this version a
 * subscription's period end lives on its items, and an invoice names its
 * subscription under `parent.subscription_details`.
 */

const SUBSCRIPTION_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
]);

/** Stripe's `paused` (trial ended without a payment method) has no Pro access: treated as unpaid. */
const STATUS: Record<string, SnapshotStatus> = {
  incomplete: "incomplete",
  incomplete_expired: "incomplete_expired",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  paused: "unpaid",
  canceled: "canceled",
};

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));
const date = (unix: number | null | undefined) => (unix ? new Date(unix * 1000) : null);

/** Plan key ↔ provider price ID, from config (PLAN_DEFS names the env var per plan). */
export function priceMap(config: Pick<Config, "STRIPE_PRICE_PRO_MONTHLY" | "STRIPE_PRICE_PRO_ANNUAL">) {
  const byPlan = new Map<string, string>();
  for (const def of PLAN_DEFS) {
    const priceId = config[def.priceRefEnv];
    if (priceId) byPlan.set(def.key, priceId);
  }
  const byPrice = new Map([...byPlan].map(([plan, price]) => [price, plan]));
  return { byPlan, byPrice };
}

export function toSnapshot(sub: Stripe.Subscription, planKeyForPrice: (priceId: string) => string, fetchedAt: Date): SubscriptionSnapshot {
  const item = sub.items.data[0];
  if (!item) throw new AppError("invalid_subscription", 422, `Stripe subscription ${sub.id} has no items`);
  const customer = typeof sub.customer === "string" ? null : sub.customer;
  const email = customer && !("deleted" in customer && customer.deleted) ? customer.email : null;
  if (!email) throw new AppError("invalid_subscription", 422, `Stripe subscription ${sub.id}: customer has no email`);
  const status = STATUS[sub.status];
  if (!status) throw new AppError("invalid_subscription", 422, `Stripe subscription ${sub.id}: unknown status ${sub.status}`);
  return {
    ref: sub.id,
    customerRef: idOf(sub.customer)!,
    email,
    planKey: planKeyForPrice(item.price.id),
    status,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    currentPeriodEnd: date(item.current_period_end),
    trialEnd: date(sub.trial_end),
    // Stripe has no "updated at"; every snapshot is fetched fresh, so fetch time orders them.
    updatedAt: fetchedAt,
  };
}

export function normalizeStripeEvent(payload: unknown): NormalizedWebhook {
  const event = payload as Stripe.Event;
  if (typeof event?.id !== "string" || typeof event.type !== "string") {
    throw new AppError("invalid_payload", 400, "Malformed Stripe event");
  }
  const object = event.data?.object as unknown as Record<string, unknown>;
  const base = { eventId: event.id, type: event.type };

  if (event.type === "charge.dispute.created") return { ...base, kind: "dispute", subscriptionRef: null };
  if (!SUBSCRIPTION_EVENTS.has(event.type)) return { ...base, kind: "ignored", subscriptionRef: null };

  let ref: string | null = null;
  if (event.type.startsWith("customer.subscription.")) ref = (object as unknown as Stripe.Subscription).id;
  else if (event.type === "checkout.session.completed") {
    const session = object as unknown as Stripe.Checkout.Session;
    ref = session.mode === "subscription" ? idOf(session.subscription) : null;
  } else {
    ref = idOf((object as unknown as Stripe.Invoice).parent?.subscription_details?.subscription);
  }
  return { ...base, kind: ref ? "subscription" : "ignored", subscriptionRef: ref };
}

export function checkoutParams(input: CheckoutInput, priceId: string): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    ...(input.customerRef ? { customer: input.customerRef } : { customer_email: input.email }),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: { plan_key: input.planKey },
    subscription_data: {
      metadata: { plan_key: input.planKey },
      ...(input.trialDays ? { trial_period_days: input.trialDays } : {}),
    },
    allow_promotion_codes: false,
  };
}

type StripeConfig = Pick<
  Config,
  "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "STRIPE_PRICE_PRO_MONTHLY" | "STRIPE_PRICE_PRO_ANNUAL"
>;

export class StripePaymentProvider implements PaymentProvider {
  readonly id = "stripe" as const;
  private readonly stripe: Stripe;
  private readonly prices: ReturnType<typeof priceMap>;
  private displayCache: { at: number; value: Record<string, DisplayPrice> } | null = null;

  constructor(
    private readonly config: StripeConfig,
    client?: Stripe,
  ) {
    if (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET) throw new AppError("misconfigured", 500, "Stripe keys missing");
    this.stripe =
      client ??
      new Stripe(config.STRIPE_SECRET_KEY, {
        maxNetworkRetries: 2,
        timeout: 10_000,
        appInfo: { name: "levelset-cloud", url: "https://github.com/MauricioRodCar/levelset-cloud" },
      });
    this.prices = priceMap(config);
  }

  async createCheckout(input: CheckoutInput) {
    const priceId = this.prices.byPlan.get(input.planKey);
    if (!priceId) throw new AppError("unknown_plan", 422, `No price configured for plan '${input.planKey}'`);
    const session = await this.stripe.checkout.sessions.create(checkoutParams(input, priceId), {
      idempotencyKey: `checkout:${input.idempotencyKey}`,
    });
    if (!session.url) throw new AppError("provider_error", 502, "Stripe returned no checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async createPortalSession(customerRef: string, returnUrl: string) {
    const session = await this.stripe.billingPortal.sessions.create({ customer: customerRef, return_url: returnUrl });
    return { url: session.url };
  }

  verifyWebhook(rawBody: string, headers: Headers): unknown {
    const signature = headers.get("stripe-signature");
    if (!signature) throw new WebhookSignatureError("missing header");
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signature, this.config.STRIPE_WEBHOOK_SECRET!);
    } catch {
      throw new WebhookSignatureError("mismatch or outside tolerance");
    }
  }

  normalizeEvent(payload: unknown): NormalizedWebhook {
    return normalizeStripeEvent(payload);
  }

  async fetchSubscription(ref: string): Promise<SubscriptionSnapshot> {
    const sub = await this.stripe.subscriptions.retrieve(ref, { expand: ["customer"] });
    return toSnapshot(sub, (p) => this.planKey(p), new Date());
  }

  async *listSubscriptions(): AsyncIterable<SubscriptionSnapshot> {
    for await (const sub of this.stripe.subscriptions.list({ status: "all", limit: 100, expand: ["data.customer"] })) {
      yield toSnapshot(sub, (p) => this.planKey(p), new Date());
    }
  }

  async cancelSubscription(ref: string, { atPeriodEnd }: { atPeriodEnd: boolean }) {
    if (atPeriodEnd) await this.stripe.subscriptions.update(ref, { cancel_at_period_end: true });
    else await this.stripe.subscriptions.cancel(ref);
  }

  /** Read from Stripe and cached for 10 minutes; amounts never live in this repo. */
  async getDisplayPrices(planKeys: readonly string[]) {
    if (!this.displayCache || Date.now() - this.displayCache.at > 600_000) {
      const value: Record<string, DisplayPrice> = {};
      for (const [plan, priceId] of this.prices.byPlan) {
        const price = await this.stripe.prices.retrieve(priceId);
        const interval = price.recurring?.interval;
        if (price.unit_amount !== null && (interval === "month" || interval === "year")) {
          value[plan] = { currency: price.currency, unitAmount: price.unit_amount, interval: interval as "month" | "year" };
        }
      }
      this.displayCache = { at: Date.now(), value };
    }
    return Object.fromEntries(planKeys.filter((k) => this.displayCache!.value[k]).map((k) => [k, this.displayCache!.value[k]!]));
  }

  async checkoutStatus(sessionId: string): Promise<CheckoutStatus> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    const status: CheckoutStatus["status"] =
      session.status === "complete" ? "complete" : session.status === "expired" ? "expired" : "open";
    return { status, subscriptionRef: idOf(session.subscription) };
  }

  async findCustomerRef(email: string): Promise<string | null> {
    const { data } = await this.stripe.customers.list({ email: email.trim().toLowerCase(), limit: 1 });
    return data[0]?.id ?? null;
  }

  /** Dispute → payment intent → invoice payment → invoice → subscription. */
  async resolveSubscriptionRef(payload: unknown): Promise<string | null> {
    const dispute = (payload as Stripe.Event).data?.object as unknown as Stripe.Dispute;
    const paymentIntent = idOf(dispute?.payment_intent);
    if (!paymentIntent) return null;
    const { data } = await this.stripe.invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: paymentIntent },
      limit: 1,
      expand: ["data.invoice"],
    });
    const invoice = data[0]?.invoice;
    if (!invoice || typeof invoice === "string" || "deleted" in invoice) return null;
    return idOf(invoice.parent?.subscription_details?.subscription);
  }

  private planKey(priceId: string): string {
    // Unknown prices surface as an unknown plan, so the event fails visibly instead of guessing.
    return this.prices.byPrice.get(priceId) ?? `unknown_price:${priceId}`;
  }
}
