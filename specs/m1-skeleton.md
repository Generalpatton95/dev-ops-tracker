# Spec M1 — Skeleton

Status: in progress · Owner: Austin Patton · Last updated: 2026-10-16

## Goal

M1 delivers a live app where you can sign in with GitHub, get a workspace, invite teammates and create projects. It's done when that works on a production URL and every PR gets its own preview deploy and database branch.

Nothing in M1 tracks work yet. It's the base that M2 (tasks and board) builds on.

## Requirements

Eight requirements, each written as a rule with checks that prove it works. Tasks below point at these IDs, and so should every PR.

**REQ-1 Sign in with GitHub.** A user can only use the app after signing in with GitHub.

- [ ] Signing in with GitHub creates a user record on first visit and reuses it after.
- [ ] Visiting any app page while signed out sends you to the sign-in page.
- [ ] Sign out ends the session on that device.
- [ ] Public endpoints are rate-limited using Postgres, and fail closed if the limiter can't run. (Added 2026-10-15.)

**REQ-2 Workspace on first sign-in.** Every user lands in a workspace they own.

- [ ] First sign-in creates a workspace with the user as owner.
- [ ] The owner can rename the workspace.

**REQ-3 Invite teammates.** An owner can bring teammates into the workspace.

- [ ] The owner can create an invite link and turn it off.
- [ ] A signed-in user who opens a working link joins as a member.
- [ ] The owner can see all members and remove any member.

**REQ-4 Projects.** Members can create and manage projects inside a workspace.

- [ ] A project has a name and a key of 2 to 5 capital letters, unique in the workspace.
- [ ] Projects show in the left sidebar.
- [ ] Projects can be renamed and archived; archived ones leave the sidebar.

**REQ-5 Database schema.** The full v1 schema from the product spec exists from day one.

- [ ] All v1 tables are defined in Drizzle and created by migrations.
- [ ] Migrations run automatically on deploy.

**REQ-6 Deploy pipeline.** Code goes live without manual steps.

- [ ] A push to main deploys to production on Vercel.
- [ ] Every PR gets a preview deploy with its own Neon database branch.
- [ ] Secrets live in environment variables, never in the repo.

**REQ-7 Portable core.** The app runs on any Node host with any Postgres.

- [ ] The app runs locally against plain Postgres using only a `DATABASE_URL`.
- [ ] The core code uses no Vercel-only or Neon-only services; those stay in deploy config.

**REQ-8 Repo basics.** The repo is ready for outside contributors.

- [x] The repo has a README, an AGPL license and a `/specs` folder holding this spec.
- [x] Every PR runs type checks, lint, a format check, tests, a production build and a dependency audit (high and critical), and must pass before merge. (Format check, build and audit added 2026-10-15.)

## Design notes

Stick to the product spec's stack and keep every hosting choice swappable.

- **Stack:** Next.js (App Router) + TypeScript + Tailwind, tRPC for app calls, Drizzle for the database, Auth.js with the GitHub provider.
- **Database access:** connect with the standard Postgres driver through `DATABASE_URL`, so Neon is just one place it can point.
- **Sessions:** stored in Postgres through the Auth.js Drizzle adapter, not in a hosted key-value store.
- **Invite links:** a random token saved on the workspace; turning the link off clears the token.
- **Project keys:** checked on the server, saved in capitals, and fixed once tasks exist (M2), since task IDs like DOT-12 use them.
- **Preview databases:** set up through the Neon and Vercel integration, so this lives in deploy config, not app code.
- **Tooling:** pnpm, Vitest for tests, ESLint (Next's rules) plus Prettier with Tailwind class sorting. Decided 2026-10-15.
- **Security baseline:** pages send headers that block framing by other sites, and load nothing from outside hosts (no Google Fonts). The tRPC route caps batches at 10 calls and request bodies at 100KB, and unexpected server errors reach the client as a generic message.
- **Known gaps (from the T-2 security review, 2026-10-15):**
  - No rate limiting yet. The only public call is a health ping, and a correct limiter needs shared storage (Postgres, T-5). Now a REQ-1 check, built in T-8.
  - The body cap trusts the `Content-Length` header. Count bytes while reading once the first mutation lands.
  - The CSP only covers framing; a nonce-based `script-src` can come later.
- **Audit exception:** `braces` ≤3.0.3 (GHSA-vfj7-8cjw-p6xm, high, no patch) comes only through `eslint-config-next`, a dev-only lint tool that never ships and only reads our own glob patterns. Ignored by advisory ID in `pnpm-workspace.yaml`, so CI still fails on any new finding. Recheck at each release.
- **Schema (T-5, decided 2026-10-16):** the node-postgres (`pg`) driver, which works through Neon's pooler. UUID keys, Postgres enums for the fixed sets, timestamps with time zone, indexed foreign keys. Migrations use `DATABASE_URL_UNPOOLED` when set, else `DATABASE_URL`. CI applies them to a throwaway Postgres; local tests use `TEST_DATABASE_URL` when it's set. The rate-limit table comes with T-8.
- **User data from GitHub:** id, name and avatar only. No email and no GitHub access tokens are stored. Disclosed on the privacy page before sign-in goes live (T-8). Decided 2026-10-16.
- **Task numbers:** each project counts its own tasks (`task.number`, from `project.next_task_number`), so IDs like DOT-12 exist from the first task. Decided 2026-10-16.

## Tasks

Twelve tasks, in build order. Until the app can track itself (M2), this table is the board.

| ID | Task | Requirement | Size | Status |
| --- | --- | --- | --- | --- |
| T-1 | Create the GitHub repo with README, AGPL license and `/specs` folder | REQ-8 | S | Done |
| T-2 | Scaffold Next.js, TypeScript, Tailwind and tRPC | REQ-8 | M | Done |
| T-3 | Add CI: type check, lint, format check, tests, build and audit on every PR | REQ-8 | S | Done |
| T-4 | Create the Neon project and production database | REQ-5 | S | Done |
| T-5 | Write the Drizzle schema for all v1 tables and the first migration | REQ-5 | M | Doing |
| T-6 | Link the repo to a Vercel project, set env vars, run migrations on deploy | REQ-6 | S | Todo |
| T-7 | Turn on Neon branches for Vercel preview deploys | REQ-6 | S | Todo |
| T-8 | Add GitHub sign-in, sign-out, protected pages and rate limits | REQ-1 | M | Todo |
| T-9 | Create a workspace on first sign-in, plus rename | REQ-2 | S | Todo |
| T-10 | Build invite links and the members list | REQ-3 | M | Todo |
| T-11 | Build projects: create, sidebar list, rename, archive | REQ-4 | M | Todo |
| T-12 | Check the app runs locally on plain Postgres | REQ-7 | S | Todo |

## Out of scope

- Tasks, the board and specs in the app (M2 and M3)
- The guest role and email invites
- Docker and self-host setup
- Any styling past clean defaults

## Open questions

- [x] Repo name: `dev-ops-tracker` on the Generalpatton95 account (can be renamed later).
- [ ] Is there a target date for M1?
