# levelset-cloud

Licence and subscription backend for [Levelset](https://github.com/MauricioRodCar/Levelset), the open-source Windows trading cockpit.

> **Status: planning.** Requirements and design are drafts awaiting approval. There is no application code yet.

- [docs/PRD.md](docs/PRD.md): requirements and decisions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design, data model, state machines, desktop client contract
- [docs/PORTFOLIO.md](docs/PORTFOLIO.md): one-page summary, stack, skills shown, status

**Planned stack:** Next.js + TypeScript, PostgreSQL (Neon) with Drizzle migrations, Stripe (test mode) behind a payment-provider adapter, Ed25519-signed licence tokens, Vitest + Playwright, GitHub Actions, Docker on Azure Container Apps.

**What it will show:** explicit subscription state machine, idempotent webhooks and endpoints, append-only audit log, role-based admin with optimistic concurrency, versioned migrations, CSV import with reconciliation, E2E tests against Stripe test mode.

No prices or secrets live in this repo. Plans reference provider price IDs through environment variables.

## License

MIT (to be added with the first code commit).
