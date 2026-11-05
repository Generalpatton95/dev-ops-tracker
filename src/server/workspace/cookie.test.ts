// T-10 (REQ-3): the current-workspace cookie: an httpOnly, SameSite=Lax cookie holding only a
// workspace id; in production Secure and named with the __Host- prefix. Reading it keeps only a
// well-formed id under this environment's name.
import { describe, expect, it } from "vitest";
import {
  SECURE_WORKSPACE_COOKIE,
  WORKSPACE_COOKIE,
  workspaceCookieHeader,
  workspaceCookieName,
  workspaceIdFromCookieHeader,
} from "./cookie";

const WS_ID = "6f1c2f5e-8d1a-4a53-9a43-2b4c1f9e7a10";
const DEV = { NODE_ENV: "development" };
const PROD = { NODE_ENV: "production" };

describe("REQ-3: the current-workspace cookie", () => {
  it("REQ-3: is httpOnly and SameSite=Lax for the whole site, holding only the workspace id", () => {
    const header = workspaceCookieHeader(WS_ID, DEV);
    const [pair, ...attributes] = header.split("; ");
    expect(pair).toBe(`dot-workspace=${WS_ID}`);
    expect(attributes).toEqual(
      expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=31536000"]),
    );
    expect(attributes).not.toContain("Secure");
  });

  it("REQ-3: in production it is Secure and named __Host-dot-workspace, with Path=/ and no Domain", () => {
    expect(workspaceCookieName(PROD)).toBe("__Host-dot-workspace");
    expect(workspaceCookieName(DEV)).toBe("dot-workspace");
    const [pair, ...attributes] = workspaceCookieHeader(WS_ID, PROD).split("; ");
    expect(pair).toBe(`__Host-dot-workspace=${WS_ID}`);
    expect(attributes).toContain("Secure");
    expect(attributes).toContain("Path=/");
    expect(attributes.some((a) => a.toLowerCase().startsWith("domain="))).toBe(false);
  });

  it("REQ-3: only a UUID can be written, so no other attribute can slip in", () => {
    for (const bad of ["", "x", `${WS_ID}; Domain=evil.example`, `${WS_ID}\r\nX: y`]) {
      expect(() => workspaceCookieHeader(bad, DEV), bad).toThrow();
    }
  });

  it("REQ-3: reading keeps a well-formed id and ignores anything else", () => {
    const read = (header: string | null) => workspaceIdFromCookieHeader(header, DEV);
    expect(read(`a=b; ${WORKSPACE_COOKIE}=${WS_ID}; c=d`)).toBe(WS_ID);
    expect(read(null)).toBeNull();
    expect(read("a=b")).toBeNull();
    expect(read(`${WORKSPACE_COOKIE}=not-a-uuid`)).toBeNull();
    expect(read(`${WORKSPACE_COOKIE}=' or 1=1 --`)).toBeNull();
    expect(read(`x${WORKSPACE_COOKIE}=${WS_ID}`)).toBeNull();
  });

  it("REQ-3: only the name for this environment is read; in production never the unprefixed one", () => {
    expect(workspaceIdFromCookieHeader(`${WORKSPACE_COOKIE}=${WS_ID}`, PROD)).toBeNull();
    expect(workspaceIdFromCookieHeader(`${SECURE_WORKSPACE_COOKIE}=${WS_ID}`, PROD)).toBe(WS_ID);
    expect(workspaceIdFromCookieHeader(`${SECURE_WORKSPACE_COOKIE}=${WS_ID}`, DEV)).toBeNull();
  });
});
