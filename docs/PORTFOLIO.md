# levelset-cloud — Portfolio summary

A one-page summary for anyone (or any assistant) building resume and portfolio material from this repo. Details live in [PRD.md](PRD.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Status (keep this current)

| Date | Stage | What exists |
|---|---|---|
| 2026-10-28 | Planning | PRD and architecture written and approved by the owner. |
| 2026-10-28 | **Milestone 0: scaffold (current)** | Next.js 16 + TypeScript project, typed env config with safety guards (test-mode-only Stripe keys, no fake provider in production), Drizzle setup, `/api/health` + `/api/ready` with migration reconciliation, migrate job, Dockerfile + docker compose, OpenAPI skeleton of the desktop contract, GitHub Actions CI (lint, typecheck, unit + integration tests, migration checks, container smoke test, secret/price scan). **No business features yet** (licences, billing, admin start in milestones 1–7). |

Describe the project only up to its current stage: name only what the table says exists as "built", and everything else as "designed / specified". Update this table at each milestone (ARCHITECTURE §12).

## One-liner

Licence and subscription backend for Levelset, an open-source Windows trading app: Stripe checkout, a subscription state machine, idempotent webhooks, signed offline-verifiable licence keys for a desktop app, and a role-based admin panel with an audit log.

## Context

- **Owner:** Mauricio (GitHub: MauricioRodCar), solo developer.
- **Parent product:** [Levelset](https://github.com/MauricioRodCar/Levelset), a Windows desktop trading cockpit (Tauri 2 + React/TypeScript + Python FastAPI engine, MIT, v0.1.0 released).
- **Why it exists:** Levelset is open core: a free public app plus a later paid Pro tier unlocked by licence keys. This server handles what can't live in a public desktop app: payments, licences, and later the hosted AI and real-time data for Pro users.
- **Repo:** public (MIT). It contains no prices or business strategy; plans are configured through environment variables.

## Stack

| Area | Technology |
|---|---|
| Language / framework | TypeScript (strict), Next.js 16 App Router, Node 22 |
| Database | PostgreSQL 16 (Neon), Drizzle ORM, versioned SQL migrations (drizzle-kit) |
| Payments | Stripe (test mode: Checkout, Billing customer portal, webhooks) behind a provider adapter |
| Auth / security | Email magic links, DB sessions, TOTP 2FA for admins, Ed25519-signed JWS licence tokens (`jose`), JWKS, HMAC-hashed keys |
| UI | React server components, Tailwind CSS, shadcn/ui, next-intl (English / Spanish) |
| Validation / API | Zod, OpenAPI contract, RFC 9457 problem responses |
| Testing | Vitest (unit + integration against real Postgres), Playwright E2E (incl. Stripe test mode via Stripe CLI) |
| DevOps | Docker (multi-stage), GitHub Actions CI, Azure Container Apps + scheduled Container Apps Jobs, GitHub Container Registry |
| Desktop client side (later task) | Rust (Tauri 2), Windows Credential Manager |

## Engineering skills it demonstrates (with where to look)

| Skill | Evidence in the design |
|---|---|
| State machines | Subscription lifecycle as a table-driven state machine with rejected illegal transitions and a transition history (ARCHITECTURE §4) |
| Idempotency | Webhook event dedupe, `Idempotency-Key` middleware with replay, unique constraints so retries never duplicate a licence or charge (§6) |
| Concurrency control | Optimistic locking with a `version` column (409 on conflict); row locks to enforce device limits under parallel requests (§5, §6.3) |
| Security | Offline-verifiable signed tokens with key rotation, hashed secrets, webhook signature checks, TOTP, rate limiting, CSP (§7, §8) |
| Audit and compliance | Append-only audit log enforced by DB permissions + trigger; data minimisation and export/delete endpoints under Mexico's privacy law (LFPDPPP) (§5, PRD §5) |
| RBAC | Owner / support / customer permission matrix (PRD §2) |
| Data migration | CSV import of beta testers with staging, duplicate review, dry run, idempotent commit and a balanced reconciliation report (PRD §4.6) |
| Reconciliation | Nightly comparison of payment-provider state with the database, fixing drift through the same state machine (§6.4); migration-journal check in readiness probe (§5) |
| Adapter / ports-and-adapters design | `PaymentProvider` interface with Stripe and in-memory fake implementations; email sender adapter (§2, §6) |
| API design for a desktop client | Activation / refresh / deactivation contract, offline grace period, device binding, clock-rollback guard (§7) |
| Testing strategy | Unit, integration, concurrency, E2E against a real provider's test mode, secrets-gated CI jobs (§11) |
| Cloud on a budget | Scale-to-zero containers + serverless Postgres designed to run at ≈ $0 (§10) |
| Product / requirements work | Written PRD with decisions, trade-offs (Stripe vs. merchant of record), open items and acceptance criteria before any code |

## Draft resume bullets

Tense by stage. Use the "Planning" set now and switch to "Built" only once the code exists and the matching milestone is done.

**Planning (true today):**
- Designed the licence and subscription backend for an open-source desktop trading app: Next.js/TypeScript, PostgreSQL, Stripe, Ed25519-signed offline licence tokens; wrote the PRD (37 requirements) and architecture before implementation.
- Specified a table-driven subscription state machine and an idempotent webhook pipeline (event dedupe, order-independent processing, nightly provider reconciliation) so retries never duplicate charges or licences.

**Built (use only after implementation):**
- Built … with Stripe Checkout and Billing portal, idempotent webhooks and a subscription state machine; covered by Vitest and Playwright E2E against Stripe test mode in GitHub Actions.
- Implemented a role-based admin panel with an append-only audit log, optimistic concurrency, and a CSV beta-tester migration with duplicate review and reconciliation reports.
- Deployed as a Docker image to Azure Container Apps with Neon Postgres and scheduled jobs at near-zero cost.

## Keywords

TypeScript, Next.js, React, Node.js, PostgreSQL, Drizzle ORM, SQL migrations, Stripe, webhooks, idempotency, state machine, optimistic concurrency, RBAC, audit logging, JWT/JWS, Ed25519, OAuth-free magic-link auth, TOTP 2FA, REST API, OpenAPI, Zod, Vitest, Playwright, E2E testing, GitHub Actions, CI/CD, Docker, Azure Container Apps, serverless Postgres (Neon), data migration, reconciliation, privacy compliance, i18n (English/Spanish), Tauri, Rust.

## Links

- Repo: not published yet (local at `C:\dev\levelset-cloud`; GitHub repo to be created when the owner decides).
- Parent product: https://github.com/MauricioRodCar/Levelset
