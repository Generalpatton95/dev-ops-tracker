// T-8 (REQ-1): the signed-in layout's own session check keeps the requested page as the return
// path (the proxy passes it in RETURN_PATH_HEADER), so its redirect never drops it.
import { describe, expect, it, vi } from "vitest";
import { RETURN_PATH_HEADER } from "@/server/auth/gate";

vi.mock("server-only", () => ({}));

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
// Auth.js answers "no session", as for a stale or forged cookie.
vi.mock("next-auth", () => ({ default: () => ({ handlers: {}, auth: async () => null }) }));

const { SignedInHeader } = await import("./signed-in-header");

async function redirectTarget(): Promise<string | undefined> {
  vi.stubEnv("AUTH_SECRET", "test-secret-not-real");
  vi.stubEnv("AUTH_GITHUB_ID", "id");
  vi.stubEnv("AUTH_GITHUB_SECRET", "secret");
  try {
    const error = await SignedInHeader().then(
      () => undefined,
      (e: unknown) => e,
    );
    const digest = (error as { digest?: unknown } | undefined)?.digest;
    return typeof digest === "string" ? digest.split(";")[2] : undefined;
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("REQ-1: the signed-in layout", () => {
  it("REQ-1: a stale session in the layout redirects to sign-in with the page's return path", async () => {
    requestHeaders = new Headers({ [RETURN_PATH_HEADER]: "/projects/DOT?tab=open" });
    expect(await redirectTarget()).toBe("/sign-in?callbackUrl=%2Fprojects%2FDOT%3Ftab%3Dopen");
  });

  it("REQ-1: an unsafe or missing return-path header falls back to home", async () => {
    requestHeaders = new Headers({ [RETURN_PATH_HEADER]: "https://evil.example/x" });
    expect(await redirectTarget()).toBe("/sign-in");
    requestHeaders = new Headers();
    expect(await redirectTarget()).toBe("/sign-in");
  });
});
