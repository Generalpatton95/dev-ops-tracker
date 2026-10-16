// T-5 (REQ-5): the full v1 schema from specs/product.md → "Data model", plus the Auth.js tables.
// Database names are snake_case; TypeScript keys are camelCase.
// Loaded by drizzle-kit as well as the app, so this file must not import "server-only".
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------- Shared columns ----------

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
// Set by Drizzle on every update made through it.
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------- Enums (the fixed sets in specs/product.md → "Core concepts") ----------

export const roleEnum = pgEnum("role", ["owner", "member", "guest"]);
export const taskStatusEnum = pgEnum("task_status", ["todo", "doing", "review", "done"]);
export const taskSizeEnum = pgEnum("task_size", ["s", "m", "l"]);
export const specStatusEnum = pgEnum("spec_status", ["draft", "active", "archived"]);
export const taskLinkKindEnum = pgEnum("task_link_kind", [
  "branch",
  "commit",
  "pr",
  "check",
  "deploy",
]);
export const environmentEnum = pgEnum("environment", ["preview", "production"]);

// ---------- Workspaces, people, membership ----------

export const workspaces = pgTable(
  "workspace",
  {
    id: id(),
    name: text("name").notNull(),
    // Random invite link token; turning the link off sets it to null (REQ-3).
    inviteToken: text("invite_token"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("workspace_invite_token_unique")
      .on(t.inviteToken)
      .where(sql`${t.inviteToken} is not null`),
  ],
);

// Also the Auth.js user table: `name`, `email`, `emailVerified` and `image` are the keys
// @auth/drizzle-adapter expects. From GitHub the app keeps only id, name and avatar
// (decided 2026-10-16), so `email` and `emailVerified` exist only for the adapter's types.
// The database rejects any value in them (user_no_email); T-8 strips them before writing.
export const users = pgTable(
  "user",
  {
    id: id(),
    name: text("name").notNull(),
    githubId: bigint("github_id", { mode: "number" }).notNull(),
    // The adapter calls the avatar `image`; the column is `avatar_url`.
    image: text("avatar_url"),
    // Always null (see above).
    email: text("email"),
    // Always null (see above).
    emailVerified: timestamp("email_verified", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("user_github_id_unique").on(t.githubId),
    check("user_no_email", sql`${t.email} is null and ${t.emailVerified} is null`),
  ],
);

export const memberships = pgTable(
  "membership",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One membership per user per workspace; also serves lookups by user_id.
    primaryKey({ name: "membership_pkey", columns: [t.userId, t.workspaceId] }),
    index("membership_workspace_id_idx").on(t.workspaceId),
  ],
);

// ---------- Projects and specs ----------

export const projects = pgTable(
  "project",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Task IDs like DOT-12 use it, so it is fixed once tasks exist (checked in the app).
    key: text("key").notNull(),
    name: text("name").notNull(),
    repo: text("repo"),
    // The number the project's next task gets (DOT-12 = key + number).
    nextTaskNumber: integer("next_task_number").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Also serves lookups by workspace_id.
    unique("project_workspace_id_key_unique").on(t.workspaceId, t.key),
    check("project_key_format", sql`${t.key} ~ '^[A-Z]{2,5}$'`),
    check("project_next_task_number_positive", sql`${t.nextTaskNumber} >= 1`),
  ],
);

export const specs = pgTable(
  "spec",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull().default(""),
    status: specStatusEnum("status").notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("spec_project_id_idx").on(t.projectId)],
);

// One acceptance criterion and whether it's been ticked off.
export type AcceptanceCriterion = { text: string; checked: boolean };

export const requirements = pgTable(
  "requirement",
  {
    id: id(),
    specId: uuid("spec_id")
      .notNull()
      .references(() => specs.id, { onDelete: "cascade" }),
    // e.g. REQ-12
    ref: text("ref").notNull(),
    rule: text("rule").notNull(),
    // Text plus checked. Ticking a box doesn't bump `version`; versions keep the text only.
    // The database only checks that this is a JSON array; the app validates each item.
    acceptance: jsonb("acceptance")
      .$type<AcceptanceCriterion[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Also serves lookups by spec_id.
    unique("requirement_spec_id_ref_unique").on(t.specId, t.ref),
    check("requirement_acceptance_is_array", sql`jsonb_typeof(${t.acceptance}) = 'array'`),
  ],
);

// Every version of a requirement is kept, which is what makes the diff view possible.
// Acceptance criteria are text only here: whether they're checked isn't part of a version.
export const requirementVersions = pgTable(
  "requirement_version",
  {
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    rule: text("rule").notNull(),
    acceptance: text("acceptance")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "requirement_version_pkey", columns: [t.requirementId, t.version] }),
    index("requirement_version_changed_by_idx").on(t.changedBy),
  ],
);

