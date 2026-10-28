import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { DbOrTx } from "@/server/platform/db";
import { AppError, problemBody, problemResponse, RateLimitedError, ValidationError } from "@/server/platform/errors";
import { keyedHash } from "@/server/platform/hashing";
import { requestHash, type StoredResponse, withIdempotency } from "@/server/platform/idempotency";
import { hitRateLimit, type RateLimitRule } from "@/server/platform/rate-limit";

/**
 * Thin helpers shared by API route handlers: request IDs, body validation,
 * RFC 9457 errors, rate limits and the Idempotency-Key header. Business logic
 * stays in src/server/*; routes only parse, call and map.
 */

export type ApiRequest = { req: Request; requestId: string };

export function requestIdOf(req: Request): string {
  const given = req.headers.get("x-request-id");
  return given && /^[\w-]{8,64}$/.test(given) ? given : randomUUID();
}

/** First hop of X-Forwarded-For (set by the Container Apps ingress), else "unknown". */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function readBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ValidationError([{ path: "(body)", message: "must be JSON" }]);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(body)", message: i.message })));
  }
  return parsed.data;
}

/** Runs a handler and turns errors into problem responses. Unknown errors are logged without details leaking out. */
export async function handleApi(req: Request, fn: (ctx: ApiRequest) => Promise<Response>): Promise<Response> {
  const requestId = requestIdOf(req);
  try {
    const res = await fn({ req, requestId });
    res.headers.set("x-request-id", requestId);
    return res;
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return problemResponse(e, requestId, { "retry-after": String(e.retryAfterSeconds), "x-request-id": requestId });
    }
    if (e instanceof AppError) return problemResponse(e, requestId, { "x-request-id": requestId });
    console.error(`[${requestId}] unhandled error:`, e instanceof Error ? `${e.name}: ${e.message}` : "unknown");
    return problemResponse(new AppError("internal_error", 500, "Something went wrong"), requestId, { "x-request-id": requestId });
  }
}

/** Counts a hit against each rule (buckets hold hashed identifiers only); throws 429 on the first one exceeded. */
export async function enforceRateLimits(
  db: DbOrTx,
  pepper: string,
  hits: { name: string; identifier: string; rule: RateLimitRule }[],
  now = new Date(),
): Promise<void> {
  for (const hit of hits) {
    const result = await hitRateLimit(db, `${hit.name}:${keyedHash(pepper, hit.identifier)}`, hit.rule, now);
    if (!result.allowed) {
      throw new RateLimitedError(Math.max(1, Math.ceil((result.resetAt.getTime() - now.getTime()) / 1000)));
    }
  }
}

/**
 * Applies the Idempotency-Key header when present (FR-14): the handler's
 * result, including domain errors (4xx), is stored and replayed for retries.
 */
export async function idempotent(
  db: DbOrTx,
  api: ApiRequest,
  scope: string,
  body: unknown,
  handler: () => Promise<StoredResponse>,
): Promise<Response> {
  const run = async (): Promise<StoredResponse> => {
    try {
      return await handler();
    } catch (e) {
      if (e instanceof AppError && !(e instanceof RateLimitedError)) return { status: e.status, body: problemBody(e) };
      throw e;
    }
  };

  const key = api.req.headers.get("idempotency-key");
  if (!key) return toResponse(await run(), false);
  if (key.length < 8 || key.length > 128) {
    throw new ValidationError([{ path: "Idempotency-Key", message: "must be 8–128 characters" }]);
  }
  const hash = requestHash({ method: api.req.method, path: new URL(api.req.url).pathname, body });
  const result = await withIdempotency(db, { scope, key, requestHash: hash }, run);
  return toResponse(result, result.replayed);
}

function toResponse({ status, body }: StoredResponse, replayed: boolean): Response {
  const headers: Record<string, string> = {};
  if (status >= 400) headers["content-type"] = "application/problem+json";
  if (replayed) headers["idempotent-replayed"] = "true";
  if (status === 204) return new Response(null, { status, headers });
  return Response.json(body, { status, headers });
}
