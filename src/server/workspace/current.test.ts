// T-9 (REQ-2): the page helper ensures the signed-in user's workspace, and a failure becomes an
// error state that is logged by code only. The session and database are stubbed here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let requireSession: () => Promise<unknown>;
vi.mock("@/server/auth", () => ({ requireSession: () => requireSession() }));
const fakeDb = { fake: true };
vi.mock("@/server/db", () => ({ getDb: () => fakeDb }));
let ensure: (db: unknown, userId: string) => Promise<unknown>;
vi.mock("./service", () => ({
  ensureOwnedWorkspace: (db: unknown, userId: string) => ensure(db, userId),
}));

const { getCurrentWorkspace } = await import("./current");

const SESSION = { user: { id: "user-1", name: "Ada" }, expires: "2099-01-01T00:00:00.000Z" };

beforeEach(() => {
  requireSession = async () => SESSION;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("REQ-2: the signed-in page's workspace", () => {
  it("REQ-2: ensures the signed-in user's workspace and returns it", async () => {
    const calls: unknown[][] = [];
    ensure = async (db, userId) => {
      calls.push([db, userId]);
      return { id: "ws-1", name: "Ada's workspace", role: "owner" };
    };
    await expect(getCurrentWorkspace()).resolves.toEqual({
      ok: true,
      workspace: { id: "ws-1", name: "Ada's workspace", role: "owner" },
    });
    expect(calls).toEqual([[fakeDb, "user-1"]]);
  });

  it("REQ-2: a failure gives an error state and logs a code, never the message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    ensure = async () => {
      throw Object.assign(
        new Error('duplicate key value violates "workspace" host=db.secret.example password=x'),
        { code: "23505" },
      );
    };
    await expect(getCurrentWorkspace()).resolves.toEqual({ ok: false });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toBe("[workspace] ensure failed: Error (23505)");
    expect(line).not.toContain("secret");
  });

  it("REQ-2: signed out, it redirects like requireSession and never touches the database", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/sign-in;307;",
    });
    requireSession = async () => {
      throw redirect;
    };
    ensure = async () => expect.unreachable("no query when signed out");
    await expect(getCurrentWorkspace()).rejects.toBe(redirect);
  });

  it("REQ-2: Next's own signals from inside the query pass through", async () => {
    const signal = Object.assign(new Error("dynamic"), { digest: "DYNAMIC_SERVER_USAGE" });
    ensure = async () => {
      throw signal;
    };
    await expect(getCurrentWorkspace()).rejects.toBe(signal);
  });
});
