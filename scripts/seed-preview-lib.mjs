// T-7 (REQ-6): helpers for scripts/seed-preview.mjs, kept apart so tests can import them without
// running the script. Deploy config, not app code (REQ-7): only Vercel preview builds seed.
import { migrationUrl } from "./migrate-on-deploy-lib.mjs";
import { hasPreviewBaseMarker } from "./preview-base-lib.mjs";

/**
 * The fake data a preview database starts with. Nothing here is a real person or account:
 * GitHub ids are positive, so a negative one can never match a real sign-in.
 */
export const SEED = Object.freeze({
  user: Object.freeze({ name: "Demo owner", githubId: -1 }),
  workspace: Object.freeze({ name: "Demo workspace" }),
  // A value of the `role` enum in src/server/db/schema.ts.
  role: "owner",
  project: Object.freeze({ key: "DEMO", name: "Demo project" }),
});

/**
 * Key for pg_advisory_xact_lock, so two builds of the same branch seeding at once take turns
 * and the second one sees the first one's rows. Any constant works; this one is "T7" in ASCII.
 */
export const SEED_LOCK_KEY = 0x5437;

/** Seconds a statement may run (or wait on the lock) before Postgres cancels it. */
export const STATEMENT_TIMEOUT_SECONDS = 20;

/**
 * @typedef {{ action: "seed"; url: string } | { action: "skip"; message: string }} SeedDecision
 */

/**
 * Decides whether this build seeds. Only a Vercel preview build with a database URL does; every
 * other case skips (never fails), so the seed can't break a production or local build.
 * The URL follows the migrate step's rule (DATABASE_URL_UNPOOLED, else DATABASE_URL), so the seed
 * writes to the database that was just migrated. Messages name variables, never their values.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {SeedDecision}
 */
export function decideSeed(env) {
  const vercelEnv = env.VERCEL_ENV?.trim();
  if (vercelEnv !== "preview") {
    const which =
      vercelEnv === "production" || vercelEnv === "development"
        ? `this is a ${vercelEnv} build`
        : "VERCEL_ENV is not preview";
    return {
      action: "skip",
      message: `seed-preview: ${which}; only preview builds are seeded. Skipping.`,
    };
  }
  const url = migrationUrl(env);
  if (!url) {
    return {
      action: "skip",
      message: "seed-preview: no database URL for this preview build; skipping the seed.",
    };
  }
  return { action: "seed", url };
}

/**
 * The seed only writes to a database where both tables are empty, so it never touches one that
 * holds real rows (or the rows of an earlier seed).
 * @param {{ hasUsers: boolean; hasWorkspaces: boolean }} state
 * @returns {boolean}
 */
export function shouldSeed({ hasUsers, hasWorkspaces }) {
  return !hasUsers && !hasWorkspaces;
}

/**
 * @typedef {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }} Queryable
 */

/**
 * @typedef {"seeded" | "has-rows" | "not-preview-base"} SeedOutcome
 */

/**
 * Seeds the database the client is connected to, in one transaction: one user, a workspace they
 * own and one project. Takes a transaction-level advisory lock first, then checks the
 * preview-base marker (the migrate step checked it too; this is defence in depth), then that
 * `user` and `workspace` are both empty, so a concurrent or repeated run inserts nothing.
 * All values go in as parameters. Rolls back and rethrows on any error.
 * @param {Queryable} client a connected pg Client
 * @returns {Promise<{ outcome: SeedOutcome }>}
 */
export async function seedDatabase(client) {
  await client.query("begin");
  try {
    // SET LOCAL lasts until the transaction ends. Set here rather than as connection options,
    // which Neon's pooler would reject.
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT_SECONDS}s'`);
    await client.query(`set local lock_timeout = '${STATEMENT_TIMEOUT_SECONDS}s'`);
    await client.query("select pg_advisory_xact_lock($1)", [SEED_LOCK_KEY]);

    if (!(await hasPreviewBaseMarker(client))) {
      await client.query("rollback");
      return { outcome: "not-preview-base" };
    }

    const { rows } = await client.query(
      'select exists (select 1 from "user") as has_users, ' +
        "exists (select 1 from workspace) as has_workspaces",
    );
    // Anything but an explicit false counts as "has rows", so an odd answer never seeds.
    const state = {
      hasUsers: rows[0]?.has_users !== false,
      hasWorkspaces: rows[0]?.has_workspaces !== false,
    };
    if (!shouldSeed(state)) {
      await client.query("rollback");
      return { outcome: "has-rows" };
    }

    const user = await client.query(
      'insert into "user" (name, github_id, avatar_url, email) values ($1, $2, null, null) ' +
        "returning id",
      [SEED.user.name, SEED.user.githubId],
    );
    const workspace = await client.query(
      "insert into workspace (name, invite_token) values ($1, null) returning id",
      [SEED.workspace.name],
    );
    const userId = user.rows[0].id;
    const workspaceId = workspace.rows[0].id;
    await client.query("insert into membership (user_id, workspace_id, role) values ($1, $2, $3)", [
      userId,
      workspaceId,
      SEED.role,
    ]);
    await client.query("insert into project (workspace_id, key, name) values ($1, $2, $3)", [
      workspaceId,
      SEED.project.key,
      SEED.project.name,
    ]);
    await client.query("commit");
    return { outcome: "seeded" };
  } catch (error) {
    // The original error matters more; a failed rollback (e.g. a dead connection) is ignored,
    // since Postgres rolls back an unfinished transaction when the connection closes.
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
