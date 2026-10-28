import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AppError } from "@/server/platform/errors";
import type {
  CheckoutInput,
  DisplayPrice,
  NormalizedWebhook,
  PaymentProvider,
  SnapshotStatus,
  SubscriptionSnapshot,
} from "./types";

/**
 * In-memory payment provider (PRD D3). It proves the PaymentProvider
 * abstraction and drives fast tests and local development. Simulation methods
 * change state the way a real provider would and queue signed webhooks;
 * tests take them with `takeDeliveries()` and can deliver them in any order,
 * twice, or not at all. Refused in production by config validation.
 */

/** Not a secret: the fake provider only runs outside production. */
export const FAKE_WEBHOOK_SECRET = "fake_whsec_local_only";
export const FAKE_SIGNATURE_HEADER = "fake-signature";
const TOLERANCE_SECONDS = 300;
const DAY_MS = 86_400_000;

export class WebhookSignatureError extends AppError {
  constructor(reason: string) {
    super("invalid_signature", 400, `Webhook signature check failed: ${reason}`);
  }
}

type FakeSubscription = Omit<SubscriptionSnapshot, "updatedAt"> & { updatedAt: Date };
type FakeSession = { id: string; planKey: string; email: string; trialDays: number };
export type FakeDelivery = { eventId: string; type: string; body: string; headers: Headers };
type FakeEventPayload = { id: string; type: string; created: number; data: { subscription: string | null } };

