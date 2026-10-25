// T-8: a migrated database of its own for one test file, created on the TEST_DATABASE_URL server
// and dropped afterwards, so files that run in parallel never share (or wipe) each other's
// tables. Test-only; the app never imports it. Same guards as ./test-database.ts: the server is
// only ever reached through TEST_DATABASE_URL, every name ends in _test, and messages never
// include the URL.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Database } from "./index";
import * as schema from "./schema";
import { isTestDatabaseName, resolveTestDatabase } from "./test-database";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export type FreshDatabase = { db: Database; url: string; drop: () => Promise<void> };

/** Why the database tests skip here, or undefined when they run. Throws in CI rather than skip. */
export async function freshDatabaseSkipReason(): Promise<string | undefined> {
  const target = resolveTestDatabase(process.env);
  if (!target.run) return target.reason;
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    const { rows } = await client.query<{ createdb: boolean }>(
      "select rolcreatedb or rolsuper as createdb from pg_roles where rolname = current_user",
    );
    if (rows[0]?.createdb) return undefined;
  } finally {
    await client.end();
  }
  const reason = "TEST_DATABASE_URL's role lacks CREATEDB, which these tests need";
  if (process.env.CI) throw new Error(`${reason}. CI runs them, so this fails.`);
  return `${reason}, so they are skipped. CI runs them.`;
}

let counter = 0;

// Postgres truncates identifiers longer than this, which could cut off the "_test" suffix.
const MAX_NAME_BYTES = 63;

/** The name for a new throwaway database; refuses one Postgres would shorten. */
export function freshDatabaseName(label: string, unique: string): string {
  const name = `dot_${label}_${unique}_test`.toLowerCase();
  if (Buffer.byteLength(name) > MAX_NAME_BYTES || !isTestDatabaseName(name)) {
    throw new Error(
      `Refusing to run: test database names must be at most ${MAX_NAME_BYTES} bytes.`,
    );
  }
  return name;
}

export async function createFreshDatabase(
  label: string,
  // Tests of this helper pass a broken folder to check the clean-up; everyone else uses drizzle/.
  options: { migrationsFolder?: string } = {},
): Promise<FreshDatabase> {
  const target = resolveTestDatabase(process.env);
  if (!target.run) throw new Error(target.reason);
  const name = freshDatabaseName(label, `${process.pid}_${Date.now()}_${counter++}`);
  const admin = new pg.Client({ connectionString: target.url });
  await admin.connect();
  let created = false;
  let pool: pg.Pool | undefined;
  const dropAll = async () => {
    await pool?.end().catch(() => {});
    if (created) {
      await admin.query(`drop database if exists ${admin.escapeIdentifier(name)} with (force)`);
    }
    await admin.end();
  };

  try {
    const { rows } = await admin.query<{ name: string }>("select current_database() as name");
    if (!isTestDatabaseName(rows[0]?.name ?? "")) {
      throw new Error('Refusing to run: the connected database name does not end in "_test".');
    }
    await admin.query(`create database ${admin.escapeIdentifier(name)}`);
    created = true;
    const url = new URL(target.url);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: options.migrationsFolder ?? migrationsFolder });
    return { db, url: url.toString(), drop: dropAll };
  } catch (error) {
    // Leave nothing behind when setup fails part-way, then report the original failure.
    await dropAll().catch(() => {});
    throw error;
  }
}
