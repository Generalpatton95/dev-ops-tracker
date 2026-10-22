import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "migrate-on-deploy.mjs");

const BLANKED = ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "TEST_DATABASE_URL"];

// Runs the script with every URL variable blanked (any case, since Windows ignores case in
// environment names), so it stops before drizzle-kit and can never reach a database, whatever
// the developer's own environment holds.
function run(vercelEnv: string | undefined) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === "VERCEL_ENV" || BLANKED.includes(upper)) delete env[key];
  }
  for (const name of BLANKED) env[name] = "";
  if (vercelEnv !== undefined) env.VERCEL_ENV = vercelEnv;
  return spawnSync(process.execPath, [script], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("migrate-on-deploy script", () => {
  it("REQ-7: exits non-zero outside a Vercel build", () => {
    const result = run(undefined);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm run db:migrate");
    expect(result.stderr).toContain("Automatically expose System Environment Variables");
  });

  it("REQ-6: a production build with no database URL fails before drizzle-kit, naming variables only", () => {
    const result = run("production");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL_UNPOOLED");
    expect(result.stderr).toMatch(/\bDATABASE_URL\b/);
    expect(result.stderr).not.toContain("://");
    expect(result.stdout).not.toContain("applying migrations");
  });

  it("REQ-6: a preview build with no database URL skips and exits 0", () => {
    const result = run("preview");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "migrate-on-deploy: no database URL for this preview build; skipping migrations.",
    );
  });
});
