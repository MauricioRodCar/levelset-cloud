// Starts the app for Playwright (playwright.config.ts → webServer):
//   1. Postgres: DATABASE_URL if set (CI service), otherwise a throwaway embedded Postgres 16
//   2. migrations + catalog seed
//   3. `next dev` on E2E_PORT, with PAYMENT_PROVIDER=fake unless set (the Stripe suite sets stripe)
// `next dev` rather than a production build: the fake provider is refused when NODE_ENV=production.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const port = process.env.E2E_PORT ?? "3100";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
  });
}

let databaseUrl = process.env.DATABASE_URL;
let pg;
let pgDir;
if (!databaseUrl) {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  pgDir = mkdtempSync(path.join(tmpdir(), "levelset-e2e-pg-"));
  const pgPort = await freePort();
  pg = new EmbeddedPostgres({ databaseDir: pgDir, port: pgPort, user: "levelset", password: "levelset", persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("levelset_e2e");
  databaseUrl = `postgres://levelset:levelset@127.0.0.1:${pgPort}/levelset_e2e`;
}

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER ?? "fake",
  APP_URL: `http://localhost:${port}`,
  NEXT_TELEMETRY_DISABLED: "1",
};

for (const job of ["src/jobs/migrate.ts", "src/jobs/seed.ts"]) {
  const r = spawnSync("npx", ["tsx", job], { env, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const app = spawn("npx", ["next", "dev", "-p", port], { env, stdio: "inherit", shell: true });

async function shutdown(code = 0) {
  app.kill();
  await pg?.stop().catch(() => {});
  if (pgDir) rmSync(pgDir, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
app.on("exit", (code) => shutdown(code ?? 0));
