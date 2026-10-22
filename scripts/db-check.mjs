// T-5 (REQ-5): fails when src/server/db/schema.ts and the committed migrations in drizzle/ differ.
// 1. `drizzle-kit check` validates the committed migration history.
// 2. `drizzle-kit generate` runs against a temporary copy of drizzle/; if it writes anything,
//    the schema has changes no migration covers.
// Works offline: no database URL is passed to drizzle-kit, and the repo is never modified.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// drizzle-kit resolves --out against the working directory, so paths passed to it are relative.
const migrations = join(root, "drizzle");
const cacheDir = join(root, "node_modules", ".cache");
const schema = "./src/server/db/schema.ts";
const drizzleKit = join(root, "node_modules", "drizzle-kit", "bin.cjs");
// drizzle-kit can wait on an interactive prompt (e.g. "was this column renamed?"); never hang CI.
const TIMEOUT_MS = 120_000;

// drizzle-kit gets no database URL, so these offline commands can never reach a database.
const env = { ...process.env };
for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "TEST_DATABASE_URL"]) {
  delete env[name];
}

class CheckFailed extends Error {}

function drizzleKitRun(args) {
  const result = spawnSync(process.execPath, [drizzleKit, ...args], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new CheckFailed(
      `drizzle-kit ${args[0]} did not finish within ${TIMEOUT_MS / 1000}s ` +
        "(it may be waiting for an answer, e.g. about a renamed column). " +
        "Run `pnpm run db:generate` in a terminal and commit the migration.",
    );
  }
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new CheckFailed(`drizzle-kit ${args[0]} failed.`);
  }
  return result.stdout;
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

// Returns the migration files `generate` would add or change; empty when everything matches.
function pendingMigrationFiles() {
  // Scratch copy under node_modules/.cache, which git, Prettier and ESLint all ignore.
  mkdirSync(cacheDir, { recursive: true });
  const scratch = mkdtempSync(join(cacheDir, "dot-db-check-"));
  try {
    const copy = join(scratch, "drizzle");
    cpSync(migrations, copy, { recursive: true });
    drizzleKitRun([
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      schema,
      "--out",
      relative(root, copy).replaceAll("\\", "/"),
    ]);
    const before = listFiles(migrations);
    const after = listFiles(copy);
    const changed = after.filter(
      (file) =>
        !before.includes(file) ||
        !readFileSync(join(copy, file)).equals(readFileSync(join(migrations, file))),
    );
    const removed = before.filter((file) => !after.includes(file));
    return [...changed, ...removed];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  drizzleKitRun(["check", "--dialect", "postgresql", "--out", "drizzle"]);
  const pending = pendingMigrationFiles();
  if (pending.length > 0) {
    console.error(
      "db:check: the schema has changes with no migration. Run `pnpm run db:generate`.",
    );
    for (const file of pending) console.error(`  would write drizzle/${file}`);
    process.exitCode = 1;
  } else {
    console.log("db:check: schema and migrations match.");
  }
} catch (error) {
  if (!(error instanceof CheckFailed)) throw error;
  console.error(`db:check: ${error.message}`);
  process.exitCode = 1;
}
