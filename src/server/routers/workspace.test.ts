// T-9 (REQ-2), T-10 (REQ-3): the workspace tRPC procedures. Signed-out checks need no database;
// the rest run against a database of their own on TEST_DATABASE_URL (skipped without it).
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
import { hashInviteToken } from "@/server/invite/token";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory, createTRPCContext } from "@/server/trpc";

const createCaller = createCallerFactory(appRouter);
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

function sessionFor(id: string): AppSession {
  return { user: { id, name: "Test" }, expires: "2099-01-01T00:00:00.000Z" };
}

describe("REQ-2: workspace procedures while signed out", () => {
  // No database in the context: a signed-out call must be refused before any query.
  const caller = createCaller(() =>
    createTRPCContext({ session: null, db: () => expect.unreachable("no query") }),
  );

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
  const caller = createCaller(() =>
    createTRPCContext({
      session: sessionFor(UNKNOWN_ID),
      db: () => expect.unreachable("no query for a malformed id"),
    }),
  );

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

describe.skipIf(skipReason !== undefined)("REQ-3: switching, invites and members", () => {
  let fresh: FreshDatabase;
  let nextGithubId = 9000;

  beforeAll(async () => {
    fresh = await createFreshDatabase("t10_ws_router");
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

  // A caller whose cookie jar holds what the server set, sent back on its next calls.
  async function callerFor(userId: string, jar: { cookie: string | null } = { cookie: null }) {
    return createCaller(
      await createTRPCContext({
        session: sessionFor(userId),
        db: () => fresh.db,
        workspaceCookie: jar.cookie,
        setWorkspaceCookie: (id) => {
          jar.cookie = id;
        },
      }),
    );
  }

  // An owner's workspace with `memberNames` added as members (as joining would).
  async function team(ownerName: string, memberNames: string[] = []) {
    const ownerId = await addUser(ownerName);
    const owner = await callerFor(ownerId);
    const workspace = await owner.workspace.current();
    const memberIds: string[] = [];
    for (const name of memberNames) {
      const id = await addUser(name);
      await fresh.db
        .insert(memberships)
        .values({ userId: id, workspaceId: workspace.id, role: "member" });
      memberIds.push(id);
    }
    return { ownerId, owner, workspace, memberIds };
  }

  async function inviteHashOf(workspaceId: string) {
    const [row] = await fresh.db
      .select({ inviteToken: workspaces.inviteToken })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return row?.inviteToken;
  }

  async function settle<T>(promise: Promise<T>) {
    return promise.then(
      () => null,
      (e: unknown) => e,
    );
  }

  it("REQ-3: workspace.list shows every workspace the user is in, the owned one first, id/name/role only", async () => {
    const { workspace: theirs, memberIds } = await team("List Owner", ["List Member"]);
    const member = await callerFor(memberIds[0]!);
    const own = await member.workspace.current();
    const list = await member.workspace.list();
    expect(list).toEqual([own, { id: theirs.id, name: theirs.name, role: "member" }]);
    for (const item of list) expect(Object.keys(item).sort()).toEqual(["id", "name", "role"]);
  });

  it("REQ-3: switching to a workspace you're in sets the cookie, and later calls act on it", async () => {
    const { workspace, memberIds } = await team("Switch Owner", ["Switcher"]);
    const jar = { cookie: null as string | null };
    const member = await callerFor(memberIds[0]!, jar);
    await expect(member.workspace.switch({ workspaceId: workspace.id })).resolves.toEqual({
      id: workspace.id,
      name: workspace.name,
      role: "member",
    });
    expect(jar.cookie).toBe(workspace.id);
    const later = await callerFor(memberIds[0]!, jar);
    await expect(later.workspace.current()).resolves.toMatchObject({
      id: workspace.id,
      role: "member",
    });
  });

  it("REQ-3: switching to a workspace you aren't in, an unknown or a malformed id is NOT_FOUND and sets nothing", async () => {
    const { workspace } = await team("Private Owner");
    const strangerId = await addUser("Switch Stranger");
    const jar = { cookie: null as string | null };
    const stranger = await callerFor(strangerId, jar);
    for (const workspaceId of [workspace.id, UNKNOWN_ID, "not-a-uuid"]) {
      await expect(stranger.workspace.switch({ workspaceId })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Workspace not found.",
      });
    }
    expect(jar.cookie).toBeNull();
  });

  it("REQ-3: a cookie naming someone else's workspace, or junk, falls back to the user's own", async () => {
    const { workspace } = await team("Cookie Owner");
    const userId = await addUser("Cookie Holder");
    for (const cookie of [workspace.id, UNKNOWN_ID, "junk"]) {
      const current = await (await callerFor(userId, { cookie })).workspace.current();
      expect(current).toMatchObject({ name: "Cookie Holder's workspace", role: "owner" });
    }
  });

  it("REQ-3: the owner can create an invite link; only its hash is stored, and a new link replaces it", async () => {
    const { owner, workspace } = await team("Link Owner");
    expect(await inviteHashOf(workspace.id)).toBeNull();
    const first = await owner.workspace.createInvite();
    expect(Object.keys(first)).toEqual(["token"]);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await inviteHashOf(workspace.id)).toBe(hashInviteToken(first.token));

    const second = await owner.workspace.createInvite();
    expect(second.token).not.toBe(first.token);
    expect(await inviteHashOf(workspace.id)).toBe(hashInviteToken(second.token));
  });

  it("REQ-3: the owner can turn the invite link off", async () => {
    const { owner, workspace } = await team("Off Owner");
    await owner.workspace.createInvite();
    await expect(owner.workspace.disableInvite()).resolves.toEqual({ active: false });
    expect(await inviteHashOf(workspace.id)).toBeNull();
    // Turning off a link that is already off is fine too.
    await expect(owner.workspace.disableInvite()).resolves.toEqual({ active: false });
  });

  it("REQ-3: the owner sees all members: id, name, role and join date only, the owner first", async () => {
    const { ownerId, owner, memberIds } = await team("Roster Owner", ["Roster A", "Roster B"]);
    const members = await owner.workspace.members();
    expect(members.map((m) => [m.userId, m.name, m.role])).toEqual([
      [ownerId, "Roster Owner", "owner"],
      [memberIds[0], "Roster A", "member"],
      [memberIds[1], "Roster B", "member"],
    ]);
    for (const member of members) {
      expect(Object.keys(member).sort()).toEqual(["joinedAt", "name", "role", "userId"]);
      expect(new Date(member.joinedAt).toISOString()).toBe(member.joinedAt);
    }
  });

  it("REQ-3: the owner can remove any member, who then can't act in the workspace", async () => {
    const { owner, workspace, memberIds } = await team("Kick Owner", ["Kicked", "Stays"]);
    const jar = { cookie: workspace.id as string | null };
    await expect(owner.workspace.removeMember({ userId: memberIds[0]! })).resolves.toEqual({
      userId: memberIds[0],
      inviteActive: false,
    });
    expect((await owner.workspace.members()).map((m) => m.name)).toEqual(["Kick Owner", "Stays"]);
    // Removed: their cookie no longer counts, and switching back is refused.
    const removed = await callerFor(memberIds[0]!, jar);
    await expect(removed.workspace.current()).resolves.toMatchObject({ role: "owner" });
    await expect(removed.workspace.switch({ workspaceId: workspace.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("REQ-3: the owner can't be removed, not even by themselves", async () => {
    const { ownerId, owner, workspace } = await team("Kept Owner");
    await expect(owner.workspace.removeMember({ userId: ownerId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Member not found.",
    });
    const rows = await fresh.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(eq(memberships.workspaceId, workspace.id));
    expect(rows).toEqual([{ role: "owner" }]);
  });

  it("REQ-3: members and outsiders get the same NOT_FOUND for every owner action, and nothing changes", async () => {
    const { ownerId, owner, workspace, memberIds } = await team("Guarded Owner", ["M1", "M2"]);
    await owner.workspace.createInvite();
    const hashBefore = await inviteHashOf(workspace.id);
    // The member's current workspace is the team's (as after joining).
    const member = await callerFor(memberIds[0]!, { cookie: workspace.id });
    await expect(member.workspace.current()).resolves.toMatchObject({ id: workspace.id });
    const outsider = await callerFor(await addUser("Outsider"));

    const workspaceErrors = await Promise.all([
      settle(member.workspace.createInvite()),
      settle(member.workspace.disableInvite()),
      settle(member.workspace.members()),
      settle(member.workspace.rename({ workspaceId: workspace.id, name: "Mine" })),
      settle(outsider.workspace.rename({ workspaceId: workspace.id, name: "Mine" })),
    ]);
    for (const error of workspaceErrors) {
      expect(error).toMatchObject({ code: "NOT_FOUND", message: "Workspace not found." });
    }
    const memberErrors = await Promise.all([
      settle(member.workspace.removeMember({ userId: memberIds[1]! })),
      settle(member.workspace.removeMember({ userId: ownerId })),
      settle(outsider.workspace.removeMember({ userId: memberIds[1]! })),
      settle(owner.workspace.removeMember({ userId: UNKNOWN_ID })),
      settle(owner.workspace.removeMember({ userId: "not-a-uuid" })),
    ]);
    for (const error of memberErrors) {
      expect(error).toMatchObject({ code: "NOT_FOUND", message: "Member not found." });
    }
    expect(await inviteHashOf(workspace.id)).toBe(hashBefore);
    expect((await owner.workspace.members()).map((m) => m.name)).toEqual([
      "Guarded Owner",
      "M1",
      "M2",
    ]);
  });

  it("REQ-3: over HTTP, removing as a member, an unknown id and the owner's own id answer identically", async () => {
    const { ownerId, workspace, memberIds } = await team("Http Kick Owner", ["Http M"]);
    async function removeAs(userId: string, target: string, cookie: string | null) {
      const res = await fetchRequestHandler({
        endpoint: "/api/trpc",
        req: new Request("http://localhost/api/trpc/workspace.removeMember", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: target }),
        }),
        router: appRouter,
        createContext: () =>
          createTRPCContext({
            session: sessionFor(userId),
            db: () => fresh.db,
            workspaceCookie: cookie,
          }),
      });
      return { status: res.status, body: await res.text() };
    }
    const byMember = await removeAs(memberIds[0]!, ownerId, workspace.id);
    const unknown = await removeAs(ownerId, UNKNOWN_ID, null);
    const ownerSelf = await removeAs(ownerId, ownerId, null);
    expect(byMember.status).toBe(404);
    expect(unknown).toEqual(byMember);
    expect(ownerSelf).toEqual(byMember);
  });

  it("REQ-3: rename acts on the current workspace only: an owner switched elsewhere can't rename by id", async () => {
    const { workspace: other } = await team("Elsewhere Owner");
    const { ownerId, workspace: own } = await team("Moved Owner");
    await fresh.db
      .insert(memberships)
      .values({ userId: ownerId, workspaceId: other.id, role: "member" });
    const away = await callerFor(ownerId, { cookie: other.id });
    await expect(
      away.workspace.rename({ workspaceId: own.id, name: "Nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const home = await callerFor(ownerId);
    await expect(home.workspace.rename({ workspaceId: own.id, name: "Yes" })).resolves.toEqual({
      id: own.id,
      name: "Yes",
    });
  });
});
