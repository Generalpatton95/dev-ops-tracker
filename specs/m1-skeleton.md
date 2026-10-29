# Spec M1 — Skeleton

Status: in progress · Owner: Austin Patton · Last updated: 2026-10-24

## Goal

M1 delivers a live app where you can sign in with GitHub, get a workspace, invite teammates and create projects. It's done when that works on a production URL and every PR gets its own preview deploy and database branch.

Nothing in M1 tracks work yet. It's the base that M2 (tasks and board) builds on.

## Requirements

Eight requirements, each written as a rule with checks that prove it works. Tasks below point at these IDs, and so should every PR.

**REQ-1 Sign in with GitHub.** A user can only use the app after signing in with GitHub.

- [x] Signing in with GitHub creates a user record on first visit and reuses it after.
- [x] Visiting any app page while signed out sends you to the sign-in page.
- [x] Sign out ends the session on that device.
- [x] Public endpoints are rate-limited using Postgres, and fail closed if the limiter can't run. (Added 2026-10-15.)

**REQ-2 Workspace on first sign-in.** Every user lands in a workspace they own.

- [x] First sign-in creates a workspace with the user as owner.
- [x] The owner can rename the workspace.

**REQ-3 Invite teammates.** An owner can bring teammates into the workspace.

- [ ] The owner can create an invite link and turn it off.
- [ ] A signed-in user who opens a working link joins as a member.
- [ ] The owner can see all members and remove any member.

**REQ-4 Projects.** Members can create and manage projects inside a workspace.

- [ ] A project has a name and a key of 2 to 5 capital letters, unique in the workspace.
- [ ] Projects show in the left sidebar.
- [ ] Projects can be renamed and archived; archived ones leave the sidebar.

**REQ-5 Database schema.** The full v1 schema from the product spec exists from day one.

- [x] All v1 tables are defined in Drizzle and created by migrations.
- [x] Migrations run automatically on deploy.

**REQ-6 Deploy pipeline.** Code goes live without manual steps.

- [x] A push to main deploys to production on Vercel.
- [x] Every PR gets a preview deploy with its own Neon database branch.
- [x] Secrets live in environment variables, never in the repo.

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
  - No rate limiting yet. The only public call is a health ping, and a correct limiter needs shared storage (Postgres, T-5). Now a REQ-1 check, built in T-8. (Closed by T-8: Postgres rate limits.)
  - The body cap trusts the `Content-Length` header. Count bytes while reading once mutations carry real payloads. T-9's rename is the first mutation but small (Node also checks the body against `Content-Length`); moved to T-10, when invites add more (decided 2026-10-28).
  - The CSP only covers framing; a nonce-based `script-src` can come later.
