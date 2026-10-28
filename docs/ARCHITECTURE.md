# levelset-cloud — Architecture (v0.1, approved 2026-10-28)

Companion to [PRD.md](PRD.md). FR-n refers to PRD requirements.

## 1. Overview

```
 Levelset.exe (desktop)                         Browser (customer / admin)
 Rust shell: license module                     Next.js pages (en/es)
   │  HTTPS: activate / refresh / deactivate        │
   ▼                                                ▼
┌──────────────────────── levelset-cloud (Docker, Next.js 16, Node 22) ─────────────────┐
│ Route handlers  /api/v1/licenses/*  /api/v1/checkout  /api/webhooks/[provider]       │
│                 /api/v1/account/*   /api/v1/admin/*   /.well-known/jwks.json         │
│ Pages           /pricing  /account/*  /admin/*  (server components + server actions) │
│ ───────────────────────────── src/server (framework-free TS) ──────────────────────── │
│  billing/      PaymentProvider adapter (stripe | fake), subscription state machine,  │
│                webhook processor, billing reconciliation                             │
│  licensing/    keys, Ed25519 tokens, activation, entitlements                        │
│  admin/        RBAC permissions, audit log, optimistic concurrency                   │
│  imports/      CSV staging, classification, review, commit, reconciliation report   │
│  auth/         magic links, sessions, TOTP                                           │
│  platform/     db, idempotency keys, rate limits, feature flags, email, config       │
└──────────────┬───────────────────────────────────────────────────┬────────────────────┘
               │ Drizzle (pg)                                      │ HTTPS
               ▼                                                   ▼
        Neon Postgres 16                                 Stripe (test mode) / fake
               ▲
   Container Apps Jobs (cron): migrate · reconcile billing · retry webhooks · purge
```

Domain logic lives in `src/server/` with no Next.js imports, so it can be unit-tested directly and reused by jobs and the future AI/relay services. Route handlers stay thin: parse, authenticate, call a service, map errors.

## 2. Tech choices

| Concern | Choice | Why |
|---|---|---|
| Framework | **Next.js 16 (App Router) + TypeScript (strict)**, `output: "standalone"` | One deployable for API, customer area and admin; standalone build → small Docker image |
| DB | **PostgreSQL 16 on Neon** (free tier) | Serverless Postgres, branch DBs for previews; plain Postgres → portable |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | SQL-first, committed `.sql` migrations, light runtime (cold starts), easy `FOR UPDATE` / version checks |
| Validation | Zod | Shared request schemas → OpenAPI (`zod-openapi`) |
| Tokens | `jose`, **EdDSA (Ed25519) JWS** | Small, fast, offline-verifiable; Rust side verifies with `ed25519-dalek` / `jsonwebtoken` |
| Payments | `stripe` SDK behind `PaymentProvider`; in-memory `fake` | D3 |
| Auth | In-house magic link + DB sessions + TOTP (`otpauth`) | Small surface, full control; shows the mechanics (no black box) |
| UI | Tailwind + shadcn/ui, `next-intl` (en, es) | Matches Levelset's look and i18n rules |
| Email | `EmailSender` adapter: console (dev), Resend or Azure Communication Services (prod) | PRD O1 |
| Logs | pino JSON with request ID | Container Apps log stream / Log Analytics |
| Tests | Vitest, Playwright, Postgres service in CI | PRD §6 |
| Hosting | **Azure Container Apps** (app + Jobs) + Neon | D4; image also runs on any Docker host |

## 3. Repository layout

