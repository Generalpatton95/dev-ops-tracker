// T-9 (REQ-2): every signed-in user owns a workspace, and its owner can rename it.
// T-10 (REQ-3): the current workspace (any the user belongs to), the owner's invite link and
// members list. Owner-only actions check ownership inside the same statement, so there is no
// window between the check and the change. Queries go through Drizzle only and select just the
// columns the callers need. No "server-only" import, so the tRPC routers (and their tests) can
// load it; nothing in the browser imports it.
import { createHash } from "node:crypto";
import { and, asc, eq, exists, ne, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import { memberships, users, workspaces, type roleEnum } from "@/server/db/schema";
import { isUuid } from "@/server/ids";
import { defaultWorkspaceName } from "./name";

export type WorkspaceRole = (typeof roleEnum.enumValues)[number];
export type CurrentWorkspace = { id: string; name: string; role: WorkspaceRole };
/** What the owner sees about each member: no avatar, GitHub id or anything else. */
export type WorkspaceMember = {
  userId: string;
  name: string;
  role: WorkspaceRole;
  joinedAt: string;
};

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Queryable = Database | Transaction;

/** Raised when a workspace can't be set up; `code` is safe to log (see errorLabel). */
export class WorkspaceSetupError extends Error {
  override name = "WorkspaceSetupError";
  constructor(readonly code: "user_missing") {
    super(code);
  }
}

/**
 * The key for this user's pg_advisory_xact_lock: the first 64 bits of a SHA-256 of a fixed
 * prefix and the user id, as a signed bigint (Postgres's type). The same user always gets the
 * same key, so two tabs creating a workspace at once take turns; the prefix keeps it apart from
 * other locks (the preview seed uses a small constant).
 */
export function workspaceLockKey(userId: string): string {
  const digest = createHash("sha256").update(`dot:owned-workspace:${userId}`).digest();
  return digest.readBigInt64BE(0).toString();
}

function ownedWorkspace(db: Queryable, userId: string) {
  return db
    .select({ id: workspaces.id, name: workspaces.name, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, userId), eq(memberships.role, "owner")))
    .orderBy(asc(memberships.createdAt), asc(memberships.workspaceId))
    .limit(1);
}

/**
 * The workspace this user owns, created first if there is none (new users, accounts from before
 * T-9, a sign-in that stopped part-way). The usual case is one query. Otherwise, in one
 * transaction under a per-user advisory lock, it looks again and only then inserts the workspace
 * (named from the user's stored name) and an owner membership, so concurrent calls make one.
 */
