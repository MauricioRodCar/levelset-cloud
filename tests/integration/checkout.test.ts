import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { featureFlags } from "@/db/schema";
import { AlreadySubscribedError, checkoutState, listOffers, startCheckout } from "@/server/billing/checkout";
import { FakePaymentProvider } from "@/server/billing/fake-provider";
import { receiveWebhook } from "@/server/billing/webhooks";
import { testDb, unique } from "./db";

const db = testDb();

function setup(config: { FLAG_TRIALS?: boolean; TRIAL_DAYS?: number } = {}) {
  const provider = new FakePaymentProvider();
  const ctx = {
    db,
    provider,
    pepper: "test-pepper",
    config: { APP_URL: "http://localhost:3000", TRIAL_DAYS: config.TRIAL_DAYS ?? 0, FLAG_TRIALS: config.FLAG_TRIALS ?? false, FLAG_SELF_SERVE_TRANSFER: true },
  };
  const deliverAll = async () => {
    for (const d of provider.takeDeliveries()) await receiveWebhook(ctx, d.body, d.headers);
  };
  return { provider, ctx, deliverAll };
}

const email = () => `${unique("buyer")}@example.test`;

describe("checkout", () => {
  it("lists the seeded plans without inventing prices", async () => {
    const offers = await listOffers(setup().ctx);
    expect(offers.map((o) => o.key).sort()).toEqual(["pro_annual", "pro_monthly"]);
    expect(offers.every((o) => o.price === null)).toBe(true);
  });

  it("returns the same session for a retried idempotency key", async () => {
    const { ctx } = setup();
    const input = { planKey: "pro_monthly", email: email(), idempotencyKey: unique("k") };
    const a = await startCheckout(ctx, input);
    expect(await startCheckout(ctx, input)).toEqual(a);
    expect(a.url).toMatch(/\/fake-checkout\//);
  });

  it("goes pending → ready only after the webhook created the licence", async () => {
    const { ctx, provider, deliverAll } = setup();
    const { sessionId } = await startCheckout(ctx, { planKey: "pro_monthly", email: email(), idempotencyKey: unique("k") });
    expect(await checkoutState(ctx, sessionId)).toBe("pending");
    provider.completeCheckout(sessionId, "paid");
    expect(await checkoutState(ctx, sessionId)).toBe("processing");
    await deliverAll();
    expect(await checkoutState(ctx, sessionId)).toBe("ready");
  });

  it("refuses a second live subscription for the same email, but allows a returning buyer", async () => {
    const { ctx, provider, deliverAll } = setup();
    const buyer = email();
    const first = await startCheckout(ctx, { planKey: "pro_monthly", email: buyer, idempotencyKey: unique("k") });
    const ref = provider.completeCheckout(first.sessionId, "paid");
    await deliverAll();
    await expect(startCheckout(ctx, { planKey: "pro_annual", email: buyer.toUpperCase(), idempotencyKey: unique("k") })).rejects.toBeInstanceOf(
      AlreadySubscribedError,
    );
    provider.cancelNow(ref);
    await deliverAll();
    await expect(startCheckout(ctx, { planKey: "pro_annual", email: buyer, idempotencyKey: unique("k") })).resolves.toHaveProperty("url");
  });

  it("offers a trial only to first-time buyers while the flag is on", async () => {
    await db.delete(featureFlags).where(eq(featureFlags.key, "trials"));
    const { ctx, provider, deliverAll } = setup({ FLAG_TRIALS: true, TRIAL_DAYS: 7 });
    const buyer = email();
    const first = await startCheckout(ctx, { planKey: "pro_monthly", email: buyer, idempotencyKey: unique("k") });
    expect(provider.getSession(first.sessionId)?.trialDays).toBe(7);

    const ref = provider.completeCheckout(first.sessionId, "trial");
    await deliverAll();
    provider.cancelNow(ref);
    await deliverAll();
    const again = await startCheckout(ctx, { planKey: "pro_monthly", email: buyer, idempotencyKey: unique("k") });
    expect(provider.getSession(again.sessionId)?.trialDays).toBe(0);

    const off = setup({ FLAG_TRIALS: false, TRIAL_DAYS: 7 });
    const s = await startCheckout(off.ctx, { planKey: "pro_monthly", email: email(), idempotencyKey: unique("k") });
    expect(off.provider.getSession(s.sessionId)?.trialDays).toBe(0);
  });

  it("rejects unknown plans", async () => {
    await expect(startCheckout(setup().ctx, { planKey: "enterprise", email: email(), idempotencyKey: unique("k") })).rejects.toMatchObject({
      code: "unknown_plan",
    });
  });
});
