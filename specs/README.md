# Specs

Every piece of work in this repo starts here. One file per spec.

| File | What it covers |
| --- | --- |
| [product.md](product.md) | The whole product: goals, concepts, workflow, stack, data model, milestones |
| [m1-skeleton.md](m1-skeleton.md) | Milestone 1: sign-in, workspaces, projects, schema, deploy |

## Format

Each spec has:

- **Goal** — what it delivers and when it counts as done.
- **Requirements** — numbered `REQ-1`, `REQ-2`… Each is a one-line rule plus acceptance criteria as checkboxes.
- **Design notes** — decisions the tasks inherit.
- **Tasks** — numbered `T-1`, `T-2`…, each pointing at one requirement, with a size (S/M/L) and status (Todo, Doing, Review, Done).
- **Out of scope** and **Open questions**.

## Rules

- Requirement IDs never get reused. If a requirement is dropped, mark it dropped instead of deleting it.
- Changing a requirement means updating its text and noting what changed in the PR, so any task built on the old version gets rechecked.
- Commits and PRs name the task and requirement: `T-5 (REQ-5): add Drizzle schema`.

Until milestone 2 ships, the working copies of these specs live as Claude Docs and are exported here. After M2, the app itself holds them and exports here.