```
levelset-cloud/
├─ src/
│  ├─ app/                    Next.js routes
│  │  ├─ (public)/pricing, checkout/success, signin
│  │  ├─ account/             licence, devices, subscription, privacy (ARCO)
│  │  ├─ admin/               customers, licences, imports, audit, flags, users
│  │  ├─ api/v1/              licenses/*, checkout, account/*, admin/*
│  │  ├─ api/webhooks/[provider]/route.ts
│  │  └─ .well-known/jwks.json/route.ts
│  ├─ server/                 billing/ licensing/ admin/ imports/ auth/ platform/
│  ├─ db/schema/*.ts          Drizzle schema (one file per aggregate)
│  └─ jobs/                   migrate.ts reconcile.ts retry-webhooks.ts purge.ts
├─ drizzle/                   NNNN_*.sql + meta/_journal.json (committed, never edited after merge)
├─ tests/                     unit/ integration/ e2e/ fixtures/ (synthetic CSVs only)
├─ docs/                      PRD.md ARCHITECTURE.md api/openapi.yaml adr/
├─ Dockerfile  docker-compose.yml (postgres, app, mailpit, stripe-cli profile)
├─ .env.example               names only, placeholder values
└─ .github/workflows/ci.yml
```

## 4. State machines

Implemented as **pure transition tables** (`(state, event) → state | reject`) with exhaustive table-driven tests. The DB stores the state as a Postgres enum, and every applied transition writes a `subscription_transitions` row and an audit entry in the same transaction.

### 4.1 Subscription

| From | Event (normalized) | To |
|---|---|---|
| — | `checkout.completed` (trial) | `trialing` |
| — | `checkout.completed` (paid) | `active` |
| — | `checkout.completed` (payment pending) | `incomplete` |
| `incomplete` | `payment.succeeded` | `active` |
| `incomplete` | `checkout.expired` | `ended` |
| `trialing` | `payment.succeeded` | `active` |
| `trialing` | `trial.ended_unpaid` | `past_due` |
| `active` | `payment.failed` | `past_due` |
| `past_due` | `payment.succeeded` | `active` |
| `past_due` | `dunning.exhausted` | `unpaid` |
| `unpaid` | `payment.succeeded` | `active` |
| `active`, `trialing` | `cancel.scheduled` | `cancel_scheduled` |
| `cancel_scheduled` | `cancel.resumed` | `active` |
| `cancel_scheduled` | `period.ended` | `ended` |
| any except `ended` | `subscription.canceled` (immediate, refund, unpaid end) | `ended` |
| `ended` | anything | reject (a resubscription is a **new** subscription) |

Plan changes (monthly ↔ annual) update `plan_id` without changing state. Entitled states: `trialing`, `active`, `cancel_scheduled`, `past_due` (FR-9).

**Normalisation:** each adapter maps provider events to the normalized events above. The Stripe adapter does this by re-fetching the subscription and comparing its `status`, `cancel_at_period_end` and `trial_end` to the local row, rather than trusting the event type alone. That makes ordering irrelevant (FR-12). Snapshots older than `provider_updated_at` are ignored.

### 4.2 Licence

`status ∈ {active, suspended, revoked}` holds only the admin/dispute override; `revoked` is terminal.
**Effective entitlement** (computed, never stored):

```
entitled = status == active
       and ( kind == tester  → now < expires_at
           | kind == manual  → expires_at is null or now < expires_at
           | kind == subscription → subscription.state ∈ ENTITLED )
tier     = kind == tester ? "tester" : "pro"     (no entitlement → "free")
```

Resubscribing re-links the customer's existing subscription licence to the new subscription (same key, `licenses.subscription_id` stays unique).

### 4.3 Import batch

`uploaded → validated → needs_review → ready → committing → committed`; `failed` and `canceled` are reachable from any non-terminal state. `needs_review → ready` only when all duplicate/conflict groups are resolved. `committing → committed` only if the report balances (FR-33).

## 5. Data model (Postgres)

Every mutable table has `id uuid`, `created_at`, `updated_at` and **`version int not null default 1`** (FR-27).

