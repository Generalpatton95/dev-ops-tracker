// T-8: the per-file throwaway database helper never leaves a database behind and never makes a
// name Postgres would shorten (which could cut off the "_test" suffix).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  createFreshDatabase,
  freshDatabaseName,
  freshDatabaseSkipReason,
} from "./fresh-test-database";
import { resolveTestDatabase } from "./test-database";

describe("fresh test database names", () => {
  it("end in _test and fit Postgres's 63-byte limit", () => {
    const name = freshDatabaseName("t8_x", "12345_1792953972279_0");
    expect(name).toBe("dot_t8_x_12345_1792953972279_0_test");
    expect(() => freshDatabaseName("x".repeat(60), "1")).toThrow("at most 63 bytes");
  });
});

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== undefined)("fresh test databases in Postgres", () => {
  const scratchRoot = fileURLToPath(new URL("../../../node_modules/.cache", import.meta.url));
  let broken = "";

  afterAll(() => {
    if (broken) rmSync(broken, { recursive: true, force: true });
  });

  async function databasesNamed(prefix: string) {
    const target = resolveTestDatabase(process.env);
    if (!target.run) return [];
    const client = new pg.Client({ connectionString: target.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ datname: string }>(
        "select datname from pg_database where datname like $1",
        [`${prefix}%`],
      );
      return rows.map((row) => row.datname);
    } finally {
      await client.end();
    }
  }

  it("drops the new database and rethrows when migrating fails part-way", async () => {
    mkdirSync(scratchRoot, { recursive: true });
    broken = mkdtempSync(join(scratchRoot, "dot-broken-migrations-"));
    mkdirSync(join(broken, "meta"), { recursive: true });
    writeFileSync(
      join(broken, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_broken", breakpoints: true }],
      }),
    );
    writeFileSync(join(broken, "0000_broken.sql"), "create table ok_first (id int);\nnot sql;\n");

    await expect(createFreshDatabase("t8_broken", { migrationsFolder: broken })).rejects.toThrow();
    expect(await databasesNamed("dot_t8_broken_")).toEqual([]);
  });

  it("drop() removes the database it made", async () => {
    const fresh = await createFreshDatabase("t8_dropme");
    expect(await databasesNamed("dot_t8_dropme_")).toHaveLength(1);
    await fresh.drop();
    expect(await databasesNamed("dot_t8_dropme_")).toEqual([]);
  }, 60_000);
});
