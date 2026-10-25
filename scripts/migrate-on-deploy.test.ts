import { describe, expect, it } from "vitest";
import { runScript } from "./test-helpers";

// Runs the script with every URL variable blanked (see test-helpers.ts), so it stops before
// drizzle-kit and can never reach a database, whatever the developer's own environment holds.
function run(vercelEnv: string | undefined, vars: Record<string, string> = {}) {
  return runScript("migrate-on-deploy.mjs", {
    ...(vercelEnv === undefined ? {} : { VERCEL_ENV: vercelEnv }),
    ...vars,
  });
}

// Fake credentials. 127.0.0.1 port 1 refuses connections at once, so nothing is ever reached
// and no name is looked up.
const FAKE_USER = "migrateuser";
const FAKE_PASSWORD = "s3cret-pass";
const refusedUrl = `postgres://${FAKE_USER}:${FAKE_PASSWORD}@127.0.0.1:1/dot`;

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

  it("REQ-6: a preview or development build that can't check the preview-base marker fails before drizzle-kit, with a code only", () => {
    for (const vercelEnv of ["preview", "development"]) {
      const result = run(vercelEnv, { DATABASE_URL_UNPOOLED: refusedUrl });
      expect(result.status, vercelEnv).toBe(1);
      expect(result.stderr.trim()).toBe(
        "migrate-on-deploy: could not check that this database is a copy of preview-base " +
          "(ECONNREFUSED); migrations were refused.",
      );
      expect(result.stdout).not.toContain("applying migrations");
      for (const leaked of [FAKE_USER, FAKE_PASSWORD, "127.0.0.1", "://"]) {
        expect(result.stdout + result.stderr).not.toContain(leaked);
      }
    }
  });
});
