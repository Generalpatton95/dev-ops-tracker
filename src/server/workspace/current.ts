// T-9 (REQ-2): the signed-in user's workspace for pages and layouts. The signed-in header calls
// it, so every signed-in page ensures the user owns a workspace; pages that show it call it too,
// and React's cache() makes that one database round per render.
import "server-only";
import { cache } from "react";
import { requireSession } from "@/server/auth";
import { getDb } from "@/server/db";
import { errorLabel } from "@/server/log-label";
import { ensureOwnedWorkspace, type CurrentWorkspace } from "./service";

export type CurrentWorkspaceResult = { ok: true; workspace: CurrentWorkspace } | { ok: false };

/**
 * The signed-in user's workspace, created if they own none, or `{ ok: false }` if that failed
 * (logged by error kind and code only, never the message). Signed out, it redirects to sign-in
 * like requireSession(). Reads the request, so call it inside a <Suspense> boundary.
 */
export const getCurrentWorkspace = cache(async (): Promise<CurrentWorkspaceResult> => {
  const { user } = await requireSession();
  try {
    return { ok: true, workspace: await ensureOwnedWorkspace(getDb(), user.id) };
  } catch (error) {
    // Next's own control-flow signals (redirects, "dynamic usage" while prerendering) must pass.
    if (error && typeof error === "object" && "digest" in error) throw error;
    console.error(`[workspace] ensure failed: ${errorLabel(error)}`);
    return { ok: false };
  }
});
