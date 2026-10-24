import { describe, expect, it } from "vitest";
import { runScript } from "./test-helpers";

// Fake credentials. 127.0.0.1 port 1 refuses connections at once, so nothing is ever reached
// and no name is looked up.
const FAKE_USER = "seeduser";
const FAKE_PASSWORD = "s3cret-pass";
const refusedUrl = `postgres://${FAKE_USER}:${FAKE_PASSWORD}@127.0.0.1:1/dot`;

// Every URL variable is blanked first (see test-helpers.ts), so the developer's own environment
// can never point the script at a database.
const run = (vars: Record<string, string>) => runScript("seed-preview.mjs", vars);

function expectNoSecrets(output: string) {
  for (const leaked of [FAKE_USER, FAKE_PASSWORD, "127.0.0.1", "://"]) {
    expect(output).not.toContain(leaked);
  }
}

describe("seed-preview script", () => {
  it("REQ-6: a preview build with no database URL skips and exits 0", () => {
    const result = run({ VERCEL_ENV: "preview" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "seed-preview: no database URL for this preview build; skipping the seed.",
    );
    expect(result.stderr).toBe("");
  });

  it("REQ-6: a production build skips and exits 0 even with database URLs set, without connecting", () => {
    // Connecting would fail (the URL refuses), so exit 0 also shows no connection was tried.
    const result = run({
      VERCEL_ENV: "production",
      DATABASE_URL: refusedUrl,
      DATABASE_URL_UNPOOLED: refusedUrl,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "seed-preview: this is a production build; only preview builds are seeded. Skipping.",
    );
    expect(result.stderr).toBe("");
  });

  it("REQ-6: outside a Vercel build (VERCEL_ENV unset) it skips and exits 0", () => {
    const result = run({ DATABASE_URL: refusedUrl });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "seed-preview: VERCEL_ENV is not preview; only preview builds are seeded. Skipping.",
    );
  });

  it("REQ-6: a failed connection exits 1 with the error code only, never the URL, user or password", () => {
    const result = run({ VERCEL_ENV: "preview", DATABASE_URL_UNPOOLED: refusedUrl });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("seed-preview: failed (ECONNREFUSED).");
    expectNoSecrets(result.stdout + result.stderr);
  });

  it("REQ-6: a malformed URL exits 1 naming only the error code", () => {
    const result = run({
      VERCEL_ENV: "preview",
      DATABASE_URL: `postgres://${FAKE_USER}:${FAKE_PASSWORD}@[bad/dot`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("seed-preview: failed (ERR_INVALID_URL).");
    expectNoSecrets(result.stdout + result.stderr);
  });
});
