import { describe, expect, it } from "vitest";
import { safeReturnPath, signInPathFor } from "./return-path";

describe("REQ-1: the return path after sign-in", () => {
  it("REQ-1: keeps a same-site relative path with its query and fragment", () => {
    expect(safeReturnPath("/")).toBe("/");
    expect(safeReturnPath("/projects")).toBe("/projects");
    expect(safeReturnPath("/projects/DOT?tab=open#top")).toBe("/projects/DOT?tab=open#top");
    expect(safeReturnPath("/a/../b")).toBe("/b");
  });

  it("REQ-1: refuses absolute and protocol-relative URLs", () => {
    for (const value of [
      "https://evil.example/",
      "http://localhost:3000/projects",
      "//evil.example",
      "//evil.example/projects",
      "///evil.example",
      "javascript:alert(1)",
      "data:text/html,hi",
      "evil.example",
      "projects",
    ]) {
      expect(safeReturnPath(value), value).toBe("/");
    }
  });

  it("REQ-1: refuses backslashes and control characters that browsers turn into //host", () => {
    for (const value of [
      "/\\evil.example",
      "/\\/evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/x\u0000",
    ]) {
      expect(safeReturnPath(value), JSON.stringify(value)).toBe("/");
    }
  });

  it("REQ-1: refuses non-strings, empty and overlong values", () => {
    for (const value of [undefined, null, 42, ["/projects"], "", `/${"a".repeat(1100)}`]) {
      expect(safeReturnPath(value), String(value)).toBe("/");
    }
  });

  it("REQ-1: never returns to an API route or to the sign-in page itself", () => {
    for (const value of [
      "/api/trpc/health.ping",
      "/api",
      "/api/auth/signout",
      "/sign-in",
      "/sign-in?callbackUrl=/x",
    ]) {
      expect(safeReturnPath(value), value).toBe("/");
    }
    expect(safeReturnPath("/apis")).toBe("/apis");
    expect(safeReturnPath("/sign-in-help")).toBe("/sign-in-help");
  });

  it("REQ-1: encoded slashes stay a path on this site", () => {
    expect(safeReturnPath("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
  });

  it("REQ-1: the sign-in address carries the return path only when it isn't home", () => {
    expect(signInPathFor("/")).toBe("/sign-in");
    expect(signInPathFor("https://evil.example")).toBe("/sign-in");
    expect(signInPathFor("/projects?tab=open")).toBe(
      "/sign-in?callbackUrl=%2Fprojects%3Ftab%3Dopen",
    );
  });
});
