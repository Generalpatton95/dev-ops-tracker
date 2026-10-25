import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db";
import * as schema from "@/server/db/schema";
import { errorLabel } from "@/server/log-label";
import { buildAuthConfig, githubProfile, isAuthConfigured, safeRedirect } from "./config";
import { authLogger } from "./logger";

const db = drizzle.mock({ schema }) as unknown as Database;
const BASE = "https://dot.example";

describe("REQ-1: Auth.js settings", () => {
  it("REQ-1: sign-in is on only when all three AUTH_* variables are set", () => {
    const all = { AUTH_SECRET: "s", AUTH_GITHUB_ID: "id", AUTH_GITHUB_SECRET: "x" };
    expect(isAuthConfigured(all)).toBe(true);
    expect(isAuthConfigured({})).toBe(false);
    expect(isAuthConfigured({ ...all, AUTH_SECRET: " " })).toBe(false);
    expect(isAuthConfigured({ ...all, AUTH_GITHUB_SECRET: undefined })).toBe(false);
  });

  it("REQ-1: the settings build with no AUTH_* variables and no database connection", () => {
    const getDatabase = vi.fn(() => db);
    const config = buildAuthConfig({}, getDatabase);
    // A fixed 30 days: updateAge equal to maxAge means Auth.js never slides the expiry.
    expect(config.session).toEqual({
      strategy: "database",
      maxAge: 30 * 24 * 60 * 60,
      updateAge: 30 * 24 * 60 * 60,
    });
    expect(config.pages).toEqual({ signIn: "/sign-in", error: "/sign-in" });
    expect(config.providers).toHaveLength(1);
  });

  it("REQ-1: the GitHub profile keeps the id, name and avatar, and drops the email", () => {
    const user = githubProfile({
      id: 4242,
      login: "octocat",
      name: null,
      email: "octo@example.com",
      avatar_url: "https://avatars.githubusercontent.com/u/4242",
    } as Parameters<typeof githubProfile>[0]);
    expect(user).toEqual({
      id: "4242",
      githubId: 4242,
      name: "octocat",
      image: "https://avatars.githubusercontent.com/u/4242",
    });
  });

  it("REQ-1: the GitHub provider keeps no tokens and asks only for the public profile", () => {
    const [provider] = buildAuthConfig({}, () => db).providers as unknown as {
      options: {
        account: (tokens: object) => object;
        authorization: { params: { scope: string } };
      };
    }[];
    expect(provider.options.account({ access_token: "gho_x", refresh_token: "ghr_x" })).toEqual({});
    expect(provider.options.authorization.params.scope).toBe("read:user");
  });

  it("REQ-1: redirects after sign-in or sign-out stay on this site", () => {
    expect(safeRedirect({ url: "/projects?tab=1", baseUrl: BASE })).toBe(`${BASE}/projects?tab=1`);
    expect(safeRedirect({ url: `${BASE}/projects`, baseUrl: BASE })).toBe(`${BASE}/projects`);
    expect(safeRedirect({ url: BASE, baseUrl: BASE })).toBe(`${BASE}/`);
    expect(safeRedirect({ url: "/sign-in", baseUrl: BASE })).toBe(`${BASE}/sign-in`);
    for (const url of [
      "https://evil.example/",
      `${BASE}.evil.example/x`,
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      expect(safeRedirect({ url, baseUrl: BASE }), url).toBe(`${BASE}/`);
    }
  });

  it("REQ-1: the session sent anywhere holds only the user's id and name", async () => {
    const callback = buildAuthConfig({}, () => db).callbacks!.session!;
    const result = await callback({
      session: { expires: new Date("2026-11-24T00:00:00Z") },
      user: { id: "u-1", name: "Octo", email: "octo@example.com", image: "https://x" },
    } as never);
    expect(result).toEqual({
      user: { id: "u-1", name: "Octo" },
      expires: "2026-11-24T00:00:00.000Z",
    });
  });
});

describe("REQ-1: Auth.js logging", () => {
  it("REQ-1: errors are logged by type and code only, never their message or cause text", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbError = Object.assign(new Error('insert into "user" values (octo@example.com)'), {
      code: "23514",
    });
    class SessionTokenError extends Error {
      static type = "SessionTokenError";
      type = "SessionTokenError";
      constructor(err: Error) {
        super("Read more at https://errors.authjs.dev", { cause: { err, detail: "gho_secret" } });
      }
    }
    authLogger.error(new SessionTokenError(dbError));
    expect(log.mock.calls).toEqual([["[auth] SessionTokenError (23514)"]]);
    log.mockRestore();
  });

  it("REQ-1: warnings print their code only and debug output is dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    authLogger.warn("debug-enabled\nforged line");
    authLogger.debug();
    expect(warn.mock.calls).toEqual([["[auth] warning debug-enabled?forged?line"]]);
    expect(out).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("REQ-1: error labels are cleaned and capped", () => {
    expect(errorLabel(Object.assign(new Error("x"), { name: "Bad\nName", code: "a b" }))).toBe(
      "Bad?Name (a?b)",
    );
    expect(errorLabel("a string")).toBe("Error");
    expect(errorLabel({ name: "n".repeat(200) })).toHaveLength(64);
  });
});
