// T-8 (REQ-1): Auth.js settings. GitHub sign-in, database sessions in the Auth.js tables, and
// only the GitHub id, name and avatar URL kept from the profile. Built per request from the
// environment (see ./index.ts), so `next build` needs no AUTH_* variables and opens no database.
import type { NextAuthConfig } from "next-auth";
import GitHub, { type GitHubProfile } from "next-auth/providers/github";
import type { Database } from "@/server/db";
import { createAuthAdapter } from "./adapter";
import { authLogger } from "./logger";
import { SIGN_IN_PATH, safeReturnPath } from "./return-path";

type Env = Readonly<Record<string, string | undefined>>;

/** How long a session lasts from sign-in, in seconds (Auth.js's unit). */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

/** The variables sign-in needs. Previews have none of them, so they have no sign-in. */
export const AUTH_VARIABLES = ["AUTH_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"] as const;

export function isAuthConfigured(env: Env): boolean {
  return AUTH_VARIABLES.every((name) => Boolean(env[name]?.trim()));
}

/** The signed-in user as the app sees it: only what pages and procedures need. */
export type AppSession = {
  user: { id: string; name: string };
  expires: string;
};

/**
 * Turns GitHub's profile into the user Auth.js passes to `createUser`. The email is left out,
 * and `githubId` is added so the adapter can store it (Auth.js keeps GitHub's id only on the
 * account row). Built in a variable first: the extra field isn't in Auth.js's `User` type.
 */
export function githubProfile(profile: GitHubProfile) {
  const user = {
    id: String(profile.id),
    githubId: profile.id,
    name: profile.name ?? profile.login,
    image: profile.avatar_url,
  };
  return user;
}

/**
 * Same-origin redirects only, to a validated relative path. The sign-in page itself is allowed
 * as a plain destination (where sign-out lands); as a return path it would only loop.
 */
export function safeRedirect({ url, baseUrl }: { url: string; baseUrl: string }): string {
  let path = url;
  if (url.startsWith(`${baseUrl}/`)) path = url.slice(baseUrl.length);
  else if (url === baseUrl) path = "/";
  if (path === SIGN_IN_PATH) return `${baseUrl}${SIGN_IN_PATH}`;
  return `${baseUrl}${safeReturnPath(path)}`;
}

export function buildAuthConfig(env: Env, getDatabase: () => Database): NextAuthConfig {
  return {
    secret: env.AUTH_SECRET,
    // getDb() only creates the pool; nothing connects until a query runs.
    adapter: createAuthAdapter(getDatabase()),
    // A fixed 30 days from sign-in: with updateAge equal to maxAge, Auth.js never slides the
    // expiry forward. Expired rows are deleted by the rate limiter's clean-up.
    session: { strategy: "database", maxAge: SESSION_MAX_AGE_S, updateAge: SESSION_MAX_AGE_S },
    providers: [
      GitHub({
        clientId: env.AUTH_GITHUB_ID,
        clientSecret: env.AUTH_GITHUB_SECRET,
        // Public profile only; the default also asks for the user's email addresses.
        authorization: { params: { scope: "read:user" } },
        profile: githubProfile,
        // Keep none of GitHub's tokens on the account (the adapter drops them again).
        account: () => ({}),
      }),
    ],
    pages: { signIn: SIGN_IN_PATH, error: SIGN_IN_PATH },
    callbacks: {
      redirect: safeRedirect,
      // Only the id and name leave the server; the rest of the user row stays there.
      session({ session, user }) {
        const expires = session.expires as unknown as Date | string;
        return {
          user: { id: user.id, name: user.name ?? "" },
          expires: expires instanceof Date ? expires.toISOString() : expires,
        };
      },
    },
    logger: authLogger,
  };
}
