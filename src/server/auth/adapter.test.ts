// T-8 (REQ-1): the adapter wrapper keeps only the GitHub id, name and avatar URL, and no tokens.
// Database tests run in a database of their own on TEST_DATABASE_URL and skip without it.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterAccount, AdapterUser } from "next-auth/adapters";
import {
  createFreshDatabase,
  freshDatabaseSkipReason,
  type FreshDatabase,
} from "@/server/db/fresh-test-database";
import * as schema from "@/server/db/schema";
import {
  cleanAvatarUrl,
  cleanName,
  createAuthAdapter,
  parseGithubId,
  withoutTokens,
  MAX_NAME_LENGTH,
} from "./adapter";

const TOKENS = {
  access_token: "gho_not_real",
  refresh_token: "ghr_not_real",
  id_token: "id_not_real",
  expires_at: 1_900_000_000,
  token_type: "bearer" as const,
  scope: "read:user",
  session_state: "state_not_real",
  // Any other field a provider might add.
  refresh_token_expires_in: 15_897_600,
};

const account = (userId: string, providerAccountId: string): AdapterAccount => ({
  userId,
  type: "oauth",
  provider: "github",
  providerAccountId,
  ...TOKENS,
});

describe("REQ-1: what the adapter wrapper lets through", () => {
  it("REQ-1: linkAccount keeps only the user, provider and GitHub account id, never a token", () => {
    expect(withoutTokens(account("u-1", "4242"))).toEqual({
      userId: "u-1",
      type: "oauth",
      provider: "github",
      providerAccountId: "4242",
    });
  });

  it("REQ-1: GitHub ids must be positive whole numbers", () => {
    expect(parseGithubId(4242)).toBe(4242);
    expect(parseGithubId("4242")).toBe(4242);
    for (const bad of [
      0,
      -1,
      1.5,
      "abc",
      "",
      null,
      undefined,
      Number.MAX_SAFE_INTEGER + 1,
      "1e3",
    ]) {
      expect(parseGithubId(bad), String(bad)).toBeNull();
    }
  });

  it("REQ-1: names are trimmed, stripped of control characters and capped", () => {
    expect(cleanName("  Octo\nCat\u0000 ")).toBe("Octo Cat");
    expect(cleanName("x".repeat(MAX_NAME_LENGTH + 10))).toHaveLength(MAX_NAME_LENGTH);
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(42)).toBeNull();
  });

  it("REQ-1: only an https avatar URL is kept", () => {
    const url = "https://avatars.githubusercontent.com/u/4242?v=4";
    expect(cleanAvatarUrl(url)).toBe(url);
    for (const bad of ["http://example.com/a.png", "javascript:alert(1)", "not a url", 7, null]) {
      expect(cleanAvatarUrl(bad), String(bad)).toBeNull();
    }
  });
});

const skipReason = await freshDatabaseSkipReason();
if (skipReason) console.warn(`[adapter.test] ${skipReason}`);

describe.skipIf(skipReason !== undefined)("REQ-1: the adapter wrapper in Postgres", () => {
  let fresh: FreshDatabase;

  beforeAll(async () => {
    fresh = await createFreshDatabase("t8_adapter");
  }, 60_000);

  afterAll(async () => {
    await fresh?.drop();
  });

  const gitHubUser = (githubId: number, extra: Partial<AdapterUser> = {}) =>
    ({
      id: crypto.randomUUID(),
      name: "Octo Cat",
      email: "octo@example.com",
      emailVerified: new Date(),
      image: "https://avatars.githubusercontent.com/u/1?v=4",
      githubId,
      ...extra,
    }) as AdapterUser & { githubId: number };

  it("REQ-1: createUser stores the GitHub id, name and avatar URL, and never the email", async () => {
    const adapter = createAuthAdapter(fresh.db);
    const created = await adapter.createUser!(gitHubUser(1001));
    const [row] = await fresh.db.select().from(schema.users).where(eq(schema.users.id, created.id));
    expect(row).toMatchObject({
      githubId: 1001,
      name: "Octo Cat",
      image: "https://avatars.githubusercontent.com/u/1?v=4",
      email: null,
      emailVerified: null,
    });
    expect(created.email).toBeNull();
    // The id Auth.js made up is not used; the database picks it.
    expect(JSON.stringify(row)).not.toContain("octo@example.com");
  });

  it("REQ-1: createUser refuses a profile without a valid GitHub id", async () => {
    const adapter = createAuthAdapter(fresh.db);
    await expect(adapter.createUser!(gitHubUser(-5))).rejects.toThrow("no valid id");
    const { rows } = await fresh.db.execute(sql`select 1 from "user" where github_id = -5`);
    expect(rows).toHaveLength(0);
  });

  it("REQ-1: createUser falls back to a placeholder name and drops a non-https avatar", async () => {
    const adapter = createAuthAdapter(fresh.db);
    const created = await adapter.createUser!(
      gitHubUser(1002, { name: "  ", image: "http://insecure.example/a.png" }),
    );
    expect(created).toMatchObject({ name: "GitHub user 1002", image: null });
  });

  it("REQ-1: linkAccount stores no token field, even when Auth.js passes them all", async () => {
    const adapter = createAuthAdapter(fresh.db);
    const user = await adapter.createUser!(gitHubUser(1003));
    await adapter.linkAccount!(account(user.id, "1003"));
    const { rows } = await fresh.db.execute(
      sql`select * from account where provider_account_id = '1003'`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    for (const column of [
      "access_token",
      "refresh_token",
      "id_token",
      "expires_at",
      "token_type",
      "scope",
      "session_state",
    ]) {
      expect(row[column], column).toBeNull();
    }
    expect(JSON.stringify(row)).not.toMatch(/not_real/);
    expect(
      await adapter.getUserByAccount!({ provider: "github", providerAccountId: "1003" }),
    ).toMatchObject({
      id: user.id,
    });
  });
});
