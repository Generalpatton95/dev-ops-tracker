// T-8 (REQ-1): the server-side session check that pages, layouts and tRPC use. Auth.js itself
// is replaced by a stub here; the real flow is in sign-in-flow.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// A plain stub rather than vi.fn(): what Auth.js's auth() answers in each test, and whether it ran.
let authAnswer: () => Promise<unknown> = async () => null;
let authCalls = 0;
// The page the proxy said was requested (RETURN_PATH_HEADER); none unless a test sets it.
let requestHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
// connection() needs a real request; here it only records that the check waited for one.
let connections = 0;
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {
    connections++;
  },
}));
vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    auth: () => {
      authCalls++;
      return authAnswer();
    },
  }),
}));

const { getCurrentSession, requireSession } = await import("./index");

const CONFIGURED = {
  AUTH_SECRET: "test-secret-not-real",
  AUTH_GITHUB_ID: "id",
  AUTH_GITHUB_SECRET: "secret",
};

function configure(on: boolean) {
  for (const [name, value] of Object.entries(CONFIGURED)) vi.stubEnv(name, on ? value : "");
}

async function redirectTarget(work: Promise<unknown>): Promise<string | undefined> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  const digest = (error as { digest?: unknown } | undefined)?.digest;
  // Next's redirect() throws an error whose digest is "NEXT_REDIRECT;<type>;<url>;<status>;".
  return typeof digest === "string" ? digest.split(";")[2] : undefined;
}

beforeEach(() => {
  authAnswer = async () => null;
  authCalls = 0;
  connections = 0;
  requestHeaders = new Headers();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("REQ-1: server-side session checks", () => {
  it("REQ-1: a page visited while signed out redirects to the sign-in page with its return path", async () => {
    configure(true);
    authAnswer = async () => null;
    expect(await redirectTarget(requireSession("/projects?tab=open"))).toBe(
      "/sign-in?callbackUrl=%2Fprojects%3Ftab%3Dopen",
    );
    expect(await redirectTarget(requireSession())).toBe("/sign-in");
  });

  it("REQ-1: with no path given, the redirect keeps the page the proxy says was requested", async () => {
    configure(true);
    requestHeaders = new Headers({ "x-dot-return-path": "/?tab=open" });
    expect(await redirectTarget(requireSession())).toBe("/sign-in?callbackUrl=%2F%3Ftab%3Dopen");
    requestHeaders = new Headers({ "x-dot-return-path": "//evil.example" });
    expect(await redirectTarget(requireSession())).toBe("/sign-in");
  });

  it("REQ-1: without the AUTH_* variables nobody is signed in and Auth.js isn't asked", async () => {
    configure(false);
    expect(await getCurrentSession()).toBeNull();
    expect(await redirectTarget(requireSession())).toBe("/sign-in");
    expect(authCalls).toBe(0);
    // Still answered per request, so a build without the variables can't bake in "signed out".
    expect(connections).toBe(2);
  });

  it("REQ-1: a signed-in session reaches the page as just the user's id and name", async () => {
    configure(true);
    authAnswer = async () => ({
      user: { id: "u-1", name: "Octo Cat", email: "octo@example.com", image: "https://x/y.png" },
      expires: "2026-11-24T00:00:00.000Z",
    });
    await expect(requireSession()).resolves.toEqual({
      user: { id: "u-1", name: "Octo Cat" },
      expires: "2026-11-24T00:00:00.000Z",
    });
  });

  it("REQ-1: a failed session lookup counts as signed out and logs only the error's kind", async () => {
    configure(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    authAnswer = async () => {
      throw Object.assign(new Error("connect to db.example user=bob"), { code: "ECONNREFUSED" });
    };
    expect(await getCurrentSession()).toBeNull();
    expect(String(log.mock.calls[0]?.[0])).toBe(
      "[auth] session check failed: Error (ECONNREFUSED)",
    );
  });

  it("REQ-1: a malformed session from Auth.js counts as signed out", async () => {
    configure(true);
    for (const value of [
      {},
      { user: {} },
      { user: { id: "" }, expires: "x" },
      { user: { id: "u" } },
      "x",
    ]) {
      authAnswer = async () => value;
      expect(await getCurrentSession(), JSON.stringify(value)).toBeNull();
    }
  });
});
