// T-9 (REQ-2): every signed-in user owns a workspace, and its owner can rename it. Queries go
// through Drizzle only and select just the columns the callers need. No "server-only" import, so
// the tRPC routers (and their tests) can load it; nothing in the browser imports it.
import { createHash } from "node:crypto";
import { and, asc, eq, exists, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import { memberships, users, workspaces, type roleEnum } from "@/server/db/schema";
import { defaultWorkspaceName } from "./name";

export type WorkspaceRole = (typeof roleEnum.enumValues)[number];
export type CurrentWorkspace = { id: string; name: string; role: WorkspaceRole };

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
  const owner = db
    .select({ one: sql`1` })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, userId),
        eq(memberships.role, "owner"),
      ),
    );
  const [renamed] = await db
    .update(workspaces)
    .set({ name, updatedAt: sql`now()` })
    .where(and(eq(workspaces.id, workspaceId), exists(owner)))
    .returning({ id: workspaces.id, name: workspaces.name });
  return renamed ?? null;
}
