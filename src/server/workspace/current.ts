// T-9 (REQ-2): the signed-in user's workspace for pages and layouts. The signed-in header calls
// it, so every signed-in page ensures the user owns a workspace; pages that show it call it too,
// and React's cache() makes that one database round per render.
// T-10 (REQ-3): "the user's workspace" is now the current one: the cookie's choice when they are
// still a member of it, else the one they own. Also the header's list of workspaces and the
// settings page's invite-link state.
import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { requireSession } from "@/server/auth";
import { getDb } from "@/server/db";
import { errorLabel } from "@/server/log-label";
import { workspaceCookieName } from "./cookie";
import {
  inviteLinkActive,
  listWorkspaces,
  resolveCurrentWorkspace,
  type CurrentWorkspace,
} from "./service";

export type CurrentWorkspaceResult = { ok: true; workspace: CurrentWorkspace } | { ok: false };

// Next's own control-flow signals (redirects, "dynamic usage" while prerendering) must pass.
function rethrowNextSignal(error: unknown) {
  if (error && typeof error === "object" && "digest" in error) throw error;
}

/**
 * The signed-in user's current workspace (created if they own none and have no other choice),
 * or `{ ok: false }` if that failed (logged by error kind and code only, never the message).
 * Signed out, it redirects to sign-in like requireSession(). Reads the request, so call it
 * inside a <Suspense> boundary.
 */
export const getCurrentWorkspace = cache(async (): Promise<CurrentWorkspaceResult> => {
  const { user } = await requireSession();
  const preferred = (await cookies()).get(workspaceCookieName())?.value ?? null;
  try {
    return { ok: true, workspace: await resolveCurrentWorkspace(getDb(), user.id, preferred) };
  } catch (error) {
    rethrowNextSignal(error);
    console.error(`[workspace] ensure failed: ${errorLabel(error)}`);
    return { ok: false };
  }
});

/** Every workspace the signed-in user belongs to, for the header; null if the query failed. */
export const getWorkspaceChoices = cache(async (): Promise<CurrentWorkspace[] | null> => {
  const { user } = await requireSession();
  try {
    return await listWorkspaces(getDb(), user.id);
  } catch (error) {
    rethrowNextSignal(error);
    console.error(`[workspace] list failed: ${errorLabel(error)}`);
    return null;
  }
});

/**
 * Whether the workspace has a working invite link, for its owner's settings page. `{ ok: false }`
 * when the query failed or the signed-in user doesn't own it.
 */
export async function getInviteLinkState(
  workspaceId: string,
): Promise<{ ok: true; active: boolean } | { ok: false }> {
  const { user } = await requireSession();
  try {
    const active = await inviteLinkActive(getDb(), user.id, workspaceId);
    return active === null ? { ok: false } : { ok: true, active };
  } catch (error) {
    rethrowNextSignal(error);
    console.error(`[workspace] invite state failed: ${errorLabel(error)}`);
    return { ok: false };
  }
}
