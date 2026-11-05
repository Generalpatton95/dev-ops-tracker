// T-10 (REQ-3): opening and joining an invite link. Both need a session, and both count in one
// per-user bucket (10 a minute) before anything else, so guessing tokens is slow even with
// malformed ones. Every wrong, malformed or turned-off token gets the same neutral NOT_FOUND.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { findInvite, joinByInvite } from "@/server/invite/service";
import { hashInviteToken, isInviteTokenFormat } from "@/server/invite/token";
import { createTRPCRouter, userLimitedProcedure } from "@/server/trpc";

export const INVITE_NOT_WORKING = "This invite link isn't working. Ask the owner for a new one.";

function notWorking(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: INVITE_NOT_WORKING });
}

const inviteProcedure = userLimitedProcedure("invite");

// Any string: one that isn't a token's shape gets the neutral answer without a query, whatever
// its length (the route's 100KB body cap and the URL length bound it).
const tokenInput = z.object({ token: z.string() });

export const inviteRouter = createTRPCRouter({
  // The workspace's name for "Join <name>". Nothing else: not its id, owner or members.
  preview: inviteProcedure.input(tokenInput).query(async ({ ctx, input }) => {
    if (!isInviteTokenFormat(input.token)) throw notWorking();
    const invite = await findInvite(ctx.db(), hashInviteToken(input.token));
    if (!invite) throw notWorking();
    return { name: invite.name };
  }),

  // Joins as a member (or keeps an existing membership) and makes it the current workspace.
  // A mutation, so it only ever runs on the Join button's POST, never on a page load.
  join: inviteProcedure.input(tokenInput).mutation(async ({ ctx, input }) => {
    if (!isInviteTokenFormat(input.token)) throw notWorking();
    const joined = await joinByInvite(ctx.db(), ctx.session.user.id, hashInviteToken(input.token));
    if (!joined) throw notWorking();
    ctx.setWorkspaceCookie(joined.id);
    return joined;
  }),
});
