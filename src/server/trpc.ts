import { initTRPC } from "@trpc/server";

// Per-request context. Empty until sign-in (T-8) adds the session.
export async function createTRPCContext() {
  return {};
}

type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create({
  // Stack traces only when explicitly in development, not whenever NODE_ENV is unset.
  isDev: process.env.NODE_ENV === "development",
  errorFormatter({ shape, error }) {
    // Unexpected errors can carry database or library text; never send it to the client.
    if (error.code === "INTERNAL_SERVER_ERROR") {
      return { ...shape, message: "Internal server error" };
    }
    return shape;
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

// Callable without signing in. Keep these few and cheap.
export const publicProcedure = t.procedure;
