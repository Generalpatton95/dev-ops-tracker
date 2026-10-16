import { createTRPCRouter, publicProcedure } from "@/server/trpc";

export const healthRouter = createTRPCRouter({
  ping: publicProcedure.query(() => ({ status: "ok" as const })),
});
