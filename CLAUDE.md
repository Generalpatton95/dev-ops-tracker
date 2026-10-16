# CLAUDE.md

Instructions for Claude Code (and any coding agent) working in this repo.

## What this is

Dev-ops-tracker: a simpler, spec-driven alternative to Jira for small dev teams. Solo build by Austin for now. Read `specs/product.md` for the full picture.

## This repo is built spec-driven

Every change traces back to a requirement in a spec.

1. **Read the spec first.** Before any work, open the spec for the current milestone (right now `specs/m1-skeleton.md`) and find the task and requirement you're working on.
2. **No task, no code.** If the work doesn't match an existing task, stop and propose a new task (and requirement if needed) in the spec before writing code.
3. **Name the task and requirement** in every branch, commit and PR:
   - Branch: `t-5-drizzle-schema`
   - Commit: `T-5 (REQ-5): add Drizzle schema for v1 tables`
4. **Meet the acceptance criteria.** A task is done only when the checkboxes under its requirement that it covers are met. Tick them in the spec in the same PR.
5. **Update the task table** in the spec: set the task's status (Todo, Doing, Review, Done) as part of the PR.
6. **Don't change requirements quietly.** If a requirement needs to change, say so, edit it in the spec, and note what changed in the PR description.

## Rules from the specs

- **Stack:** Next.js (App Router) + TypeScript + Tailwind, tRPC, Postgres with Drizzle, Auth.js with GitHub sign-in.
- **Portable core (REQ-7):** the app must run on any Node host with any Postgres via `DATABASE_URL`. No Vercel-only or Neon-only services in app code; those belong in deploy config.
- **Secrets** go in env vars, never in the repo. Keep `.env.example` up to date with variable names only.
- **Keep it simple.** Check `specs/product.md` → Non-goals before adding anything that sounds like Jira (custom fields, workflows, story points, query languages, permission schemes).

## Working style

- Small PRs, one task each where possible.
- Run type check, lint and tests before calling a task done.
- Plain, short commit messages and PR descriptions.

## Where things are

- `specs/` — product spec, milestone specs, spec format guide
- Working copies of the specs are also kept as Claude Docs; if they disagree with the files here, ask which is current.
