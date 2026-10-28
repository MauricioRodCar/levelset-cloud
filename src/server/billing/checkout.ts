import { and, eq, inArray } from "drizzle-orm";
import { customers, licenses, plans, products, subscriptions, users } from "@/db/schema";
import { PRODUCT } from "@/server/catalog/seed";
import type { Config } from "@/server/platform/config";
import { AppError } from "@/server/platform/errors";
import { isFlagEnabled } from "@/server/platform/flags";
import { ENTITLED_STATES } from "./machine";
import type { BillingContext } from "./sync";
import type { DisplayPrice } from "./types";

/**
 * Checkout (FR-2–4). The licence is created only by the webhook, never by the
 * redirect back from the provider; the success page just polls `checkoutState`.
 */

export class AlreadySubscribedError extends AppError {
  constructor() {
    super("already_subscribed", 409, "This email already has an active Pro subscription; manage it from your account");
  }
}

export type CheckoutContext = BillingContext & { config: Pick<Config, "APP_URL" | "TRIAL_DAYS" | "FLAG_TRIALS" | "FLAG_SELF_SERVE_TRANSFER"> };

export type PlanOffer = { key: string; interval: "month" | "year"; price: DisplayPrice | null };

/** Active plans with their display price from the provider (null when it has none, e.g. the fake). */
export async function listOffers(ctx: BillingContext): Promise<PlanOffer[]> {
  const rows = await ctx.db
    .select({ key: plans.key, interval: plans.interval })
    .from(plans)
    .innerJoin(products, eq(plans.productId, products.id))
    .where(and(eq(products.slug, PRODUCT.slug), eq(plans.active, true)))
    .orderBy(plans.interval);
  const prices = await ctx.provider.getDisplayPrices(rows.map((r) => r.key)).catch(() => ({}) as Record<string, DisplayPrice>);
  return rows.map((r) => ({ ...r, price: prices[r.key] ?? null }));
}

export async function startCheckout(
  ctx: CheckoutContext,
  input: { planKey: string; email: string; idempotencyKey: string },
): Promise<{ url: string; sessionId: string }> {
  const email = input.email.trim().toLowerCase();
  const [plan] = await ctx.db
    .select({ id: plans.id })
    .from(plans)
    .innerJoin(products, eq(plans.productId, products.id))
    .where(and(eq(products.slug, PRODUCT.slug), eq(plans.key, input.planKey), eq(plans.active, true)));
  if (!plan) throw new AppError("unknown_plan", 404, `No active plan '${input.planKey}'`);

  // A known buyer: reuse their provider customer, refuse a second live subscription.
  const known = await ctx.db
    .select({ customerId: customers.id, provider: customers.provider, providerCustomerId: customers.providerCustomerId })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(users.email, email))
    .limit(1);
  const customer = known[0];
  let hadSubscription = false;
  if (customer) {
    const subs = await ctx.db
      .select({ state: subscriptions.state })
      .from(subscriptions)
      .where(eq(subscriptions.customerId, customer.customerId));
    if (subs.some((s) => ENTITLED_STATES.has(s.state))) throw new AlreadySubscribedError();
    hadSubscription = subs.length > 0;
  }
  const customerRef =
    (customer?.provider === ctx.provider.id ? customer.providerCustomerId : null) ??
    (await ctx.provider.findCustomerRef?.(email)) ??
    undefined;

  // Trials only for first-time buyers, and only while the flag is on (FR-6).
  const trial = !hadSubscription && (await isFlagEnabled(ctx.db, ctx.config as Config, "trials")) ? ctx.config.TRIAL_DAYS : 0;

  return ctx.provider.createCheckout({
    planKey: input.planKey,
    email,
    customerRef,
    trialDays: trial || undefined,
    idempotencyKey: input.idempotencyKey,
    successUrl: `${ctx.config.APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${ctx.config.APP_URL}/pricing?canceled=1`,
  });
}

export type CheckoutState = "pending" | "processing" | "ready" | "expired";

/**
 * pending: not paid yet · processing: paid, webhook not processed yet ·
 * ready: subscription and licence exist · expired: abandoned. No personal data.
 */
export async function checkoutState(ctx: BillingContext, sessionId: string): Promise<CheckoutState> {
  const status = await ctx.provider.checkoutStatus(sessionId);
  if (status.status === "expired") return "expired";
  if (!status.subscriptionRef) return "pending";
  const [row] = await ctx.db
    .select({ licenseId: licenses.id })
    .from(subscriptions)
    .innerJoin(licenses, eq(licenses.subscriptionId, subscriptions.id))
    .where(
      and(
        eq(subscriptions.provider, ctx.provider.id),
        inArray(subscriptions.providerSubscriptionId, [status.subscriptionRef]),
      ),
    )
    .limit(1);
  return row ? "ready" : "processing";
}
