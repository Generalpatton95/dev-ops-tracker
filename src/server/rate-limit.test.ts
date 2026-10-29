// T-8 (REQ-1): the Postgres rate limiter. Unit tests need no database: failures use a local port
// nothing listens on, and a local server that accepts connections but never answers. The
// counting tests run in a database of their own on TEST_DATABASE_URL and skip without it.
import { createServer, type Server, type Socket } from "node:net";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db";
import {
  createFreshDatabase,
  freshDatabaseSkipReason,
  type FreshDatabase,
} from "@/server/db/fresh-test-database";
import * as schema from "@/server/db/schema";

vi.mock("server-only", () => ({}));

const {
  CLEANUP_INTERVAL_MS,
  RATE_LIMITS,
  checkRateLimit,
  clientIp,
  rateLimitKey,
  rateLimitResponse,
} = await import("./rate-limit");

const SECRET = "test-secret-not-real-0123456789abcdef";
const VERCEL_ENV = { AUTH_SECRET: SECRET, TRUSTED_IP_HEADER: "x-real-ip" };
const fromIp = (ip: string) => new Headers({ "x-real-ip": ip });
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Stands in for the database's clock in the counting tests: 5 seconds into a minute.
const T0 = Date.UTC(2026, 9, 25, 12, 0, 5);
// An instance that cleaned up "just now", so no clean-up is scheduled.
const noCleanup = () => ({ lastRunMs: Number.MAX_SAFE_INTEGER });

afterEach(() => vi.restoreAllMocks());

function poolDb(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  return drizzle(pool, { schema });
}

