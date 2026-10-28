import { describe, expect, it } from "vitest";
import { FAKE_SIGNATURE_HEADER, FakePaymentProvider, WebhookSignatureError } from "@/server/billing/fake-provider";

const checkoutInput = (idempotencyKey: string) => ({
  planKey: "pro_monthly",
  email: "Buyer@Example.test",
  successUrl: "http://localhost/ok",
  cancelUrl: "http://localhost/cancel",
  idempotencyKey,
});

describe("FakePaymentProvider", () => {
  it("returns the same checkout session for a retried idempotency key", async () => {
    const p = new FakePaymentProvider();
    const a = await p.createCheckout(checkoutInput("k1"));
    expect(await p.createCheckout(checkoutInput("k1"))).toEqual(a);
    expect((await p.createCheckout(checkoutInput("k2"))).sessionId).not.toBe(a.sessionId);
  });

  it("emits signed webhooks that verify, and rejects tampering, staleness and missing headers", async () => {
    let now = new Date("2026-10-28T12:00:00Z");
    const p = new FakePaymentProvider({ now: () => now });
    const { sessionId } = await p.createCheckout(checkoutInput("k"));
    const ref = p.completeCheckout(sessionId, "paid");
    const [delivery] = p.takeDeliveries();

    const payload = p.verifyWebhook(delivery!.body, delivery!.headers);
    expect(p.normalizeEvent(payload)).toEqual({
      eventId: delivery!.eventId,
      type: "checkout.session.completed",
      kind: "subscription",
      subscriptionRef: ref,
    });

    expect(() => p.verifyWebhook(delivery!.body.replace(ref, "sub_other"), delivery!.headers)).toThrow(WebhookSignatureError);
    expect(() => p.verifyWebhook(delivery!.body, new Headers())).toThrow(WebhookSignatureError);
    expect(() => new FakePaymentProvider({ secret: "other" }).verifyWebhook(delivery!.body, delivery!.headers)).toThrow(
      WebhookSignatureError,
    );
    now = new Date(now.getTime() + 301_000);
    expect(() => p.verifyWebhook(delivery!.body, delivery!.headers)).toThrow(/tolerance/);
    expect(delivery!.headers.get(FAKE_SIGNATURE_HEADER)).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("classifies events and normalises the customer email", async () => {
    const p = new FakePaymentProvider();
    const { sessionId } = await p.createCheckout(checkoutInput("k"));
    const ref = p.completeCheckout(sessionId, "trial");
    p.openDispute(ref);
    const kinds = p.takeDeliveries().map((d) => p.normalizeEvent(JSON.parse(d.body)).kind);
    expect(kinds).toEqual(["subscription", "subscription", "dispute"]);
    expect(p.normalizeEvent({ id: "evt", type: "customer.updated", data: { subscription: null } }).kind).toBe("ignored");
    expect((await p.fetchSubscription(ref)).email).toBe("buyer@example.test");
  });

  it("drops webhooks for silent changes but keeps the state", async () => {
    const p = new FakePaymentProvider();
    const { sessionId } = await p.createCheckout(checkoutInput("k"));
    const ref = p.completeCheckout(sessionId);
    p.takeDeliveries();
    p.silently(() => p.failPayment(ref));
    expect(p.takeDeliveries()).toEqual([]);
    expect((await p.fetchSubscription(ref)).status).toBe("past_due");
  });

  it("never invents prices", async () => {
    expect(await new FakePaymentProvider().getDisplayPrices(["pro_monthly"])).toEqual({});
  });
});
