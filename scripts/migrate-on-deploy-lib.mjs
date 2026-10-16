// T-6 (REQ-5, REQ-6): pure helpers for scripts/migrate-on-deploy.mjs, kept apart so tests can
// import them without running the script. Deploy config, not app code (REQ-7).

/** The URL variables drizzle.config.ts reads, in the order it prefers them. */
export const URL_VARIABLES = ["DATABASE_URL_UNPOOLED", "DATABASE_URL"];

/**
 * Same rule as migrationDatabaseUrl in src/server/db/migration-url.ts, which drizzle.config.ts
 * uses to pick the database drizzle-kit connects to: DATABASE_URL_UNPOOLED when non-empty, else
 * DATABASE_URL; empty or blank counts as unset. A .mjs script can't import that .ts file on every
 * Node version we support, so the rule is repeated here and a test checks the two agree.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string | undefined}
 */
export function migrationUrl(env) {
  const unpooled = env.DATABASE_URL_UNPOOLED?.trim();
  if (unpooled) return unpooled;
  const pooled = env.DATABASE_URL?.trim();
  return pooled || undefined;
}

/**
 * @typedef {{ action: "migrate" } | { action: "skip"; message: string } | { action: "fail"; message: string }} Decision
 */

/**
 * Decides what the deploy-time migrate step does. Messages name variables, never their values.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {Decision}
 */
export function decideMigration(env) {
  const vercelEnv = env.VERCEL_ENV?.trim();
  const hasUrl = migrationUrl(env) !== undefined;

  if (vercelEnv === "production") {
    if (hasUrl) return { action: "migrate" };
    return {
      action: "fail",
      message:
        "migrate-on-deploy: this is a production build but neither DATABASE_URL_UNPOOLED nor " +
        "DATABASE_URL is set. Set them in the Vercel project's Production environment.",
    };
  }

  if (vercelEnv === "preview" || vercelEnv === "development") {
    if (hasUrl) return { action: "migrate" };
    return {
      action: "skip",
      message: `migrate-on-deploy: no database URL for this ${vercelEnv} build; skipping migrations.`,
    };
  }

  return {
    action: "fail",
    message:
      "migrate-on-deploy: VERCEL_ENV is missing or not production, preview or development. " +
      "On Vercel this means 'Automatically expose System Environment Variables' is off in the " +
      "project settings; turn it on. This script is for Vercel builds; on other hosts run " +
      "`pnpm run db:migrate` with DATABASE_URL set before starting the new version.",
  };
}

/**
 * The environment drizzle-kit runs with.
 * - TEST_DATABASE_URL is dropped.
 * - Every DOTENV_* variable is dropped. drizzle-kit's bundled dotenv reads DOTENV_CONFIG_OVERRIDE,
 *   DOTENV_CONFIG_PATH, DOTENV_KEY and others from the environment, and could otherwise be told to
 *   load another file or to overwrite variables that are already set.
 * - Both URL variables are always present (empty when unset). With the DOTENV_* variables gone,
 *   dotenv loads only .env and never overwrites a variable that already exists, so a stray .env
 *   can't point the migration somewhere this script didn't check.
 * Names are matched in any case, since Windows treats environment names that way.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {Record<string, string | undefined>}
 */
export function childEnv(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith("DOTENV_") ||
      upper === "TEST_DATABASE_URL" ||
      URL_VARIABLES.includes(upper)
    ) {
      delete out[key];
    }
  }
  for (const name of URL_VARIABLES) out[name] = env[name] ?? "";
  return out;
}

const REDACTED = "[redacted]";

/** @param {string} text */
function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Exact strings to hide from output: each URL variable's value, and the password, user name and
 * host inside it (raw and percent-decoded), so errors like `getaddrinfo ENOTFOUND <host>` or
 * `password authentication failed for user "<user>"` don't show them either.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string[]}
 */
export function secretsFrom(env) {
  const secrets = new Set();
  for (const name of URL_VARIABLES) {
    const value = env[name]?.trim();
    if (!value) continue;
    secrets.add(value);
    let url;
    try {
      url = new URL(value);
    } catch {
      continue; // Not a parseable URL: the whole value is already hidden.
    }
    for (const part of [url.password, url.username, url.hostname]) {
      if (!part) continue;
      secrets.add(part);
      secrets.add(decoded(part));
    }
  }
  // Longest first, so a URL is hidden whole before the password inside it.
  return [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

/**
 * Hides connection strings and passwords in text before it is printed.
 * - the exact secrets given (see secretsFrom);
 * - any postgres:// or postgresql:// URL, whole;
 * - the user:password part of any other URL;
 * - password=…, password: …, "password": "…" and similar (also passwd, pwd, PGPASSWORD).
 * @param {string} text
 * @param {readonly string[]} [secrets]
 * @returns {string}
 */
export function redact(text, secrets = []) {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out
    .replace(/\bpostgres(?:ql)?:\/\/[^\s'"`<>]+/gi, `postgres://${REDACTED}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"`<>]+@/gi, `$1${REDACTED}@`)
    .replace(
      /([\w-]*(?:password|passwd|pwd))(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}'"]+)/gi,
      `$1$2${REDACTED}`,
    );
}
