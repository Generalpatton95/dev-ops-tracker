// T-9 (REQ-2): every signed-in user owns exactly one workspace, and only its owner can rename it.
// Against a database of its own on TEST_DATABASE_URL (skipped without it); the lock key is
// checked without one.
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFreshDatabase,
  freshDatabaseSkipReason,
  type FreshDatabase,
} from "@/server/db/fresh-test-database";
import { memberships, users, workspaces } from "@/server/db/schema";
import {
  ensureOwnedWorkspace,
  inviteLinkActive,
  listMembers,
  removeMember,
  renameWorkspace,
  resolveCurrentWorkspace,
  setInviteHash,
  workspaceLockKey,
} from "./service";

const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);

describe("REQ-2: the per-user advisory lock key", () => {
  it("REQ-2: is stable per user, differs between users and fits a Postgres bigint", () => {
    const a = "6f1c2f5e-8d1a-4a53-9a43-2b4c1f9e7a10";
    const b = "0b8e4c9a-3f2d-4e71-8c55-7d9a1e2f3b40";
    expect(workspaceLockKey(a)).toBe(workspaceLockKey(a));
    expect(workspaceLockKey(a)).not.toBe(workspaceLockKey(b));
    for (const id of [a, b]) {
      const key = BigInt(workspaceLockKey(id));
      expect(key >= INT64_MIN && key <= INT64_MAX).toBe(true);
    }
  });
});

const skipReason = await freshDatabaseSkipReason();
if (skipReason) console.warn(`[workspace service.test] ${skipReason}`);