export async function ensureOwnedWorkspace(
  db: Database,
  userId: string,
): Promise<CurrentWorkspace> {
  const [found] = await ownedWorkspace(db, userId);
  if (found) return found;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${workspaceLockKey(userId)}::bigint)`);
    const [existing] = await ownedWorkspace(tx, userId);
    if (existing) return existing;

    const [user] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new WorkspaceSetupError("user_missing");

    const [created] = await tx
      .insert(workspaces)
      .values({ name: defaultWorkspaceName(user.name) })
      .returning({ id: workspaces.id, name: workspaces.name });
    await tx.insert(memberships).values({ userId, workspaceId: created.id, role: "owner" });
    return { id: created.id, name: created.name, role: "owner" };
  });
}

/**
 * Renames the workspace if `userId` owns it, in one statement. Returns null when the workspace
 * doesn't exist or the user isn't its owner; callers answer both the same way. `name` must
 * already have passed workspaceNameSchema.
 */
export async function renameWorkspace(
  db: Database,
  userId: string,
  workspaceId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const [renamed] = await db
    .update(workspaces)
    .set({ name, updatedAt: sql`now()` })
    .where(and(eq(workspaces.id, workspaceId), exists(ownerCheck(db, userId, workspaceId))))
    .returning({ id: workspaces.id, name: workspaces.name });
  return renamed ?? null;
}

// "userId owns workspaceId", as a subquery for an owner-only statement's WHERE. Its values are
// parameters, so its `membership` never refers to an outer query's table.
function ownerCheck(db: Queryable, userId: string, workspaceId: string) {
  return db
    .select({ one: sql`1` })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, userId),
        eq(memberships.role, "owner"),
      ),
    );
}

/** The workspace and the user's role in it, or null when they aren't a member (or it's gone). */
export async function membershipOf(
  db: Queryable,
  userId: string,
  workspaceId: string,
): Promise<CurrentWorkspace | null> {
  const [found] = await db
    .select({ id: workspaces.id, name: workspaces.name, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
    .limit(1);
  return found ?? null;
}

/**
 * T-10: the workspace this request acts on. `preferredId` comes from the current-workspace
 * cookie and is only a preference: it is used when it is a UUID naming a workspace the user is
 * still a member of. Otherwise (missing, malformed, never theirs, or they were removed) it is
 * the workspace they own, created first if there is none.
 */
export async function resolveCurrentWorkspace(
  db: Database,
  userId: string,
  preferredId: string | null | undefined,
): Promise<CurrentWorkspace> {
  if (isUuid(preferredId)) {
    const chosen = await membershipOf(db, userId, preferredId);
    if (chosen) return chosen;
  }
  return ensureOwnedWorkspace(db, userId);
}

/** Every workspace the user belongs to: the one they own first, then by when they joined. */
export async function listWorkspaces(db: Database, userId: string): Promise<CurrentWorkspace[]> {
  return db
    .select({ id: workspaces.id, name: workspaces.name, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(
      sql`case when ${memberships.role} = 'owner' then 0 else 1 end`,
      asc(memberships.createdAt),
      asc(memberships.workspaceId),
    );
}

/**
 * Sets the workspace's invite hash (a new link replaces the old one) or clears it (null: the
 * link is off), if `userId` owns it, in one statement. False when it doesn't exist or isn't
 * theirs; callers answer both the same way. Only ever a hash: see src/server/invite/token.ts.
 */
export async function setInviteHash(
  db: Database,
  userId: string,
  workspaceId: string,
  hash: string | null,
): Promise<boolean> {
  const updated = await db
    .update(workspaces)
    .set({ inviteToken: hash, updatedAt: sql`now()` })
    .where(and(eq(workspaces.id, workspaceId), exists(ownerCheck(db, userId, workspaceId))))
    .returning({ id: workspaces.id });
  return updated.length > 0;
}

/** Whether the workspace has a working invite link, or null when `userId` doesn't own it. */
export async function inviteLinkActive(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<boolean | null> {
  const [row] = await db
    .select({ active: sql<boolean>`${workspaces.inviteToken} is not null` })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), exists(ownerCheck(db, userId, workspaceId))))
    .limit(1);
  return row ? row.active : null;
}

/**
 * The workspace's members (the owner first, then by join date), or null when `userId` doesn't
 * own it. One query: the owner always has a row of their own, so an empty answer can only mean
 * the check failed. Only the id (for Remove), name, role and join date leave the database.
 */
export async function listMembers(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMember[] | null> {
  const rows = await db
    .select({
      userId: memberships.userId,
      name: users.name,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(eq(memberships.workspaceId, workspaceId), exists(ownerCheck(db, userId, workspaceId))),
    )
    .orderBy(
      sql`case when ${memberships.role} = 'owner' then 0 else 1 end`,
      asc(memberships.createdAt),
      asc(memberships.userId),
    );
  if (rows.length === 0) return null;
  return rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() }));
}

/**
 * Removes `memberId` from the workspace if `userId` owns it, with one guarded DELETE that never
 * matches an owner's row, so the owner can't be removed (not even by themselves). When a row is
 * deleted, the invite link is turned off in the same transaction (decided 2026-11-02), so the
 * removed person can't rejoin with it. False when nothing was removed (not the owner, an unknown
 * member, or the owner's own row); the link is then left as it was.
 *
 * Lock order: the workspace row first (FOR UPDATE), then the membership, the same order a join
 * takes them (FOR SHARE on the workspace, then the membership insert in
 * src/server/invite/service.ts). So a join and a removal at the same moment queue behind each
 * other instead of deadlocking, and either the join lands first and is then removed, or the
 * removal (and the link going off) lands first and the join finds no working link.
 */
export async function removeMember(
  db: Database,
  userId: string,
  workspaceId: string,
  memberId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), exists(ownerCheck(tx, userId, workspaceId))))
      .limit(1)
      .for("update");
    if (!owned) return false;
    const removed = await tx
      .delete(memberships)
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, memberId),
          ne(memberships.role, "owner"),
          exists(ownerCheck(tx, userId, workspaceId)),
        ),
      )
      .returning({ userId: memberships.userId });
    if (removed.length === 0) return false;
    await tx
      .update(workspaces)
      .set({ inviteToken: null, updatedAt: sql`now()` })
      .where(eq(workspaces.id, workspaceId));
    return true;
  });
}
