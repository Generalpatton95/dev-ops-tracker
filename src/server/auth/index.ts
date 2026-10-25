// T-8 (REQ-1): the app's Auth.js instance and the server-side session checks. Pages, layouts
// and tRPC all ask here; the proxy's redirect is only a first, optimistic check.
import "server-only";
import NextAuth from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { getDb } from "@/server/db";
import { errorLabel } from "@/server/log-label";
import { buildAuthConfig, isAuthConfigured, type AppSession } from "./config";
import { returnPathFromHeaders } from "./gate";
import { signInPathFor } from "./return-path";

export { isAuthConfigured, type AppSession } from "./config";

// Built per request from the environment, so `next build` needs no AUTH_* variables or
// database, and previews (which have neither sign-in variables nor a reason to sign in) work.
export const { handlers, auth } = NextAuth(() => buildAuthConfig(process.env, getDb));

function toAppSession(value: unknown): AppSession | null {
  if (!value || typeof value !== "object") return null;
  const { user, expires } = value as { user?: { id?: unknown; name?: unknown }; expires?: unknown };
  if (typeof user?.id !== "string" || !user.id || typeof expires !== "string") return null;
  return { user: { id: user.id, name: typeof user.name === "string" ? user.name : "" }, expires };
}

/**
 * The signed-in session for this request, or null. Looks the session cookie up in the database
 * (Auth.js database sessions), so a stale or forged cookie counts as signed out. Without the
 * AUTH_* variables nobody is signed in. Errors count as signed out and are logged by kind only.
 * Reads the request's cookies, so pages call it inside a <Suspense> boundary.
 */
export const getCurrentSession = cache(async (): Promise<AppSession | null> => {
  // Always a request-time answer: without this, a build with no AUTH_* variables would never
  // read the request, and the prerendered page would bake in "signed out".
  await connection();
  if (!isAuthConfigured(process.env)) return null;
  try {
    return toAppSession(await auth());
  } catch (error) {
    // Next's own control-flow signals (e.g. "dynamic usage" during prerendering) must pass.
    if (error && typeof error === "object" && "digest" in error) throw error;
    console.error(`[auth] session check failed: ${errorLabel(error)}`);
    return null;
  }
});

/**
 * For pages and layouts: the signed-in user, or a redirect to the sign-in page. The return path
 * defaults to the page the proxy says was requested (RETURN_PATH_HEADER, validated), so a
 * layout and its page redirect to the same place and the query string is kept.
 */
export async function requireSession(returnTo?: string): Promise<AppSession> {
  const session = await getCurrentSession();
  if (!session) redirect(signInPathFor(returnTo ?? returnPathFromHeaders(await headers())));
  return session;
}
