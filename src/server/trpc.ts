import { initTRPC, TRPCError } from "@trpc/server";
import type { AppSession } from "@/server/auth/config";
import type { Database } from "@/server/db";

// Per-request context. The route looks the session up on the server (T-8, REQ-1) and passes it
// in; nothing the client sends can set it. The route also passes the app's database (T-9); it is
// a function so procedures that don't need it never connect. Tests pass their own.
export async function createTRPCContext(
  opts: { session?: AppSession | null; db?: () => Database } = {},
) {
  return { session: opts.session ?? null, db: opts.db ?? noDatabase };
}

function noDatabase(): never {
  throw new Error("No database in this tRPC context");
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

// Callable without signing in. Keep these few and cheap; the route rate-limits signed-out calls.
export const publicProcedure = t.procedure;

// Needs a signed-in user (T-8, REQ-1); `ctx.session` is then never null.
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in first." });
  }
  return next({ ctx: { session: ctx.session } });
});
