import { defineConfig, devices } from "@playwright/test";

// E2E (ARCHITECTURE §11). `fake`: full purchase flow on the in-memory provider, always runs.
// `stripe`: the same flow on Stripe test mode; needs keys + `stripe listen` (see docs/STRIPE-SETUP.md).
const port = process.env.E2E_PORT ?? "3100";
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  workers: 1,
  retries: ci ? 1 : 0,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  projects: [
    { name: "fake", testMatch: /.*\.fake\.spec\.ts/ },
    { name: "stripe", testMatch: /.*\.stripe\.spec\.ts/ },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `http://localhost:${port}/api/health`,
    timeout: 240_000,
    reuseExistingServer: !ci,
    env: { E2E_PORT: port },
    stdout: "pipe",
  },
});
