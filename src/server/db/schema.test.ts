// T-5 (REQ-5): the migrations build the v1 schema and its rules hold in a real Postgres.
// Runs only against TEST_DATABASE_URL (database name ending in _test), which it wipes first.
// Skipped locally when that's unset; CI sets it and fails if it's missing.
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";
import { isTestDatabaseName, resolveTestDatabase } from "./test-database";

const target = resolveTestDatabase(process.env);
if (!target.run) {
  console.warn(`[schema.test] ${target.reason}`);
}

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

const EXPECTED_TABLES = [
  "account",
  "activity",
  "cycle",
  "membership",
  "project",
  "requirement",
  "requirement_version",
  "session",
  "spec",
  "task",
  "task_link",
  "user",
  "verification_token",
  "workspace",
];

type PgFailure = { code?: string; constraint?: string };

// Drizzle wraps driver errors; the Postgres error is somewhere down the `cause` chain.
function pgFailure(error: unknown): PgFailure {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ("code" in current && typeof current.code === "string") {
      return current as PgFailure;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return {};
}

async function expectRejected(query: PromiseLike<unknown>, code: string, constraint: string) {
  const error = await Promise.resolve(query).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected Postgres to reject with ${constraint}`).toBeDefined();
  expect(pgFailure(error)).toMatchObject({ code, constraint });
}

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

describe.skipIf(!target.run)("REQ-5: v1 schema in Postgres", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let counter = Date.now();

  async function newUser() {
    const [row] = await db
      .insert(schema.users)
      .values({ name: "Test user", githubId: counter++ })
      .returning({ id: schema.users.id });
    return row;
  }

  async function newWorkspace() {
    const [row] = await db
      .insert(schema.workspaces)
      .values({ name: "Test workspace" })
      .returning({ id: schema.workspaces.id });
    return row;
  }

  async function newProject(workspaceId: string, key = "DOT") {
    const [row] = await db
      .insert(schema.projects)
      .values({ workspaceId, key, name: "Test project" })
      .returning({ id: schema.projects.id });
    return row;
  }

  async function newProjectInNewWorkspace() {
    const workspace = await newWorkspace();
    return newProject(workspace.id);
  }

  async function newRequirement(projectId: string) {
    const [spec] = await db
      .insert(schema.specs)
      .values({ projectId, title: "Spec" })
      .returning({ id: schema.specs.id });
    const [row] = await db
      .insert(schema.requirements)
      .values({ specId: spec.id, ref: "REQ-1", rule: "A rule" })
      .returning({ id: schema.requirements.id });
    return { specId: spec.id, id: row.id };
  }

  async function newTask(projectId: string, number = 1) {
    const [row] = await db
      .insert(schema.tasks)
      .values({ projectId, number, title: "Task" })
      .returning({ id: schema.tasks.id });
    return row;
  }

  beforeAll(async () => {
    if (!target.run) return;
    pool = new Pool({ connectionString: target.url, max: 2 });
    db = drizzle(pool, { schema });

    // Second guard, on the database we actually reached, before anything is dropped.
    const current = await db.execute<{ name: string }>(sql`select current_database() as name`);
    if (!isTestDatabaseName(current.rows[0]?.name ?? "")) {
      throw new Error('Refusing to run: the connected database name does not end in "_test".');
    }

    // Start from an empty schema every run, then apply the committed migrations.
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`create schema public`);
    await migrate(db, { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  // ---------- Tables ----------

  it("REQ-5: migrations create every v1 table and the Auth.js tables", async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `);
    expect(result.rows.map((row) => row.table_name)).toEqual(EXPECTED_TABLES);
  });

  // ---------- Projects ----------

  it("REQ-5: a project key must be 2 to 5 capital letters", async () => {
    const workspace = await newWorkspace();
    for (const key of ["dot", "D", "DOTSIX", "DO1", "DÖT", "DOT\n"]) {
      await expectRejected(
        db.insert(schema.projects).values({ workspaceId: workspace.id, key, name: "Bad key" }),
        CHECK_VIOLATION,
        "project_key_format",
      );
    }
    await expect(newProject(workspace.id, "DOT")).resolves.toHaveProperty("id");
    await expect(newProject(workspace.id, "AB")).resolves.toHaveProperty("id");
    await expect(newProject(workspace.id, "ABCDE")).resolves.toHaveProperty("id");
  });

  it("REQ-5: a project key is unique in its workspace but reusable in another", async () => {
    const first = await newWorkspace();
    const second = await newWorkspace();
    await newProject(first.id, "DOT");
    await expectRejected(
      db.insert(schema.projects).values({ workspaceId: first.id, key: "DOT", name: "Again" }),
      UNIQUE_VIOLATION,
      "project_workspace_id_key_unique",
    );
    await expect(newProject(second.id, "DOT")).resolves.toHaveProperty("id");
  });

  it("REQ-5: a project's next task number is at least 1", async () => {
    const workspace = await newWorkspace();
    await expectRejected(
      db
        .insert(schema.projects)
        .values({ workspaceId: workspace.id, key: "ZERO", name: "Zero", nextTaskNumber: 0 }),
      CHECK_VIOLATION,
      "project_next_task_number_positive",
    );
  });

  // ---------- Workspaces, users, membership ----------

  it("REQ-5: a user can't be a member of the same workspace twice", async () => {
    const user = await newUser();
    const workspace = await newWorkspace();
    await db
      .insert(schema.memberships)
      .values({ userId: user.id, workspaceId: workspace.id, role: "owner" });
    await expectRejected(
      db
        .insert(schema.memberships)
        .values({ userId: user.id, workspaceId: workspace.id, role: "member" }),
      UNIQUE_VIOLATION,
      "membership_pkey",
    );
  });

  it("REQ-5: an invite token is unique when set, and many workspaces can have none", async () => {
    const token = `token-${counter++}`;
    await db.insert(schema.workspaces).values({ name: "A", inviteToken: token });
    await expectRejected(
      db.insert(schema.workspaces).values({ name: "B", inviteToken: token }),
      UNIQUE_VIOLATION,
      "workspace_invite_token_unique",
    );
    await newWorkspace();
    await newWorkspace();
  });

  it("REQ-5: a GitHub account maps to one user", async () => {
    const githubId = counter++;
    await db.insert(schema.users).values({ name: "A", githubId });
    await expectRejected(
      db.insert(schema.users).values({ name: "B", githubId }),
      UNIQUE_VIOLATION,
      "user_github_id_unique",
    );
  });

  // ---------- No email, no GitHub tokens ----------

  it("REQ-5: the database refuses to store a user's email", async () => {
    await expectRejected(
      db.insert(schema.users).values({ name: "A", githubId: counter++, email: "a@example.com" }),
      CHECK_VIOLATION,
      "user_no_email",
    );
    await expectRejected(
      db.insert(schema.users).values({ name: "A", githubId: counter++, emailVerified: new Date() }),
      CHECK_VIOLATION,
      "user_no_email",
    );
    const user = await newUser();
    await expectRejected(
      db.update(schema.users).set({ email: "a@example.com" }).where(eq(schema.users.id, user.id)),
      CHECK_VIOLATION,
      "user_no_email",
    );
  });

  it("REQ-5: the database refuses to store any GitHub token field on an account", async () => {
    const user = await newUser();
    const link = () => ({
      userId: user.id,
      type: "oauth",
      provider: "github",
      providerAccountId: String(counter++),
    });
    const tokenFields = [
      { refresh_token: "x" },
      { access_token: "x" },
      { expires_at: 1 },
      { token_type: "bearer" },
      { scope: "read:user" },
      { id_token: "x" },
      { session_state: "x" },
    ];
    for (const field of tokenFields) {
      await expectRejected(
        db.insert(schema.accounts).values({ ...link(), ...field }),
        CHECK_VIOLATION,
        "account_no_tokens",
      );
    }
    // The link itself, with no tokens, is what T-8 stores.
    await db.insert(schema.accounts).values(link());
  });

  // ---------- Requirements ----------

  it("REQ-5: acceptance criteria are stored as a JSON array of text plus checked", async () => {
    const project = await newProjectInNewWorkspace();
    const { specId } = await newRequirement(project.id);
    const acceptance = [
      { text: "It works", checked: true },
      { text: "It is tested", checked: false },
    ];
    const [row] = await db
      .insert(schema.requirements)
      .values({ specId, ref: "REQ-2", rule: "Another rule", acceptance })
      .returning({ acceptance: schema.requirements.acceptance });
    expect(row.acceptance).toEqual(acceptance);

    for (const notAnArray of [`{"text":"x","checked":false}`, `"x"`, `null`]) {
      await expectRejected(
        db.insert(schema.requirements).values({
          specId,
          ref: `REQ-${counter++}`,
          rule: "Bad acceptance",
          acceptance: sql`${notAnArray}::jsonb`,
        }),
        CHECK_VIOLATION,
        "requirement_acceptance_is_array",
      );
    }
  });

  it("REQ-5: a requirement version number can't be stored twice", async () => {
    const project = await newProjectInNewWorkspace();
    const requirement = await newRequirement(project.id);
    await db.insert(schema.requirementVersions).values({
      requirementId: requirement.id,
      version: 1,
      rule: "A rule",
      acceptance: ["It works"],
    });
    await expectRejected(
      db
        .insert(schema.requirementVersions)
        .values({ requirementId: requirement.id, version: 1, rule: "Changed" }),
      UNIQUE_VIOLATION,
      "requirement_version_pkey",
    );
  });

  // ---------- Tasks, links, cycles ----------

  it("REQ-5: task numbers are unique within a project and start at 1", async () => {
    const workspace = await newWorkspace();
    const project = await newProject(workspace.id);
    const other = await newProject(workspace.id, "OTH");
    await newTask(project.id, 1);
    await expectRejected(
      db.insert(schema.tasks).values({ projectId: project.id, number: 1, title: "Duplicate" }),
      UNIQUE_VIOLATION,
      "task_project_id_number_unique",
    );
    // Each project counts its own tasks.
    await newTask(other.id, 1);
    await expectRejected(
      db.insert(schema.tasks).values({ projectId: project.id, number: 0, title: "Zero" }),
      CHECK_VIOLATION,
      "task_number_positive",
    );
  });

  it("REQ-5: a task link is stored once per task, kind and URL, so redeliveries upsert", async () => {
    const project = await newProjectInNewWorkspace();
    const task = await newTask(project.id);
    const url = "https://github.com/o/r/pull/1";
    await db.insert(schema.taskLinks).values({ taskId: task.id, kind: "pr", url, state: "open" });
    await expectRejected(
      db.insert(schema.taskLinks).values({ taskId: task.id, kind: "pr", url, state: "open" }),
      UNIQUE_VIOLATION,
      "task_link_task_id_kind_url_unique",
    );

    // A redelivered webhook updates the row in place.
    await db
      .insert(schema.taskLinks)
      .values({ taskId: task.id, kind: "pr", url, state: "merged" })
      .onConflictDoUpdate({
        target: [schema.taskLinks.taskId, schema.taskLinks.kind, schema.taskLinks.url],
        set: { state: "merged" },
      });
    const rows = await db
      .select({ state: schema.taskLinks.state })
      .from(schema.taskLinks)
      .where(eq(schema.taskLinks.taskId, task.id));
    expect(rows).toEqual([{ state: "merged" }]);

    // The same URL under another kind is a different link.
    await db.insert(schema.taskLinks).values({ taskId: task.id, kind: "check", url });
  });

  it("REQ-5: only deploy links have an environment", async () => {
    const project = await newProjectInNewWorkspace();
    const task = await newTask(project.id);
    await expectRejected(
      db.insert(schema.taskLinks).values({
        taskId: task.id,
        kind: "pr",
        url: "https://github.com/o/r/pull/2",
        environment: "preview",
      }),
      CHECK_VIOLATION,
      "task_link_environment_only_for_deploy",
    );
    await db.insert(schema.taskLinks).values({
      taskId: task.id,
      kind: "deploy",
      url: "https://example.com/deploy/1",
      environment: "production",
    });
  });

  it("REQ-5: a cycle can't end before it starts", async () => {
    const project = await newProjectInNewWorkspace();
    await expectRejected(
      db
        .insert(schema.cycles)
        .values({ projectId: project.id, startsOn: "2026-10-14", endsOn: "2026-10-13" }),
      CHECK_VIOLATION,
      "cycle_dates",
    );
    // A one-day cycle is fine.
    await db
      .insert(schema.cycles)
      .values({ projectId: project.id, startsOn: "2026-10-14", endsOn: "2026-10-14" });
  });

  it("REQ-5: deleting a cycle takes its tasks out of the cycle, not off the board", async () => {
    const project = await newProjectInNewWorkspace();
    const [cycle] = await db
      .insert(schema.cycles)
      .values({ projectId: project.id, startsOn: "2026-10-01", endsOn: "2026-10-14" })
      .returning({ id: schema.cycles.id });
    const [task] = await db
      .insert(schema.tasks)
      .values({ projectId: project.id, number: 1, title: "Task", cycleId: cycle.id })
      .returning({ id: schema.tasks.id });

    await db.delete(schema.cycles).where(eq(schema.cycles.id, cycle.id));

    const rows = await db
      .select({ cycleId: schema.tasks.cycleId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, task.id));
    expect(rows).toEqual([{ cycleId: null }]);
  });

  // ---------- Deletes ----------

  it("REQ-5: deleting a workspace deletes everything inside it", async () => {
    const user = await newUser();
    const workspace = await newWorkspace();
    await db
      .insert(schema.memberships)
      .values({ userId: user.id, workspaceId: workspace.id, role: "owner" });
    const project = await newProject(workspace.id);
    const requirement = await newRequirement(project.id);
    await db
      .insert(schema.requirementVersions)
      .values({ requirementId: requirement.id, version: 1, rule: "A rule", changedBy: user.id });
    const [cycle] = await db
      .insert(schema.cycles)
      .values({ projectId: project.id, startsOn: "2026-10-01", endsOn: "2026-10-14" })
      .returning({ id: schema.cycles.id });
    const [task] = await db
      .insert(schema.tasks)
      .values({
        projectId: project.id,
        number: 1,
        title: "Task",
        requirementId: requirement.id,
        builtOnVersion: 1,
        assigneeId: user.id,
        cycleId: cycle.id,
      })
      .returning({ id: schema.tasks.id });
    await db
      .insert(schema.taskLinks)
      .values({ taskId: task.id, kind: "pr", url: "https://github.com/o/r/pull/1" });

    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspace.id));

    const left = await db.execute<Record<string, number>>(sql`
      select
        (select count(*)::int from ${schema.memberships} where ${schema.memberships.workspaceId} = ${workspace.id}) as memberships,
        (select count(*)::int from ${schema.projects} where ${schema.projects.id} = ${project.id}) as projects,
        (select count(*)::int from ${schema.specs} where ${schema.specs.id} = ${requirement.specId}) as specs,
        (select count(*)::int from ${schema.requirements} where ${schema.requirements.id} = ${requirement.id}) as requirements,
        (select count(*)::int from ${schema.requirementVersions} where ${schema.requirementVersions.requirementId} = ${requirement.id}) as versions,
        (select count(*)::int from ${schema.tasks} where ${schema.tasks.id} = ${task.id}) as tasks,
        (select count(*)::int from ${schema.taskLinks} where ${schema.taskLinks.taskId} = ${task.id}) as task_links,
        (select count(*)::int from ${schema.cycles} where ${schema.cycles.projectId} = ${project.id}) as cycles,
        (select count(*)::int from ${schema.users} where ${schema.users.id} = ${user.id}) as users
    `);
    expect(left.rows[0]).toEqual({
      memberships: 0,
      projects: 0,
      specs: 0,
      requirements: 0,
      versions: 0,
      tasks: 0,
      task_links: 0,
      cycles: 0,
      // People outlive a workspace they belonged to.
      users: 1,
    });
  });

  it("REQ-5: deleting a user unassigns their tasks and keeps the history", async () => {
    const user = await newUser();
    const project = await newProjectInNewWorkspace();
    const requirement = await newRequirement(project.id);
    await db
      .insert(schema.requirementVersions)
      .values({ requirementId: requirement.id, version: 1, rule: "A rule", changedBy: user.id });
    const [task] = await db
      .insert(schema.tasks)
      .values({ projectId: project.id, number: 1, title: "Task", assigneeId: user.id })
      .returning({ id: schema.tasks.id });
    const [activity] = await db
      .insert(schema.activities)
      .values({ entity: "task", entityId: task.id, change: { status: "doing" }, actor: user.id })
      .returning({ id: schema.activities.id });

    await db.delete(schema.users).where(eq(schema.users.id, user.id));

    const [taskAfter] = await db
      .select({ assigneeId: schema.tasks.assigneeId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, task.id));
    expect(taskAfter).toEqual({ assigneeId: null });

    const [activityAfter] = await db
      .select({ actor: schema.activities.actor })
      .from(schema.activities)
      .where(eq(schema.activities.id, activity.id));
    expect(activityAfter).toEqual({ actor: null });

    const [versionAfter] = await db
      .select({ changedBy: schema.requirementVersions.changedBy })
      .from(schema.requirementVersions)
      .where(eq(schema.requirementVersions.requirementId, requirement.id));
    expect(versionAfter).toEqual({ changedBy: null });
  });

  it("REQ-5: deleting a user deletes their sessions, accounts and memberships", async () => {
    const user = await newUser();
    const workspace = await newWorkspace();
    await db
      .insert(schema.memberships)
      .values({ userId: user.id, workspaceId: workspace.id, role: "member" });
    await db.insert(schema.accounts).values({
      userId: user.id,
      type: "oauth",
      provider: "github",
      providerAccountId: String(counter++),
    });
    await db.insert(schema.sessions).values({
      sessionToken: `session-${counter++}`,
      userId: user.id,
      expires: new Date(Date.now() + 86_400_000),
    });

    await db.delete(schema.users).where(eq(schema.users.id, user.id));

    const left = await db.execute<Record<string, number>>(sql`
      select
        (select count(*)::int from ${schema.sessions} where ${schema.sessions.userId} = ${user.id}) as sessions,
        (select count(*)::int from ${schema.accounts} where ${schema.accounts.userId} = ${user.id}) as accounts,
        (select count(*)::int from ${schema.memberships} where ${schema.memberships.userId} = ${user.id}) as memberships,
        (select count(*)::int from ${schema.workspaces} where ${schema.workspaces.id} = ${workspace.id}) as workspaces
    `);
    // The workspace stays; only the user's own rows go.
    expect(left.rows[0]).toEqual({ sessions: 0, accounts: 0, memberships: 0, workspaces: 1 });
  });

  it("REQ-5: deleting a requirement unlinks its tasks instead of deleting them", async () => {
    const project = await newProjectInNewWorkspace();
    const requirement = await newRequirement(project.id);
    const [task] = await db
      .insert(schema.tasks)
      .values({ projectId: project.id, number: 1, title: "Task", requirementId: requirement.id })
      .returning({ id: schema.tasks.id });

    await db.delete(schema.requirements).where(eq(schema.requirements.id, requirement.id));

    const [taskAfter] = await db
      .select({ requirementId: schema.tasks.requirementId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, task.id));
    expect(taskAfter).toEqual({ requirementId: null });
  });
});
