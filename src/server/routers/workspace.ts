// T-9 (REQ-2): the caller's workspace and renaming it. Every procedure needs a session; who is
// asking comes from the server-side session, never from the input.
// T-10 (REQ-3): the caller's workspaces and switching between them, and the owner's invite link
// and members list. Owner actions act on the current workspace (the cookie's choice, checked
// against the caller's memberships, else the one they own).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Database } from "@/server/db";
import { MAX_ID_LENGTH, isUuid } from "@/server/ids";
import { hashInviteToken, newInviteToken } from "@/server/invite/token";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { workspaceNameSchema } from "@/server/workspace/name";
import {
  listMembers,
  listWorkspaces,
  membershipOf,
  removeMember,
  renameWorkspace,
  resolveCurrentWorkspace,
  setInviteHash,
} from "@/server/workspace/service";

// One answer for a workspace that doesn't exist and one the caller may not see or change, so
// the answer never tells them which. Removing a member has its own, used the same way.
const NOT_FOUND_MESSAGE = "Workspace not found.";
const MEMBER_NOT_FOUND_MESSAGE = "Member not found.";

function notFound(message = NOT_FOUND_MESSAGE): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message });
}

// Any id is accepted up to MAX_ID_LENGTH; one that isn't a UUID gets the same NOT_FOUND as an
// unknown one, without a query.
const idSchema = z.string().max(MAX_ID_LENGTH);

type Ctx = {
  db: () => Database;
  session: { user: { id: string } };
  workspaceCookie: string | null;
};

function currentWorkspace(ctx: Ctx) {
  return resolveCurrentWorkspace(ctx.db(), ctx.session.user.id, ctx.workspaceCookie);
}

export const workspaceRouter = createTRPCRouter({
  // The workspace this request acts on: the cookie's choice if the caller is still a member of
  // it, else the one they own (created if they own none).
  current: protectedProcedure.query(({ ctx }) => currentWorkspace(ctx)),

  // Every workspace the caller belongs to, for the header's switcher.
  list: protectedProcedure.query(({ ctx }) => listWorkspaces(ctx.db(), ctx.session.user.id)),

  // Makes a workspace the caller belongs to the current one (kept in an httpOnly cookie).
  switch: protectedProcedure
    .input(z.object({ workspaceId: idSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!isUuid(input.workspaceId)) throw notFound();
      const chosen = await membershipOf(ctx.db(), ctx.session.user.id, input.workspaceId);
      if (!chosen) throw notFound();
      ctx.setWorkspaceCookie(chosen.id);
      return chosen;
    }),

  // The id must name the current workspace (so a tab left open on another one can't rename the
  // wrong one), and the caller must own it.
  rename: protectedProcedure
    .input(z.object({ workspaceId: idSchema, name: workspaceNameSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!isUuid(input.workspaceId)) throw notFound();
      const current = await currentWorkspace(ctx);
      if (current.id !== input.workspaceId.toLowerCase()) throw notFound();
      const renamed = await renameWorkspace(ctx.db(), ctx.session.user.id, current.id, input.name);
      if (!renamed) throw notFound();
      return renamed;
    }),

  // A new invite link for the current workspace, replacing any old one. The token is returned
  // this once; only its hash is stored.
  createInvite: protectedProcedure.mutation(async ({ ctx }) => {
    const current = await currentWorkspace(ctx);
    const token = newInviteToken();
    const saved = await setInviteHash(
      ctx.db(),
      ctx.session.user.id,
      current.id,
      hashInviteToken(token),
    );
    if (!saved) throw notFound();
    return { token };
  }),

  // Turns the current workspace's invite link off.
  disableInvite: protectedProcedure.mutation(async ({ ctx }) => {
    const current = await currentWorkspace(ctx);
    const cleared = await setInviteHash(ctx.db(), ctx.session.user.id, current.id, null);
    if (!cleared) throw notFound();
    return { active: false as const };
  }),

  // The current workspace's members: id, name, role and join date only.
  members: protectedProcedure.query(async ({ ctx }) => {
    const current = await currentWorkspace(ctx);
    const members = await listMembers(ctx.db(), ctx.session.user.id, current.id);
    if (!members) throw notFound();
    return members;
  }),

  // Removes a member from the current workspace and turns its invite link off. The owner's row
  // is never removed; a caller who isn't the owner, an unknown id and the owner's own id all get
  // the same NOT_FOUND, and the link stays as it was.
  removeMember: protectedProcedure
    .input(z.object({ userId: idSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!isUuid(input.userId)) throw notFound(MEMBER_NOT_FOUND_MESSAGE);
      const current = await currentWorkspace(ctx);
      const removed = await removeMember(ctx.db(), ctx.session.user.id, current.id, input.userId);
      if (!removed) throw notFound(MEMBER_NOT_FOUND_MESSAGE);
      // Removing also turned the invite link off, so the settings page can say so.
      return { userId: input.userId, inviteActive: false as const };
    }),
});
