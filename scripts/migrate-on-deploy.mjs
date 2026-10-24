// T-6 (REQ-5, REQ-6): Vercel's build command runs this after `pnpm run build` succeeds (see
// vercel.json). Deploy config, not app code (REQ-7): other hosts run `pnpm run db:migrate`.
// - production: migrates; fails the deploy when no database URL is set.
// - preview / development: migrates when a URL is set, skips otherwise. Before migrating it
//   connects and checks the preview-base marker (T-7, see preview-base-lib.mjs); a database
//   without it (production's, say) fails the build and nothing is migrated.
// - anything else: fails, since this script only makes sense inside a Vercel build.
// drizzle-kit's output is captured and passed through redact() before printing, and neither the
// environment nor any URL is ever printed. A failed migration exits non-zero, failing the deploy.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  childEnv,
  decideMigration,
  migrationUrl,
  redact,
  secretsFrom,
} from "./migrate-on-deploy-lib.mjs";
import {
  connect,
  errorLabel,
  hasPreviewBaseMarker,
  notPreviewBaseMessage,
} from "./preview-base-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const drizzleKit = join(root, "node_modules", "drizzle-kit", "bin.cjs");
// A migration that hangs (e.g. waiting on a lock) must not hold the build open.
const TIMEOUT_MS = 300_000;

const decision = decideMigration(process.env);
const secrets = secretsFrom(process.env);

/**
 * Whether the database is a copy of preview-base. Prints why not, with an error code at most.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function isPreviewBaseCopy(url) {
  let client;
  try {
    client = await connect(url);
    if (await hasPreviewBaseMarker(client)) return true;
    console.error(
      redact(notPreviewBaseMessage("migrate-on-deploy", "migrations were refused"), secrets),
    );
    return false;
  } catch (error) {
    console.error(
      redact(
        "migrate-on-deploy: could not check that this database is a copy of preview-base " +
          `(${errorLabel(error)}); migrations were refused.`,
        secrets,
      ),
    );
    return false;
  } finally {
    await client?.end().catch(() => {});
  }
}

if (decision.action === "fail") {
  console.error(decision.message);
  process.exitCode = 1;
} else if (decision.action === "skip") {
  console.log(decision.message);
} else if (
  decision.requireMarker &&
  !(await isPreviewBaseCopy(/** @type {string} */ (migrationUrl(process.env))))
) {
  process.exitCode = 1;
} else {
  console.log("migrate-on-deploy: applying migrations with drizzle-kit.");
  const result = spawnSync(process.execPath, [drizzleKit, "migrate"], {
    cwd: root,
    env: childEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(redact(result.stdout, secrets));
  if (result.stderr) process.stderr.write(redact(result.stderr, secrets));

  if (result.error?.code === "ETIMEDOUT") {
    console.error(`migrate-on-deploy: drizzle-kit did not finish within ${TIMEOUT_MS / 1000}s.`);
    process.exitCode = 1;
  } else if (result.error) {
    // Only the error code: the message could carry details from the environment.
    console.error(
      `migrate-on-deploy: could not run drizzle-kit (${result.error.code ?? "error"}).`,
    );
    process.exitCode = 1;
  } else if (result.status !== 0) {
    console.error(
      `migrate-on-deploy: drizzle-kit migrate failed (exit ${result.status ?? result.signal}).`,
    );
    process.exitCode = 1;
  } else {
    console.log("migrate-on-deploy: migrations applied.");
  }
}
