import { initTRPC, TRPCError } from "@trpc/server";
import type { AppSession } from "@/server/auth/config";
import type { Database } from "@/server/db";
import type { RateLimitResult, UserRateLimitBucket } from "@/server/rate-limit";

/** Counts one call by a signed-in user in a per-user bucket (src/server/rate-limit.ts). */
export type UserRateLimiter = (
  bucket: UserRateLimitBucket,
  userId: string,
) => Promise<RateLimitResult>;

// Per-request context. The route looks the session up on the server (T-8, REQ-1) and passes it
// in; nothing the client sends can set it. The route also passes the app's database (T-9); it is
// a function so procedures that don't need it never connect. Tests pass their own.
// T-10 (REQ-3): the route also passes the current-workspace cookie's value (a preference only;
// procedures check membership before using it), a way to set that cookie on the response, and
// the per-user rate limiter. Without a limiter every limited call is refused: it fails closed.
export async function createTRPCContext(
  opts: {
    session?: AppSession | null;
    db?: () => Database;
    workspaceCookie?: string | null;
    setWorkspaceCookie?: (workspaceId: string) => void;
    limitUser?: UserRateLimiter;
  } = {},
) {
  return {
    session: opts.session ?? null,
    db: opts.db ?? noDatabase,
    workspaceCookie: opts.workspaceCookie ?? null,
    setWorkspaceCookie: opts.setWorkspaceCookie ?? noCookies,
    limitUser: opts.limitUser ?? noLimiter,
  };
}

function noDatabase(): never {
  throw new Error("No database in this tRPC context");
}

function noCookies(): never {
  throw new Error("No cookie writer in this tRPC context");
}

async function noLimiter(): Promise<RateLimitResult> {
  return { ok: false, status: 503 };
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

/**
 * T-10 (REQ-3): a protectedProcedure that also counts each call in a per-user bucket before it
 * runs (so malformed input costs a call too). Over the limit it answers TOO_MANY_REQUESTS; if
 * the limiter can't run, SERVICE_UNAVAILABLE: it fails closed, never a free pass.
 */
export function userLimitedProcedure(bucket: UserRateLimitBucket) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    const limited = await ctx.limitUser(bucket, ctx.session.user.id);
    if (!limited.ok) {
      throw limited.status === 429
        ? new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many requests." })
        : new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Try again shortly." });
    }
    return next();
  });
}
