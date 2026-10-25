// T-8 (REQ-1): the proxy sends signed-out page visits to /sign-in. It is a first check only;
// the pages' own server-side checks are tested in src/server/auth/session.test.ts.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";
import { RETURN_PATH_HEADER, returnPathFromHeaders, signedOutRedirect } from "@/server/auth/gate";

const ORIGIN = "https://dot.example";

function visit(path: string, cookie?: string) {
  const headers = cookie ? { cookie } : undefined;
  return proxy(new NextRequest(`${ORIGIN}${path}`, { headers }));
}

describe("REQ-1: signed-out page visits", () => {
  it("REQ-1: visiting an app page while signed out sends you to the sign-in page", () => {
    for (const path of ["/", "/projects", "/settings/members"]) {
      const res = visit(path);
      expect(res.status, path).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, path).toBe("/sign-in");
    }
  });

  it("REQ-1: the redirect stays on this site and carries the page as a relative return path", () => {
    const res = visit("/projects/DOT?tab=open");
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe(ORIGIN);
    expect(location.searchParams.get("callbackUrl")).toBe("/projects/DOT?tab=open");
    // Home needs no return path.
    expect(visit("/").headers.get("location")).toBe(`${ORIGIN}/sign-in`);
  });

  it("REQ-1: a request path that would be a protocol-relative URL is not carried over", () => {
    expect(signedOutRedirect({ pathname: "//evil.example", search: "" }, () => false)).toBe(
      "/sign-in",
    );
    expect(signedOutRedirect({ pathname: "/\\evil.example", search: "" }, () => false)).toBe(
      "/sign-in",
    );
  });

  it("REQ-1: the sign-in and privacy pages are open to everyone", () => {
    for (const path of ["/sign-in", "/sign-in?callbackUrl=/x", "/privacy", "/privacy/"]) {
      expect(visit(path).headers.get("x-middleware-next"), path).toBe("1");
    }
    // Only those exact pages: look-alikes still need a session.
    expect(visit("/privacy-settings").status).toBe(307);
    expect(visit("/sign-in-later").status).toBe(307);
  });

  it("REQ-1: with a session cookie the proxy lets the request through to the page's own check", () => {
    for (const cookie of ["authjs.session-token=abc", "__Secure-authjs.session-token=abc"]) {
      expect(visit("/projects", cookie).headers.get("x-middleware-next")).toBe("1");
    }
    // An empty or unrelated cookie is not a session.
    expect(visit("/projects", "authjs.session-token=").status).toBe(307);
    expect(visit("/projects", "authjs.csrf-token=abc").status).toBe(307);
  });

  it("REQ-1: requests it lets through carry the page's own path for the layout's check", () => {
    const res = visit("/projects/DOT?tab=open", "authjs.session-token=stale");
    // NextResponse.next({ request: { headers } }) forwards these as x-middleware-request-*.
    expect(res.headers.get(`x-middleware-request-${RETURN_PATH_HEADER}`)).toBe(
      "/projects/DOT?tab=open",
    );
    expect(res.headers.get("x-middleware-override-headers")).toContain(RETURN_PATH_HEADER);
  });

  it("REQ-1: a return-path header sent by the client is replaced, never passed on", () => {
    const res = proxy(
      new NextRequest(`${ORIGIN}/projects`, {
        headers: { cookie: "authjs.session-token=x", [RETURN_PATH_HEADER]: "https://evil.example" },
      }),
    );
    expect(res.headers.get(`x-middleware-request-${RETURN_PATH_HEADER}`)).toBe("/projects");
    // And readers validate it again anyway.
    const spoofed = new Headers({ [RETURN_PATH_HEADER]: "//evil.example" });
    expect(returnPathFromHeaders(spoofed)).toBe("/");
    expect(returnPathFromHeaders(new Headers())).toBe("/");
  });

  it("REQ-1: the proxy runs on pages, not on API routes or Next's static files", () => {
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const url of ["/", "/projects", "/sign-in", "/privacy", "/apidocs"]) {
      expect(matches(url), url).toBe(true);
    }
    for (const url of [
      "/api/trpc/health.ping",
      "/api/auth/csrf",
      "/_next/static/chunk.js",
      "/favicon.ico",
    ]) {
      expect(matches(url), url).toBe(false);
    }
  });
});
