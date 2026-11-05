// T-10 (REQ-3): finding a workspace by its invite link and joining it. Lookups go through the
// unique index on workspace.invite_token, by hash only (see ./token.ts). No "server-only"
// import, so the tRPC routers (and their tests) can load it; nothing in the browser imports it.
import { eq } from "drizzle-orm";
import type { Database } from "@/server/db";
import { memberships, workspaces } from "@/server/db/schema";
import { membershipOf, type CurrentWorkspace } from "@/server/workspace/service";

/** The name of the workspace whose working link has this hash, or null (wrong or turned off). */
export async function findInvite(db: Database, hash: string): Promise<{ name: string } | null> {
  const [found] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.inviteToken, hash))
    .limit(1);
  return found ?? null;
}

/**
 * Adds `userId` as a member of the workspace whose working link has this hash, and returns that
 * workspace and their role in it; null when no link has this hash. Someone already in it (the
 * owner opening their own link included) keeps their membership and role: nothing is
 * duplicated. The workspace row is locked FOR SHARE while joining, so turning the link off or
 * replacing it at the same moment waits, and a join never lands after the link has changed.
 * (FOR KEY SHARE would not do: invite_token's index is partial, so changing it isn't a "key"
 * update and wouldn't wait.)
 *
 * Racing a removal: removeMember locks this same workspace row FOR UPDATE before it deletes
 * (and it turns the link off), so the two never interleave. The insert can only find an
 * existing membership that is still there when it is read back below. If that read ever comes
 * back empty anyway, the insert did nothing and the transaction changes nothing, so the neutral
 * answer leaves no half state; with the link off after a removal, that answer is the true one.
 */
export async function joinByInvite(
  db: Database,
  userId: string,
  hash: string,
): Promise<CurrentWorkspace | null> {
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.inviteToken, hash))
      .limit(1)
      .for("share");
    if (!workspace) return null;
    await tx
      .insert(memberships)
      .values({ userId, workspaceId: workspace.id, role: "member" })
      .onConflictDoNothing({ target: [memberships.userId, memberships.workspaceId] });
    return membershipOf(tx, userId, workspace.id);
  });
}