describe("REQ-1: rate-limit keys and caller IPs", () => {
  it("REQ-1: the IP comes only from the header named in TRUSTED_IP_HEADER", () => {
    const headers = new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" });
    expect(clientIp(headers, { TRUSTED_IP_HEADER: "x-real-ip" })).toBe("203.0.113.7");
    expect(clientIp(headers, { TRUSTED_IP_HEADER: "x-forwarded-for" })).toBe("198.51.100.1");
  });

  it("REQ-1: with no TRUSTED_IP_HEADER, no caller has an IP, so everyone shares one bucket", () => {
    const a = new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7" });
    const b = new Headers({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.1" });
    const env = { AUTH_SECRET: SECRET };
    expect(clientIp(a, env)).toBeNull();
    expect(clientIp(b, { ...env, TRUSTED_IP_HEADER: " " })).toBeNull();
    expect(rateLimitKey("auth", clientIp(a, env), env)).toBe(
      rateLimitKey("auth", clientIp(b, env), env),
    );
  });

  it("REQ-1: a header value that isn't one plain IP counts as no IP (the shared bucket)", () => {
    for (const value of [
      "",
      "not-an-ip",
      "203.0.113.7, 198.51.100.1",
      "1.2.3.4:80",
      "x".repeat(70),
    ]) {
      expect(clientIp(fromIp(value), VERCEL_ENV), value).toBeNull();
    }
    expect(clientIp(fromIp(" 203.0.113.7 "), VERCEL_ENV)).toBe("203.0.113.7");
    expect(clientIp(new Headers(), VERCEL_ENV)).toBeNull();
    expect(clientIp(fromIp("1.2.3.4"), { TRUSTED_IP_HEADER: "bad header name" })).toBeNull();
  });

  it("REQ-1: IPv6 callers are grouped by /64, and IPv4-mapped addresses count as IPv4", () => {
    expect(clientIp(fromIp("2001:db8:1:2:3:4:5:6"), VERCEL_ENV)).toBe("2001:db8:1:2::/64");
    expect(clientIp(fromIp("2001:DB8:1:2::ffff"), VERCEL_ENV)).toBe("2001:db8:1:2::/64");
    expect(clientIp(fromIp("2001:db8::1"), VERCEL_ENV)).toBe("2001:db8:0:0::/64");
    expect(clientIp(fromIp("::1"), VERCEL_ENV)).toBe("0:0:0:0::/64");
    expect(clientIp(fromIp("::ffff:203.0.113.7"), VERCEL_ENV)).toBe("203.0.113.7");
  });

  it("REQ-1: the key is an HMAC of bucket and IP, not the IP or a plain hash of it", async () => {
    const { createHash } = await import("node:crypto");
    const key = rateLimitKey("auth", "203.0.113.7", VERCEL_ENV);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("203");
    for (const plain of ["203.0.113.7", "auth\nip:203.0.113.7", "auth203.0.113.7"]) {
      expect(key).not.toBe(createHash("sha256").update(plain).digest("hex"));
    }
    // Keyed by AUTH_SECRET: another secret gives another key for the same caller.
    expect(rateLimitKey("auth", "203.0.113.7", { AUTH_SECRET: "another-secret" })).not.toBe(key);
    // Stable for the same caller, and different per bucket and per IP.
    expect(rateLimitKey("auth", "203.0.113.7", VERCEL_ENV)).toBe(key);
    expect(rateLimitKey("trpc-public", "203.0.113.7", VERCEL_ENV)).not.toBe(key);
    expect(rateLimitKey("auth", "203.0.113.8", VERCEL_ENV)).not.toBe(key);
  });

  it("REQ-1: without AUTH_SECRET the IP is left out of the key, so all callers share the bucket", () => {
    const env = { TRUSTED_IP_HEADER: "x-real-ip" };
    expect(rateLimitKey("trpc-public", "203.0.113.7", env)).toBe(
      rateLimitKey("trpc-public", "198.51.100.1", env),
    );
    expect(rateLimitKey("trpc-public", null, env)).not.toBe(rateLimitKey("auth", null, env));
  });

  it("REQ-1: refusals are 429 or 503 with no detail and no caching", async () => {
    const tooMany = rateLimitResponse(429);
    expect(tooMany.status).toBe(429);
    expect(tooMany.headers.get("retry-after")).toBe("60");
    expect(tooMany.headers.get("cache-control")).toBe("no-store");
    expect(rateLimitResponse(503).status).toBe(503);
  });
});

describe("REQ-1: the limiter fails closed", () => {
  let silent: Server;
  let silentPort = 0;
  const sockets = new Set<Socket>();
  const dropSockets = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  beforeAll(async () => {
    // Accepts connections and never answers, like a database that has hung.
    silent = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    silentPort = (silent.address() as { port: number }).port;
  });

  afterAll(async () => {
    dropSockets();
    await new Promise((resolve) => silent.close(resolve));
  });

  it("REQ-1: a database error means 503, logged by code only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = poolDb("postgres://u:secret-pass@127.0.0.1:1/never_test");
    const result = await checkRateLimit({
      bucket: "auth",
      headers: fromIp("203.0.113.7"),
      env: VERCEL_ENV,
      db: () => db,
      cleanup: noCleanup(),
    });
    await db.$client.end();
    expect(result).toEqual({ ok: false, status: 503 });
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("ECONNREFUSED");
    expect(line).not.toContain("secret-pass");
    expect(line).not.toContain("127.0.0.1");
  });

  it("REQ-1: no answer within the timeout means 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = poolDb(`postgres://u:p@127.0.0.1:${silentPort}/never_test`);
    const started = Date.now();
    const result = await checkRateLimit({
      bucket: "trpc-public",
      headers: fromIp("203.0.113.7"),
      env: VERCEL_ENV,
      db: () => db,
      timeoutMs: 200,
      cleanup: noCleanup(),
    });
    expect(result).toEqual({ ok: false, status: 503 });
    expect(Date.now() - started).toBeLessThan(2_000);
    dropSockets();
    await db.$client.end().catch(() => {});
  });

  it("REQ-1: the default timeout is 2 seconds", async () => {
    const { TIMEOUT_MS } = await import("./rate-limit");
    expect(TIMEOUT_MS).toBe(2_000);
  });

  it("REQ-1: a secret with no TRUSTED_IP_HEADER is warned about once per instance, without values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = () => {
      throw new Error("no database in this test");
    };
    const warnings = { missingIpHeader: false };
    const call = (env: Record<string, string>) =>
      checkRateLimit({
        bucket: "auth",
        headers: fromIp("203.0.113.7"),
        env,
        db: failing,
        warnings,
      });
    await call({ AUTH_SECRET: SECRET, TRUSTED_IP_HEADER: "x-real-ip" });
    await call({});
    expect(warn).not.toHaveBeenCalled();
    await call({ AUTH_SECRET: SECRET });
    await call({ AUTH_SECRET: SECRET });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("TRUSTED_IP_HEADER");
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("203.0.113.7");
  });

  it("REQ-1: no database configured (no DATABASE_URL) means 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await checkRateLimit({
      bucket: "auth",
      headers: fromIp("203.0.113.7"),
      env: VERCEL_ENV,
      db: () => {
        throw new Error("DATABASE_URL is not set");
      },
    });
    expect(result).toEqual({ ok: false, status: 503 });
  });
});

