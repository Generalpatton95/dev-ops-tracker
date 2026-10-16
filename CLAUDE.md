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
- **Next.js 16 is newer than most training data.** Read the guide in `node_modules/next/dist/docs/` before writing Next code (see `AGENTS.md`).
- **Keep it simple.** Check `specs/product.md` → Non-goals before adding anything that sounds like Jira (custom fields, workflows, story points, query languages, permission schemes).

## Working style

- Small PRs, one task each where possible.
- Run the CI checks before calling a task done: `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`, `pnpm run test`, `pnpm run build` and `pnpm audit --audit-level high`. (pnpm 12 rejects `-s`.)
- Plain, short commit messages and PR descriptions.
- **The working tree is shared** with the owner and other sessions. Run `git status` before any git command that rewrites files, and never discard changes you didn't make (`reset --hard`, `checkout --`, `restore`, `clean`, `stash`). To drop your own commit, use `git reset --soft` or `git revert`.

## Agents

Defined in `.claude/agents/` (added 2026-10-15). The builder builds; both reviewers then run in parallel, read-only; the coordinator verifies their claims, sends all findings back in one round, and commits after owner sign-off.

| Agent                   | Job                                                                                           | Limits                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dot-builder`           | Builds one approved task or one round of review fixes, with tests; reports real check results | Never commits, pushes, opens PRs or deploys; never edits `specs/`; never reads `.env*`; dev/test databases only; no destructive git; no new outside services |
| `dot-code-reviewer`     | Correctness, spec conformance, conventions, REQ-7 portability, performance                    | Read-only                                                                                                                                                    |
| `dot-security-reviewer` | Owner's security standards plus the spec's security baseline, known gaps and audit exceptions | Read-only; local `curl` only to a server the coordinator names                                                                                               |

## Mods

| Mod         | Where                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Why                                                                                     |
| ----------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `git-guard` | `.claude/mods/git-guard/` | Denies git commands that discard work (`reset --hard/--merge`, `checkout` of files or with `--`/`.`/`-f`, `restore` of the worktree, `clean -f`, `stash` other than list/show, `switch -f`, `rm -f`, `checkout-index -f`) in Bash or PowerShell while `git status` shows uncommitted changes, with a reason. Reads quotes, heredocs, `$( )`, `bash -c`, `pwsh -Command`/`-EncodedCommand`, `eval` and a preceding `cd`. Denies when it can't check: status fails, `GIT_*` variables, `--git-dir`/`--work-tree`, a path it can't resolve, a folder outside this project, or the check errors. Runs only local `git status`/`rev-parse`, only inside this project, with fsmonitor off; sends nothing anywhere. Known gaps: aliases in your git config, scripts that run git, and commands piped into a shell. | On 2026-10-15 `git reset --hard` wiped the owner's uncommitted `specs/product.md` edit. |

Mods are checked with `claude plugin validate <dir>` and `claude plugin test <dir>` (git-guard: 100 tests), not by the app's lint or type check. A guard is a backstop, not a replacement for checking `git status`.

To load the mods in a session, the repo is a local plugin marketplace (`.claude-plugin/marketplace.json`). Run once per machine: `claude plugin marketplace add <path to this repo>`, then `claude plugin install git-guard@dev-ops-tracker --scope local`. It reads from `.claude/mods/` directly, so after editing a mod run `/reload-plugins`.

## Agent/mod audit

Counted in tasks, because a spec here is a whole milestone. Tasks done: 4 (T-1 to T-4). Last audit: 2026-10-15, when the agents and git-guard were created. **Next audit due when T-7 is done**, or sooner when a trigger in `~/.claude/CLAUDE.md` fires (an agent mistake better instructions would prevent, a new area no agent covers, a changed convention, a milestone).

## Where things are

- `specs/` — product spec, milestone specs, spec format guide
- `src/app/` — pages and the tRPC route (`api/trpc/[trpc]`)
- `src/server/` — tRPC setup and routers; tests sit next to the code as `*.test.ts`
- `src/trpc/` — browser tRPC client and limits shared with the server
- `.claude/agents/` — project agents; `.claude/mods/` — Claude Code mods (see above)
- Working copies of the specs are also kept as Claude Docs; if they disagree with the files here, ask which is current.
