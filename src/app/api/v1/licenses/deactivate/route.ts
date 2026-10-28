import { handleApi, idempotent, readBody } from "@/server/http/api";
import { deactivate } from "@/server/licensing/activation";
import { getLicensingContext } from "@/server/licensing/context";
import { DeactivateBody, withLicenseLimits } from "@/server/licensing/http";

// FR-20: free this device's slot.
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleApi(req, async (api) => {
    const ctx = await getLicensingContext();
    const body = await readBody(req, DeactivateBody);
    return idempotent(ctx.db, api, "licenses.deactivate", body, () =>
      withLicenseLimits(ctx, api, body.key, async () => {
        await deactivate(ctx, { key: body.key, deviceIdHash: body.device_id_hash, requestId: api.requestId });
        return { status: 204, body: null };
      }),
    );
  });
}
