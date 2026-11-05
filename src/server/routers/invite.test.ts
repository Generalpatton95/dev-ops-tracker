// T-10 (REQ-3): opening and joining invite links. Session and rate-limit checks need no database;
// the rest run against a database of its own on TEST_DATABASE_URL (skipped without it).
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSession } from "@/server/auth/config";
import {
  createFreshDatabase,
  freshDatabaseSkipReason,
  type FreshDatabase,
} from "@/server/db/fresh-test-database";
import { memberships, users, workspaces } from "@/server/db/schema";
import { hashInviteToken, newInviteToken } from "@/server/invite/token";
import type { RateLimitResult } from "@/server/rate-limit";
import { appRouter } from "@/server/routers/_app";
import { INVITE_NOT_WORKING } from "@/server/routers/invite";
import { createCallerFactory, createTRPCContext, type UserRateLimiter } from "@/server/trpc";

vi.mock("server-only", () => ({}));

const createCaller = createCallerFactory(appRouter);
const USER_ID = "6f1c2f5e-8d1a-4a53-9a43-2b4c1f9e7a10";
const SOME_TOKEN = "A".repeat(43);
const allow: UserRateLimiter = async () => ({ ok: true, count: 1, limit: 10 });

function sessionFor(id: string): AppSession {
  return { user: { id, name: "Test" }, expires: "2099-01-01T00:00:00.000Z" };
}

afterEach(() => vi.restoreAllMocks());

