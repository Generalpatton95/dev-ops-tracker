// T-9 (REQ-2): the page helper ensures the signed-in user's workspace, and a failure becomes an
// error state that is logged by code only. T-10 (REQ-3): it passes the current-workspace cookie
// on as a preference. The session, cookies and database are stubbed here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let requireSession: () => Promise<unknown>;
vi.mock("@/server/auth", () => ({ requireSession: () => requireSession() }));
let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "dot-workspace" && cookieValue !== undefined
        ? { name, value: cookieValue }
        : undefined,
  }),
}));
const fakeDb = { fake: true };
vi.mock("@/server/db", () => ({ getDb: () => fakeDb }));
let resolve: (db: unknown, userId: string, preferred: string | null) => Promise<unknown>;
let list: (db: unknown, userId: string) => Promise<unknown>;
let inviteActive: (db: unknown, userId: string, workspaceId: string) => Promise<unknown>;
vi.mock("./service", () => ({
  resolveCurrentWorkspace: (db: unknown, userId: string, preferred: string | null) =>
    resolve(db, userId, preferred),
  listWorkspaces: (db: unknown, userId: string) => list(db, userId),
  inviteLinkActive: (db: unknown, userId: string, workspaceId: string) =>
    inviteActive(db, userId, workspaceId),
}));

const { getCurrentWorkspace, getInviteLinkState, getWorkspaceChoices } = await import("./current");

const SESSION = { user: { id: "user-1", name: "Ada" }, expires: "2099-01-01T00:00:00.000Z" };
const WS_ID = "6f1c2f5e-8d1a-4a53-9a43-2b4c1f9e7a10";

beforeEach(() => {
  requireSession = async () => SESSION;
  cookieValue = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("REQ-2: the signed-in page's workspace", () => {
  it("REQ-2: ensures the signed-in user's workspace and returns it", async () => {
    const calls: unknown[][] = [];
    resolve = async (db, userId, preferred) => {
      calls.push([db, userId, preferred]);
      return { id: "ws-1", name: "Ada's workspace", role: "owner" };
    };
    await expect(getCurrentWorkspace()).resolves.toEqual({
      ok: true,
      workspace: { id: "ws-1", name: "Ada's workspace", role: "owner" },
    });
    expect(calls).toEqual([[fakeDb, "user-1", null]]);
  });

  it("REQ-2: a failure gives an error state and logs a code, never the message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    resolve = async () => {
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
    resolve = async () => expect.unreachable("no query when signed out");
    await expect(getCurrentWorkspace()).rejects.toBe(redirect);
  });

  it("REQ-2: Next's own signals from inside the query pass through", async () => {
    const signal = Object.assign(new Error("dynamic"), { digest: "DYNAMIC_SERVER_USAGE" });
    resolve = async () => {
      throw signal;
    };
    await expect(getCurrentWorkspace()).rejects.toBe(signal);
  });
});

describe("REQ-3: the current workspace on pages", () => {
  it("REQ-3: the current-workspace cookie is passed on as a preference for the service to check", async () => {
    cookieValue = WS_ID;
    const seen: unknown[] = [];
    resolve = async (_db, _userId, preferred) => {
      seen.push(preferred);
      return { id: WS_ID, name: "Team", role: "member" };
    };
    await expect(getCurrentWorkspace()).resolves.toMatchObject({ ok: true });
    expect(seen).toEqual([WS_ID]);
  });

  it("REQ-3: the header's list of workspaces comes from the service; a failure is null, logged by code", async () => {
    list = async (_db, userId) => [{ id: WS_ID, name: `${userId}'s`, role: "owner" }];
    await expect(getWorkspaceChoices()).resolves.toEqual([
      { id: WS_ID, name: "user-1's", role: "owner" },
    ]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    list = async () => {
      throw Object.assign(new Error("password=x"), { code: "57P01" });
    };
    await expect(getWorkspaceChoices()).resolves.toBeNull();
    expect(String(log.mock.calls[0]?.[0])).toBe("[workspace] list failed: Error (57P01)");
  });

  it("REQ-3: the invite-link state is asked for as the signed-in user; not the owner means not ok", async () => {
    const calls: unknown[][] = [];
    inviteActive = async (db, userId, workspaceId) => {
      calls.push([db, userId, workspaceId]);
      return true;
    };
    await expect(getInviteLinkState(WS_ID)).resolves.toEqual({ ok: true, active: true });
    expect(calls).toEqual([[fakeDb, "user-1", WS_ID]]);
    inviteActive = async () => null;
    await expect(getInviteLinkState(WS_ID)).resolves.toEqual({ ok: false });
  });
});
