// T-9 (REQ-2): the workspace tRPC procedures. Signed-out checks need no database; the rest run
// against a database of its own on TEST_DATABASE_URL (skipped without it).
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppSession } from "@/server/auth/config";
import {
  createFreshDatabase,
  freshDatabaseSkipReason,
  type FreshDatabase,
} from "@/server/db/fresh-test-database";
import { memberships, users, workspaces } from "@/server/db/schema";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory, createTRPCContext } from "@/server/trpc";

const createCaller = createCallerFactory(appRouter);
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

function sessionFor(id: string): AppSession {
  return { user: { id, name: "Test" }, expires: "2099-01-01T00:00:00.000Z" };
}

describe("REQ-2: workspace procedures while signed out", () => {
  // No database in the context: a signed-out call must be refused before any query.
  const caller = createCaller({ session: null, db: () => expect.unreachable("no query") });

  it("REQ-2: workspace.current answers UNAUTHORIZED when signed out", async () => {
    await expect(caller.workspace.current()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("REQ-2: workspace.rename answers UNAUTHORIZED when signed out", async () => {
    await expect(
      caller.workspace.rename({ workspaceId: UNKNOWN_ID, name: "Nope" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("REQ-2: a malformed workspace id", () => {
  // Signed in, but no database: a malformed id must be answered before any query.
  const caller = createCaller({
    session: sessionFor(UNKNOWN_ID),
    db: () => expect.unreachable("no query for a malformed id"),
  });

  it("REQ-2: a malformed id gets the same NOT_FOUND as an unknown one, without a query", async () => {
    for (const workspaceId of ["not-a-uuid", "", "1", `${UNKNOWN_ID}x`, "' or 1=1 --"]) {
      await expect(
        caller.workspace.rename({ workspaceId, name: "Mine" }),
        workspaceId,
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Workspace not found." });
    }
  });

  it("REQ-2: an id past the length cap is refused as bad input", async () => {
    await expect(
      caller.workspace.rename({ workspaceId: "a".repeat(101), name: "Mine" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

const skipReason = await freshDatabaseSkipReason();
if (skipReason) console.warn(`[workspace router.test] ${skipReason}`);

describe.skipIf(skipReason !== undefined)("REQ-2: workspace procedures", () => {
  let fresh: FreshDatabase;
  let nextGithubId = 5000;

  beforeAll(async () => {
    fresh = await createFreshDatabase("t9_router");
  }, 60_000);
  afterAll(async () => {
    await fresh?.drop();
  });

  async function addUser(name: string): Promise<string> {
    const [user] = await fresh.db
      .insert(users)
      .values({ name, githubId: nextGithubId++ })
      .returning({ id: users.id });
    return user.id;
  }

  async function callerFor(userId: string) {
    return createCaller(
      await createTRPCContext({ session: sessionFor(userId), db: () => fresh.db }),
    );
  }

  async function nameOf(id: string) {
    const [row] = await fresh.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, id));
    return row?.name;
  }

  it("REQ-2: workspace.current creates the user's owned workspace on first call, then reuses it", async () => {
    const userId = await addUser("Octo Cat");
    const caller = await callerFor(userId);
    const current = await caller.workspace.current();
    expect(current).toEqual({
      id: expect.any(String),
      name: "Octo Cat's workspace",
      role: "owner",
    });
    // Only the fields the page needs.
    expect(Object.keys(current).sort()).toEqual(["id", "name", "role"]);
    expect(await caller.workspace.current()).toEqual(current);
    const rows = await fresh.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    expect(rows).toEqual([{ role: "owner" }]);
  });

  it("REQ-2: the owner can rename the workspace; the name is trimmed", async () => {
    const caller = await callerFor(await addUser("Owner"));
    const { id } = await caller.workspace.current();
    await expect(caller.workspace.rename({ workspaceId: id, name: "  Ops  " })).resolves.toEqual({
      id,
      name: "Ops",
    });
    expect(await nameOf(id)).toBe("Ops");
    await expect(caller.workspace.current()).resolves.toMatchObject({ name: "Ops" });
  });

  it("REQ-2: a blank, too-long or control-character name is refused with BAD_REQUEST and nothing changes", async () => {
    const caller = await callerFor(await addUser("Validator"));
    const { id, name } = await caller.workspace.current();
    for (const bad of [
      "",
      "   ",
      "a".repeat(51),
      "\u{1F600}".repeat(51),
      // Postgres can't store NUL, so without the check this was a 500.
      "Ops\u0000",
      "Ops\nteam",
      "‮evil",
    ]) {
      await expect(
        caller.workspace.rename({ workspaceId: id, name: bad }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await nameOf(id)).toBe(name);
  });

  it("REQ-2: a non-owner, another user or an unknown id get the same NOT_FOUND", async () => {
    const ownerCaller = await callerFor(await addUser("The Owner"));
    const workspace = await ownerCaller.workspace.current();
    const memberId = await addUser("A Member");
    await fresh.db
      .insert(memberships)
      .values({ userId: memberId, workspaceId: workspace.id, role: "member" });
    const strangerCaller = await callerFor(await addUser("A Stranger"));
    await strangerCaller.workspace.current();

    const attempts = [
      (await callerFor(memberId)).workspace.rename({ workspaceId: workspace.id, name: "Mine" }),
      strangerCaller.workspace.rename({ workspaceId: workspace.id, name: "Mine" }),
      ownerCaller.workspace.rename({ workspaceId: UNKNOWN_ID, name: "Mine" }),
    ];
    const errors = await Promise.all(
      attempts.map((p) =>
        p.then(
          () => null,
          (e: unknown) => e,
        ),
      ),
    );
    for (const error of errors) {
      expect(error).toMatchObject({ code: "NOT_FOUND", message: "Workspace not found." });
    }
    expect(await nameOf(workspace.id)).toBe(workspace.name);
  });

  it("REQ-2: over HTTP the NOT_FOUND answer is identical for a forbidden, an unknown and a malformed id", async () => {
    const owner = await addUser("Http Owner");
    const workspace = await (await callerFor(owner)).workspace.current();
    const stranger = await addUser("Http Stranger");

    async function renameAs(userId: string, workspaceId: string) {
      const body = JSON.stringify({ workspaceId, name: "Mine" });
      const res = await fetchRequestHandler({
        endpoint: "/api/trpc",
        req: new Request("http://localhost/api/trpc/workspace.rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        router: appRouter,
        createContext: () => createTRPCContext({ session: sessionFor(userId), db: () => fresh.db }),
      });
      return { status: res.status, body: await res.text() };
    }

    const forbidden = await renameAs(stranger, workspace.id);
    const unknown = await renameAs(stranger, UNKNOWN_ID);
    const malformed = await renameAs(stranger, "not-a-uuid");
    expect(forbidden.status).toBe(404);
    expect(unknown).toEqual(forbidden);
    expect(malformed).toEqual(forbidden);
    expect(forbidden.body).not.toContain(workspace.id);
    expect(forbidden.body).not.toContain(workspace.name);
  });
});
