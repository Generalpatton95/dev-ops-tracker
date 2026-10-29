import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSession } from "@/server/auth/config";
import type { RateLimitOptions, RateLimitResult } from "@/server/rate-limit";
import { MAX_BATCH_SIZE, MAX_BODY_BYTES } from "@/trpc/limits";

vi.mock("server-only", () => ({}));

// The session lookup and the Postgres limiter are stubbed; both have their own tests.
const session = vi.fn<() => Promise<AppSession | null>>();
vi.mock("@/server/auth", () => ({ getCurrentSession: () => session() }));
const limit = vi.fn<(options: RateLimitOptions) => Promise<RateLimitResult>>();
vi.mock("@/server/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/rate-limit")>()),
  checkRateLimit: (options: RateLimitOptions) => limit(options),
}));

const { GET, POST } = await import("@/app/api/trpc/[trpc]/route");

const base = "http://localhost/api/trpc";
const SIGNED_IN: AppSession = {
  user: { id: "u-1", name: "Octo" },
  expires: "2026-11-24T00:00:00Z",
};

function post(headers: Record<string, string>) {
  return POST(new Request(`${base}/health.ping`, { method: "POST", headers, body: "{}" }));
}

function batch(size: number) {
  const paths = Array(size).fill("health.ping").join(",");
  const input = encodeURIComponent(
    JSON.stringify(Object.fromEntries(paths.split(",").map((_, i) => [i, {}]))),
  );
  return GET(new Request(`${base}/${paths}?batch=1&input=${input}`));
}

beforeEach(() => {
  session.mockResolvedValue(null);
  limit.mockResolvedValue({ ok: true, count: 1, limit: 60 });
});

afterEach(() => {
  vi.restoreAllMocks();
  session.mockReset();
  limit.mockReset();
});

describe("/api/trpc limits", () => {
  it("answers a ping", async () => {
    const res = await GET(new Request(`${base}/health.ping`));
    expect(res.status).toBe(200);
  });

  it("refuses a POST with no content-length", async () => {
    expect((await post({})).status).toBe(411);
  });

  it("refuses a malformed content-length", async () => {
    expect((await post({ "content-length": "abc" })).status).toBe(400);
  });

  it("refuses a body over the limit", async () => {
    expect((await post({ "content-length": String(MAX_BODY_BYTES + 1) })).status).toBe(413);
  });

  it("allows a full batch and refuses a bigger one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await batch(MAX_BATCH_SIZE)).status).toBe(200);
    expect((await batch(MAX_BATCH_SIZE + 1)).status).toBe(400);
  });

  it("logs a cleaned, capped path for unknown procedures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await GET(new Request(`${base}/x%0Afake-line${"a".repeat(500)}`));
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(120);
  });
});

describe("/api/trpc rate limits", () => {
  it("REQ-1: signed-out calls are rate-limited per IP in the trpc-public bucket", async () => {
    const req = new Request(`${base}/health.ping`, { headers: { "x-real-ip": "203.0.113.7" } });
    expect((await GET(req)).status).toBe(200);
    expect(limit).toHaveBeenCalledTimes(1);
    const options = limit.mock.calls[0]![0];
    expect(options).toMatchObject({ bucket: "trpc-public", cost: 1 });
    expect(options.headers.get("x-real-ip")).toBe("203.0.113.7");
  });

  it("REQ-1: each call in a batch counts towards the limit", async () => {
    await batch(4);
    expect(limit.mock.calls[0]![0]).toMatchObject({ cost: 4 });
  });

  it("REQ-1: a batch whose commas are percent-encoded (%2C) is counted call by call too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const paths = Array(5).fill("health.ping").join("%2C");
    const input = encodeURIComponent(JSON.stringify({ 0: {}, 1: {}, 2: {}, 3: {}, 4: {} }));
    const res = await GET(new Request(`${base}/${paths}?batch=1&input=${input}`));
    // tRPC decodes the path and runs all five, so all five are counted.
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toHaveLength(5);
    expect(limit.mock.calls[0]![0]).toMatchObject({ cost: 5 });
  });

  it("REQ-1: a batch path that can't be decoded counts as an oversized batch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await GET(new Request(`${base}/health.ping%E0%A4%A?batch=1&input=%7B%7D`));
    expect(limit.mock.calls[0]![0]).toMatchObject({ cost: MAX_BATCH_SIZE + 1 });
  });

  it("REQ-1: a request that isn't a batch is one call, as tRPC runs it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await GET(new Request(`${base}/health.ping,health.ping`));
    expect(limit.mock.calls[0]![0]).toMatchObject({ cost: 1 });
  });

  it("REQ-1: over the limit, signed-out calls get a 429 and the procedure doesn't run", async () => {
    limit.mockResolvedValue({ ok: false, status: 429 });
    const res = await GET(new Request(`${base}/health.ping`));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.text()).not.toContain("ok");
  });

  it("REQ-1: if the limiter can't run, signed-out calls fail closed with a 503", async () => {
    limit.mockResolvedValue({ ok: false, status: 503 });
    expect((await GET(new Request(`${base}/health.ping`))).status).toBe(503);
  });

  it("REQ-1: signed-in calls skip the public limiter and carry the server-side session", async () => {
    session.mockResolvedValue(SIGNED_IN);
    expect((await GET(new Request(`${base}/health.ping`))).status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
  });

  it("REQ-1: size checks run before the session lookup or the limiter", async () => {
    expect((await post({})).status).toBe(411);
    expect(session).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });
});
