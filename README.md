# Dev-ops-tracker

A simpler, spec-driven alternative to Jira for small dev teams. (Working title.)

Jira makes small teams pay for enterprise complexity, and its tickets drift away from what was actually agreed. Dev-ops-tracker keeps the tracker to five objects and makes the spec the source of truth:

- **Specs make tasks.** Write a spec with numbered requirements, and the app proposes tasks for each one.
- **Tasks link back.** Every task points at the requirement it delivers.
- **Change tracking.** Edit a requirement and every task built on the old version gets flagged with a diff.
- **Agent-ready.** Any task can be handed to a coding agent with everything it needs to build it.

## Status

Milestone 1 (Skeleton) is in progress. See [`specs/m1-skeleton.md`](specs/m1-skeleton.md).

## How this repo works

This project is built spec-driven, the same way the app works:

1. Every piece of work starts as a requirement in a spec under [`specs/`](specs/).
2. Each requirement has an ID (`REQ-1`) and acceptance criteria.
3. Tasks (`T-1`) point at a requirement.
4. Commits and PRs name the task and requirement they cover, for example `T-5 (REQ-5): add Drizzle schema`.

See [`specs/README.md`](specs/README.md) for the spec format.

## Stack

Next.js + TypeScript + Tailwind, tRPC, Postgres with Drizzle, Auth.js (GitHub sign-in). The hosted version runs on Vercel and Neon, but the core app runs on any Node host with any Postgres.

## Run it locally

You need Node 22 or newer and [pnpm](https://pnpm.io/installation).

```sh
pnpm install
pnpm dev        # http://localhost:3000
```

Before opening a PR, run the checks CI runs (CI also runs `pnpm audit --audit-level high`):

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## Deploy

The hosted version deploys from `main` on Vercel. `vercel.json` holds the settings: region `iad1`, and a build command that runs `pnpm run build` and then, only if the build passed, applies database migrations (`scripts/migrate-on-deploy.mjs`). A failed migration fails the deploy, so it never goes live.

Environment variables in the Vercel project (names only; values never go in the repo):

| Environment | Variables                                                                           |
| ----------- | ----------------------------------------------------------------------------------- |
| Production  | `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct, used for migrations)      |
| Preview     | No database variables until T-7, so previews can't reach production data            |
| All         | `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the pnpm version in `package.json` |

Migrations run while the previous deploy is still serving, so each one must keep working with the code before it: add first, remove in a later deploy.

Rollback: code through Vercel's Instant Rollback to the previous deployment; data through Neon's restore to a time before the deploy. The current Neon plan keeps 6 hours of history, so check each deploy straight away.

Other hosts: set `DATABASE_URL` (and optionally `DATABASE_URL_UNPOOLED`), run `pnpm run db:migrate`, then start the new version. drizzle-kit loads `.env` but not `.env.local`, so export the variables (or set them in the host's environment) before running `pnpm run db:migrate`.

## License

[AGPL-3.0](LICENSE). You can self-host it and change it; if you run a modified version as a service, you have to share your changes.
