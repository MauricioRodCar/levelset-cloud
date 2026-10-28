import { getBillingContext } from "@/server/billing/context";
import { receiveWebhook } from "@/server/billing/webhooks";
import { AppError, problemResponse } from "@/server/platform/errors";

// Payment provider webhooks (FR-11). The raw body is read as text: signatures cover the exact bytes.
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const ctx = getBillingContext();
  if (provider !== ctx.provider.id) {
    return problemResponse(new AppError("unknown_provider", 404, "No webhook endpoint for this provider"));
  }
  const result = await receiveWebhook(ctx, await req.text(), req.headers);
  return Response.json({ outcome: result.outcome }, { status: result.status });
}