| Table | Key columns / constraints |
|---|---|
| `products` | `slug` unique (`levelset`) |
| `plans` | `product_id`, `key` unique per product, `tier`, `interval`, `price_ref_env` (name of the env var holding the provider price ID), `device_limit`, `features text[]`, `active` |
| `users` | `email citext` unique, `role enum(customer, support, owner)`, `totp_secret_enc`, `deleted_at` |
| `customers` | `user_id` unique, `provider`, `provider_customer_id` unique per provider |
| `subscriptions` | `customer_id`, `plan_id`, `provider_subscription_id` unique per provider, `state enum`, `current_period_end`, `trial_end`, `provider_updated_at` |
| `subscription_transitions` | `subscription_id`, `from_state`, `to_state`, `webhook_event_id`, `at` |
| `licenses` | `customer_id`, `product_id`, `kind enum`, `subscription_id` **unique nullable**, `key_hash` unique, `key_hint` (last 4), `status enum`, `expires_at`, `device_limit_override` |
| `activations` | `license_id`, `device_hash`, `label`, `os`, `app_version`, `first_seen_at`, `last_seen_at`, `deactivated_at`; **partial unique** `(license_id, device_hash) where deactivated_at is null` |
| `webhook_events` | `provider`, `event_id` (**unique pair**), `type`, `payload jsonb`, `received_at`, `processed_at`, `attempts`, `last_error` |
| `idempotency_keys` | PK `(scope, key)`, `request_hash`, `state enum(in_progress, done)`, `response_status`, `response_body jsonb`, `expires_at` |
| `audit_log` | `bigserial id`, `at`, `actor_type enum(user, system, provider)`, `actor_id`, `action`, `entity_type`, `entity_id`, `changes jsonb` (field → {from,to}, PII hashed), `reason`, `request_id`. **Append-only** |
| `magic_links`, `sessions` | token **hashes** only, `expires_at`, `used_at` |
| `import_batches`, `import_rows`, `import_groups` | batch `file_hash` unique, `state enum`; row `row_hash`, `classification`, `resolution`, `outcome` |
| `feature_flags` | `key` PK, `enabled`, `updated_by` (+ version) |
| `rate_limits` | `(bucket, window_start)` PK, `count`; buckets use hashed IP / key |

**Append-only audit:** the app's DB role is granted only `INSERT, SELECT` on `audit_log`, and a `BEFORE UPDATE OR DELETE` trigger raises an exception, a second layer in case of a misconfigured role. Audit rows never contain raw emails or keys (hashed or field-name only), so an ARCO deletion doesn't need to touch them.

**Optimistic concurrency:** `UPDATE … SET …, version = version + 1 WHERE id = $1 AND version = $2 RETURNING *`. Zero rows → `409 version_conflict` with the current row. Admin forms carry the version in a hidden field.

**Migrations:** `drizzle-kit generate` writes `drizzle/NNNN_*.sql`. They are forward-only and never edited after merge; breaking changes use expand → backfill → contract over two releases. CI checks that `generate` produces no diff and applies every migration to an empty DB. `jobs/migrate.ts` runs as a Container Apps Job **before** a new revision gets traffic. `/api/ready` returns 503 if the DB journal is behind the journal bundled in the image (migration reconciliation).

## 6. Idempotency and webhooks

### 6.1 Webhook pipeline (FR-11–13)

```
POST /api/webhooks/stripe
 1. raw body + signature → adapter.verifyWebhook()        (400 on bad signature)
 2. INSERT webhook_events … ON CONFLICT (provider, event_id) DO NOTHING
      conflict and processed_at set → 200 (duplicate, nothing to do)
 3. BEGIN
      SELECT subscription … FOR UPDATE   (serialises concurrent events per subscription)
      snapshot = adapter.fetchSubscription(ref)          (skip if older than provider_updated_at)
      events   = normalize(local, snapshot)
      for e in events: machine.apply → transitions row + audit
      ensure licence: INSERT … ON CONFLICT (subscription_id) DO NOTHING / re-link
      mark webhook_events.processed_at
    COMMIT → 200
 4. on error: ROLLBACK, attempts++, last_error → 500 (provider retries);
    jobs/retry-webhooks.ts also retries unprocessed rows with backoff; admin "replay"
```

