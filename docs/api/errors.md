# Error codes

Every error is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem (`application/problem+json`) with a stable `code`. Clients branch on `code`, never on `title`. Each response also carries `request_id` (also in the `x-request-id` header) for support.

```json
{ "type": "…/errors.md#device_limit_reached", "title": "…", "status": 409, "code": "device_limit_reached", "request_id": "…" }
```

| Code | Status | Meaning | What the desktop app should do |
|---|---|---|---|
| `validation_failed` | 400 | Body or header is malformed; `issues[]` lists `path` + `message` | Bug in the client; log it |
| `invalid_key` | 404 | Key is malformed or unknown (deliberately the same answer for both) | Ask the user to check the key |
| `license_revoked` | 403 | The licence was revoked | Fall back to Free; show "contact support" |
| `license_not_entitled` | 403 | No Pro right now; `reason` is `suspended`, `expired`, `subscription_inactive` or `no_subscription` | Fall back to Free; link to "Manage licence" |
| `device_limit_reached` | 409 | All slots are taken; `devices[]` (label, OS, last seen), `device_limit`, and `retry_after` when a recently freed slot is cooling down | Offer to deactivate a device in the customer area, or wait until `retry_after` |
| `device_deactivated` | 403 | This device was signed out (deactivated, or the key was rotated) | Ask the user to activate again |
| `invalid_token` | 403 | Token signature, issuer, audience or licence doesn't match | Discard the token; activate again |
| `rate_limited` | 429 | Too many requests; `Retry-After` header and `retry_after_seconds` | Back off |
| `idempotency_in_progress` | 409 | Same `Idempotency-Key` is still being processed | Retry shortly with the same key |
| `idempotency_key_reused` | 422 | Same `Idempotency-Key` sent with a different body | Bug in the client: use a new key per action |
| `version_conflict` | 409 | Admin edit lost a race; `current` holds the latest row | Show the newer values and let the user retry |
| `already_subscribed` | 409 | Checkout refused: this email already has a live Pro subscription | Send the buyer to the customer area |
| `unknown_plan` | 404 | Checkout for a plan that doesn't exist or is inactive | — |
| `not_found` | 404 | Entity doesn't exist | — |
| `unknown_provider` | 404 | Webhook sent to a provider this deployment doesn't use | — |
| `internal_error` | 500 | Unexpected failure (details only in server logs, by `request_id`) | Retry with backoff; the offline grace period covers outages |