const SUBSCRIPTION_EVENTS = new Set([
  "checkout.session.completed",
  "subscription.created",
  "subscription.updated",
  "subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export class FakePaymentProvider implements PaymentProvider {
  readonly id = "fake" as const;
  private readonly ns = randomUUID().slice(0, 8);
  private seq = 0;
  private lastUpdate = 0;
  private readonly subs = new Map<string, FakeSubscription>();
  private readonly customerRefs = new Map<string, string>();
  private readonly sessions = new Map<string, FakeSession>();
  private readonly sessionsByIdempotencyKey = new Map<string, string>();
  private outbox: FakeDelivery[] = [];
  private failFetches = 0;

  constructor(
    private readonly opts: {
      secret?: string;
      baseUrl?: string;
      prices?: Record<string, DisplayPrice>;
      now?: () => Date;
    } = {},
  ) {}

  // ── PaymentProvider ──────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput) {
    const existing = this.sessionsByIdempotencyKey.get(input.idempotencyKey);
    const id = existing ?? this.nextId("cs");
    if (!existing) {
      this.sessions.set(id, { id, planKey: input.planKey, email: input.email.trim().toLowerCase(), trialDays: input.trialDays ?? 0 });
      this.sessionsByIdempotencyKey.set(input.idempotencyKey, id);
    }
    return { sessionId: id, url: `${this.baseUrl}/fake-checkout/${id}` };
  }

  async createPortalSession(customerRef: string, returnUrl: string) {
    return { url: `${this.baseUrl}/fake-portal/${customerRef}?return=${encodeURIComponent(returnUrl)}` };
  }

  verifyWebhook(rawBody: string, headers: Headers): unknown {
    const header = headers.get(FAKE_SIGNATURE_HEADER);
    if (!header) throw new WebhookSignatureError("missing header");
    const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || !parts.v1) throw new WebhookSignatureError("malformed header");
    if (Math.abs(this.now().getTime() / 1000 - t) > TOLERANCE_SECONDS) throw new WebhookSignatureError("timestamp outside tolerance");
    const expected = Buffer.from(this.signature(rawBody, t), "hex");
    const given = Buffer.from(parts.v1, "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new WebhookSignatureError("mismatch");
    return JSON.parse(rawBody) as unknown;
  }

  normalizeEvent(payload: unknown): NormalizedWebhook {
    const p = payload as Partial<FakeEventPayload>;
    if (typeof p?.id !== "string" || typeof p.type !== "string") throw new AppError("invalid_payload", 400, "Malformed fake event");
    const subscriptionRef = p.data?.subscription ?? null;
    const kind = p.type === "dispute.created" ? "dispute" : SUBSCRIPTION_EVENTS.has(p.type) ? "subscription" : "ignored";
    return { eventId: p.id, type: p.type, kind, subscriptionRef };
  }

  async fetchSubscription(ref: string): Promise<SubscriptionSnapshot> {
    if (this.failFetches > 0) {
      this.failFetches--;
      throw new AppError("provider_unavailable", 503, "Fake provider: simulated outage");
    }
    const sub = this.subs.get(ref);
    if (!sub) throw new AppError("not_found", 404, `Fake provider: no subscription ${ref}`);
    return { ...sub };
  }

  async *listSubscriptions(): AsyncIterable<SubscriptionSnapshot> {
    for (const sub of this.subs.values()) yield { ...sub };
  }

  async cancelSubscription(ref: string, { atPeriodEnd }: { atPeriodEnd: boolean }) {
    if (atPeriodEnd) this.scheduleCancel(ref);
    else this.cancelNow(ref);
  }

  async getDisplayPrices(planKeys: readonly string[]) {
    const prices = this.opts.prices ?? {};
    return Object.fromEntries(planKeys.filter((k) => prices[k]).map((k) => [k, prices[k]!]));
  }

  // ── Simulation (tests and local development) ─────────────────────────────

  /** The customer finished checkout: `paid` → active, `trial` → trialing, `pending` → incomplete. */
  completeCheckout(sessionId: string, outcome: "paid" | "trial" | "pending" = "paid"): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Fake provider: unknown checkout session ${sessionId}`);
    const now = this.tick();
    const customerRef = this.customerRefs.get(session.email) ?? this.nextId("cus");
    this.customerRefs.set(session.email, customerRef);
    const status: SnapshotStatus = outcome === "paid" ? "active" : outcome === "trial" ? "trialing" : "incomplete";
    const ref = this.nextId("sub");
    this.subs.set(ref, {
      ref,
      customerRef,
      email: session.email,
      planKey: session.planKey,
      status,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(now.getTime() + this.periodMs(session.planKey)),
      trialEnd: outcome === "trial" ? new Date(now.getTime() + Math.max(session.trialDays, 1) * DAY_MS) : null,
      updatedAt: now,
    });
    this.emit("checkout.session.completed", ref);
    this.emit("subscription.created", ref);
    return ref;
  }

  succeedPayment(ref: string) {
    this.update(ref, "invoice.paid", (s) => {
      s.status = "active";
      s.trialEnd = null;
      s.currentPeriodEnd = new Date(this.now().getTime() + this.periodMs(s.planKey));
    });
  }

  failPayment(ref: string) {
    this.update(ref, "invoice.payment_failed", (s) => {
      s.status = "past_due";
    });
  }

  exhaustDunning(ref: string) {
    this.update(ref, "subscription.updated", (s) => {
      s.status = "unpaid";
    });
  }

  scheduleCancel(ref: string) {
    this.update(ref, "subscription.updated", (s) => {
      s.cancelAtPeriodEnd = true;
    });
  }

  resume(ref: string) {
    this.update(ref, "subscription.updated", (s) => {
      s.cancelAtPeriodEnd = false;
    });
  }

  /** The billing period ends: a scheduled cancellation takes effect. */
  endPeriod(ref: string) {
    this.update(ref, "subscription.deleted", (s) => {
      if (s.cancelAtPeriodEnd) s.status = "canceled";
    });
  }

  cancelNow(ref: string) {
    this.update(ref, "subscription.deleted", (s) => {
      s.status = "canceled";
    });
  }

  expireCheckout(ref: string) {
    this.update(ref, "subscription.updated", (s) => {
      s.status = "incomplete_expired";
    });
  }

  changePlan(ref: string, planKey: string) {
    this.update(ref, "subscription.updated", (s) => {
      s.planKey = planKey;
    });
  }

  /** Changes state without sending a webhook (a lost delivery), for reconciliation tests. */
  silently(fn: () => void) {
    const before = this.outbox.length;
    fn();
    this.outbox = this.outbox.slice(0, before);
  }

  openDispute(ref: string) {
    this.emit("dispute.created", ref);
  }

  /** The next `count` fetches fail, simulating a provider outage. */
  failNextFetches(count = 1) {
    this.failFetches = count;
  }

  /** Returns and clears the queued webhooks, oldest first. */
  takeDeliveries(): FakeDelivery[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /** Signs an arbitrary body, e.g. to test tampering. */
  sign(body: string, at = this.now()): Headers {
    const t = Math.floor(at.getTime() / 1000);
    return new Headers({ [FAKE_SIGNATURE_HEADER]: `t=${t},v1=${this.signature(body, t)}` });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private get baseUrl() {
    return this.opts.baseUrl ?? "http://localhost:3000";
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Strictly increasing timestamps, so every change is newer than the last. */
  private tick(): Date {
    this.lastUpdate = Math.max(this.now().getTime(), this.lastUpdate + 1);
    return new Date(this.lastUpdate);
  }

  private nextId(prefix: string) {
    return `${prefix}_${this.ns}_${++this.seq}`;
  }

  private periodMs(planKey: string) {
    return (planKey.endsWith("annual") ? 365 : 30) * DAY_MS;
  }

  private signature(body: string, t: number) {
    return createHmac("sha256", this.opts.secret ?? FAKE_WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  }

  private update(ref: string, eventType: string, mutate: (s: FakeSubscription) => void) {
    const sub = this.subs.get(ref);
    if (!sub) throw new Error(`Fake provider: no subscription ${ref}`);
    mutate(sub);
    sub.updatedAt = this.tick();
    this.emit(eventType, ref);
  }

  private emit(type: string, subscriptionRef: string) {
    const payload: FakeEventPayload = {
      id: this.nextId("evt"),
      type,
      created: Math.floor(this.now().getTime() / 1000),
      data: { subscription: subscriptionRef },
    };
    const body = JSON.stringify(payload);
    this.outbox.push({ eventId: payload.id, type, body, headers: this.sign(body) });
  }
}
