import { healthRouter } from "@/server/routers/health";
import { workspaceRouter } from "@/server/routers/workspace";
import { createTRPCRouter } from "@/server/trpc";

export const appRouter = createTRPCRouter({
  health: healthRouter,
  workspace: workspaceRouter,
});

export type AppRouter = typeof appRouter;
