// Test-only helper for the deploy script tests (not a test file itself; vitest picks up
// *.test.ts only). Runs a script in scripts/ with a scrubbed environment, so the developer's own
// variables can never point it at a database.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const BLANKED = ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "TEST_DATABASE_URL"];

/** Dropped: VERCEL_ENV, the URL variables, every PG* (libpq defaults pg reads) and POSTGRES_*. */
function scrubbed(name: string) {
  const upper = name.toUpperCase();
  return (
    upper === "VERCEL_ENV" ||
    BLANKED.includes(upper) ||
    upper.startsWith("PG") ||
    upper.startsWith("POSTGRES_")
  );
}

/**
 * Runs `node scripts/<name>` from the repo root. Every matching variable is removed in any case
 * (Windows ignores case in environment names), the URL variables are then set empty, and only
 * then are `vars` applied.
 */
export function runScript(name: string, vars: Record<string, string> = {}, timeout = 30_000) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (scrubbed(key)) delete env[key];
  }
  for (const urlName of BLANKED) env[urlName] = "";
  Object.assign(env, vars);
  return spawnSync(process.execPath, [join(here, name)], {
    cwd: join(here, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout,
  });
}
