/**
 * Domain errors with a stable `code`, mapped to RFC 9457 problem responses at
 * the route boundary (ARCHITECTURE §7.1). Messages never contain secrets.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(entityType: string, id: string) {
    super("not_found", 404, `${entityType} ${id} not found`);
  }
}

/** Optimistic concurrency (FR-27): carries the current row so the UI can show what changed. */
export class VersionConflictError<T = unknown> extends AppError {
  constructor(
    entityType: string,
    id: string,
    readonly current: T,
  ) {
    super("version_conflict", 409, `${entityType} ${id} was changed by someone else`, { current });
  }
}

export class IdempotencyInProgressError extends AppError {
  constructor() {
    super("idempotency_in_progress", 409, "A request with this Idempotency-Key is still being processed; retry shortly");
  }
}

export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super("idempotency_key_reused", 422, "This Idempotency-Key was already used with a different request");
  }
}

export function problemBody(err: AppError, requestId?: string): Record<string, unknown> {
  return {
    type: `https://github.com/MauricioRodCar/levelset-cloud/blob/main/docs/api/errors.md#${err.code}`,
    title: err.message,
    status: err.status,
    code: err.code,
    ...err.extra,
    ...(requestId ? { request_id: requestId } : {}),
  };
}

export function problemResponse(err: AppError, requestId?: string, headers: HeadersInit = {}): Response {
  return Response.json(problemBody(err, requestId), {
    status: err.status,
    headers: { ...headers, "content-type": "application/problem+json" },
  });
}

export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super("rate_limited", 429, "Too many requests; try again later", { retry_after_seconds: retryAfterSeconds });
  }
}

export class ValidationError extends AppError {
  constructor(issues: { path: string; message: string }[]) {
    super("validation_failed", 400, "The request body is not valid", { issues });
  }
}
