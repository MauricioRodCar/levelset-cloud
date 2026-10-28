import { createHash, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { licenses, products } from "@/db/schema";
import type { LicensingContext } from "@/server/licensing/activation";
import { issueKey } from "@/server/licensing/keys";
import { unique } from "./db";
import { makeCustomer } from "./fixtures";

// The routes read config from process.env, so point it at the test database before loading them.
process.env.DATABASE_URL = inject("databaseUrl");

type Handler = (req: Request) => Promise<Response>;
let routes: { activate: Handler; refresh: Handler; deactivate: Handler; jwks: Handler };
let ctx: LicensingContext;

beforeAll(async () => {
  routes = {
    activate: (await import("@/app/api/v1/licenses/activate/route")).POST,
    refresh: (await import("@/app/api/v1/licenses/refresh/route")).POST,
    deactivate: (await import("@/app/api/v1/licenses/deactivate/route")).POST,
    jwks: (await import("@/app/.well-known/jwks.json/route")).GET,
  };
  ctx = await (await import("@/server/licensing/context")).getLicensingContext();
});

const ip = () => `203.0.113.${randomInt(1, 254)}-${unique("t")}`; // unique per test, so rate limits don't leak between tests
const idHash = () => createHash("sha256").update(unique("machine")).digest("hex");

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function testerKey() {
  const customer = await makeCustomer(ctx.db);
  const [product] = await ctx.db.select().from(products).where(eq(products.slug, "levelset"));
  const [license] = await ctx.db
    .insert(licenses)
    .values({ customerId: customer.id, productId: product!.id, kind: "tester", expiresAt: new Date(Date.now() + 7 * 86_400_000) })
    .returning();
  return (await issueKey(ctx.db, { licenseId: license!.id, expectedVersion: 1, actor: { type: "system", id: "test" }, pepper: ctx.pepper })).key;
}

const deviceBody = (id = idHash(), label = "Desk PC") => ({ id_hash: id, label, os: "Windows 11", app_version: "1.1.0" });

describe("POST /api/v1/licenses/activate", () => {
  it("returns a token in the documented shape", async () => {
    const res = await routes.activate(post("/api/v1/licenses/activate", { key: await testerKey(), device: deviceBody() }, { "x-forwarded-for": ip() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["expires_at", "features", "refresh_after", "tier", "token"]);
    expect(body.tier).toBe("tester");
  });

  it("replays the same response for a retried Idempotency-Key and rejects a reused one", async () => {
    const key = await testerKey();
    const headers = { "x-forwarded-for": ip(), "idempotency-key": unique("idem-key") };
    const body = { key, device: deviceBody() };
    const first = await routes.activate(post("/api/v1/licenses/activate", body, headers));
    const second = await routes.activate(post("/api/v1/licenses/activate", body, headers));
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect((await second.json()).token).toBe((await first.json()).token);

    const reused = await routes.activate(post("/api/v1/licenses/activate", { key, device: deviceBody() }, headers));
    expect(reused.status).toBe(422);
    expect((await reused.json()).code).toBe("idempotency_key_reused");
  });

  it("answers the device limit with a 409 problem listing the devices", async () => {
    const key = await testerKey();
    const from = ip();
    for (const label of ["PC 1", "PC 2"]) {
      await routes.activate(post("/api/v1/licenses/activate", { key, device: deviceBody(idHash(), label) }, { "x-forwarded-for": from }));
    }
    const res = await routes.activate(post("/api/v1/licenses/activate", { key, device: deviceBody() }, { "x-forwarded-for": from }));
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const problem = await res.json();
    expect(problem).toMatchObject({ code: "device_limit_reached", status: 409, device_limit: 2 });
    expect(problem.devices.map((d: { label: string }) => d.label)).toEqual(["PC 1", "PC 2"]);
  });

  it("rejects malformed bodies with field-level issues", async () => {
    const res = await routes.activate(post("/api/v1/licenses/activate", { key: "x", device: { id_hash: "nope" } }, { "x-forwarded-for": ip() }));
    expect(res.status).toBe(400);
    const problem = await res.json();
    expect(problem.code).toBe("validation_failed");
    expect(problem.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(["device.id_hash", "device.label"]));
    expect((await routes.activate(post("/api/v1/licenses/activate", "{not json", { "x-forwarded-for": ip() }))).status).toBe(400);
  });

  it("slows down key guessing: 10 invalid keys per IP per hour, then 429", async () => {
    const from = ip();
    const guess = () => routes.activate(post("/api/v1/licenses/activate", { key: "LSET-00000-00000-00000-00000", device: deviceBody() }, { "x-forwarded-for": from }));
    for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(404);
    const blocked = await guess();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another IP is unaffected.
    expect((await routes.activate(post("/api/v1/licenses/activate", { key: await testerKey(), device: deviceBody() }, { "x-forwarded-for": ip() }))).status).toBe(200);
  });
});

describe("refresh, deactivate and JWKS", () => {
  it("refreshes, then deactivates with 204, after which refresh fails", async () => {
    const key = await testerKey();
    const id = idHash();
    const from = { "x-forwarded-for": ip() };
    const { token } = await (await routes.activate(post("/api/v1/licenses/activate", { key, device: deviceBody(id) }, from))).json();

    const refreshed = await routes.refresh(post("/api/v1/licenses/refresh", { key, token }, from));
    expect(refreshed.status).toBe(200);

    const off = await routes.deactivate(post("/api/v1/licenses/deactivate", { key, device_id_hash: id }, from));
    expect(off.status).toBe(204);
    const after = await routes.refresh(post("/api/v1/licenses/refresh", { key, token }, from));
    expect(after.status).toBe(403);
    expect((await after.json()).code).toBe("device_deactivated");
  });

  it("publishes public keys only", async () => {
    const res = await routes.jwks(new Request("http://localhost/.well-known/jwks.json"));
    const { keys } = await res.json();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(keys.every((k: Record<string, unknown>) => !("d" in k))).toBe(true);
    expect(res.headers.get("cache-control")).toContain("max-age");
  });
});