const skipReason = await freshDatabaseSkipReason();
if (skipReason) console.warn(`[rate-limit.test] ${skipReason}`);

describe.skipIf(skipReason !== undefined)("REQ-1: rate limits in Postgres", () => {
  let fresh: FreshDatabase;
  let db: Database;
  // Each test uses its own caller, so tests never share counts.
  let n = 0;
  const nextIp = () => `198.51.100.${++n}`;
  const keyOf = (ip: string) => rateLimitKey("auth", ip, VERCEL_ENV);

  // One request from `ip`, with the database's clock standing at `atMs`.
  const hit = (
    ip: string | null,
    atMs: number,
    extra: Partial<Parameters<typeof checkRateLimit>[0]> = {},
  ) =>
    checkRateLimit({
      bucket: "auth",
      headers: ip ? fromIp(ip) : new Headers(),
      env: VERCEL_ENV,
      db: () => db,
      clock: new Date(atMs),
      cleanup: noCleanup(),
      ...extra,
    });

  beforeAll(async () => {
    fresh = await createFreshDatabase("t8_limits");
    db = fresh.db;
  }, 60_000);

  afterAll(async () => {
    await fresh?.drop();
  });

  it("REQ-1: sign-in routes allow 10 requests a minute per IP, then answer 429", async () => {
    const ip = nextIp();
    for (let i = 1; i <= RATE_LIMITS.auth; i++) {
      expect(await hit(ip, T0 + i)).toEqual({ ok: true, count: i, limit: 10 });
    }
    expect(await hit(ip, T0 + 50)).toEqual({ ok: false, status: 429 });
    // Another IP has its own count.
    expect(await hit(nextIp(), T0 + 51)).toMatchObject({ ok: true, count: 1 });
  });

  it("REQ-1: signed-out tRPC calls allow 60 a minute per IP, counted separately from sign-in", async () => {
    const ip = nextIp();
    const trpc = (atMs: number, cost = 1) => hit(ip, atMs, { bucket: "trpc-public", cost });
    expect(RATE_LIMITS["trpc-public"]).toBe(60);
    expect(await trpc(T0, 59)).toMatchObject({ ok: true, count: 59 });
    expect(await trpc(T0 + 1)).toMatchObject({ ok: true, count: 60 });
    expect(await trpc(T0 + 2)).toEqual({ ok: false, status: 429 });
    // The same IP's sign-in bucket is untouched.
    expect(await hit(ip, T0 + 3)).toMatchObject({ ok: true, count: 1 });
  });

  it("REQ-1: counts are per fixed one-minute window and start again in the next one", async () => {
    const ip = nextIp();
    const minuteStart = Math.floor(T0 / MINUTE) * MINUTE;
    for (let i = 0; i < 10; i++) await hit(ip, minuteStart + i * 1000);
    expect(await hit(ip, minuteStart + MINUTE - 1)).toEqual({ ok: false, status: 429 });
    expect(await hit(ip, minuteStart + MINUTE)).toMatchObject({ ok: true, count: 1 });
  });

  it("REQ-1: the window comes from the database's clock, not the app server's", async () => {
    const ip = nextIp();
    // An app server whose own clock is a year ahead: the stored window still follows Postgres.
    const result = await checkRateLimit({
      bucket: "auth",
      headers: fromIp(ip),
      env: VERCEL_ENV,
      db: () => db,
      now: () => Date.now() + 365 * DAY,
      cleanup: noCleanup(),
    });
    expect(result).toMatchObject({ ok: true, count: 1 });
    const { rows } = await db.execute<{ fits: boolean }>(sql`
      select window_start <= now() and window_start > now() - interval '2 minutes'
             and window_start = date_bin('1 minute', window_start, timestamptz 'epoch') as fits
      from rate_limit where key = ${keyOf(ip)}
    `);
    expect(rows[0]?.fits).toBe(true);
  });

  it("REQ-1: an older window never resets a caller's count", async () => {
    const ip = nextIp();
    const minuteStart = Math.floor(T0 / MINUTE) * MINUTE;
    await hit(ip, minuteStart + MINUTE);
    expect(await hit(ip, minuteStart + 10)).toMatchObject({ ok: true, count: 2 });
  });

  it("REQ-1: 20 requests at once from one caller are each counted exactly once", async () => {
    const ip = nextIp();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => hit(ip, T0, { bucket: "trpc-public" })),
    );
    const counts = results.map((r) => (r.ok ? r.count : -1)).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const { rows } = await db.execute<{ count: number }>(
      sql`select count from rate_limit where key = ${rateLimitKey("trpc-public", ip, VERCEL_ENV)}`,
    );
    expect(rows).toEqual([{ count: 20 }]);
  });

  it("REQ-1: one upsert row per caller and bucket, keyed by the HMAC, never the raw IP", async () => {
    const ip = "192.0.2.77";
    await hit(ip, T0);
    await hit(ip, T0 + 1);
    const rows = await db.execute<{ key: string; count: number; window_start: Date }>(
      sql`select key, count, window_start from rate_limit where key = ${keyOf(ip)}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.count).toBe(2);
    expect(new Date(rows.rows[0]!.window_start).getTime()).toBe(Math.floor(T0 / MINUTE) * MINUTE);
    const all = await db.execute<{ dump: string }>(
      sql`select string_agg(rate_limit::text, ' ') as dump from rate_limit`,
    );
    expect(all.rows[0]?.dump).not.toContain(ip);
  });

  it("REQ-1: the database refuses a key that isn't an HMAC, such as a raw IP", async () => {
    const error = await db
      .insert(schema.rateLimits)
      .values({ key: "203.0.113.7", windowStart: new Date(T0), count: 1 })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    let cause: unknown = error;
    while (cause && typeof cause === "object" && !("constraint" in cause)) {
      cause = "cause" in cause ? cause.cause : undefined;
    }
    expect(cause).toMatchObject({ code: "23514", constraint: "rate_limit_key_is_hmac" });
  });

  it("REQ-1: with no trusted IP header, every caller shares one bucket", async () => {
    const at = T0 + 7 * MINUTE;
    const shared = (ip: string) =>
      hit(ip, at, { env: { AUTH_SECRET: SECRET }, warnings: { missingIpHeader: true } });
    for (let i = 0; i < 10; i++) await shared(`203.0.113.${i + 1}`);
    expect(await shared("198.51.100.200")).toEqual({ ok: false, status: 429 });
  });

  it("REQ-1: after a request, the clean-up deletes day-old rate-limit rows and expired sessions", async () => {
    const at = T0 + 3 * DAY;
    const old = nextIp();
    const recent = nextIp();
    await hit(old, at - DAY - MINUTE);
    await hit(recent, at - DAY + MINUTE);
    const [user] = await db
      .insert(schema.users)
      .values({ name: "Cleanup test", githubId: 990_001 })
      .returning({ id: schema.users.id });
    await db.insert(schema.sessions).values([
      { sessionToken: "t8-expired", userId: user!.id, expires: new Date(at - 1000) },
      { sessionToken: "t8-current", userId: user!.id, expires: new Date(at + DAY) },
    ]);
    const present = async (ip: string) =>
      (await db.execute(sql`select 1 from rate_limit where key = ${keyOf(ip)}`)).rows.length === 1;
    const sessionTokens = async () =>
      (
        await db.execute<{ session_token: string }>(
          sql`select session_token from session where session_token like 't8-%' order by 1`,
        )
      ).rows.map((row) => row.session_token);

    const scheduled: (() => Promise<void>)[] = [];
    const schedule = (task: () => Promise<void>) => void scheduled.push(task);
    const instanceNow = 1_000_000_000;

    // Not yet: this instance cleaned up less than CLEANUP_INTERVAL_MS ago.
    const cleanup = { lastRunMs: instanceNow - CLEANUP_INTERVAL_MS + 1 };
    await hit(nextIp(), at, { cleanup, schedule, now: () => instanceNow });
    expect(scheduled).toHaveLength(0);

    // Due: handed to the scheduler (Next's after()), so it runs after the response is sent.
    cleanup.lastRunMs = instanceNow - CLEANUP_INTERVAL_MS;
    await hit(nextIp(), at, { cleanup, schedule, now: () => instanceNow });
    expect(cleanup.lastRunMs).toBe(instanceNow);
    expect(scheduled).toHaveLength(1);
    expect(await present(old)).toBe(true);

    await scheduled[0]!();
    expect(await present(old)).toBe(false);
    expect(await present(recent)).toBe(true);
    expect(await sessionTokens()).toEqual(["t8-current"]);
  });

  it("REQ-1: a clean-up that can't be scheduled never fails the request", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = { lastRunMs: 0 };
    // Outside a request Next's after() throws; the request is still counted and answered.
    const result = await hit(nextIp(), T0, { cleanup });
    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(cleanup.lastRunMs).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/^rate-limit cleanup not scheduled: /);
  });
});