There is no code path that creates a charge. Checkout sessions are created with the provider's idempotency key derived from our `Idempotency-Key`.

### 6.2 `Idempotency-Key` middleware (FR-14)

For `POST /checkout`, `/licenses/activate|deactivate|rotate` and all admin mutations:
1. `INSERT idempotency_keys (scope, key, request_hash, state='in_progress')`. On conflict:
   - same hash and `done` → replay the stored response.
   - same hash and `in_progress` → `409 idempotency_in_progress` (client retries).
   - different hash → `422 idempotency_key_reused`.
2. Run the handler, store the response, set `done`. Keys expire after 24 h (`jobs/purge.ts`).

Even without a key, activation is naturally idempotent: the partial unique index on `(license_id, device_hash)` means the same device never takes two slots.

### 6.3 Device limit under concurrency (FR-18)

Activation takes `SELECT … FROM licenses WHERE id = $1 FOR UPDATE`, counts active activations, then inserts or returns `409 device_limit_reached`. The row lock makes two simultaneous activations from different devices respect the limit (covered by a concurrency test).

### 6.4 Billing reconciliation (FR-15)

`jobs/reconcile.ts` (nightly, plus an admin button) iterates `adapter.listSubscriptions()` and compares each one with its local row. It applies missing transitions through the same machine (actor `system`), flags orphans on either side, and stores a report shown in the admin panel.

## 7. Levelset client contract (desktop integration)

This section is specified here; it's implemented later in the Levelset repo as a separate task. The API will be frozen in `docs/api/openapi.yaml`. Errors use RFC 9457 problem JSON with a stable `code`.

### 7.1 Endpoints

| Method / path | Body | Success | Errors (`code`) |
|---|---|---|---|
| `POST /api/v1/licenses/activate` | `{ key, device: { id_hash, label, os, app_version } }` | `200 { token, refresh_after, expires_at, tier, features[] }` | `invalid_key`, `license_revoked`, `license_not_entitled`, `device_limit_reached` (+ `devices[]`), `rate_limited` |
| `POST /api/v1/licenses/refresh` | `{ key, token }` | `200` same shape | as above + `device_deactivated` |
| `POST /api/v1/licenses/deactivate` | `{ key, device_id_hash }` | `204` | `invalid_key` |
| `GET /.well-known/jwks.json` | — | Ed25519 public keys (`kid`) | — |

### 7.2 Token (JWS, `alg: EdDSA`)

```json
{ "iss": "levelset-cloud", "aud": "levelset-desktop", "kid": "2026-10",
  "sub": "<license uuid>", "prd": "levelset", "tier": "pro|tester",
  "features": ["<feature_a>", "<feature_b>"],
  "dev": "<server-side HMAC of device id_hash>",
  "iat": 0, "nbf": 0, "exp": "iat + TOKEN_TTL_DAYS",
  "rfa": "iat + TOKEN_REFRESH_HOURS", "ent": "<entitled-until, e.g. period end or tester expiry>" }
```

