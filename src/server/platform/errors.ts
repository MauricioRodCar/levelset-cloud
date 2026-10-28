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

export function problemResponse(err: AppError, requestId?: string): Response {
  return Response.json(
    {
      type: `https://github.com/MauricioRodCar/levelset-cloud/blob/main/docs/errors.md#${err.code}`,
      title: err.message,
      status: err.status,
      code: err.code,
      ...err.extra,
      ...(requestId ? { request_id: requestId } : {}),
    },
    { status: err.status, headers: { "content-type": "application/problem+json" } },
  );
}
