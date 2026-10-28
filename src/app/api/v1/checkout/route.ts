import { randomUUID } from "node:crypto";
import { z } from "zod";
import { startCheckout } from "@/server/billing/checkout";
import { getBillingContext } from "@/server/billing/context";
import { clientIp, enforceRateLimits, handleApi, idempotent, readBody } from "@/server/http/api";

// FR-3: start a provider checkout. Retries with the same Idempotency-Key return the same session.
export const dynamic = "force-dynamic";

const Body = z.object({
  plan_key: z.string().min(1).max(64),
  email: z.email().max(254),
});

export function POST(req: Request) {
  return handleApi(req, async (api) => {
    const ctx = getBillingContext();
    const body = await readBody(req, Body);
    await enforceRateLimits(ctx.db, ctx.pepper, [
      { name: "checkout-ip", identifier: clientIp(req), rule: { limit: 20, windowSeconds: 600 } },
    ]);
    const providerKey = req.headers.get("idempotency-key") ?? randomUUID();
    return idempotent(ctx.db, api, "checkout", body, async () => {
      const session = await startCheckout(ctx, { planKey: body.plan_key, email: body.email, idempotencyKey: providerKey });
      return { status: 200, body: { url: session.url } };
    });
  });
}
