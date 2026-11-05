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

// T-10: the workspace service is stubbed too, so the cookie wiring can be checked without a
// database; the procedures themselves have their own tests.
const fakeDb = { fake: true };
vi.mock("@/server/db", () => ({ getDb: () => fakeDb }));
const membershipOf =
  vi.fn<(db: unknown, userId: string, workspaceId: string) => Promise<unknown>>();
const resolveCurrent =
  vi.fn<(db: unknown, userId: string, preferred: string | null) => Promise<unknown>>();
vi.mock("@/server/workspace/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/workspace/service")>()),
  membershipOf: (db: unknown, userId: string, workspaceId: string) =>
    membershipOf(db, userId, workspaceId),
  resolveCurrentWorkspace: (db: unknown, userId: string, preferred: string | null) =>
    resolveCurrent(db, userId, preferred),
}));

const { GET, POST } = await import("@/app/api/trpc/[trpc]/route");

const base = "http://localhost/api/trpc";
const SIGNED_IN: AppSession = {
  user: { id: "u-1", name: "Octo" },
  expires: "2026-11-24T00:00:00Z",
};

function post(headers: Record<string, string>) {
  return POST(
    new Request(`${base}/health.ping`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    }),
  );
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
  membershipOf.mockReset();
  resolveCurrent.mockReset();
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

const WS_ID = "6f1c2f5e-8d1a-4a53-9a43-2b4c1f9e7a10";

