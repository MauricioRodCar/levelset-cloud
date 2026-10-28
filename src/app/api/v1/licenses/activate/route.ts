import { handleApi, idempotent, readBody } from "@/server/http/api";
import { activate } from "@/server/licensing/activation";
import { getLicensingContext } from "@/server/licensing/context";
import { ActivateBody, grantBody, withLicenseLimits } from "@/server/licensing/http";

// FR-18: activate a licence key on this device and get a signed token.
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleApi(req, async (api) => {
    const ctx = await getLicensingContext();
    const body = await readBody(req, ActivateBody);
    // Limits run inside the idempotent handler so domain errors (e.g. invalid key) still count.
    return idempotent(ctx.db, api, "licenses.activate", body, () =>
      withLicenseLimits(ctx, api, body.key, async () => {
        const grant = await activate(ctx, {
          key: body.key,
          device: {
            idHash: body.device.id_hash,
            label: body.device.label,
            os: body.device.os,
            appVersion: body.device.app_version,
          },
          requestId: api.requestId,
        });
        return { status: 200, body: grantBody(grant) };
      }),
    );
  });
}
