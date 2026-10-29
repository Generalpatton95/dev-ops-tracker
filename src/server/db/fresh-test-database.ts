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

// SQLSTATE admin_shutdown: what DROP DATABASE ... WITH (FORCE) sends to the sessions it ends.
const ADMIN_SHUTDOWN = "57P01";
const SESSIONS_GONE_TIMEOUT_MS = 5_000;

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

/**
 * Waits until no session but the caller's own is connected to `name`: a server backend can
 * outlive its client's socket by a moment. Fails, rather than force-dropping live sessions, if
 * one is still there after SESSIONS_GONE_TIMEOUT_MS (that would mean a connection was leaked).
 */
async function waitForNoSessions(admin: pg.Client, name: string): Promise<void> {
  const deadline = Date.now() + SESSIONS_GONE_TIMEOUT_MS;
  for (;;) {
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity " +
        "where datname = $1 and pid <> pg_backend_pid()",
      [name],
    );
    const left = rows[0]?.n ?? 0;
    if (left === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`${left} session(s) still connected to a test database before its drop.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  // Every connection the pool has opened, until its socket has closed. pg-pool's end() resolves
  // as soon as it has asked its clients to close, not once they have, so dropping right after it
  // could reach live sessions, and the drop's 57P01 would land on clients nobody listens to.
  const closing = new Map<pg.Client, Promise<void>>();
  let tearingDown = false;

  const dropAll = async () => {
    tearingDown = true;
    await pool?.end().catch(() => {});
    await Promise.all(closing.values());
    if (created) {
      await waitForNoSessions(admin, name);
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
    pool.on("connect", (client) => {
      const ended = new Promise<void>((resolve) => client.once("end", () => resolve()));
      closing.set(client, ended);
    });
    // Backstop: during teardown, an idle client ended by the drop (57P01) is expected. Any other
    // pool error is a real failure and is rethrown, so it still fails the run.
    pool.on("error", (error: Error & { code?: string }) => {
      if (tearingDown && error.code === ADMIN_SHUTDOWN) return;
      throw error;
    });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: options.migrationsFolder ?? migrationsFolder });
    return { db, url: url.toString(), drop: dropAll };
  } catch (error) {
    // Leave nothing behind when setup fails part-way, then report the original failure.
    await dropAll().catch(() => {});
    throw error;
  }
}