// ---------- Tasks ----------

export const tasks = pgTable(
  "task",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Taken from project.next_task_number when the task is created.
    number: integer("number").notNull(),
    requirementId: uuid("requirement_id").references(() => requirements.id, {
      onDelete: "set null",
    }),
    // A task is stale when this is older than its requirement's version.
    builtOnVersion: integer("built_on_version"),
    title: text("title").notNull(),
    status: taskStatusEnum("status").notNull().default("todo"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    size: taskSizeEnum("size"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Optional, so the board can filter by cycle. The app keeps it within the task's project.
    cycleId: uuid("cycle_id").references(() => cycles.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Also serves lookups by project_id.
    unique("task_project_id_number_unique").on(t.projectId, t.number),
    index("task_project_id_status_idx").on(t.projectId, t.status),
    index("task_assignee_id_idx").on(t.assigneeId),
    index("task_requirement_id_idx").on(t.requirementId),
    // A cycle belongs to one project, so cycle_id alone narrows a board to that cycle as well
    // as (project_id, cycle_id) would, and it also serves the set-null when a cycle is deleted.
    index("task_cycle_id_idx").on(t.cycleId),
    check("task_number_positive", sql`${t.number} >= 1`),
  ],
);

// A branch, commit, PR, CI check or deploy linked to a task.
export const taskLinks = pgTable(
  "task_link",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: taskLinkKindEnum("kind").notNull(),
    url: text("url").notNull(),
    // e.g. open/merged/closed for a PR, passing/failing for a check.
    state: text("state"),
    // Only for deploys.
    environment: environmentEnum("environment"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One row per link, so webhook redeliveries can upsert. Also serves lookups by task_id.
    unique("task_link_task_id_kind_url_unique").on(t.taskId, t.kind, t.url),
    check(
      "task_link_environment_only_for_deploy",
      sql`${t.environment} is null or ${t.kind} = 'deploy'`,
    ),
  ],
);

// ---------- Cycles ----------

// `start` and `end` in the product spec; `end` is a reserved word, so starts_on/ends_on.
export const cycles = pgTable(
  "cycle",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("cycle_project_id_idx").on(t.projectId),
    check("cycle_dates", sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);

// ---------- Activity ----------

// Polymorphic: `entity` names the table and `entity_id` the row, so there is no foreign key.
export const activities = pgTable(
  "activity",
  {
    id: id(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    change: jsonb("change").notNull(),
    actor: uuid("actor").references(() => users.id, { onDelete: "set null" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("activity_entity_entity_id_idx").on(t.entity, t.entityId),
    index("activity_actor_idx").on(t.actor),
  ],
);

// ---------- Auth.js (database sessions through @auth/drizzle-adapter) ----------

// Links a GitHub account to a user. The token columns below exist only for the adapter's
// types: no GitHub access tokens are stored (decided 2026-10-16), so the database rejects
// any value in them (account_no_tokens); T-8 strips them before insert.
export const accounts = pgTable(
  "account",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    // Always null (see above).
    refresh_token: text("refresh_token"),
    // Always null (see above).
    access_token: text("access_token"),
    // Always null (see above).
    expires_at: integer("expires_at"),
    // Always null (see above).
    token_type: text("token_type"),
    // Always null (see above).
    scope: text("scope"),
    // Always null (see above).
    id_token: text("id_token"),
    // Always null (see above).
    session_state: text("session_state"),
  },
  (t) => [
    primaryKey({ name: "account_pkey", columns: [t.provider, t.providerAccountId] }),
    index("account_user_id_idx").on(t.userId),
    check(
      "account_no_tokens",
      sql`num_nonnulls(${t.refresh_token}, ${t.access_token}, ${t.expires_at}, ${t.token_type}, ${t.scope}, ${t.id_token}, ${t.session_state}) = 0`,
    ),
  ],
);

export const sessions = pgTable(
  "session",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const verificationTokens = pgTable(
  "verification_token",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ name: "verification_token_pkey", columns: [t.identifier, t.token] })],
);
