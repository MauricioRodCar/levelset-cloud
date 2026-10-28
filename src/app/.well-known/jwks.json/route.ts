import { handleApi } from "@/server/http/api";
import { getLicensingContext } from "@/server/licensing/context";

// FR-21: public keys for verifying licence tokens offline. The desktop app embeds a copy at build time.
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleApi(req, async () => {
    const { keys } = await getLicensingContext();
    return Response.json({ keys: keys.publicJwks }, { headers: { "cache-control": "public, max-age=3600" } });
  });
}
