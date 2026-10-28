import { checkoutState } from "@/server/billing/checkout";
import { getBillingContext } from "@/server/billing/context";
import { handleApi } from "@/server/http/api";
import { ValidationError } from "@/server/platform/errors";

// FR-4: the success page polls this until the webhook has created the licence.
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleApi(req, async () => {
    const sessionId = new URL(req.url).searchParams.get("session_id");
    if (!sessionId || sessionId.length > 255) throw new ValidationError([{ path: "session_id", message: "is required" }]);
    const state = await checkoutState(getBillingContext(), sessionId);
    return Response.json({ state }, { headers: { "cache-control": "no-store" } });
  });
}
