// T-8 (REQ-1): the Auth.js database adapter, wrapped so that from GitHub the app keeps only the
// user's GitHub id, name and avatar URL (decided 2026-10-16). `createUser` writes those three
// and nothing else, so no email ever reaches the database; `linkAccount` drops every token.
// The database CHECKs (user_no_email, account_no_tokens) are the backstop if this is bypassed.
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/server/db/schema";

export const MAX_NAME_LENGTH = 255;
export const MAX_AVATAR_URL_LENGTH = 2048;

/** What `githubProfile` in ./config.ts hands to `createUser`, beyond Auth.js's own fields. */
export type GitHubUserFields = { githubId?: unknown; name?: unknown; image?: unknown };

/** A GitHub user id: a positive whole number (seeded fake users use negative ones). */
export function parseGithubId(value: unknown): number | null {
  const id = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return name ? name.slice(0, MAX_NAME_LENGTH) : null;
}

/** Only an https URL is kept (it is stored, not shown, for now); anything else becomes null. */
export function cleanAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_AVATAR_URL_LENGTH) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** The account row Auth.js may store: which GitHub account belongs to which user. No tokens. */
export function withoutTokens(account: AdapterAccount): AdapterAccount {
  const { userId, type, provider, providerAccountId } = account;
  return { userId, type, provider, providerAccountId };
}

type Db = NodePgDatabase<typeof schema>;

export function createAuthAdapter(db: Db): Adapter {
  const base = DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  });

  return {
    ...base,

    // Auth.js calls createUser, linkAccount and createSession with no transaction. If an earlier
    // first sign-in stopped after the user row was written, that GitHub id already has a row
    // with no account; reuse it (refreshing name and avatar, keeping its id) instead of failing
    // on user_github_id_unique on every later attempt. Only that GitHub user's own sign-in can
    // reach here with that id: anyone already linked is found by getUserByAccount first.
    async createUser(user: AdapterUser & GitHubUserFields): Promise<AdapterUser> {
      const githubId = parseGithubId(user.githubId);
      if (githubId === null) throw new Error("GitHub profile has no valid id");
      const name = cleanName(user.name) ?? `GitHub user ${githubId}`;
      const image = cleanAvatarUrl(user.image);
      const [row] = await db
        .insert(schema.users)
        .values({ githubId, name, image })
        .onConflictDoUpdate({ target: schema.users.githubId, set: { name, image } })
        .returning({
          id: schema.users.id,
          name: schema.users.name,
          image: schema.users.image,
          email: schema.users.email,
          emailVerified: schema.users.emailVerified,
        });
      if (!row) throw new Error("user insert returned no row");
      // `email` is always null here (the column is kept empty); Auth.js's type says string, and
      // with no email it never uses the value.
      return row as AdapterUser;
    },

    async linkAccount(account: AdapterAccount) {
      await base.linkAccount!(withoutTokens(account));
    },
  };
}