- **Audit exception:** `braces` ≤3.0.3 (GHSA-vfj7-8cjw-p6xm, high, no patch) comes only through `eslint-config-next`, a dev-only lint tool that never ships and only reads our own glob patterns. Ignored by advisory ID in `pnpm-workspace.yaml`, so CI still fails on any new finding. Recheck at each release.
- **Schema (T-5, decided 2026-10-16):** the node-postgres (`pg`) driver, which works through Neon's pooler. UUID keys, Postgres enums for the fixed sets, timestamps with time zone, indexed foreign keys. Migrations use `DATABASE_URL_UNPOOLED` when set, else `DATABASE_URL`. CI applies them to a throwaway Postgres; local tests use `TEST_DATABASE_URL` when it's set. The rate-limit table comes with T-8.
- **User data from GitHub:** id, name and avatar only. No email and no GitHub access tokens are stored. Disclosed on the privacy page before sign-in goes live (T-8). Decided 2026-10-16.
- **Task numbers:** each project counts its own tasks (`task.number`, from `project.next_task_number`), so IDs like DOT-12 exist from the first task. Decided 2026-10-16.
- **Cycles and acceptance ticks:** a task has an optional `cycle_id`, so the board can filter by cycle. Each acceptance criterion stores its text and whether it's checked; requirement versions keep only the text, so ticking never makes a task stale. Decided 2026-10-16.
- **Enforced in the database:** the email and GitHub token columns that Auth.js's adapter needs exist but must stay empty (a CHECK rejects any value), so a missed wrapper fails loudly instead of storing them.
- **Deploy (T-6, decided 2026-10-16):**
  - The owner imports the repo into Vercel and sets the variables; the coordinator then checks the settings read-only (variable names only, never values).
  - Production gets `DATABASE_URL` (Neon's pooled URL) and `DATABASE_URL_UNPOOLED` (direct), both marked Sensitive. Every environment gets `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the pnpm version pinned in `package.json`.
  - Preview gets no database variables until T-7, so previews can never reach production data.
  - `vercel.json` holds the deploy settings: region `iad1` (next to Neon's `aws-us-east-1`), and a build command that runs `next build` and then a migrate step. A failed build never touches the database; a failed migration fails the deploy, so it's never promoted.
  - The migrate step (`scripts/`, deploy config, not app code) runs in production and fails if no database URL is set. On previews (and Vercel's development builds) it migrates when a URL is set and skips otherwise. Its output never shows a connection string, host or user.
  - Migrations are forward-only and must keep working with the code before them (add first, remove in a later deploy), because the old deployment keeps serving while a new one migrates.
  - CI tests on Postgres 17, production's version, pinned by digest.
  - Rollback: code through Vercel's Instant Rollback to the previous deployment. Database through Neon's restore to a time before the deploy; this plan keeps 6 hours of history, so check right after each deploy.
  - First production deploy, 2026-10-22: merge of #8 (`b2c86d5`) on the Vercel project `dev-ops-tracker-2r9n` built and migrated; the health ping answers `ok`. Rollback point: Neon restore to before 19:50 UTC that day (no earlier schema). A second project, `dev-ops-tracker`, was imported before the database variables were set; its build failed after 21 seconds (most likely the migrate step stopping with no database URL; logs not checked), and it is to be deleted.
- **Preview databases (T-7, decided 2026-10-24, review fixes the same day):**
  - Neon's own Vercel integration (Neon-Managed, linked from the existing Neon account) creates one `preview/<git-branch>` branch per git branch with a preview, injects that branch's `DATABASE_URL` and `DATABASE_URL_UNPOOLED` into its deploys, and deletes it once the git branch is merged or deleted. No Neon API key in GitHub, no branching code.
  - Previews never copy production. The integration always branches from the Neon project's default branch, so the default becomes `preview-base`: a schema-only branch of `main`, emptied, marked, with its own role password. `main` stays the integration's Production branch.
  - `preview-base` keeps its `public` schema (owner, grants, extensions) but no tables, types or rows; a schema-only copy has the tables but not `drizzle.__drizzle_migrations`, so migrations would fail on it. `scripts/empty-preview-base.sql` empties it once. It stops, changing nothing, if it finds migration history or any rows, so on `main` it does nothing. It then marks the branch: `public` gets the comment `dot-preview-base`, which every preview copies and `main` never has.
  - Preview and development builds check that marker before migrating or seeding, and fail if it's missing, so a Preview pointed at production by mistake never migrates or seeds it. Production builds don't look at the marker.
  - Each preview build migrates its branch from scratch (the T-6 step), then a seed step adds fake data: one user (negative `github_id`, which no real GitHub account has), a workspace they own and one project. It writes in one transaction under an advisory lock, only when `user` and `workspace` are both empty. Later tasks add to the seed as their screens land. Output names no URL, host, user or password.
  - Production's database pair moves from hand-set to the integration (set from `main`). The running deployment keeps its values until the next deploy; a deploy in between fails at the migrate step and is never promoted. The integration's variables are locked against edits, so they can't be marked Sensitive; accepted 2026-10-24 because the owner is the only member of the Vercel project and the values are encrypted at rest. Recheck if anyone joins the project.
  - Development builds get no database. The integration's `vercel-dev` branch was first created while `main` was still the default branch, so it copied production; it was deleted on 2026-10-24 and not recreated (local development uses `.env.local`). Only Production holds production credentials.
  - Fork PRs: every preview branch shares `preview-base`'s password, so an approved fork's build learns it. It can't open `main`, but it can open other previews (after T-8 these hold the owner's GitHub name, avatar and sessions from testing). So: don't approve fork PRs through Fork Protection without reading them first, and reset `preview-base`'s password after approving one. How the integration names branches for forks with the same branch name is unchecked; look at the first one.
  - Owner setup, in this order. Each step is checked before the next:
    1. Neon → Branches → New branch: parent `main`, name `preview-base`, **Schema only**, and untick "Automatically delete branch after". Check: it shows no parent and no expiry.
    2. Neon → SQL Editor, branch `preview-base`, role `dev_ops_tracker_owner` (the database's owner, which the integration uses; the editor connects as it by default): run `scripts/empty-preview-base.sql`. Check: Tables shows nothing in `public` for `preview-base`, while `main` still has its 14 tables.
    3. Neon → `preview-base` → Roles → `dev_ops_tracker_owner` → Reset password. Check: the production site still works and its next deploy passes the migrate step (that branch's password is unchanged).
    4. Neon → Branches → `preview-base` → Set as default. `main` keeps running production.
    5. Vercel → Settings → Environment Variables: delete the hand-set `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. Production keeps serving on the current deployment.
    6. Neon → Integrations → Vercel → Add, "Link Existing Neon Account": Vercel project `dev-ops-tracker-2r9n`, Neon project `dev-ops-tracker`, Production branch `main`, database `dev_ops_tracker`, role `dev_ops_tracker_owner`. Leave the `vercel-dev` branch off; turn on "Automatically delete obsolete Neon branches". Under Settings, keep only `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. Check: Integrations → Manage → Branches shows Production branch `main`. Check again after any Save on the Settings tab: on 2026-10-25 a resync made after `preview-base` became the default switched Production to `preview-base`, and it was set back to `main` before any deploy.
    7. Vercel → Environment Variables. Check: exactly `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, Production only, with the Neon mark; no hand-set or Preview-scoped copies; `ENABLE_EXPERIMENTAL_COREPACK` in every environment.
    8. Redeploy production. Check: the build passes its migrate step (GitHub shows the Vercel check green) and the site loads.
    9. Push a commit to the T-7 PR. Check: Neon shows `preview/t-7-neon-preview-branches` with parent `preview-base`, not `main`, and the preview build log shows migrations applied and the seed added.
  - First preview, 2026-10-25: PR #10 (`00674d2`) got `preview/t-7-neon-preview-branches` from `preview-base`; the build passed the marker check, applied the migration and seeded the demo user, workspace and project, and the log showed no URL, host or password.
  - First production deploy with the integration, 2026-10-25: merge of #10 (`5d8823f`) migrated `main` (already current) and skipped the seed; `main` still has its 14 tables, no demo rows and no marker; the health ping answers `ok`. The preview's Neon branch is deleted by the integration at the next preview deploy.
  - Rollback: in Neon → Integrations, disconnect Vercel; set the hand-set pair again in Vercel, **Production scope only**, as in T-6; set `main` as the default branch. Nothing in T-7 changes `main`'s data or schema.
- **Sign-in (T-8, decided 2026-10-25):**
  - Auth.js v5 (`next-auth`, pinned to exactly `5.0.0-beta.32`: still a beta, but the release that supports Next 16 and matches `@auth/drizzle-adapter`) with the GitHub provider and database sessions in the existing Auth.js tables.
  - The adapter is wrapped: `createUser` sets `github_id`, name and `avatar_url` from the GitHub profile and drops the email; `linkAccount` drops every token field. The database CHECKs reject any email or token that slips through. Auth.js gets its own logger that records error names and codes only.
  - Every page needs a session except `/sign-in` and `/privacy`. Signed out, a page redirects to `/sign-in`, carrying only a same-site relative return path. Next 16's `proxy.ts` does the redirect, but pages, layouts and tRPC check the session on the server too; the proxy is never the only check. tRPC gets a `protectedProcedure` (`UNAUTHORIZED` when signed out); `health.ping` stays public.
  - Sessions last a fixed 30 days from sign-in (not extended by use); expired session rows are deleted by the same clean-up. Sign out deletes that device's session row (Auth.js's CSRF-protected sign-out).
  - Sign-in and sign-out buttons fetch Auth.js's CSRF token and POST to its endpoints, so every request passes the rate limit and Auth.js's CSRF check; they need JavaScript (accepted 2026-10-25). Only four Auth.js endpoints are open (`csrf`, `signin/github`, `callback/github`, `signout`); the rest answer 404.
  - Rate limits in Postgres (REQ-1): a `rate_limit` table keyed by an HMAC of the caller's IP and the bucket name (never the raw IP), counting fixed one-minute windows (from the database's clock) in one upsert per request. IPv6 callers are counted per /64 network. A row is kept about a day after the caller's last request and deleted by a clean-up that runs as the site handles later requests (no scheduled job; decided 2026-10-25). Buckets: Auth.js sign-in and callback routes 10 per minute per IP; signed-out tRPC calls 60 per minute per IP. If the limiter can't run (database error, or no answer within 2 seconds), the request gets a 503: it fails closed. The HMAC key is derived from `AUTH_SECRET`.
  - The caller's IP comes only from the header named in `TRUSTED_IP_HEADER` (`x-real-ip` on Vercel, set by the owner). Unset, every caller shares one bucket, so it fails safe on hosts without a trusted proxy (REQ-7: no Vercel-only code).
  - `/privacy` lists what is kept: GitHub id, name and avatar URL; the session cookie and session row; the keyed IP hash for rate limiting, kept about a day after the last request. It also says what isn't kept (no email, no GitHub tokens, no analytics) and where it is hosted (Vercel, Neon in US East). Live before sign-in is.
  - UI: `/sign-in` with one "Sign in with GitHub" button and a link to `/privacy`; a signed-in header with initials, name and "Sign out"; a placeholder home until T-9. Avatars are stored but not shown yet, so pages still load nothing from outside hosts.
  - Previews have no sign-in: the `AUTH_*` variables are Production only (and local), so no production secret reaches a preview. Without them the sign-in page says sign-in works on production and locally, and builds still pass.
  - Owner setup: two GitHub OAuth Apps. Production: homepage `https://dev-ops-tracker-2r9n.vercel.app`, callback `https://dev-ops-tracker-2r9n.vercel.app/api/auth/callback/github`. Local: callback `http://localhost:3000/api/auth/callback/github`. Vercel Production gets `AUTH_SECRET`, `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` (Sensitive) and `TRUSTED_IP_HEADER=x-real-ip`; `.env.local` gets the local app's values. `.env.example` lists the names.
  - Known gap (accepted 2026-10-25, revisit before launch): requests carrying a session cookie, even a junk one, cost one indexed session lookup without a rate limit, and a CSRF-checked sign-out costs one delete.
  - First production sign-in, 2026-10-28: merge of #14 (`886734c`) applied migration `0001` on `main`; the owner signed in, out and in again. Checked by counts only: one user with a GitHub id and no email, one account with no tokens, one session (the signed-out one deleted) expiring in 30 days, one hashed rate-limit row. Rollback: Vercel Instant Rollback; `rate_limit` can stay.
  - Not now: hashing session tokens at rest (optional per the T-5 review; a database leak is already worse), avatars, preview sign-in.
  - The `rate_limit` migration only adds a table (forward-only). Rollback: Vercel Instant Rollback; the table can stay.
- **Workspaces (T-9, decided 2026-10-28):**
  - A signed-in user always has a workspace they own. The server ensures it on every signed-in page: one indexed lookup finds the owned workspace; only if there is none does it open a transaction, take a per-user advisory lock, look again and create the workspace with an `owner` membership, so two tabs never make two. This covers new users, accounts that signed in before T-9 (the owner's) and half-finished sign-ins. Sign-in itself is unchanged.
  - The default name is "<GitHub name>'s workspace", cut to fit 50 characters, or "My workspace" when the name is blank.
  - Names: trimmed, 1 to 50 characters, any text, checked on the server with Zod and always rendered as text.
  - Names refuse control characters and bidi controls, so a name can't hide text or reverse it for other members.
  - In M1 the current workspace is the one the user owns. (T-10 adds membership of other workspaces; a switcher comes when it's needed.)
  - tRPC: `workspace.current` (name and the caller's role) and `workspace.rename` (owner only), both `protectedProcedure`. Anyone else, or an unknown workspace id, gets the same `NOT_FOUND`.
  - UI: the home page shows the workspace name; the header links to `/settings`, a protected page with the name field and Save. T-10 adds invites and members there.
  - No migration: the `workspace` and `membership` tables exist. Nothing new is public, so no new rate-limit bucket.
- **Notes for later tasks (from the T-5 and T-6 reviews, 2026-10-16):**
  - T-8: wrap the adapter's `createUser` (set `github_id`, drop email) and `linkAccount` (drop tokens), with tests; give Auth.js its own logger that records error names and codes only, since Drizzle errors carry query values; hashing session tokens at rest is optional.
  - T-10: invite tokens from `randomBytes(32)` (base64url), looked up through the unique index; consider storing a hash.
  - T-6 and T-12: drizzle-kit loads `.env` but not `.env.local`, so export the variables before `db:migrate`.
  - T-7 (from the T-6 security review): Neon preview branches are copies of production, user rows included, and a fork's PR approved through Vercel's Fork Protection would run its code against one. Decide how previews are seeded or masked before turning branches on. (Decided 2026-10-24: see Preview databases.)
  - T-12 (from the T-8 reviews): the rate limiter uses `date_bin`, which needs Postgres 14 or later; nothing indexes `session.expires`, so the session clean-up scans the table (fine at this size; add an index if sessions grow).
  - Before the first migration that locks a busy table: give migrations a `lock_timeout` (e.g. `PGOPTIONS` on the direct URL only; Neon's pooler rejects startup options). The 300s build timeout stops the deploy but not a backend already waiting on a lock.
  - The CI Postgres image is pinned by digest; refresh it at each release. `pnpm audit` also shows a moderate esbuild finding (GHSA-67mh-4wv8-2f99) via drizzle-kit, dev only and only in esbuild's dev server, which drizzle-kit never starts.

## Tasks

Twelve tasks, in build order. Until the app can track itself (M2), this table is the board.

| ID | Task | Requirement | Size | Status |
| --- | --- | --- | --- | --- |
| T-1 | Create the GitHub repo with README, AGPL license and `/specs` folder | REQ-8 | S | Done |
| T-2 | Scaffold Next.js, TypeScript, Tailwind and tRPC | REQ-8 | M | Done |
| T-3 | Add CI: type check, lint, format check, tests, build and audit on every PR | REQ-8 | S | Done |
| T-4 | Create the Neon project and production database | REQ-5 | S | Done |
| T-5 | Write the Drizzle schema for all v1 tables and the first migration | REQ-5 | M | Done |
| T-6 | Link the repo to a Vercel project, set env vars, run migrations on deploy | REQ-6 | S | Done |
| T-7 | Turn on Neon branches for Vercel preview deploys | REQ-6 | S | Done |
| T-8 | Add GitHub sign-in, sign-out, protected pages and rate limits | REQ-1 | M | Done |
| T-9 | Create a workspace on first sign-in, plus rename | REQ-2 | S | Review |
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
