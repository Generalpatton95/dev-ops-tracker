import { healthRouter } from "@/server/routers/health";
import { inviteRouter } from "@/server/routers/invite";
import { workspaceRouter } from "@/server/routers/workspace";
import { createTRPCRouter } from "@/server/trpc";

export const appRouter = createTRPCRouter({
  health: healthRouter,
  invite: inviteRouter,
  workspace: workspaceRouter,
});

export type AppRouter = typeof appRouter;
