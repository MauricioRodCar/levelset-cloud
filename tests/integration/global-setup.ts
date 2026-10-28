import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/server/platform/migrate-runner";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Uses DATABASE_URL when set (CI service, docker compose). Otherwise starts a
 * throwaway embedded Postgres 16 so integration tests run without Docker.
 * Either way, applies all migrations first.
 */
export default async function setup(project: TestProject) {
  let url = process.env.DATABASE_URL;
  let teardown = async () => {};

  if (!url) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = await mkdtemp(path.join(tmpdir(), "levelset-pg-"));
    const port = await freePort();
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      port,
      user: "levelset",
      password: "levelset", // throwaway local test cluster
      persistent: false,
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("levelset_test");
    url = `postgres://levelset:levelset@127.0.0.1:${port}/levelset_test`;
    teardown = async () => {
      await pg.stop();
      await rm(dir, { recursive: true, force: true });
    };
  }

  await runMigrations(url, path.join(process.cwd(), "drizzle"));
  project.provide("databaseUrl", url);
  return teardown;
}
