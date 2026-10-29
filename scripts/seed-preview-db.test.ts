// T-7 (REQ-6): the preview migrate and seed steps, the preview-base marker and the
// preview-base emptying script, against a real Postgres.
// - Runs only when TEST_DATABASE_URL is set (database name ending in _test); CI sets it and
//   fails if it's missing.
// - Needs CREATEDB (or superuser) for TEST_DATABASE_URL's role: every test works in its own new
//   database on that server, created here and dropped afterwards, so nothing races
//   schema.test.ts, which wipes the shared test database. Without CREATEDB the tests are
//   skipped with a message locally, and fail in CI.
// - TABLES below is written out on purpose rather than read from the schema: a new table
//   should make someone look at the seed and at what "exactly the demo rows" means.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTestDatabaseName, resolveTestDatabase } from "../src/server/db/test-database";
import { PREVIEW_BASE_MARKER, notPreviewBaseMessage } from "./preview-base-lib.mjs";
import { SEED_LOCK_KEY, seedDatabase } from "./seed-preview-lib.mjs";
import { runScript } from "./test-helpers";

const target = resolveTestDatabase(process.env);

/** Whether TEST_DATABASE_URL's role may create databases, and whether it is a superuser. */
async function rolePowers(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ createdb: boolean; superuser: boolean }>(
      "select rolcreatedb or rolsuper as createdb, rolsuper as superuser " +
        "from pg_roles where rolname = current_user",
    );
    return rows[0] ?? { createdb: false, superuser: false };
  } finally {
    await client.end();
  }
}

let skipReason = target.run ? undefined : target.reason;
const powers = target.run ? await rolePowers(target.url) : { createdb: false, superuser: false };
if (target.run && !powers.createdb) {
  const reason =
    "TEST_DATABASE_URL's role lacks CREATEDB, which the preview database tests need to make " +
    "their own throwaway databases";
  if (process.env.CI) throw new Error(`${reason}. CI runs them, so this fails.`);
  skipReason = `${reason}, so they are skipped. CI runs them.`;
}
if (skipReason) console.warn(`[seed-preview-db.test] ${skipReason}`);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "drizzle");
const emptyPreviewBaseSql = readFileSync(join(here, "empty-preview-base.sql"), "utf8");

const TABLES = [
  "account",
  "activity",
  "cycle",
  "membership",
  "project",
  "rate_limit",
  "requirement",
  "requirement_version",
  "session",
  "spec",
  "task",
  "task_link",
  "user",
  "verification_token",
  "workspace",
];

const SCRIPT_TIMEOUT_MS = 120_000;
const migrateScript = (url: string, vercelEnv = "preview") =>
  runScript(
    "migrate-on-deploy.mjs",
    { VERCEL_ENV: vercelEnv, DATABASE_URL: url },
    SCRIPT_TIMEOUT_MS,
  );
