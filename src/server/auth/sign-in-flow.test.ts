// T-8 (REQ-1): the whole GitHub sign-in and sign-out flow through the app's /api/auth route and
// the real Auth.js, against a database of its own on TEST_DATABASE_URL (skipped without it).
// GitHub is played by a stubbed fetch: any request to another address fails the test, so nothing
// leaves the machine.
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFreshDatabase,
  freshDatabaseSkipReason,
  type FreshDatabase,
} from "@/server/db/fresh-test-database";

vi.mock("server-only", () => ({}));

const { default: NextAuth } = await import("next-auth");
const { NextRequest } = await import("next/server");
const { buildAuthConfig, SESSION_MAX_AGE_S } = await import("./config");
const schema = await import("@/server/db/schema");
const { createAuthRouteHandler } = await import("./route-handler");

const ORIGIN = "http://localhost:3000";
const ENV = {
  AUTH_SECRET: "test-secret-not-real-0123456789abcdef",
  AUTH_GITHUB_ID: "test-client-id",
  AUTH_GITHUB_SECRET: "test-client-secret-not-real",
};

const PROFILE = {
  id: 4242,
  login: "octocat",
  name: "Octo Cat",
  email: "octo@example.com",
  avatar_url: "https://avatars.githubusercontent.com/u/4242?v=4",
};

/** A browser's cookies for this site: one jar per device. */
class Jar {
  private cookies = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  get(name: string) {
    return this.cookies.get(name);
  }
  set(name: string, value: string) {
    this.cookies.set(name, value);
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

const skipReason = await freshDatabaseSkipReason();
if (skipReason) console.warn(`[sign-in-flow.test] ${skipReason}`);

describe.skipIf(skipReason !== undefined)("REQ-1: GitHub sign-in and sign-out", () => {
  let fresh: FreshDatabase;
  let handler: (req: InstanceType<typeof NextRequest>) => Promise<Response>;
  let sessionHandler: (req: InstanceType<typeof NextRequest>) => Promise<Response>;
  const limited: string[] = [];
  const outbound: string[] = [];

  beforeAll(async () => {
    fresh = await createFreshDatabase("t8_flow");
    const { handlers } = NextAuth(() => buildAuthConfig(ENV, () => fresh.db));
    sessionHandler = handlers.GET;
    handler = createAuthRouteHandler(handlers, ENV, async ({ bucket, headers }) => {
      limited.push(`${bucket} ${headers.get("x-test-route") ?? ""}`.trim());
      return { ok: true, count: 1, limit: 10 };
    });
  }, 60_000);

  afterAll(async () => {
    await fresh?.drop();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubGitHub(profile: Record<string, unknown> = PROFILE) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      outbound.push(`${url.origin}${url.pathname}`);
      if (url.href === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "gho_not_real",
          token_type: "bearer",
          scope: "read:user",
          refresh_token: "ghr_not_real",
          expires_in: 28_800,
        });
      }
      if (url.href === "https://api.github.com/user") return Response.json(profile);
      // What GitHub answers when the token lacks the user:email scope.
      if (url.href === "https://api.github.com/user/emails") {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      throw new Error("unexpected outbound request in a test");
    });
  }

  function send(jar: Jar, method: "GET" | "POST", path: string, form?: Record<string, string>) {
    const body = form ? new URLSearchParams(form).toString() : undefined;
    const headers: Record<string, string> = { cookie: jar.header() };
    if (body !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers["content-length"] = String(Buffer.byteLength(body));
      headers["x-auth-return-redirect"] = "1";
    }
    return handler(new NextRequest(`${ORIGIN}${path}`, { method, headers, body }));
  }

  async function csrf(jar: Jar) {
    const res = await send(jar, "GET", "/api/auth/csrf");
    jar.take(res);
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    return csrfToken;
  }

  /** Sign in as `profile` on the device `jar`, as the browser would. Returns the final redirect. */
  async function signIn(jar: Jar, callbackUrl = "/", profile: Record<string, unknown> = PROFILE) {
    stubGitHub(profile);
    const csrfToken = await csrf(jar);
    const start = await send(jar, "POST", "/api/auth/signin/github", { csrfToken, callbackUrl });
    expect(start.status).toBe(200);
    jar.take(start);
    const { url } = (await start.json()) as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );

    const params = new URLSearchParams({ code: "fake-code" });
    const state = authorize.searchParams.get("state");
    if (state) params.set("state", state);
    const back = await send(jar, "GET", `/api/auth/callback/github?${params}`);
    jar.take(back);
    return { back, authorize };
  }

