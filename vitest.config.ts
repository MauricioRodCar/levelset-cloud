import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      {
        resolve: { alias },
        // Needs DATABASE_URL pointing at a migrated Postgres (docker compose locally, a service in CI).
        test: { name: "integration", include: ["tests/integration/**/*.test.ts"], fileParallelism: false },
      },
    ],
  },
});
