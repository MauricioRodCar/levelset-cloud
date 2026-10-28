# levelset-cloud — Product Requirements (v0.1, draft for sign-off)

Owner: Mauricio · Status: **draft, awaiting approval — no application code until approved** · Companion: [ARCHITECTURE.md](ARCHITECTURE.md)

## 1. What this is

`levelset-cloud` is the server side of [Levelset](https://github.com/MauricioRodCar/Levelset), the open-source Windows trading cockpit. Levelset follows an open-core model: the core is free and public, a Pro tier is unlocked by a licence key, and one installer serves everyone. This repo holds the part that can't be copied from GitHub:

- **v1 (this PRD):** subscriptions, payments, licence keys, desktop activation, an admin panel, and the import of beta testers.
- **Later (designed for, not built):** a hosted AI proxy and a real-time market-data relay for Pro users (§9).

It is also a public portfolio project. It deliberately shows explicit state machines, idempotent endpoints and webhooks, an append-only audit log, role-based permissions, optimistic concurrency, versioned migrations with reconciliation, and E2E tests against a real payment provider's test mode.

### Hard rules
- **The repo is public.** It contains **no prices, plan amounts or business strategy**. Plans refer to provider price IDs and limits through env/config. Display prices are read from the payment provider at runtime.
- **Secrets only in env vars** (and the host's secret store). Never in code, fixtures, logs or error messages.
- Levelset's own rule still applies: nothing here sends orders to a broker or makes buy/sell calls.

## 2. Users and roles

| Role | Who | Can |
|---|---|---|
| Anonymous | Desktop app, visitors | Activate/refresh/deactivate a licence with its key; start checkout; request a sign-in link |
| Customer | A buyer or a tester | See their licence key (reveal once, then rotate), devices, subscription; open the billing portal; deactivate devices; export or delete their data |
| Support | Helper | Search customers; view licences, devices, subscriptions and the audit log; deactivate devices; extend or revoke **Tester** keys; add notes |
| Owner | Mauricio | Everything Support can do, plus create and revoke any licence, run CSV imports, toggle feature flags, manage admin users, and trigger reconciliation |

Free users have **no account and no key**. Levelset Free never contacts this server.

## 3. Decisions (answered 2026-10-28)

| # | Question | Decision |
|---|---|---|
| D1 | Repo / product name | **levelset-cloud**. Licensing is a clean internal module; the AI proxy and data relay join the same server later. |
| D2 | Single vs. multi-product | **Single product (Levelset)**, but every plan and licence row carries `product_id`. A second product is new data, not a migration. |
| D3 | Payments | **`PaymentProvider` adapter** with two implementations: **Stripe** (test mode) and an **in-memory fake** that proves the abstraction and drives fast tests. A merchant-of-record adapter is added only at launch, and only if one is chosen (§8). |
| D4 | Hosting | **Azure Container Apps** (Docker image, monthly free grant, scale to zero) **+ Neon Postgres free tier**. Target cost ≈ $0 for the portfolio stage. The owner creates the Azure account. |
| D5 | ORM / migrations | **Drizzle ORM + drizzle-kit**. Plain versioned `.sql` migrations are committed and reviewed. |
| D6 | Device limit | **2 active devices** per Pro licence by default; configurable per plan and per licence. |
| D7 | Offline grace | Signed token valid **7 days**; the app refreshes **every 24 h** when online. Both are configurable. |
| D8 | Customer sign-in | **Email magic link.** Admin roles use the same link **plus required TOTP 2FA**. |
| D9 | Privacy | **Minimal data** + Mexican privacy notice (LFPDPPP) **placeholder** for the lawyer; ARCO export/delete endpoints included. |

## 4. Functional requirements

IDs are referenced by tests and commits.

### 4.1 Plans and checkout
- **FR-1** Plans are configured as data (seeded from env): `key` (e.g. `pro_monthly`, `pro_annual`), tier, interval, provider price reference (env var), device limit, and feature list. No amounts are stored in the repo.
- **FR-2** Pricing page: shows the Pro plans with prices fetched from the provider (cached) and a "Free — download" option.
- **FR-3** Checkout: `POST /api/v1/checkout` creates a provider checkout session for a plan and an email. It accepts an `Idempotency-Key`, so a retried request returns the same session, never a second one.
- **FR-4** After payment the customer lands on a success page. The licence is created **only by the webhook**, never by the redirect. The page polls until the licence exists, then offers "Email me a sign-in link".
- **FR-5** Billing portal: signed-in customers open the provider's portal to change payment method, switch monthly ↔ annual, cancel or resume, and download invoices.
- **FR-6** Optional trial (feature flag `trials`, length from config).

### 4.2 Subscription lifecycle (state machine)
- **FR-7** A subscription moves only through the transitions in ARCHITECTURE §4. Any other transition is rejected, logged, and raises an alert in the admin panel.
- **FR-8** Every transition is recorded (`from`, `to`, cause event, timestamp) and audited.
- **FR-9** Entitlement is derived from state: `trialing`, `active`, `cancel_scheduled` and `past_due` (dunning grace) grant Pro. `unpaid`, `ended` and `incomplete` don't.
- **FR-10** A dispute or chargeback suspends the licence until an admin resolves it.

### 4.3 Webhooks and idempotency
- **FR-11** Webhooks are signature-verified on the raw body and stored (`provider`, `event_id` unique) **before** processing. A duplicate delivery returns `200` and does nothing.
- **FR-12** Processing is transactional and order-independent. The handler re-reads the current object from the provider (or compares `provider_updated_at`), so out-of-order events never move state backwards.
- **FR-13** A failed processing attempt is retried with backoff (the provider retries too; plus an admin "replay" button). Retries never create a second licence (`licenses.subscription_id` unique) and never create a charge. The server never creates charges directly; it only creates checkout sessions.
- **FR-14** All mutating client and admin endpoints accept an `Idempotency-Key`. The same key with the same body replays the stored response; the same key with a different body returns `422`.
- **FR-15** Nightly **billing reconciliation** compares provider subscriptions with local rows, writes a drift report, and fixes drift through the same transition code (audited as `system`).

### 4.4 Licences and desktop activation
- **FR-16** Key format: `LSET-XXXXX-XXXXX-XXXXX-XXXXX` (Crockford base32 with a check character, so typos are caught offline). Only a keyed hash is stored. The key is shown once; a customer can **rotate** it, which deactivates its devices.
- **FR-17** Licence kinds: `subscription` (follows its subscription), `tester` (full access, **expiry required**, revocable), `manual` (owner-issued, e.g. for press).
- **FR-18** **Activate**: the key + device info (hashed device ID, label, OS, app version) returns a signed licence token. The same device activating again is idempotent and doesn't use a new slot. If the device limit is reached, the response is `409` with the list of active devices (labels + last seen) so the app can offer "deactivate one".
- **FR-19** **Refresh**: the app exchanges its current token (+ key) for a new one. It returns the current tier and features, so revocation, cancellation and plan changes reach the app within one refresh.
- **FR-20** **Deactivate**: by the app (this device), by the customer (any device of theirs) or by Support. A slot freed by a device transfer becomes reusable after a cooldown (configurable, rate-limited against key sharing).
- **FR-21** Tokens are signed with **Ed25519** and carry a key ID. Public keys are published at a JWKS endpoint and **embedded in the Levelset build**, so verification works offline. Keys rotate without breaking issued tokens.
- **FR-22** **Free needs no key**: without a valid token, Levelset is Free and never calls this server.
- **FR-23** Rate limits on activate/refresh per key and per IP. Repeated invalid keys from one IP are throttled.

### 4.5 Admin panel
- **FR-24** Search by email, key prefix, provider IDs. Customer page shows subscription, licences, devices, transitions, audit trail and notes.
- **FR-25** Actions (permission-checked per §2): create/extend/revoke Tester keys, issue/revoke manual licences, deactivate devices, suspend/unsuspend, replay webhook, run reconciliation, toggle flags, manage admin users.
- **FR-26** **Audit log** of every change by anyone (admin, customer, system, provider webhook): actor, action, entity, before/after diff, reason, request ID. It is append-only: the database refuses UPDATE and DELETE. It is viewable and filterable, and exportable as CSV.
- **FR-27** **Optimistic concurrency**: every editable row has a `version`. Edits send the version they read; a mismatch returns `409` and the UI shows the current values and the other person's change.
- **FR-28** Destructive actions require a reason (stored in the audit log) and a confirm step.

### 4.6 Beta tester import (CSV)
- **FR-29** Owner uploads a CSV (`email`, optional `name`, `tester_expires_at`, `notes`, `source_ref`). The file goes into a staging batch; nothing touches live tables yet.
- **FR-30** Validation and normalisation (trim, lowercase email, date parsing). Each row is classified: `new`, `existing_customer`, `duplicate_in_file`, `conflict` (same email, different data), or `invalid` (with a reason).
- **FR-31** **Duplicate review** screen: for each duplicate/conflict group, pick keep / merge / skip. The batch can't be committed with unresolved groups.
- **FR-32** **Dry run** shows exactly what commit would do. **Commit** is idempotent: the batch is keyed by file hash and rows by row hash, so re-uploading the same file is a no-op.
- **FR-33** **Reconciliation report**: rows in = created + updated + skipped + rejected (must balance, otherwise the commit fails), with the outcome per row. Downloadable CSV. Optionally, sign-in emails go to the created testers (behind a confirm step).

### 4.7 Customer area
- **FR-34** Magic-link sign-in (single use, short expiry, rate-limited). Sessions are httpOnly cookies.
- **FR-35** Pages: licence (masked key, reveal-once/rotate), devices (deactivate), subscription (status, renewal/end date, portal button).
- **FR-36** ARCO: export my data (JSON) and delete my account. Deletion cancels the subscription at the provider, revokes licences, and anonymises the customer; audit rows keep pseudonymous IDs only.

### 4.8 Feature flags
- **FR-37** A small flag table with an env default, toggled by the Owner (audited). v1 flags: `trials` (offer a trial at checkout) and `self_serve_transfer` (customers can deactivate devices themselves; when off, Support does it).

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Security | Webhook signature verification; Ed25519 signing key only in env/secret store; keyed hashes for licence keys and device IDs; TOTP for admins; CSRF protection; strict CSP; no secrets in logs; dependency audit in CI |
| Privacy | Store only email, provider customer ID, hashed device ID, device label, OS, app version, last-seen time. No IPs stored beyond rate-limit windows (hashed, short TTL). Inactive devices purged after 12 months; audit log kept 5 years (configurable). The privacy notice (aviso de privacidad) text is a placeholder until the legal review |
| Reliability | Activation p95 < 500 ms when warm; tolerates scale-to-zero cold starts (client retries with backoff, and the grace period covers outages) |
| Correctness | No duplicate licences or charges under concurrent or duplicate requests (tested); migrations forward-only, checksum-verified |
| Portability | Docker image; any Postgres 16; no Vercel- or Azure-only APIs in app code |
| Accessibility / i18n | Admin and customer pages in English and Spanish (neutral Latin American), WCAG AA |
| Observability | Structured JSON logs with request ID, `/api/health` (liveness) and `/api/ready` (DB + migrations applied) |

## 6. Quality

- **Vitest**: unit tests (state-machine transition table, token sign/verify, key checksum, CSV classification, idempotency) and integration tests against a real Postgres (Docker service).
- **Playwright E2E**: full flows on the **fake provider** (always run) and on **Stripe test mode**: checkout with Stripe's documented test cards, webhook delivery via the Stripe CLI, licence appears, activate, cancel in the portal, entitlement ends. The Stripe suite runs only when test-mode secrets are present (skipped on forks).
- **Concurrency tests**: parallel duplicate webhooks, parallel activations past the device limit, conflicting admin edits.
- **GitHub Actions CI**: lint, typecheck, unit, integration, migration check (generate → no diff; apply from empty), Docker build, E2E (fake), E2E (Stripe, secrets-gated).

## 7. Out of scope (v1)

Building a merchant-of-record adapter; tax calculation and invoices (the provider does those); teams/seats; coupons beyond what the provider portal offers; mobile; usage-based billing; the AI proxy and data relay (§9); any change inside the Levelset repo (the client contract is specified in ARCHITECTURE §7 and implemented later as a separate task).

## 8. Payment provider: Stripe vs. merchant of record

The adapter exists so this decision can wait until launch.

| | **Stripe (direct)** | **Merchant of record (Lemon Squeezy, Paddle)** |
|---|---|---|
| Who sells legally | You do; you're the seller of record | The MoR resells your software; it's the seller |
| Taxes | You register, collect and remit (Mexican IVA, EU VAT, US sales tax…). Stripe Tax calculates, but filing is on you | The MoR calculates, collects and **remits** worldwide, Mexican IVA included |
| Fees | Lower per transaction | Higher (tax and compliance are included) |
| Invoices (e.g. CFDI in Mexico) | Your responsibility | Issued by the MoR (check CFDI expectations for Mexican buyers) |
| Developer experience / portfolio | Excellent test mode, CLI, best known | Good, smaller ecosystem |
| Payouts to Mexico | Supported (check the account type) | Supported (check each one) |

**Recommendation:** Stripe test mode for v1 (portfolio, best testability). At launch, a **merchant of record is likely simpler for a solo seller in Mexico**, because it removes the tax registration and remittance work. Adding that adapter is about 4–6 days, since the fake provider already proves the interface. Confirm with the accountant/lawyer during the pre-launch legal review.

## 9. Future (design for, don't build)

- **Hosted AI proxy**: Pro users call `/api/v1/ai/*` with their licence token. The server holds the AI provider key and enforces per-licence quotas and metering. It keeps Levelset's rule: the AI explains and coaches, it never makes buy/sell calls.
- **Real-time data relay**: a separate container (WebSocket/SSE) authenticated by the licence token, fanning out a licensed provider's feed to entitled users.
- Both reuse the entitlement module and token verification from v1. See ARCHITECTURE §9.

## 10. Open items (non-blocking, decide later)

| # | Item | Recommendation |
|---|---|---|
| O1 | Transactional email for magic links | `EmailSender` adapter: console in dev; **Resend** free tier (or Azure Communication Services) in prod. Check free-tier limits at sign-up |
| O2 | Domain + TLS for the API | Container Apps' default domain for the portfolio stage; a custom domain at launch |
| O3 | Live payment provider | Decide at launch (§8) |
| O4 | Privacy notice, terms, refund policy text | Pre-launch legal review (already on the private checklist) |
| O5 | Device transfer cooldown and trial length values | Config defaults set during build; tuned with testers |

## 11. Acceptance (definition of done for v1)

All FRs pass their tests. A fresh `docker compose up` + migrate + seed runs the full fake-provider E2E. The Stripe test-mode E2E passes in CI. The image deploys to Azure Container Apps with Neon. `grep` finds no prices or secrets in the repo. The client contract (ARCHITECTURE §7) is frozen as `docs/api/openapi.yaml` for the later Levelset task.
