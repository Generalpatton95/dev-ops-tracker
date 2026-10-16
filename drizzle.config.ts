// T-5 (REQ-5): drizzle-kit settings. `generate` and `check` work offline; only `migrate`
// connects, using DATABASE_URL_UNPOOLED when set, else DATABASE_URL.
import { defineConfig } from "drizzle-kit";
import { migrationDatabaseUrl } from "./src/server/db/migration-url";

const url = migrationDatabaseUrl(process.env);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  // Left out when no URL is set, so `drizzle-kit migrate` fails instead of guessing.
  ...(url ? { dbCredentials: { url } } : {}),
  strict: true,
  verbose: true,
});