`exp` never exceeds `ent` for testers, so a Tester key stops working offline at its expiry. Feature names are defined in config (they mirror Levelset's `Feature` set); the repo doesn't decide which features are Pro.

### 7.3 Desktop behaviour (fits Levelset ARCHITECTURE §5 and §8)

- **Ownership:** the **Rust shell** owns licensing, as it owns secrets (`secrets.rs`). A future `license.rs` adds Tauri commands `license_activate(key)`, `license_refresh()`, `license_deactivate()`, `license_status()`. The UI never receives the key or token, only `{ state, tier, features, expires_at, days_offline_left }`, the same way it can't read the Claude key.
- **Storage:** the key goes in Credential Manager (service `Levelset`, name `license_key`, which passes `validate_name`). The token goes in Credential Manager too (`license_token`, about 1 KB, under `MAX_SECRET_LEN` 4096).
- **Device ID:** `id_hash = SHA-256("levelset-device-v1:" + MachineGuid)` from `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`. The raw GUID is never sent; the server HMACs the hash again before storing it. `label` defaults to the computer name, editable.
- **Offline verification:** the JWKS public keys are embedded at build time. On start, Rust verifies the signature, `aud`, `exp`, and that `dev` matches the local device (it calls `/refresh` when unsure). Clock rollback guard: it stores `last_verified_at`, and if the clock moves backwards by more than 1 h, it requires an online refresh before staying Pro.
- **Refresh loop:** on launch and whenever `now > rfa`, it refreshes in the background with exponential backoff. On a network failure it keeps the current token until `exp`.
- **States shown to the user:** `free` (no key) · `pro` / `tester` · `offline_grace` (badge: "N days left offline") · `expired` / `revoked` → falls back to Free with a banner and a "Manage licence" link. Free features never depend on this server.
- **Engine:** after each verify, Rust pushes `{ tier, features, expires_at }` to the engine with `PUT /license`, mirroring `push_claude_key`. The engine's `LicenseProvider` keeps it in memory and defaults to `free`. That makes gating a config change, as Levelset §5 intended.
- **Honest threat model:** client checks in an MIT app can be patched out. Real protection comes from (a) Pro modules living in the private repo and (b) server-side features (AI proxy, data relay) verifying the token **and** checking live revocation in the DB on every session.

## 8. Security

- **Secrets:** env only (Container Apps secrets now; Key Vault reference later). `.env.example` lists names with placeholder values. CI greps for live keys and price patterns.
- **Keys and hashes:** licence keys and device hashes are stored as `HMAC-SHA256(KEY_HASH_PEPPER, value)`. Magic-link and session tokens are stored as SHA-256 hashes.
- **Signing keys:** `LICENSE_SIGNING_KEYS` is a JWK set of private keys. `LICENSE_ACTIVE_KID` selects the signer. Rotation: add the new key → publish JWKS → ship a Levelset build embedding both → switch the active kid → retire the old one after the max token TTL.
- **Webhooks:** signature check on the raw body; timestamp tolerance; provider-only route.
- **Web:** session cookies are `httpOnly`, `Secure` and `SameSite=Lax`; server actions get origin checks and CSRF tokens on admin forms; strict CSP; admin requires TOTP; admin bootstrap comes from `OWNER_EMAILS`.
- **Abuse:** Postgres-backed fixed-window rate limits per hashed IP and per key on sign-in, activate and refresh; transfer cooldown.
- **Privacy:** data minimisation per PRD §5; `jobs/purge.ts` handles retention; ARCO export/delete (FR-36).

## 9. Future services (designed for, not built)

```
Levelset (Pro) ──Bearer licence token──▶ ai-proxy (route group /api/v1/ai, same app)
                                         └─ verify token + live revocation check
                                         └─ per-licence quota (usage table), stream to AI provider
Levelset (Pro) ──WebSocket + token─────▶ relay (separate Container App, same environment)
                                         └─ subscribes to the licensed feed, fans out per symbol
```

- Both use `licensing/entitlements.ts` (the same verification as the desktop) plus a live DB check, so revocation is immediate server-side.
- New tables later: `usage_events` (AI metering) and `relay_sessions`. They're additive migrations only.
- The AI proxy enforces Levelset's AI rule in its system prompt and output checks: it explains and coaches, it never makes buy/sell calls.
- The relay is a separate container because WebSockets keep connections open (no scale-to-zero). Its cost is a launch decision.

## 10. Deployment and environments

| Env | DB | Provider | Where |
|---|---|---|---|
| local | Postgres (docker compose) | `fake` or Stripe test + `stripe listen` | `npm run dev` |
| CI | Postgres service container | `fake`; Stripe test (secrets-gated) | GitHub Actions |
| prod (portfolio) | Neon main branch | Stripe **test mode** | Azure Container Apps |

- **Image:** multi-stage Dockerfile (deps → build → `node:22-slim` runner, non-root user, standalone output).
- **Azure:** one Container Apps environment. App: min replicas 0, max 1–2, HTTP ingress. Jobs (cron): `migrate` (also triggered manually on deploy), `reconcile` (nightly), `retry-webhooks` (every 15 min), `purge` (daily). The image comes from GitHub Container Registry (free for public repos), so there's no paid Azure Container Registry.
- **Cost:** the app and jobs fit inside the Container Apps monthly free grant at portfolio traffic, and Neon free covers the DB. Check the current free-tier limits when creating the account and set an Azure budget alert at $1.
- **Deploy workflow:** added later, manual `workflow_dispatch` only, once the owner has created the Azure resources. Nothing is deployed automatically from this repo before then.

### Configuration (env names; values never committed)

`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `APP_URL`, `PAYMENT_PROVIDER` (`stripe|fake`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL`, `STRIPE_ALLOW_LIVE` (false; refuses non-`sk_test_` keys), `LICENSE_SIGNING_KEYS`, `LICENSE_ACTIVE_KID`, `KEY_HASH_PEPPER`, `SESSION_SECRET`, `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `OWNER_EMAILS`, `TOKEN_TTL_DAYS` (7), `TOKEN_REFRESH_HOURS` (24), `DEFAULT_DEVICE_LIMIT` (2), `TRANSFER_COOLDOWN_HOURS`, `TRIAL_DAYS`, `AUDIT_RETENTION_YEARS` (5), `DEVICE_PURGE_MONTHS` (12), `FLAG_TRIALS`, `FLAG_SELF_SERVE_TRANSFER`, `MIGRATIONS_DIR` (migrate job only).

## 11. Testing and CI

| Layer | What | Tool |
|---|---|---|
| Unit | transition tables (every cell), entitlement function, key checksum, token sign/verify/rotation, CSV classify, idempotency hashing, permission matrix | Vitest |
| Integration | webhook pipeline with duplicate + out-of-order events, concurrent activation at the limit, version conflicts, audit append-only (UPDATE must fail), import commit idempotency, migration apply from empty | Vitest + real Postgres |
| E2E (fake) | buy → licence → activate (via API as the desktop would) → cancel → entitlement ends; admin edits + audit; CSV import with duplicates | Playwright |
| E2E (Stripe) | real test-mode Checkout with test cards, webhooks via Stripe CLI, billing portal cancel | Playwright, secrets-gated |

CI (`ci.yml`, on PR and push): install → lint → typecheck → unit → integration (Postgres service) → migrations check → `next build` → Docker build → E2E fake → E2E Stripe (only if `STRIPE_SECRET_KEY` secret exists) → secret/price grep.

## 12. Build plan (after sign-off)

| M | Milestone | Depends on |
|---|---|---|
| 0 | Scaffold: Next.js, Drizzle, docker compose, CI skeleton, config loader, OpenAPI skeleton | — |
| 1 | Schema + migrations; platform (idempotency, rate limits, flags, audit, version updates) | 0 |
| 2 | Billing core: state machine, `PaymentProvider`, fake adapter, webhook pipeline, reconciliation | 1 |
| 3 | Licensing: keys, tokens/JWKS, activate/refresh/deactivate, entitlements | 1 (parallel with 2) |
| 4 | Stripe adapter: checkout, portal, webhooks, display prices; Stripe E2E | 2 |
| 5 | Auth + customer area (magic link, licence/devices/subscription, ARCO) | 1, 3 |
| 6 | Admin panel: RBAC, TOTP, customer view, actions, audit viewer, flags | 1, 5 |
| 7 | CSV import: staging, review, commit, report | 6 |
| 8 | Docker + Azure Container Apps guide, deploy workflow (manual), freeze `openapi.yaml` | all |
| — | **Separate task:** Levelset `license.rs` + engine `PUT /license` (§7.3) | 8 |

Milestones 2 and 3, and later 6 and 7, can go to parallel subagents with separate `src/server/*` folders.
