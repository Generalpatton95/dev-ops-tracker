// T-9 (REQ-2): the caller's workspace and renaming it. Both need a session; who is asking comes
// from the server-side session, never from the input.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { workspaceNameSchema } from "@/server/workspace/name";
import { ensureOwnedWorkspace, renameWorkspace } from "@/server/workspace/service";

// One answer for a workspace that doesn't exist and one the caller may not rename, so the
// answer never tells them which.
const NOT_FOUND_MESSAGE = "Workspace not found.";

// Any id is accepted up to this length; one that isn't a UUID can't name a workspace, so it gets
// the same NOT_FOUND without a query (Postgres would reject it as a uuid).
const MAX_ID_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: NOT_FOUND_MESSAGE });
}

export const workspaceRouter = createTRPCRouter({
  // In M1 the current workspace is the one the caller owns, created if they own none.
  current: protectedProcedure.query(({ ctx }) =>
    ensureOwnedWorkspace(ctx.db(), ctx.session.user.id),
  ),

  rename: protectedProcedure
    .input(z.object({ workspaceId: z.string().max(MAX_ID_LENGTH), name: workspaceNameSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!UUID.test(input.workspaceId)) throw notFound();
      const renamed = await renameWorkspace(
        ctx.db(),
        ctx.session.user.id,
        input.workspaceId,
        input.name,
      );
      if (!renamed) throw notFound();
      return renamed;
    }),
});
