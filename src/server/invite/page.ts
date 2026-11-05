// T-10 (REQ-3): the invite page's lookup. It calls invite.preview through a server-side tRPC
// caller, so the page gets exactly the procedure's checks: the session, the per-user rate limit
// (shared with joining) and the neutral answer for any token that isn't working. Looking only;
// joining needs the Join button's POST.
import "server-only";
import { TRPCError } from "@trpc/server";
import { requireSession } from "@/server/auth";
import { getDb } from "@/server/db";
import { errorLabel } from "@/server/log-label";
import { limitUser } from "@/server/rate-limit";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory, createTRPCContext } from "@/server/trpc";

export type InvitePreview =
  { ok: true; name: string } | { ok: false; reason: "not-working" | "too-many" | "unavailable" };

const createCaller = createCallerFactory(appRouter);

/** What the invite page shows for this token. Signed out, it redirects to sign-in and back. */
export async function previewInvite(token: string): Promise<InvitePreview> {
  const session = await requireSession();
  const caller = createCaller(
    await createTRPCContext({
      session,
      db: getDb,
      limitUser,
      // Looking at an invite never changes the current workspace.
      setWorkspaceCookie: () => {
        throw new Error("invite.preview never sets the workspace cookie");
      },
    }),
  );
  try {
    const { name } = await caller.invite.preview({ token });
    return { ok: true, name };
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    if (error instanceof TRPCError) {
      if (error.code === "NOT_FOUND") return { ok: false, reason: "not-working" };
      if (error.code === "TOO_MANY_REQUESTS") return { ok: false, reason: "too-many" };
      if (error.code === "SERVICE_UNAVAILABLE") return { ok: false, reason: "unavailable" };
    }
    console.error(`[invite] preview failed: ${errorLabel(error)}`);
    return { ok: false, reason: "unavailable" };
  }
}
