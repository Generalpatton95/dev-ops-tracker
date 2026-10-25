// T-8 (REQ-1): the /api/auth route around Auth.js: allow-list, body cap, rate limit, and no
// sign-in without the AUTH_* variables. Auth.js itself is a stub here (see sign-in-flow.test.ts).
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/server/rate-limit";

vi.mock("server-only", () => ({}));

const { createAuthRouteHandler, MAX_AUTH_BODY_BYTES } = await import("./route-handler");

const ENV = { AUTH_SECRET: "s", AUTH_GITHUB_ID: "id", AUTH_GITHUB_SECRET: "secret" };

function setup(
  result: RateLimitResult = { ok: true, count: 1, limit: 10 },
  env: Record<string, string> = ENV,
) {
  const authjs = vi.fn(async () => new Response("from Auth.js"));
  const limit = vi.fn(async () => result);
  const handler = createAuthRouteHandler({ GET: authjs, POST: authjs }, env, limit);
  return { authjs, limit, handler };
}

function request(method: string, path: string, headers: Record<string, string> = {}) {
  const body = method === "POST" ? "csrfToken=x" : undefined;
  const sized: Record<string, string> =
    method === "POST" && !("content-length" in headers) ? { "content-length": "11" } : {};
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { ...sized, ...headers },
    body,
  });
}

describe("REQ-1: the /api/auth route", () => {
  it("REQ-1: sign-in and the OAuth callback are rate-limited in the auth bucket", async () => {
    const { handler, limit, authjs } = setup();
    for (const [method, path] of [
      ["POST", "/api/auth/signin/github"],
      ["GET", "/api/auth/callback/github?code=x"],
    ]) {
      limit.mockClear();
      const res = await handler(request(method, path));
      expect(await res.text(), path).toBe("from Auth.js");
      expect(limit, path).toHaveBeenCalledWith(expect.objectContaining({ bucket: "auth" }));
    }
    expect(authjs).toHaveBeenCalledTimes(2);
  });

  it("REQ-1: over the limit is a 429 and a limiter failure a 503, before Auth.js runs", async () => {
    for (const status of [429, 503] as const) {
      const { handler, authjs } = setup({ ok: false, status });
      const res = await handler(request("POST", "/api/auth/signin/github"));
      expect(res.status).toBe(status);
      expect(authjs).not.toHaveBeenCalled();
    }
  });

  it("REQ-1: the CSRF token and sign-out endpoints aren't limited", async () => {
    const { handler, limit } = setup();
    expect((await handler(request("GET", "/api/auth/csrf"))).status).toBe(200);
    expect((await handler(request("POST", "/api/auth/signout"))).status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
  });

  it("REQ-1: Auth.js endpoints the app doesn't use answer 404", async () => {
    const { handler, authjs } = setup();
    for (const [method, path] of [
      ["GET", "/api/auth/session"],
      ["POST", "/api/auth/session"],
      ["GET", "/api/auth/providers"],
      ["GET", "/api/auth/signin"],
      ["GET", "/api/auth/signin/github"],
      ["GET", "/api/auth/signout"],
      ["GET", "/api/auth/error"],
      ["POST", "/api/auth/callback/github"],
      ["POST", "/api/auth/signin/credentials"],
      ["GET", "/api/auth/callback/other"],
    ]) {
      expect((await handler(request(method, path))).status, `${method} ${path}`).toBe(404);
    }
    expect(authjs).not.toHaveBeenCalled();
  });

  it("REQ-1: without the AUTH_* variables (previews) sign-in answers 503 and touches nothing", async () => {
    const { handler, authjs, limit } = setup(undefined, {});
    const res = await handler(request("POST", "/api/auth/signin/github"));
    expect(res.status).toBe(503);
    expect(authjs).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("REQ-1: POST bodies must be sized and small", async () => {
    const { handler, authjs } = setup();
    const signin = "/api/auth/signin/github";
    expect((await handler(request("POST", signin, { "content-length": "abc" }))).status).toBe(400);
    expect(
      (
        await handler(
          request("POST", signin, { "content-length": String(MAX_AUTH_BODY_BYTES + 1) }),
        )
      ).status,
    ).toBe(413);
    expect(authjs).not.toHaveBeenCalled();
  });

  it("REQ-1: a setup failure answers 500 and logs no message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw new Error("DATABASE_URL is not set: postgres://user:pass@host");
    });
    const handler = createAuthRouteHandler({ GET: failing, POST: failing }, ENV, async () => ({
      ok: true,
      count: 1,
      limit: 10,
    }));
    const res = await handler(request("GET", "/api/auth/csrf"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
    expect(String(log.mock.calls[0]?.[0])).toBe("[auth] GET csrf failed: Error");
    log.mockRestore();
  });
});
