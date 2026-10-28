# levelset-cloud

Licence and subscription backend for [Levelset](https://github.com/MauricioRodCar/Levelset), the open-source Windows trading cockpit.

> **Status: milestone 0 (scaffold).** Requirements and design are approved; business features (billing, licences, admin) are built in milestones 1–7.

- [docs/PRD.md](docs/PRD.md): requirements and decisions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design, data model, state machines, desktop client contract
- [docs/PORTFOLIO.md](docs/PORTFOLIO.md): one-page summary, stack, skills shown, status
- [docs/api/openapi.yaml](docs/api/openapi.yaml): API contract

**Stack:** Next.js 16 + TypeScript, PostgreSQL (Neon) with Drizzle migrations, Stripe (test mode) behind a payment-provider adapter, Ed25519-signed licence tokens, Vitest + Playwright, GitHub Actions, Docker on Azure Container Apps.

**What it will show:** explicit subscription state machine, idempotent webhooks and endpoints, append-only audit log, role-based admin with optimistic concurrency, versioned migrations, CSV import with reconciliation, E2E tests against Stripe test mode.

No prices or secrets live in this repo. Plans reference provider price IDs through environment variables, and CI fails if a live key or a price amount is committed.

## Development

Requires Node 22.12+ and Docker (for Postgres).

```bash
npm ci
cp .env.example .env
docker compose up -d db mailpit
npm run db:migrate
npm run dev
```

| Command | What it does |
|---|---|
| `npm run lint` · `npm run typecheck` | ESLint, TypeScript |
| `npm test` | Unit tests (no database) |
| `npm run test:integration` | Integration tests against `DATABASE_URL` (migrate first) |
| `npm run db:generate` · `npm run db:check` · `npm run db:migrate` | Create, verify and apply migrations in `drizzle/` |
| `npm run build` | Next.js standalone build + bundled jobs in `dist/jobs/` |
| `docker compose --profile app up --build` | Production image with the migrate job run first |
| `bash scripts/check-public-safety.sh` | Scan tracked files for live keys and prices |

Health: `GET /api/health` (liveness) and `GET /api/ready` (database reachable and all migrations applied).

## License

[MIT](LICENSE)
