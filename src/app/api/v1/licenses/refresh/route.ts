import { handleApi, readBody } from "@/server/http/api";
import { refresh } from "@/server/licensing/activation";
import { getLicensingContext } from "@/server/licensing/context";
import { grantBody, RefreshBody, withLicenseLimits } from "@/server/licensing/http";

// FR-19: exchange the current token for a fresh one with the current tier and features.
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleApi(req, async (api) => {
    const ctx = await getLicensingContext();
    const body = await readBody(req, RefreshBody);
    const grant = await withLicenseLimits(ctx, api, body.key, () => refresh(ctx, { key: body.key, token: body.token }));
    return Response.json(grantBody(grant));
  });
}
