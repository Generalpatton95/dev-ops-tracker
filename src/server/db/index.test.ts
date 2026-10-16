import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "server-only" throws outside Next's server bundles; Vitest isn't one.
vi.mock("server-only", () => ({}));

const globalForDb = globalThis as unknown as { dotDb?: unknown };

describe("getDb", () => {
  beforeEach(() => {
    vi.resetModules();
    delete globalForDb.dotDb;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const db = globalForDb.dotDb as { $client?: { end(): Promise<void> } } | undefined;
    await db?.$client?.end();
    delete globalForDb.dotDb;
  });

  it("REQ-7: importing the client needs no DATABASE_URL and opens no connection", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { getDb } = await import("./index");
    expect(globalForDb.dotDb).toBeUndefined();
    expect(() => getDb()).toThrow("DATABASE_URL is not set");
  });

  it("REQ-7: reads only DATABASE_URL and creates the client once, without connecting", async () => {
    // Port 1 on loopback: nothing listens there, so any connect attempt would fail the test.
    vi.stubEnv("DATABASE_URL", "postgres://u:p@127.0.0.1:1/never_used");
    const { getDb } = await import("./index");
    const db = getDb();
    expect(getDb()).toBe(db);
    expect(db.$client.totalCount).toBe(0);
  });
});
