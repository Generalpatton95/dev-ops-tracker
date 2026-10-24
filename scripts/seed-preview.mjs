// T-7 (REQ-6): Vercel's build command runs this after the migrate step (see vercel.json).
// Deploy config, not app code (REQ-7).
// - preview with a database URL: adds fake data (one user, a workspace they own, one project) in
//   one transaction, only when the database has the preview-base marker and the `user` and
//   `workspace` tables are both empty. A database without the marker fails the build.
// - anything else, production included: logs a one-line skip and exits 0.
// Output never shows a connection string, host, user or password: errors print a code or class
// name only, and every line goes through redact(). A failed seed exits 1, failing that preview.
import { redact, secretsFrom } from "./migrate-on-deploy-lib.mjs";
import { connect, errorLabel, notPreviewBaseMessage } from "./preview-base-lib.mjs";
import { decideSeed, seedDatabase } from "./seed-preview-lib.mjs";

// Connect and each query are capped in preview-base-lib.mjs; this caps the whole run.
const RUN_TIMEOUT_MS = 90_000;

const secrets = secretsFrom(process.env);
/** @param {string} line */
const log = (line) => console.log(redact(line, secrets));
/** @param {string} line */
const fail = (line) => {
  console.error(redact(line, secrets));
  process.exitCode = 1;
};

async function main() {
  const decision = decideSeed(process.env);
  if (decision.action === "skip") {
    log(decision.message);
    return;
  }

  const deadline = setTimeout(() => {
    fail(`seed-preview: did not finish within ${RUN_TIMEOUT_MS / 1000}s.`);
    process.exit(1);
  }, RUN_TIMEOUT_MS);
  deadline.unref();

  /** @type {Awaited<ReturnType<typeof connect>> | undefined} */
  let client;
  try {
    client = await connect(decision.url);
    const { outcome } = await seedDatabase(client);
    if (outcome === "seeded") {
      log("seed-preview: added the demo user, workspace and project.");
    } else if (outcome === "has-rows") {
      log("seed-preview: the user or workspace table already has rows; nothing changed.");
    } else {
      fail(notPreviewBaseMessage("seed-preview", "nothing was seeded"));
    }
  } catch (error) {
    fail(`seed-preview: failed (${errorLabel(error)}).`);
  } finally {
    await client?.end().catch(() => {});
    clearTimeout(deadline);
  }
}

await main();
