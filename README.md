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

## License

[AGPL-3.0](LICENSE). You can self-host it and change it; if you run a modified version as a service, you have to share your changes.
