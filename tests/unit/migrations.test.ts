import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareMigrations, readBundledMigrations } from "@/server/platform/migrations";

describe("compareMigrations", () => {
  it("is up to date when every bundled migration is applied", () => {
    expect(compareMigrations([1, 2], [1, 2])).toEqual({ bundled: 2, applied: 2, pending: 0, unknown: 0, upToDate: true });
  });

  it("reports pending migrations as not ready", () => {
    expect(compareMigrations([1, 2, 3], [1])).toMatchObject({ pending: 2, upToDate: false });
  });

  it("stays ready when the DB has migrations this build doesn't know (expand/contract)", () => {
    expect(compareMigrations([1], [1, 2])).toMatchObject({ unknown: 1, upToDate: true });
  });

  it("treats an empty project as up to date", () => {
    expect(compareMigrations([], []).upToDate).toBe(true);
  });
});

describe("readBundledMigrations", () => {
  it("returns [] when no journal exists yet", async () => {
    expect(await readBundledMigrations(path.join(tmpdir(), "levelset-no-such-dir"))).toEqual([]);
  });

  it("reads `when` stamps from the drizzle journal", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ls-mig-"));
    await mkdir(path.join(dir, "meta"));
    await writeFile(
      path.join(dir, "meta", "_journal.json"),
      JSON.stringify({ entries: [{ when: 10, tag: "0000_a" }, { when: 20, tag: "0001_b" }] }),
    );
    expect(await readBundledMigrations(dir)).toEqual([10, 20]);
  });
});