describe.skipIf(skipReason !== undefined)("REQ-2: owned workspaces in Postgres", () => {
  let fresh: FreshDatabase;
  let nextGithubId = 1000;

  beforeAll(async () => {
    fresh = await createFreshDatabase("t9_ws");
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

  async function membershipsOf(userId: string) {
    return fresh.db
      .select({ workspaceId: memberships.workspaceId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, userId));
  }

  async function workspaceRow(id: string) {
    const [row] = await fresh.db
      .select({ name: workspaces.name, updatedAt: workspaces.updatedAt })
      .from(workspaces)
      .where(eq(workspaces.id, id));
    return row;
  }

  it("REQ-2: first sign-in creates a workspace with the user as owner (on their first page)", async () => {
    const userId = await addUser("Ada Lovelace");
    expect(await membershipsOf(userId)).toEqual([]);

    const workspace = await ensureOwnedWorkspace(fresh.db, userId);

    expect(workspace).toEqual({
      id: expect.any(String),
      name: "Ada Lovelace's workspace",
      role: "owner",
    });
    expect(await membershipsOf(userId)).toEqual([{ workspaceId: workspace.id, role: "owner" }]);
    expect((await workspaceRow(workspace.id))?.name).toBe("Ada Lovelace's workspace");
  });

  it("REQ-2: later pages reuse the same workspace and create nothing more", async () => {
    const userId = await addUser("Grace");
    const first = await ensureOwnedWorkspace(fresh.db, userId);
    const before = await workspaceRow(first.id);
    for (let i = 0; i < 3; i++) {
      expect(await ensureOwnedWorkspace(fresh.db, userId)).toEqual(first);
    }
    expect(await membershipsOf(userId)).toHaveLength(1);
    expect(await workspaceRow(first.id)).toEqual(before);
  });

  it("REQ-2: ten concurrent calls for one user create exactly one workspace", async () => {
    const userId = await addUser("Two Tabs");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ensureOwnedWorkspace(fresh.db, userId)),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    const rows = await membershipsOf(userId);
    expect(rows).toEqual([{ workspaceId: [...ids][0], role: "owner" }]);
    const [{ n }] = await fresh.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaces)
      .where(eq(workspaces.name, "Two Tabs's workspace"));
    expect(n).toBe(1);
  }, 30_000);

  it("REQ-2: calls that all missed the workspace wait on the user's lock and still make one", async () => {
    // Hold this user's lock from another connection, so every call gets past the first lookup
    // (nothing there yet) and must queue on the lock; then let them go at once.
    const userId = await addUser("Raced");
    const holder = new pg.Client({ connectionString: fresh.url });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1::bigint)", [workspaceLockKey(userId)]);
      const calls = Array.from({ length: 10 }, () => ensureOwnedWorkspace(fresh.db, userId));
      // The test pool has 4 connections, so up to 4 calls wait on the lock at a time.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await holder.query<{ n: number }>(
          "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted " +
            "and database = (select oid from pg_database where datname = current_database())",
        );
        if ((rows[0]?.n ?? 0) >= 4) break;
        if (Date.now() > deadline) throw new Error("the calls never waited on the lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await holder.query("commit");
      const results = await Promise.all(calls);
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(await membershipsOf(userId)).toHaveLength(1);
    } finally {
      await holder.end();
    }
  }, 30_000);

  it("REQ-2: an existing user with no workspace (signed in before T-9) gets one", async () => {
    // Also a member elsewhere, which doesn't count as owning a workspace.
    const ownerId = await addUser("Other Owner");
    const other = await ensureOwnedWorkspace(fresh.db, ownerId);
    const userId = await addUser("Early User");
    await fresh.db.insert(memberships).values({ userId, workspaceId: other.id, role: "member" });

    const workspace = await ensureOwnedWorkspace(fresh.db, userId);

    expect(workspace.id).not.toBe(other.id);
    expect(workspace).toMatchObject({ name: "Early User's workspace", role: "owner" });
    expect(await membershipsOf(userId)).toHaveLength(2);
  });

  it("REQ-2: a user who already owns a workspace keeps it unchanged", async () => {
    const userId = await addUser("Has One");
    const [existing] = await fresh.db
      .insert(workspaces)
      .values({ name: "Hand-made" })
      .returning({ id: workspaces.id });
    await fresh.db.insert(memberships).values({ userId, workspaceId: existing.id, role: "owner" });
    const before = await workspaceRow(existing.id);

    expect(await ensureOwnedWorkspace(fresh.db, userId)).toEqual({
      id: existing.id,
      name: "Hand-made",
      role: "owner",
    });
    expect(await membershipsOf(userId)).toHaveLength(1);
    expect(await workspaceRow(existing.id)).toEqual(before);
  });

  it('REQ-2: a user with a blank name gets "My workspace"; a long name is cut to 50', async () => {
    const blank = await ensureOwnedWorkspace(fresh.db, await addUser("   "));
    expect(blank.name).toBe("My workspace");
    const long = await ensureOwnedWorkspace(fresh.db, await addUser("L".repeat(70)));
    expect(long.name).toBe(`${"L".repeat(38)}'s workspace`);
  });

  it("REQ-2: an unknown user id fails with a loggable code and creates nothing", async () => {
    const [{ n: before }] = await fresh.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaces);
    await expect(
      ensureOwnedWorkspace(fresh.db, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ name: "WorkspaceSetupError", code: "user_missing" });
    const [{ n: after }] = await fresh.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaces);
    expect(after).toBe(before);
  });

  it("REQ-2: the owner can rename the workspace, and updated_at moves", async () => {
    const userId = await addUser("Renamer");
    const workspace = await ensureOwnedWorkspace(fresh.db, userId);
    const before = await workspaceRow(workspace.id);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await renameWorkspace(fresh.db, userId, workspace.id, "Platform team")).toEqual({
      id: workspace.id,
      name: "Platform team",
    });
    const after = await workspaceRow(workspace.id);
    expect(after?.name).toBe("Platform team");
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
    expect(await ensureOwnedWorkspace(fresh.db, userId)).toMatchObject({ name: "Platform team" });
  });

  it("REQ-2: a member, another user or an unknown id can't rename, and nothing changes", async () => {
    const ownerId = await addUser("Real Owner");
    const workspace = await ensureOwnedWorkspace(fresh.db, ownerId);
    const memberId = await addUser("Just Member");
    await fresh.db
      .insert(memberships)
      .values({ userId: memberId, workspaceId: workspace.id, role: "member" });
    const strangerId = await addUser("Stranger");
    await ensureOwnedWorkspace(fresh.db, strangerId);
    const before = await workspaceRow(workspace.id);

    expect(await renameWorkspace(fresh.db, memberId, workspace.id, "Taken")).toBeNull();
    expect(await renameWorkspace(fresh.db, strangerId, workspace.id, "Taken")).toBeNull();
    expect(
      await renameWorkspace(fresh.db, ownerId, "00000000-0000-4000-8000-000000000000", "Taken"),
    ).toBeNull();
    expect(await workspaceRow(workspace.id)).toEqual(before);
  });

  // T-10 (REQ-3): the owner-only reads and writes, checked inside each statement.
  async function teamWithMember(owner: string, member: string) {
    const ownerId = await addUser(owner);
    const workspace = await ensureOwnedWorkspace(fresh.db, ownerId);
    const memberId = await addUser(member);
    await fresh.db
      .insert(memberships)
      .values({ userId: memberId, workspaceId: workspace.id, role: "member" });
    return { ownerId, memberId, workspace };
  }

  it("REQ-3: only the owner learns whether the invite link is on, and only the owner can set it", async () => {
    const { ownerId, memberId, workspace } = await teamWithMember("Link Keeper", "Link Member");
    expect(await inviteLinkActive(fresh.db, ownerId, workspace.id)).toBe(false);
    expect(await setInviteHash(fresh.db, memberId, workspace.id, "a".repeat(64))).toBe(false);
    expect(await inviteLinkActive(fresh.db, ownerId, workspace.id)).toBe(false);
    expect(await setInviteHash(fresh.db, ownerId, workspace.id, "b".repeat(64))).toBe(true);
    expect(await inviteLinkActive(fresh.db, ownerId, workspace.id)).toBe(true);
    expect(await inviteLinkActive(fresh.db, memberId, workspace.id)).toBeNull();
    expect(await setInviteHash(fresh.db, ownerId, workspace.id, null)).toBe(true);
    expect(await inviteLinkActive(fresh.db, ownerId, workspace.id)).toBe(false);
  });

  it("REQ-3: the members list is the owner's only; a member or stranger gets null", async () => {
    const { ownerId, memberId, workspace } = await teamWithMember("Roster Keeper", "On Roster");
    const strangerId = await addUser("Roster Stranger");
    expect((await listMembers(fresh.db, ownerId, workspace.id))?.map((m) => m.name)).toEqual([
      "Roster Keeper",
      "On Roster",
    ]);
    expect(await listMembers(fresh.db, memberId, workspace.id)).toBeNull();
    expect(await listMembers(fresh.db, strangerId, workspace.id)).toBeNull();
  });

  it("REQ-3: one guarded DELETE removes a member, never the owner's row", async () => {
    const { ownerId, memberId, workspace } = await teamWithMember("Delete Keeper", "Deleted");
    const other = await teamWithMember("Other Keeper", "Other Member");
    expect(await removeMember(fresh.db, memberId, workspace.id, ownerId)).toBe(false);
    expect(await removeMember(fresh.db, ownerId, workspace.id, ownerId)).toBe(false);
    // An owner can't reach into another workspace.
    expect(await removeMember(fresh.db, ownerId, other.workspace.id, other.memberId)).toBe(false);
    expect(await removeMember(fresh.db, ownerId, workspace.id, memberId)).toBe(true);
    expect(await removeMember(fresh.db, ownerId, workspace.id, memberId)).toBe(false);
    expect(await membershipsOf(ownerId)).toEqual([{ workspaceId: workspace.id, role: "owner" }]);
    expect(await membershipsOf(other.memberId)).toHaveLength(1);
  });

  it("REQ-3: the current workspace is the cookie's choice only while the user is a member of it", async () => {
    const { memberId, workspace } = await teamWithMember("Choice Keeper", "Chooser");
    expect(await resolveCurrentWorkspace(fresh.db, memberId, workspace.id)).toEqual({
      id: workspace.id,
      name: workspace.name,
      role: "member",
    });
    await fresh.db.delete(memberships).where(eq(memberships.userId, memberId));
    const fallback = await resolveCurrentWorkspace(fresh.db, memberId, workspace.id);
    expect(fallback).toMatchObject({ name: "Chooser's workspace", role: "owner" });
    expect(await resolveCurrentWorkspace(fresh.db, memberId, "junk")).toEqual(fallback);
    expect(await resolveCurrentWorkspace(fresh.db, memberId, null)).toEqual(fallback);
  });
});