  async function sessionOf(jar: Jar) {
    const res = await sessionHandler(
      new NextRequest(`${ORIGIN}/api/auth/session`, { headers: { cookie: jar.header() } }),
    );
    return (await res.json()) as { user?: Record<string, unknown>; expires?: string } | null;
  }

  async function count(table: string) {
    const { rows } = await fresh.db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier(table)}`,
    );
    return rows[0]?.n ?? 0;
  }

  it("REQ-1: signing in with GitHub creates a user record on first visit and reuses it after", async () => {
    const laptop = new Jar();
    const { back, authorize } = await signIn(laptop, "/projects?tab=open");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${ORIGIN}/projects?tab=open`);
    expect(laptop.get("authjs.session-token")).toBeTruthy();
    // Only the public profile is asked for, not email addresses.
    expect(authorize.searchParams.get("scope")).toBe("read:user");

    const users = await fresh.db.execute<Record<string, unknown>>(sql`select * from "user"`);
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]).toMatchObject({
      github_id: "4242",
      name: "Octo Cat",
      avatar_url: PROFILE.avatar_url,
      email: null,
      email_verified: null,
    });

    // A second visit, from another device, signs in as the same user.
    const phone = new Jar();
    const second = await signIn(phone);
    expect(second.back.status).toBe(302);
    expect(await count("user")).toBe(1);
    expect(await count("account")).toBe(1);
    expect(await count("session")).toBe(2);

    const session = await sessionOf(phone);
    expect(session?.user).toEqual({ id: users.rows[0]?.id, name: "Octo Cat" });
  });

  it("REQ-1: no email and no GitHub token reaches the database, and GitHub is the only host asked", async () => {
    const dump = await fresh.db.execute<{ dump: string }>(sql`
      select concat_ws(' ', (select string_agg(u::text, ' ') from "user" u),
                            (select string_agg(a::text, ' ') from account a)) as dump
    `);
    expect(dump.rows[0]?.dump).not.toContain("octo@example.com");
    expect(dump.rows[0]?.dump).not.toContain("not_real");
    const { rows } = await fresh.db.execute(sql`
      select 1 from account where num_nonnulls(access_token, refresh_token, id_token, expires_at,
        token_type, scope, session_state) > 0
    `);
    expect(rows).toHaveLength(0);
    expect(new Set(outbound)).toEqual(
      new Set(["https://github.com/login/oauth/access_token", "https://api.github.com/user"]),
    );
  });

  it("REQ-1: the session the app sees holds only the user's id and name", async () => {
    const jar = new Jar();
    await signIn(jar);
    const session = await sessionOf(jar);
    expect(Object.keys(session?.user ?? {}).sort()).toEqual(["id", "name"]);
    expect(JSON.stringify(session)).not.toContain("octo@example.com");
    expect(JSON.stringify(session)).not.toContain("avatars");
  });

  it("REQ-1: sign out ends the session on that device only, deleting its session row", async () => {
    const desk = new Jar();
    const tablet = new Jar();
    await signIn(desk);
    await signIn(tablet);
    const deskToken = desk.get("authjs.session-token")!;
    const tabletToken = tablet.get("authjs.session-token")!;

    const csrfToken = await csrf(desk);
    const res = await send(desk, "POST", "/api/auth/signout", {
      csrfToken,
      callbackUrl: "/sign-in",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: `${ORIGIN}/sign-in` });
    desk.take(res);

    expect(desk.get("authjs.session-token")).toBeUndefined();
    const tokens = await fresh.db.execute<{ session_token: string }>(
      sql`select session_token from session`,
    );
    const stored = tokens.rows.map((row) => row.session_token);
    expect(stored).not.toContain(deskToken);
    expect(stored).toContain(tabletToken);

    // The old cookie, replayed, is no longer a session; the other device is still signed in.
    const replay = new Jar();
    replay.set("authjs.session-token", deskToken);
    expect(await sessionOf(replay)).toBeNull();
    expect((await sessionOf(tablet))?.user).toMatchObject({ name: "Octo Cat" });
  });

  it("REQ-1: sign out without Auth.js's CSRF token changes nothing", async () => {
    const jar = new Jar();
    await signIn(jar);
    const token = jar.get("authjs.session-token")!;
    const res = await send(jar, "POST", "/api/auth/signout", { callbackUrl: "/sign-in" });
    expect((await res.json()) as { url: string }).toMatchObject({
      url: expect.stringContaining("/sign-in?error="),
    });
    const { rows } = await fresh.db.execute(
      sql`select 1 from session where session_token = ${token}`,
    );
    expect(rows).toHaveLength(1);
  });

  it("REQ-1: a return path to another site is replaced by the home page", async () => {
    const jar = new Jar();
    const { back } = await signIn(jar, "https://evil.example/steal");
    expect(back.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("REQ-1: the sign-in and callback steps go through the rate limiter, the others don't", async () => {
    limited.length = 0;
    await signIn(new Jar());
    expect(limited).toEqual(["auth", "auth"]);
  });
  it("REQ-1: a session lasts a fixed 30 days from sign-in and using it never extends it", async () => {
    const jar = new Jar();
    const before = Date.now();
    await signIn(jar);
    const token = jar.get("authjs.session-token")!;
    const expiresOf = async () => {
      const [row] = await fresh.db
        .select({ expires: schema.sessions.expires })
        .from(schema.sessions)
        .where(eq(schema.sessions.sessionToken, token));
      return row!.expires.getTime();
    };
    const thirtyDays = SESSION_MAX_AGE_S * 1000;
    expect(SESSION_MAX_AGE_S).toBe(30 * 24 * 60 * 60);
    expect(await expiresOf()).toBeGreaterThanOrEqual(before + thirtyDays - 1000);
    expect(await expiresOf()).toBeLessThanOrEqual(Date.now() + thirtyDays + 1000);

    // As if signed in two days ago: Auth.js's default would slide this forward on use.
    const twoDaysIn = new Date(Date.now() + thirtyDays - 2 * 24 * 60 * 60 * 1000);
    await fresh.db
      .update(schema.sessions)
      .set({ expires: twoDaysIn })
      .where(eq(schema.sessions.sessionToken, token));
    const session = await sessionOf(jar);
    expect(session?.user).toMatchObject({ name: "Octo Cat" });
    expect(await expiresOf()).toBe(twoDaysIn.getTime());
    expect(session?.expires).toBe(twoDaysIn.toISOString());
  });

  it("REQ-1: sign-in works with no public email, and still stores no email", async () => {
    const noEmail = { ...PROFILE, id: 7777, login: "quiet", name: "Quiet Cat", email: null };
    outbound.length = 0;
    const { back } = await signIn(new Jar(), "/", noEmail);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${ORIGIN}/`);
    // Auth.js asked for the email list, GitHub refused, and sign-in carried on without one.
    expect(outbound).toContain("https://api.github.com/user/emails");
    const { rows } = await fresh.db.execute<Record<string, unknown>>(
      sql`select name, email, email_verified from "user" where github_id = 7777`,
    );
    expect(rows).toEqual([{ name: "Quiet Cat", email: null, email_verified: null }]);
  });

  it("REQ-1: a first sign-in that stopped after creating the user is finished by the next one", async () => {
    // A user row with no account, as left by a sign-in whose linkAccount step failed.
    const [orphan] = await fresh.db
      .insert(schema.users)
      .values({ githubId: 8888, name: "Old name", image: null })
      .returning({ id: schema.users.id });
    const profile = { ...PROFILE, id: 8888, login: "again", name: "New name" };
    const jar = new Jar();
    const { back } = await signIn(jar, "/", profile);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${ORIGIN}/`);

    const users = await fresh.db.execute<Record<string, unknown>>(
      sql`select id, name, avatar_url from "user" where github_id = 8888`,
    );
    expect(users.rows).toEqual([
      { id: orphan!.id, name: "New name", avatar_url: PROFILE.avatar_url },
    ]);
    const accounts = await fresh.db.execute<{ user_id: string }>(
      sql`select user_id from account where provider_account_id = '8888'`,
    );
    expect(accounts.rows).toEqual([{ user_id: orphan!.id }]);
    expect((await sessionOf(jar))?.user).toEqual({ id: orphan!.id, name: "New name" });
  });
});