describe("REQ-3: invite procedures before the database", () => {
  it("REQ-3: signed out, preview and join answer UNAUTHORIZED before counting or querying", async () => {
    const limiter = vi.fn(allow);
    const caller = createCaller(() =>
      createTRPCContext({
        session: null,
        db: () => expect.unreachable("no query"),
        limitUser: limiter,
      }),
    );
    await expect(caller.invite.preview({ token: SOME_TOKEN })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.invite.join({ token: SOME_TOKEN })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(limiter).not.toHaveBeenCalled();
  });

  it("REQ-3: preview and join both count in the invite bucket for the signed-in user, even for a malformed token", async () => {
    const limiter = vi.fn(allow);
    const caller = createCaller(() =>
      createTRPCContext({
        session: sessionFor(USER_ID),
        db: () => expect.unreachable("a malformed token needs no query"),
        limitUser: limiter,
      }),
    );
    for (const call of [
      () => caller.invite.preview({ token: "nope" }),
      () => caller.invite.join({ token: "nope" }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: INVITE_NOT_WORKING,
      });
    }
    expect(limiter.mock.calls).toEqual([
      ["invite", USER_ID],
      ["invite", USER_ID],
    ]);
  });

  it("REQ-3: over the limit is TOO_MANY_REQUESTS and a limiter that can't run is SERVICE_UNAVAILABLE, with no query", async () => {
    const answers: RateLimitResult[] = [
      { ok: false, status: 429 },
      { ok: false, status: 503 },
    ];
    const caller = createCaller(() =>
      createTRPCContext({
        session: sessionFor(USER_ID),
        db: () => expect.unreachable("refused before any query"),
        limitUser: async () => answers.shift()!,
      }),
    );
    await expect(caller.invite.join({ token: SOME_TOKEN })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    await expect(caller.invite.preview({ token: SOME_TOKEN })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("REQ-3: a context with no limiter refuses every invite call: it fails closed", async () => {
    const caller = createCaller(() =>
      createTRPCContext({
        session: sessionFor(USER_ID),
        db: () => expect.unreachable("no query"),
      }),
    );
    await expect(caller.invite.preview({ token: SOME_TOKEN })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

const skipReason = await freshDatabaseSkipReason();
if (skipReason) console.warn(`[invite router.test] ${skipReason}`);

describe.skipIf(skipReason !== undefined)("REQ-3: invite links in Postgres", () => {
  let fresh: FreshDatabase;
  let nextGithubId = 7000;

  beforeAll(async () => {
    fresh = await createFreshDatabase("t10_invite");
  }, 60_000);
  afterAll(async () => {
    await fresh?.drop();
  });

  async function addUser(name: string): Promise<string> {
    const [user] = await fresh.db
      .insert(users)
      .values({ name, githubId: nextGithubId++ })
      .returning({ id: users.id });
    return user.id;
  }

  // A caller with its own cookie jar: what the server set, and what the browser sends back.
  async function callerFor(
    userId: string,
    options: { limitUser?: UserRateLimiter; jar?: { cookie: string | null } } = {},
  ) {
    const jar = options.jar ?? { cookie: null };
    const caller = createCaller(
      await createTRPCContext({
        session: sessionFor(userId),
        db: () => fresh.db,
        workspaceCookie: jar.cookie,
        setWorkspaceCookie: (id) => {
          jar.cookie = id;
        },
        limitUser: options.limitUser ?? allow,
      }),
    );
    return { caller, jar };
  }

  // An owner with a working link; returns the link's token.
  async function ownerWithLink(name: string) {
    const ownerId = await addUser(name);
    const { caller } = await callerFor(ownerId);
    const workspace = await caller.workspace.current();
    const { token } = await caller.workspace.createInvite();
    return { ownerId, owner: caller, workspace, token };
  }

  async function membershipRows(workspaceId: string) {
    return fresh.db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.workspaceId, workspaceId));
  }

  it("REQ-3: the workspace keeps only the token's hash; the raw token never reaches the database", async () => {
    const sent: string[] = [];
    const query = pg.Client.prototype.query;
    vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      sent.push(JSON.stringify(args));
      return (query as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof query);

    const { workspace, token } = await ownerWithLink("Hash Owner");
    const joiner = await addUser("Hash Joiner");
    await (await callerFor(joiner)).caller.invite.preview({ token });
    await (await callerFor(joiner)).caller.invite.join({ token });
    vi.restoreAllMocks();

    expect(sent.length).toBeGreaterThan(0);
    for (const statement of sent) expect(statement).not.toContain(token);
    const [row] = await fresh.db
      .select({ inviteToken: workspaces.inviteToken })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id));
    expect(row?.inviteToken).toBe(hashInviteToken(token));
    const dump = await fresh.db.execute<{ dump: string }>(
      sql`select string_agg(workspace::text, ' ') as dump from workspace`,
    );
    expect(dump.rows[0]?.dump).not.toContain(token);
  });

  it("REQ-3: preview shows only the workspace name and joins nobody", async () => {
    const { workspace, token } = await ownerWithLink("Preview Owner");
    const visitor = await addUser("Visitor");
    const { caller, jar } = await callerFor(visitor);
    const preview = await caller.invite.preview({ token });
    expect(preview).toEqual({ name: workspace.name });
    expect(Object.keys(preview)).toEqual(["name"]);
    expect((await membershipRows(workspace.id)).map((r) => r.userId)).not.toContain(visitor);
    expect(jar.cookie).toBeNull();
  });

  it("REQ-3: a signed-in user who opens a working link joins as a member and is switched to it", async () => {
    const { workspace, token } = await ownerWithLink("Join Owner");
    const joiner = await addUser("Joiner");
    const { caller, jar } = await callerFor(joiner);
    await expect(caller.invite.join({ token })).resolves.toEqual({
      id: workspace.id,
      name: workspace.name,
      role: "member",
    });
    expect(jar.cookie).toBe(workspace.id);
    expect(await membershipRows(workspace.id)).toContainEqual({ userId: joiner, role: "member" });
    // The next request, carrying the cookie, is in the joined workspace.
    const next = await callerFor(joiner, { jar });
    await expect(next.caller.workspace.current()).resolves.toMatchObject({
      id: workspace.id,
      role: "member",
    });
  });

  it("REQ-3: joining again (or twice at once) adds no second membership; it just switches", async () => {
    const { workspace, token } = await ownerWithLink("Twice Owner");
    const joiner = await addUser("Twice Joiner");
    const { caller } = await callerFor(joiner);
    await caller.invite.join({ token });
    await caller.invite.join({ token });
    await Promise.all(
      Array.from({ length: 5 }, async () =>
        (await callerFor(joiner)).caller.invite.join({ token }),
      ),
    );
    const rows = (await membershipRows(workspace.id)).filter((r) => r.userId === joiner);
    expect(rows).toEqual([{ userId: joiner, role: "member" }]);
  });

  it("REQ-3: an owner opening their own link stays owner and just switches to it", async () => {
    const { ownerId, workspace, token } = await ownerWithLink("Self Owner");
    const { caller, jar } = await callerFor(ownerId);
    await expect(caller.invite.join({ token })).resolves.toMatchObject({
      id: workspace.id,
      role: "owner",
    });
    expect(jar.cookie).toBe(workspace.id);
    expect(await membershipRows(workspace.id)).toEqual([{ userId: ownerId, role: "owner" }]);
  });

  it("REQ-3: a wrong, malformed, turned-off or replaced token gets the same neutral answer and joins nobody", async () => {
    const { owner, workspace, token: old } = await ownerWithLink("Neutral Owner");
    const { token: current } = await owner.workspace.createInvite();
    const visitor = await addUser("Neutral Visitor");
    const { caller, jar } = await callerFor(visitor);

    const offOwner = await ownerWithLink("Off Owner");
    await offOwner.owner.workspace.disableInvite();

    for (const token of [
      old, // replaced by a newer link
      offOwner.token, // turned off
      newInviteToken(), // never existed
      hashInviteToken(current), // the stored hash, used as if it were a token
      "not-a-token",
      "",
      "x".repeat(5000),
    ]) {
      for (const call of [caller.invite.preview, caller.invite.join]) {
        await expect(call({ token }), token.slice(0, 20)).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: INVITE_NOT_WORKING,
        });
      }
    }
    expect(jar.cookie).toBeNull();
    expect((await membershipRows(workspace.id)).map((r) => r.userId)).not.toContain(visitor);
    expect((await membershipRows(offOwner.workspace.id)).map((r) => r.userId)).not.toContain(
      visitor,
    );
    // The current link still works.
    await expect(caller.invite.preview({ token: current })).resolves.toEqual({
      name: workspace.name,
    });
  });

  it("REQ-3: over HTTP the neutral answer is identical for a malformed, an unknown and a turned-off token", async () => {
    const { owner, token } = await ownerWithLink("Http Owner");
    await owner.workspace.disableInvite();
    const visitor = await addUser("Http Visitor");
    vi.spyOn(console, "error").mockImplementation(() => {});

    async function joinWith(value: string) {
      const body = JSON.stringify({ token: value });
      const res = await fetchRequestHandler({
        endpoint: "/api/trpc",
        req: new Request("http://localhost/api/trpc/invite.join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        router: appRouter,
        createContext: () =>
          createTRPCContext({
            session: sessionFor(visitor),
            db: () => fresh.db,
            setWorkspaceCookie: () => expect.unreachable("no cookie for a failed join"),
            limitUser: allow,
          }),
      });
      return { status: res.status, body: await res.text() };
    }

    const turnedOff = await joinWith(token);
    const unknown = await joinWith(newInviteToken());
    const malformed = await joinWith("not-a-token");
    expect(turnedOff.status).toBe(404);
    expect(unknown).toEqual(turnedOff);
    expect(malformed).toEqual(turnedOff);
  });

  it("REQ-3: preview and join share one bucket of 10 a minute per user, in the rate_limit table", async () => {
    const { checkRateLimit } = await import("@/server/rate-limit");
    const env = { AUTH_SECRET: "test-secret-not-real-0123456789abcdef" };
    const limitUser: UserRateLimiter = (bucket, userId) =>
      checkRateLimit({
        bucket,
        userId,
        headers: new Headers(),
        env,
        db: () => fresh.db,
        cleanup: { lastRunMs: Number.MAX_SAFE_INTEGER },
      });
    const { token } = await ownerWithLink("Limited Owner");
    const busy = await addUser("Busy");
    const other = await addUser("Other");
    const { caller } = await callerFor(busy, { limitUser });

    // Five looks and five joins fill the bucket whatever their mix (the minute may not roll
    // over mid-test: the window comes from the database's clock, so wait for a fresh one).
    const [{ seconds }] = (
      await fresh.db.execute<{ seconds: number }>(
        sql`select extract(second from now())::float as seconds`,
      )
    ).rows;
    if (seconds > 50) await new Promise((resolve) => setTimeout(resolve, (61 - seconds) * 1000));
    for (let i = 0; i < 5; i++) {
      await caller.invite.preview({ token });
      await caller.invite.join({ token });
    }
    await expect(caller.invite.preview({ token })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    await expect(caller.invite.join({ token: "malformed" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    // Someone else has their own count.
    const otherCaller = (await callerFor(other, { limitUser })).caller;
    await expect(otherCaller.invite.preview({ token })).resolves.toBeTruthy();
  }, 30_000);

  it("REQ-3: someone removed from a workspace falls back to their own, even with the old cookie", async () => {
    const { owner, workspace, token } = await ownerWithLink("Remover");
    const joiner = await addUser("Removed Later");
    const { caller, jar } = await callerFor(joiner);
    await caller.invite.join({ token });
    expect(jar.cookie).toBe(workspace.id);

    await owner.workspace.removeMember({ userId: joiner });
    const [left] = await fresh.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspace.id), eq(memberships.userId, joiner)));
    expect(left?.n).toBe(0);

    // The browser still sends the old workspace's id; the server no longer honours it.
    const after = await callerFor(joiner, { jar });
    const current = await after.caller.workspace.current();
    expect(current.id).not.toBe(workspace.id);
    expect(current).toMatchObject({ name: "Removed Later's workspace", role: "owner" });
  });

  async function inviteHashOf(workspaceId: string) {
    const [row] = await fresh.db
      .select({ inviteToken: workspaces.inviteToken })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return row?.inviteToken;
  }

  it("REQ-3: removing a member turns the link off: the old link gives the neutral answer and they can't rejoin", async () => {
    const { owner, workspace, token } = await ownerWithLink("Lockout Owner");
    const joiner = await addUser("Locked Out");
    const { caller } = await callerFor(joiner);
    await caller.invite.join({ token });

    await expect(owner.workspace.removeMember({ userId: joiner })).resolves.toEqual({
      userId: joiner,
      inviteActive: false,
    });
    expect(await inviteHashOf(workspace.id)).toBeNull();
    for (const call of [caller.invite.preview, caller.invite.join]) {
      await expect(call({ token })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: INVITE_NOT_WORKING,
      });
    }
    expect((await membershipRows(workspace.id)).map((r) => r.userId)).not.toContain(joiner);
  });

  it("REQ-3: a failed removal (by a member, of an unknown id or of the owner) leaves the link on", async () => {
    const { ownerId, owner, workspace, token } = await ownerWithLink("Steady Owner");
    const joiner = await addUser("Steady Member");
    const first = await callerFor(joiner);
    expect((await first.caller.invite.join({ token })).id).toBe(workspace.id);
    // The member's next requests carry the cookie, so they act on the owner's workspace.
    const { caller: member } = await callerFor(joiner, { jar: first.jar });
    await expect(member.workspace.current()).resolves.toMatchObject({ id: workspace.id });
    const hash = await inviteHashOf(workspace.id);

    for (const attempt of [
      () => member.workspace.removeMember({ userId: ownerId }),
      () => owner.workspace.removeMember({ userId: "00000000-0000-4000-8000-000000000000" }),
      () => owner.workspace.removeMember({ userId: ownerId }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await inviteHashOf(workspace.id)).toBe(hash);
    const newcomer = await addUser("Steady Newcomer");
    await expect((await callerFor(newcomer)).caller.invite.preview({ token })).resolves.toEqual({
      name: workspace.name,
    });
  });

  // How many backends of this test database are waiting on a lock, polled until there are at
  // least `n` or `ms` pass. True when there were. `client` must not be inside a transaction:
  // pg_stat_activity is snapshotted once per transaction, so polling from one sees no change.
  async function lockWaiters(client: pg.Client, n: number, ms = 5_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const { rows } = await client.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity " +
          "where datname = current_database() and wait_event_type = 'Lock'",
      );
      if ((rows[0]?.n ?? 0) >= n) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  for (const change of ["disableInvite", "createInvite"] as const) {
    it(`REQ-3: a join in progress holds the link, so ${change} waits for it; a join after that commits is refused`, async () => {
      const { owner, workspace, token } = await ownerWithLink(`Race ${change}`);
      const joiner = await addUser(`Racer ${change}`);
      const late = await addUser(`Late ${change}`);
      const holder = new pg.Client({ connectionString: fresh.url });
      const watcher = new pg.Client({ connectionString: fresh.url });
      await holder.connect();
      await watcher.connect();
      const order: string[] = [];
      try {
        // An uncommitted copy of the joiner's membership: the join takes its FOR SHARE lock on
        // the workspace row, then waits at its own insert, so it stays in progress.
        await holder.query("begin");
        await holder.query(
          "insert into membership (user_id, workspace_id, role) values ($1, $2, 'member')",
          [joiner, workspace.id],
        );
        const join = (await callerFor(joiner)).caller.invite.join({ token }).then((result) => {
          order.push("join");
          return result;
        });
        expect(await lockWaiters(watcher, 1)).toBe(true);

        const changed = owner.workspace[change]().then(() => {
          order.push(change);
        });
        // Under FOR SHARE the change to invite_token queues behind the join. Under FOR KEY
        // SHARE (invite_token's index is partial, so it isn't a key) or no lock it wouldn't.
        expect(await lockWaiters(watcher, 2, 3_000)).toBe(true);
        expect(order).toEqual([]);

        await holder.query("rollback");
        await expect(join).resolves.toMatchObject({ id: workspace.id, role: "member" });
        await changed;
        expect(order).toEqual(["join", change]);
      } finally {
        await holder.end().catch(() => {});
        await watcher.end().catch(() => {});
      }

      // Started after the change committed: the old link no longer works.
      const { caller, jar } = await callerFor(late);
      await expect(caller.invite.join({ token })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: INVITE_NOT_WORKING,
      });
      expect(jar.cookie).toBeNull();
      expect((await membershipRows(workspace.id)).map((r) => r.userId)).not.toContain(late);
    }, 30_000);
  }

  it("REQ-3: a rejoin racing a removal never errors or leaves a half state", async () => {
    const { owner, workspace } = await ownerWithLink("Churn Owner");
    const joiner = await addUser("Churner");
    const { caller } = await callerFor(joiner);
    for (let round = 0; round < 8; round++) {
      const { token } = await owner.workspace.createInvite();
      await caller.invite.join({ token });
      const [joined, removed] = await Promise.allSettled([
        caller.invite.join({ token }),
        owner.workspace.removeMember({ userId: joiner }),
      ]);
      // No deadlock or other error: the removal always stands...
      expect(removed.status, `round ${round}`).toBe("fulfilled");
      // ...and the join either landed before it (then removed) or found the link off.
      if (joined.status === "rejected") {
        expect(joined.reason).toMatchObject({ code: "NOT_FOUND", message: INVITE_NOT_WORKING });
      }
      expect((await membershipRows(workspace.id)).map((r) => r.userId)).not.toContain(joiner);
      expect(await inviteHashOf(workspace.id)).toBeNull();
    }
  }, 30_000);
});
