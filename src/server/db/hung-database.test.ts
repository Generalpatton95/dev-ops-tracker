// T-8 (REQ-1): a database that accepts connections but never answers must make the app's
// queries fail within the pool's timeouts, never hang a request. The "database" here is a local
// socket that says nothing; nothing outside 127.0.0.1 is reached.
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const globalForDb = globalThis as unknown as { dotDb?: { $client: { end(): Promise<void> } } };

const ENV = {
  AUTH_SECRET: "test-secret-not-real-0123456789abcdef",
  AUTH_GITHUB_ID: "test-client-id",
  AUTH_GITHUB_SECRET: "test-client-secret-not-real",
  TRUSTED_IP_HEADER: "x-real-ip",
};

describe("REQ-1: a hung database", () => {
  let silent: Server;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    silent = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as { port: number };
    vi.stubEnv("DATABASE_URL", `postgres://u:hung-pass@127.0.0.1:${port}/hung_test`);
    delete globalForDb.dotDb;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await globalForDb.dotDb?.$client.end().catch(() => {});
    delete globalForDb.dotDb;
    vi.unstubAllEnvs();
    await new Promise((resolve) => silent.close(resolve));
  });

  it("REQ-1: the app's pool gives up on connecting after 2s and on a query after 5s", async () => {
    const { getDb, POOL_TIMEOUTS } = await import("./index");
    expect(POOL_TIMEOUTS).toEqual({ connectionTimeoutMillis: 2_000, query_timeout: 5_000 });
    const options = getDb().$client.options;
    expect(options.connectionTimeoutMillis).toBe(2_000);
    expect(options.query_timeout).toBe(5_000);
  });

  it("REQ-1: a session lookup fails as signed out within the timeout, logging no details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: NextAuth } = await import("next-auth");
    const { NextRequest } = await import("next/server");
    const { getDb } = await import("./index");
    const { buildAuthConfig } = await import("@/server/auth/config");
    const { handlers } = NextAuth(() => buildAuthConfig(ENV, getDb));

    const started = Date.now();
    const res = await handlers.GET(
      new NextRequest("http://localhost:3000/api/auth/session", {
        headers: { cookie: "authjs.session-token=some-token" },
      }),
    );
    expect(await res.json()).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\[auth\] /);
      expect(line).not.toMatch(/hung-pass|127\.0\.0\.1|some-token/);
    }
  }, 10_000);

  it("REQ-1: signed-out tRPC calls then fail closed with a 503 within 2s", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkRateLimit } = await import("@/server/rate-limit");
    const started = Date.now();
    const result = await checkRateLimit({
      bucket: "trpc-public",
      headers: new Headers({ "x-real-ip": "203.0.113.7" }),
      env: ENV,
      cleanup: { lastRunMs: Number.MAX_SAFE_INTEGER },
    });
    expect(result).toEqual({ ok: false, status: 503 });
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);
});
