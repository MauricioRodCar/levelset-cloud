import type { paymentProvider, subscriptionState } from "@/db/schema";

export type SubscriptionState = (typeof subscriptionState.enumValues)[number];
export type ProviderId = (typeof paymentProvider.enumValues)[number];

/** Provider-neutral subscription status; each adapter maps its own statuses onto these. */
export type SnapshotStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "canceled";

/** The provider's current view of a subscription, fetched fresh for every event (ARCHITECTURE §4.1). */
export type SubscriptionSnapshot = {
  ref: string;
  customerRef: string;
  email: string;
  /** Resolved by the adapter (e.g. Stripe price ID → plan key via config). */
  planKey: string;
  status: SnapshotStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  /** Older snapshots than the stored one are ignored. */
  updatedAt: Date;
};

export type NormalizedWebhook = {
  eventId: string;
  type: string;
  kind: "subscription" | "dispute" | "ignored";
  subscriptionRef: string | null;
};

export type CheckoutInput = {
  planKey: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
  /** Passed to the provider, so a retried request returns the same session (FR-3). */
  idempotencyKey: string;
  trialDays?: number;
  customerRef?: string;
};

export type DisplayPrice = { currency: string; unitAmount: number; interval: "month" | "year" };

export interface PaymentProvider {
  readonly id: ProviderId;
  createCheckout(input: CheckoutInput): Promise<{ sessionId: string; url: string }>;
  createPortalSession(customerRef: string, returnUrl: string): Promise<{ url: string }>;
  /** Verifies the signature over the raw body; throws WebhookSignatureError. Returns the parsed payload. */
  verifyWebhook(rawBody: string, headers: Headers): unknown;
  /** Pure: reads a stored payload (also used when retrying without the original request). */
  normalizeEvent(payload: unknown): NormalizedWebhook;
  fetchSubscription(ref: string): Promise<SubscriptionSnapshot>;
  listSubscriptions(): AsyncIterable<SubscriptionSnapshot>;
  cancelSubscription(ref: string, opts: { atPeriodEnd: boolean }): Promise<void>;
  /** Prices live in the provider, never in this repo. */
  getDisplayPrices(planKeys: readonly string[]): Promise<Record<string, DisplayPrice>>;
}