function switchRequest(init: RequestInit & { duplex?: "half" }) {
  return new Request(`${base}/workspace.switch`, {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
}

describe("/api/trpc body cap (T-10: bytes are counted, Content-Length isn't trusted)", () => {
  it("REQ-3: a body bigger than the cap is refused even when Content-Length claims it is small", async () => {
    session.mockResolvedValue(SIGNED_IN);
    const body = JSON.stringify({ workspaceId: WS_ID, pad: "x".repeat(MAX_BODY_BYTES) });
    const req = switchRequest({ headers: { "content-length": "2" }, body });
    // The header really does lie in this request.
    expect(req.headers.get("content-length")).toBe("2");
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(membershipOf).not.toHaveBeenCalled();
  });

  it("REQ-3: a streamed body stops being read once it passes the cap", async () => {
    session.mockResolvedValue(SIGNED_IN);
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await POST(
      switchRequest({ headers: { "content-length": "10" }, body: stream, duplex: "half" }),
    );
    expect(res.status).toBe(413);
    // 100KB is about 7 chunks of 16KB; it never reads the 16MB on offer.
    expect(pulled).toBeLessThan(12);
    expect(membershipOf).not.toHaveBeenCalled();
  });

  it("REQ-3: a body that doesn't match its Content-Length is refused", async () => {
    session.mockResolvedValue(SIGNED_IN);
    const body = JSON.stringify({ workspaceId: WS_ID });
    const shorter = await POST(switchRequest({ headers: { "content-length": "500" }, body }));
    expect(shorter.status).toBe(400);
    expect(membershipOf).not.toHaveBeenCalled();
  });

  it("REQ-3: a body at the cap with an honest Content-Length gets through to tRPC", async () => {
    session.mockResolvedValue(SIGNED_IN);
    membershipOf.mockResolvedValue({ id: WS_ID, name: "Team", role: "member" });
    const body = JSON.stringify({ workspaceId: WS_ID });
    const res = await POST(
      switchRequest({ headers: { "content-length": String(Buffer.byteLength(body)) }, body }),
    );
    expect(res.status).toBe(200);
    expect(membershipOf).toHaveBeenCalledWith(fakeDb, SIGNED_IN.user.id, WS_ID);
  });
});

describe("/api/trpc current-workspace cookie", () => {
  it("REQ-3: switching sets an httpOnly, SameSite=Lax cookie holding the workspace id", async () => {
    session.mockResolvedValue(SIGNED_IN);
    membershipOf.mockResolvedValue({ id: WS_ID, name: "Team", role: "member" });
    const body = JSON.stringify({ workspaceId: WS_ID });
    const res = await POST(
      switchRequest({ headers: { "content-length": String(Buffer.byteLength(body)) }, body }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^dot-workspace=${WS_ID}; `));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("REQ-3: switching to a workspace you aren't in sets no cookie and answers NOT_FOUND", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    session.mockResolvedValue(SIGNED_IN);
    membershipOf.mockResolvedValue(null);
    const body = JSON.stringify({ workspaceId: WS_ID });
    const res = await POST(
      switchRequest({ headers: { "content-length": String(Buffer.byteLength(body)) }, body }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("REQ-3: the cookie's id reaches the procedures only as a preference to check; junk is dropped", async () => {
    session.mockResolvedValue(SIGNED_IN);
    resolveCurrent.mockResolvedValue({ id: WS_ID, name: "Team", role: "member" });
    await GET(
      new Request(`${base}/workspace.current`, { headers: { cookie: `dot-workspace=${WS_ID}` } }),
    );
    await GET(
      new Request(`${base}/workspace.current`, { headers: { cookie: "dot-workspace=junk" } }),
    );
    expect(resolveCurrent.mock.calls.map((call) => call[2])).toEqual([WS_ID, null]);
  });
});

describe("/api/trpc takes only JSON POSTs (T-10)", () => {
  async function postAs(contentType: string | null, body: BodyInit = "{}") {
    const headers: Record<string, string> = { "content-length": "2" };
    if (contentType !== null) headers["content-type"] = contentType;
    return POST(new Request(`${base}/workspace.createInvite`, { method: "POST", headers, body }));
  }

  it("REQ-3: form-data, octet-stream, text/plain and missing content types get 415 before the session lookup", async () => {
    session.mockResolvedValue(SIGNED_IN);
    for (const type of [
      "multipart/form-data; boundary=x",
      "application/octet-stream",
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/jsonx",
      null,
    ]) {
      expect((await postAs(type)).status, String(type)).toBe(415);
    }
    expect(session).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("REQ-3: application/json (with or without a charset) gets through to tRPC", async () => {
    session.mockResolvedValue(SIGNED_IN);
    resolveCurrent.mockResolvedValue({ id: WS_ID, name: "Team", role: "member" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const type of ["application/json", "application/json; charset=utf-8"]) {
      const res = await postAs(type);
      expect(res.status, type).not.toBe(415);
    }
    // It reached the procedure, which looked up the current workspace each time.
    expect(resolveCurrent).toHaveBeenCalledTimes(2);
  });

  it("REQ-3: the browser client sends application/json on every POST, no-input mutations included", async () => {
    const { createTRPCClient, httpBatchLink } = await import("@trpc/client");
    const seen: { method: string; type: string | null; body: string }[] = [];
    const client = createTRPCClient<import("@/server/routers/_app").AppRouter>({
      links: [
        httpBatchLink({
          url: "http://localhost/api/trpc",
          fetch: async (url, init) => {
            const headers = new Headers(init?.headers);
            seen.push({
              method: init?.method ?? "GET",
              type: headers.get("content-type"),
              body: String(init?.body ?? ""),
            });
            return new Response(JSON.stringify([{ result: { data: { active: false } } }]), {
              headers: { "content-type": "application/json" },
            });
          },
        }),
      ],
    });
    await client.workspace.disableInvite.mutate();
    expect(seen).toEqual([{ method: "POST", type: "application/json", body: "{}" }]);
  });
});

describe("/api/trpc reads the body only after the rate limit (T-10)", () => {
  it("REQ-3: a signed-out caller over the limit gets 429 without the body being read", async () => {
    limit.mockResolvedValue({ ok: false, status: 429 });
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 100) controller.close();
        else controller.enqueue(new Uint8Array(1024));
      },
    });
    const pulledBefore = () => pulled;
    const req = switchRequest({
      headers: { "content-length": "102400" },
      body: stream,
      duplex: "half",
    });
    // A stream queues its first chunk by itself, a tick after it is made.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ready = pulledBefore();
    expect(ready).toBeLessThanOrEqual(1);
    const res = await POST(req);
    expect(res.status).toBe(429);
    // Nothing beyond what the stream queued by itself before the request was handled.
    expect(pulled).toBe(ready);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("REQ-3: the free header checks (411, 400, 413) still come before the session lookup", async () => {
    expect((await post({})).status).toBe(411);
    expect((await post({ "content-length": "abc" })).status).toBe(400);
    expect((await post({ "content-length": String(MAX_BODY_BYTES + 1) })).status).toBe(413);
    expect(session).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });
});