const seedScript = (url: string, vercelEnv = "preview") =>
  runScript("seed-preview.mjs", { VERCEL_ENV: vercelEnv, DATABASE_URL: url }, SCRIPT_TIMEOUT_MS);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(skipReason !== undefined)("REQ-6: preview databases in Postgres", () => {
  let admin: pg.Client;
  let password = "";
  const created: string[] = [];
  const clients: pg.Client[] = [];
  let counter = 0;

  beforeAll(async () => {
    if (!target.run) return;
    password = decodeURIComponent(new URL(target.url).password);
    admin = new pg.Client({ connectionString: target.url });
    await admin.connect();
    // Second guard, on the database we actually reached, before anything is created.
    const { rows } = await admin.query<{ name: string }>("select current_database() as name");
    if (!isTestDatabaseName(rows[0]?.name ?? "")) {
      throw new Error('Refusing to run: the connected database name does not end in "_test".');
    }
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
    for (const name of created) {
      await admin.query(`drop database if exists ${admin.escapeIdentifier(name)} with (force)`);
    }
    await admin?.end();
  });

  async function newClient(url: string) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function mark(client: pg.Client) {
    // A constant, not input; COMMENT takes no parameters.
    await client.query(`comment on schema public is '${PREVIEW_BASE_MARKER}'`);
  }

  /**
   * A new, empty database on the test server; its name ends in _test too. `marked` gives it the
   * preview-base marker, as every real preview branch inherits.
   */
  async function freshDatabase(marked = true) {
    const name = `dot_t7_${process.pid}_${Date.now()}_${counter++}_test`;
    await admin.query(`create database ${admin.escapeIdentifier(name)}`);
    created.push(name);
    const url = new URL(target.run ? target.url : "");
    url.pathname = `/${name}`;
    const client = await newClient(url.toString());
    if (marked) await mark(client);
    return { url: url.toString(), client };
  }

  async function migrated(marked = true) {
    const database = await freshDatabase(marked);
    await migrate(drizzle(database.client), { migrationsFolder });
    return database;
  }

  async function counts(client: pg.Client) {
    const out: Record<string, number> = {};
    for (const table of TABLES) {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from ${client.escapeIdentifier(table)}`,
      );
      out[table] = rows[0].n;
    }
    return out;
  }

  const only = (rows: Record<string, number>) =>
    Object.fromEntries(TABLES.map((table) => [table, rows[table] ?? 0]));

  const DEMO_ROWS = only({ user: 1, workspace: 1, membership: 1, project: 1 });

  async function publicTables(client: pg.Client) {
    const { rows } = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    return rows.map((row) => row.tablename);
  }

  async function migrationRows(client: pg.Client) {
    const { rows } = await client.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    return rows[0].n;
  }

  /** The public schema's owner, grants and comment (the marker). */
  async function publicSchema(client: pg.Client) {
    const { rows } = await client.query<{ owner: string; acl: string | null; marker: string }>(`
      select nspowner::regrole::text as owner, nspacl::text as acl,
             obj_description(oid, 'pg_namespace') as marker
      from pg_namespace where nspname = 'public'
    `);
    return rows[0];
  }

  /**
   * Every relation (tables, indexes, sequences, views…) and type in public that doesn't belong
   * to an extension. Deliberately broader than the script's own filters: a type counts as an
   * extension's when it, its relation (a view's row type) or its element type (an array) does.
   */
  async function ownObjectsInPublic(client: pg.Client) {
    const { rows } = await client.query<{ object: string }>(`
      with ext_rel as (
        select objid from pg_depend where classid = 'pg_class'::regclass and deptype = 'e'
      ), ext_type as (
        select t.oid from pg_type t
        where t.oid in (select objid from pg_depend
                        where classid = 'pg_type'::regclass and deptype = 'e')
           or t.typrelid in (select objid from ext_rel)
      )
      select c.relkind::text || ' ' || c.relname as object
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.oid not in (select objid from ext_rel)
      union all
      select 'type ' || t.typname
      from pg_type t
      where t.typnamespace = 'public'::regnamespace
        and t.oid not in (select oid from ext_type)
        and t.typelem not in (select oid from ext_type)
      order by 1
    `);
    return rows.map((row) => row.object);
  }

  async function hasDrizzleSchema(client: pg.Client) {
    const { rows } = await client.query("select to_regnamespace('drizzle') is not null as found");
    return rows[0].found as boolean;
  }

  // ---------- Migrate and seed ----------

  it("REQ-6: the build's migrate then seed steps fill an empty marked preview database with exactly the demo rows", async () => {
    const { url, client } = await freshDatabase();

    const migrateRun = migrateScript(url);
    expect(migrateRun.status, migrateRun.stderr).toBe(0);
    const seedRun = seedScript(url);
    expect(seedRun.status, seedRun.stderr).toBe(0);
    expect(seedRun.stdout.trim()).toBe("seed-preview: added the demo user, workspace and project.");
    for (const output of [migrateRun.stdout, migrateRun.stderr, seedRun.stdout, seedRun.stderr]) {
      expect(output).not.toContain(url);
      if (password.length >= 4) expect(output).not.toContain(password);
    }

    expect(await counts(client)).toEqual(DEMO_ROWS);
    const { rows } = await client.query(`
      select u.name as user_name, u.github_id, u.avatar_url, u.email, u.email_verified,
             w.name as workspace_name, w.invite_token, m.role,
             p.key, p.name as project_name, p.workspace_id = w.id as project_in_workspace,
             p.archived_at
      from membership m
      join "user" u on u.id = m.user_id
      join workspace w on w.id = m.workspace_id
      join project p on p.workspace_id = w.id
    `);
    expect(rows).toEqual([
      {
        user_name: "Demo owner",
        github_id: "-1",
        avatar_url: null,
        email: null,
        email_verified: null,
        workspace_name: "Demo workspace",
        invite_token: null,
        role: "owner",
        key: "DEMO",
        project_name: "Demo project",
        project_in_workspace: true,
        archived_at: null,
      },
    ]);
  }, 120_000);

  it("REQ-6: preview and development builds refuse to migrate a database without the preview-base marker", async () => {
    for (const vercelEnv of ["preview", "development"]) {
      const { url, client } = await freshDatabase(false);
      const result = migrateScript(url, vercelEnv);
      expect(result.status, vercelEnv).toBe(1);
      expect(result.stderr.trim()).toBe(
        notPreviewBaseMessage("migrate-on-deploy", "migrations were refused"),
      );
      expect(result.stdout).not.toContain("applying migrations");
      expect(result.stdout + result.stderr).not.toContain(url);
      expect(await publicTables(client)).toEqual([]);
      expect(await hasDrizzleSchema(client)).toBe(false);
    }
  }, 60_000);

  it("REQ-6: the seed refuses a database without the preview-base marker and adds no rows", async () => {
    const { url, client } = await migrated(false);
    const result = seedScript(url);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(notPreviewBaseMessage("seed-preview", "nothing was seeded"));
    expect(result.stdout + result.stderr).not.toContain(url);
    expect(await counts(client)).toEqual(only({}));
  }, 60_000);

  it("REQ-6: a production build migrates without looking at the marker, with or without it, and never seeds", async () => {
    for (const marked of [true, false]) {
      const { url, client } = await freshDatabase(marked);
      const result = migrateScript(url, "production");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("migrations applied");
      expect(await publicTables(client)).toEqual(TABLES);
      expect(seedScript(url, "production").status).toBe(0);
      expect(await counts(client)).toEqual(only({}));
    }
  }, 120_000);

  it("REQ-6: a second seed run inserts nothing", async () => {
    const { url, client } = await migrated();
    expect(seedScript(url).status).toBe(0);
    const before = await client.query('select id from "user"');

    const again = seedScript(url);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout.trim()).toBe(
      "seed-preview: the user or workspace table already has rows; nothing changed.",
    );
    expect(await counts(client)).toEqual(DEMO_ROWS);
    expect((await client.query('select id from "user"')).rows).toEqual(before.rows);
  }, 60_000);

  it("REQ-6: a database with an existing user is not touched", async () => {
    const { url, client } = await migrated();
    await client.query(`insert into "user" (name, github_id) values ('Real person', 4242)`);

    const result = seedScript(url);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("already has rows; nothing changed");
    expect(await counts(client)).toEqual(only({ user: 1 }));
    const { rows } = await client.query('select name, github_id from "user"');
    expect(rows).toEqual([{ name: "Real person", github_id: "4242" }]);
  }, 60_000);

  it("REQ-6: a database with an existing workspace is not touched", async () => {
    const { url, client } = await migrated();
    await client.query(`insert into workspace (name) values ('Real workspace')`);

    const result = seedScript(url);
    expect(result.status, result.stderr).toBe(0);
    expect(await counts(client)).toEqual(only({ workspace: 1 }));
  }, 60_000);

  it("REQ-6: two seeds waiting on the lock at once add the demo rows only once", async () => {
    const { url, client } = await migrated();
    const second = await newClient(url);
    const holder = await newClient(url);

    // Hold the seed's lock so both seeds are certainly inside their transactions, waiting,
    // before either can check the tables.
    await holder.query("select pg_advisory_lock($1)", [SEED_LOCK_KEY]);
    const runs = Promise.all([seedDatabase(client), seedDatabase(second)]);
    try {
      let waiting = 0;
      for (let i = 0; i < 200 && waiting < 2; i++) {
        const { rows } = await holder.query<{ n: number }>(`
          select count(*)::int as n from pg_locks
          where locktype = 'advisory' and not granted
            and database = (select oid from pg_database where datname = current_database())
        `);
        waiting = rows[0].n;
        if (waiting < 2) await sleep(50);
      }
      expect(waiting).toBe(2);
    } finally {
      await holder.query("select pg_advisory_unlock($1)", [SEED_LOCK_KEY]);
    }

    const results = await runs;
    expect(results.map((result) => result.outcome).sort()).toEqual(["has-rows", "seeded"]);
    expect(await counts(client)).toEqual(DEMO_ROWS);
  }, 60_000);

  it("REQ-6: a failed seed exits 1 with a code only and leaves nothing behind", async () => {
    const { url, client } = await migrated();
    // The project insert, the last one, now fails, after the user and workspace went in.
    await client.query("drop table project cascade");

    const result = seedScript(url);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("seed-preview: failed (42P01).");
    expect(result.stdout + result.stderr).not.toContain(url);
    const left = await client.query<{ users: number; workspaces: number; memberships: number }>(`
      select (select count(*)::int from "user") as users,
             (select count(*)::int from workspace) as workspaces,
             (select count(*)::int from membership) as memberships
    `);
    expect(left.rows).toEqual([{ users: 0, workspaces: 0, memberships: 0 }]);
  }, 60_000);

  it("REQ-6: production and development builds never seed, even with a URL to an empty marked database", async () => {
    const { url, client } = await migrated();
    for (const vercelEnv of ["production", "development", ""]) {
      const result = seedScript(url, vercelEnv);
      expect(result.status, vercelEnv).toBe(0);
      expect(result.stdout).toContain("only preview builds are seeded");
    }
    expect(await counts(client)).toEqual(only({}));
  }, 60_000);

  // ---------- empty-preview-base.sql ----------

  async function runEmptyScript(client: pg.Client) {
    return client.query(emptyPreviewBaseSql).then(
      () => undefined,
      (error: unknown) => error as { message?: string },
    );
  }

  it("REQ-6: empty-preview-base.sql stops at the guard on a database with migration history, like main, and changes nothing", async () => {
    const { client } = await migrated(false);
    await client.query(`insert into "user" (name, github_id) values ('Real person', 4242)`);
    const history = await migrationRows(client);
    expect(history).toBeGreaterThan(0);
    const schemaBefore = await publicSchema(client);
    const objectsBefore = await ownObjectsInPublic(client);

    const error = await runEmptyScript(client);
    expect(error?.message).toBe(
      "migration history found: this is not the schema-only preview-base branch; nothing was changed",
    );
    expect(await publicTables(client)).toEqual(TABLES);
    expect(await ownObjectsInPublic(client)).toEqual(objectsBefore);
    expect(await migrationRows(client)).toBe(history);
    expect(await counts(client)).toEqual(only({ user: 1 }));
    // In particular, main never gets the marker.
    expect(await publicSchema(client)).toEqual(schemaBefore);
    expect(schemaBefore.marker).not.toBe(PREVIEW_BASE_MARKER);
  }, 60_000);

  it("REQ-6: empty-preview-base.sql stops when public.user or public.workspace has rows, even with no migration history", async () => {
    for (const [insert, message] of [
      [
        `insert into "user" (name, github_id) values ('Real person', 4242)`,
        'rows found in public."user": this is not the schema-only preview-base branch; nothing was changed',
      ],
      [
        `insert into workspace (name) values ('Real workspace')`,
        "rows found in public.workspace: this is not the schema-only preview-base branch; nothing was changed",
      ],
    ]) {
      const { client } = await migrated(false);
      await client.query("drop schema drizzle cascade");
      await client.query(insert);

      const error = await runEmptyScript(client);
      expect(error?.message).toBe(message);
      expect(await publicTables(client)).toEqual(TABLES);
      expect((await publicSchema(client)).marker).not.toBe(PREVIEW_BASE_MARKER);
    }
  }, 60_000);

  it("REQ-6: empty-preview-base.sql stops when any other table has rows", async () => {
    const { client } = await migrated(false);
    await client.query("delete from drizzle.__drizzle_migrations");
    await client.query(
      "insert into verification_token (identifier, token, expires) values ('x', 'y', now())",
    );

    const error = await runEmptyScript(client);
    expect(error?.message).toBe(
      "rows found in public.verification_token: this is not the schema-only preview-base branch; nothing was changed",
    );
    expect(await publicTables(client)).toEqual(TABLES);
    expect(await hasDrizzleSchema(client)).toBe(true);
    expect((await publicSchema(client)).marker).not.toBe(PREVIEW_BASE_MARKER);
  }, 60_000);

  it("REQ-6: on a schema-only copy, empty-preview-base.sql leaves nothing of ours in public, keeps the schema's owner and grants, marks it, and a preview then migrates and seeds", async () => {
    // Two shapes of schema-only copy: the migrations table there but empty, or not there at all.
    for (const strip of [
      "delete from drizzle.__drizzle_migrations",
      "drop schema drizzle cascade",
    ]) {
      const { url, client } = await migrated(false);
      await client.query(strip);
      const before = await publicSchema(client);
      expect(before.marker).not.toBe(PREVIEW_BASE_MARKER);

      expect(await runEmptyScript(client)).toBeUndefined();
      // No tables, indexes, sequences, views or types (the six enums included) are left.
      expect(await ownObjectsInPublic(client)).toEqual([]);
      expect(await hasDrizzleSchema(client)).toBe(false);
      expect(await publicSchema(client)).toEqual({ ...before, marker: PREVIEW_BASE_MARKER });

      // A second run changes nothing and doesn't fail.
      expect(await runEmptyScript(client)).toBeUndefined();
      expect(await ownObjectsInPublic(client)).toEqual([]);
      expect(await publicSchema(client)).toEqual({ ...before, marker: PREVIEW_BASE_MARKER });

      // What a preview build does next, on a branch that inherits the marker.
      const migrateRun = migrateScript(url);
      expect(migrateRun.status, migrateRun.stderr).toBe(0);
      expect(seedScript(url).status).toBe(0);
      expect(await counts(client)).toEqual(DEMO_ROWS);
    }
  }, 180_000);

  it("REQ-6: empty-preview-base.sql drops our own views, sequences, domains and composite types but keeps extensions' objects", async () => {
    const { client } = await migrated(false);
    await client.query("drop schema drizzle cascade");
    // cube and earthdistance are trusted extensions; earthdistance adds the domain "earth" to
    // public. pg_buffercache adds a view to public but needs a superuser.
    await client.query("create extension cube schema public");
    await client.query("create extension earthdistance schema public");
    if (powers.superuser) await client.query("create extension pg_buffercache schema public");
    await client.query(`
      create view public.demo_view as select id from public.workspace;
      create materialized view public.demo_matview as select id from public.workspace;
      create sequence public.demo_seq;
      create domain public.demo_domain as text;
      create type public.demo_composite as (a int, b text);
      create type public.demo_range as range (subtype = int8);
    `);

    expect(await runEmptyScript(client)).toBeUndefined();
    expect(await ownObjectsInPublic(client)).toEqual([]);
    const { rows } = await client.query<{ extname: string }>(
      "select extname from pg_extension where extname <> 'plpgsql' order by extname",
    );
    expect(rows.map((row) => row.extname)).toEqual(
      powers.superuser ? ["cube", "earthdistance", "pg_buffercache"] : ["cube", "earthdistance"],
    );
    const kept = await client.query(`
      select to_regtype('public.earth') is not null as earth,
             to_regtype('public.cube') is not null as cube,
             to_regclass('public.pg_buffercache') is not null as buffercache
    `);
    expect(kept.rows[0]).toEqual({ earth: true, cube: true, buffercache: powers.superuser });
    expect((await publicSchema(client)).marker).toBe(PREVIEW_BASE_MARKER);
  }, 60_000);
});
