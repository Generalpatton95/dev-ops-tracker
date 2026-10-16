# Dev-ops-tracker — Product Spec

Owner: Austin Patton · Last updated: 2026-10-15

Diagrams (the spec-driven loop and the architecture) live in the Claude Doc version of this spec.

## Problem and goals

Jira makes small teams pay for enterprise complexity, and its tickets drift away from what was actually agreed. This app keeps the tracker to a handful of objects and makes the spec the source of truth that tasks come from.

What hurts in Jira today:

- **Too much setup.** Issue types, field schemes, workflow schemes and screens need an admin before a team can work.
- **Too many clicks.** Making or updating a ticket means a big form and several page loads.
- **Specs live somewhere else.** Requirements sit in Confluence or a Google Doc, so tickets go stale the moment the doc changes.
- **Not built for AI agents.** A ticket rarely holds enough context for a coding agent to pick it up and build it.

Goals for v1:

1. A new team is set up and tracking work in under 5 minutes, with no admin role.
2. A task can be created with one keystroke and at most 3 fields.
3. Every task traces back to a spec requirement, and a spec change flags the tasks it affects.
4. Any task can be handed to a coding agent with everything it needs to build it.

## Who it's for

V1 is for small dev teams of 3 to 15 people: class project teams, startups and side-project crews. If those teams stick with it, it grows into a real product for more and bigger teams.

| User | What they need | What they do most |
| --- | --- | --- |
| Developer | See their work, update it fast, know why a task exists | Pick up a task, move it, link a PR |
| Team lead / PM | Write specs, turn them into tasks, see what's covered and what's stale | Edit specs, review generated tasks, check progress |
| AI coding agent | A task with full context and a way to report back | Read a task brief, open a PR, update status |

Treating the AI agent as a real user from day one is the main difference from Jira. It gets its own API and MCP access, not a bolted-on integration.

## Core concepts

The whole app is built on five objects. Specs and requirements replace Jira's epics and stories, so there is no ticket hierarchy to manage.

| Object | What it is | Replaces in Jira |
| --- | --- | --- |
| Project | One product or repo the team works on | Project + its schemes |
| Spec | A markdown doc for one feature: goal, requirements, design notes | Epic + the Confluence page behind it |
| Requirement | One testable rule inside a spec, with an ID like REQ-12 and acceptance criteria | Story |
| Task | One piece of work that delivers part of a requirement | Task, sub-task, bug |
| Cycle | An optional time box, like a two-week sprint | Sprint |

Fixed rules that keep it simple:

- **Four statuses, same for everyone:** Todo, Doing, Review, Done.
- **Task fields:** title, assignee, size (S/M/L), requirement link and tags. Nothing else in v1.
- **Bugs are tasks with a bug tag**, linked to the requirement they break.
- **Roles:** owner, member and guest. No permission schemes.

## Spec-driven workflow

The spec is the source of truth: tasks are generated from it, every task points back to it, and editing it flags the work it affects. This is the feature Jira doesn't have.

1. **Write the spec.** A lead writes a markdown spec. Each requirement is its own block with an ID (REQ-12), a one-line rule and acceptance criteria.
2. **Generate tasks.** The app uses an AI model to propose tasks for each requirement. A person accepts, edits or drops each one before it lands on the board.
3. **Do the work.** Tasks move Todo → Doing → Review → Done. A branch or PR that names the task ID links itself.
4. **Change the spec.** Editing a requirement bumps its version. Every task built on the old version gets a "spec changed" flag with a diff of what changed.
5. **Resolve the flag.** The assignee marks the task still valid, updates it, or splits off a new task.
6. **Close it out.** A requirement is done when all its tasks are done and its acceptance criteria are checked.
7. **Hand off to an agent.** Any task can export a brief (requirement text, acceptance criteria, linked design notes) through the API or MCP. A coding agent builds from it and reports back by opening a PR.

A requirement edit sends its tasks through the flag step before they can count toward the requirement being done.

Where this fits: tools like [GitHub Spec Kit](https://github.com/github/spec-kit) and [Kiro](https://kiro.dev/blog/from-chat-to-specs-deep-dive/) already run a spec → plan → tasks flow, but inside one developer's repo or IDE, as markdown files. This app brings that flow to the whole team's tracker. V1 should import and export those spec files so teams already using them don't start over.

## Git and deploy integration

The tracker follows git, so nobody moves tasks by hand: a task ID in a branch, commit or PR links the work, and PR and deploy events move the task.

| When this happens | The app does this |
| --- | --- |
| A branch is created with `dot-12` in its name | Links it to DOT-12 and moves the task to Doing |
| A commit mentions DOT-12 | Adds it to the task's activity |
| A PR naming DOT-12 is opened | Links the PR and moves the task to Review |
| CI checks run on the PR | Shows passing or failing on the task card |
| The PR is merged | Moves the task to Done |
| The PR is closed without merging | Moves the task back to Doing |
| A preview deploy is ready | Puts the preview link on the task |
| A production deploy includes the merge | Marks the task shipped; a requirement is shipped when all its tasks are |
| A spec is edited in the app | Opens a PR that updates `/specs` in the repo |

Rules:

- **Branch from a task.** Each task has a button that copies `git checkout -b dot-12-short-title`, so the link exists from the first commit.
- **IDs match loosely.** `DOT-12`, `dot-12` and `dot12` all count, in branch names, commit messages and PR titles or bodies.
- **Done vs shipped.** Done means merged. Shipped means live in production.
- **People can still move tasks.** Git events move them by default, but a manual move always wins.
- **GitHub is core, Vercel is optional.** Deploy status comes from GitHub deployment statuses, which Vercel and many other hosts already post. So previews and shipped status work without any Vercel-only code, in line with the portability rule.

## Screens and navigation

V1 has four screens, and anything in the app is at most two clicks or one command away.

| Screen | What's on it | Main actions |
| --- | --- | --- |
| My work | Your tasks across all projects, grouped by status, plus anything flagged "spec changed" | Pick up, move, resolve flags |
| Spec | Spec text on the left, its requirements and their tasks on the right with coverage per requirement | Edit spec, generate tasks, see what's stale |
| Board | One board per project, the four fixed columns, filter by person, tag or cycle | Drag tasks, quick-add with N |
| Task panel | Slides in over any screen instead of opening a new page: requirement text, links, activity | Edit fields, copy agent brief |

Navigation rules:

- **Left sidebar:** projects, and inside a project just Specs, Board and Cycles.
- **Command palette (Ctrl/Cmd + K):** jump to anything, create a task, run any action.
- **Keyboard first:** every common action has a single-key shortcut.
- **Search:** one box that searches specs, requirements and tasks together. No query language.

## V1 scope vs later

V1 ships the tracker plus the full spec loop for one team; anything for big orgs waits until small teams prove they want it.

| Feature | V1 | Later |
| --- | --- | --- |
| Projects, tasks, board, task panel | Yes | |
| Command palette and shortcuts | Yes | |
| Spec editor with requirement blocks | Yes | |
| AI task generation from a spec | Yes | |
| Spec change flags with diffs | Yes | |
| Agent brief export, API and MCP server | Yes | |
| GitHub linking of branches, commits and PRs by task ID | Yes | |
| Task status from PR events, CI checks on cards | Yes | |
| Preview links and shipped status from deploys | Yes | |
| Spec export to the repo by PR | Yes | Two-way sync |
| Import/export Spec Kit and Kiro spec files | Yes | |
| Cycles (sprints) | Basic | Burndown and velocity |
| Notifications | In-app | Email, Slack, Discord |
| Reports | Spec coverage only | Cycle and team reports |
| Multiple teams per workspace | | Yes |
| SSO, audit log, billing | | Yes |
| GitLab and Bitbucket | | Yes |
| Import from Jira | | Yes |

## Non-goals

These are the Jira features this app refuses to add, because each one is where Jira's complexity comes from.

- **No custom workflows.** Four statuses for every team, forever in v1.
- **No custom fields or screens.** Tags cover what extra fields usually do.
- **No issue-type hierarchy.** No epics, stories or sub-tasks; specs and requirements carry that structure.
- **No story points.** S/M/L size only.
- **No query language.** Filters and search instead of JQL.
- **No permission schemes.** Three roles cover a small team.
- **No admin console.** Settings fit on one page.

## Tech stack and architecture

One TypeScript web app on Postgres, with GitHub, the Claude API and an MCP server around it. One language end to end keeps it buildable by a small team.

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Next.js + React + TypeScript, Tailwind | Fast to build, one codebase for UI and API |
| API | Next.js route handlers with tRPC | Typed calls from UI to server, no hand-written client |
| Database | Postgres with Drizzle ORM | Relational data with clear links; typed schema and migrations |
| Live updates | Server-sent events | Board and spec views update without refresh, simpler than websockets |
| Auth | Auth.js with GitHub sign-in | Every user is a developer with a GitHub account |
| Git link | GitHub App with webhooks | Links branches, commits and PRs, moves tasks on PR events, reads CI and deploy statuses |
| AI | Claude API | Task generation, change diffs, agent briefs |
| Agents | MCP server + REST API | Coding agents read tasks and specs and update status |
| Hosting | Vercel for the app, Neon for Postgres | Free tiers to start; each Vercel preview deploy gets its own Neon database branch |

Everything goes through the app's API, so the browser, GitHub and coding agents all see the same data and rules.

**Portability rule:** the core app runs on any Node host with any Postgres. Vercel- and Neon-only features (like preview database branches) stay in deploy config, never in app code, so the open source version can be self-hosted. Milestone 1 is spelled out in [m1-skeleton.md](m1-skeleton.md).

## Data model

The key link is task → requirement version: a task is stale when the requirement's version is newer than the one the task was built from.

| Table | Key fields | Links to |
| --- | --- | --- |
| workspace | id, name, invite_token | |
| user | id, name, github_id, avatar_url | |
| membership | user_id, workspace_id, role (owner/member/guest) | workspace, user |
| project | id, workspace_id, key (e.g. DOT), name, repo, next_task_number, archived_at | workspace |
| spec | id, project_id, title, body_md, status (draft/active/archived) | project |
| requirement | id, spec_id, ref (REQ-12), rule, acceptance[], version | spec |
| requirement_version | requirement_id, version, rule, acceptance[], changed_by, changed_at | requirement |
| task | id, project_id, number (DOT-12 = key + number), requirement_id, built_on_version, title, status, assignee_id, size, tags[] | project, requirement, user |
| task_link | task_id, kind (branch/commit/pr/check/deploy), url, state, environment (preview/production) | task |
| cycle | id, project_id, start, end | project |
| activity | id, entity, entity_id, change, actor, at | any |

Sign-in sessions live in Postgres in the Auth.js tables (account, session, verification_token). From GitHub the app keeps only the user's id, name and avatar: no email, and no GitHub access tokens.

Stale rule: a task `t` is stale when `t.built_on_version < requirement(t).version`.

Resolving a flag sets `built_on_version` to the current version. Keeping every requirement version is what makes the diff view possible.

## Success metrics

V1 works if a beta team sets up fast, keeps using it, and keeps its tasks tied to specs. These are starting targets to check against real use.

| Metric | Target |
| --- | --- |
| Sign-up to first task | Under 5 minutes |
| Steps to create a task | 1 shortcut, at most 3 fields |
| Tasks linked to a requirement | 80% or more |
| "Spec changed" flags resolved | Within 2 working days |
| Beta teams still active after 4 weeks | At least half |

## Build plan and milestones

Build it in six milestones, each usable on its own, and build it spec-driven: this doc's sections become the first specs, broken into requirements and tasks. Once milestone 2 lands, the app tracks its own build.

1. **Skeleton.** Repo, GitHub sign-in, workspaces, projects, database schema, deploy pipeline.
   - Done when: you can sign in and create a project on a live URL.
2. **Tracker core.** Tasks, board, task panel, My work, command palette, shortcuts.
   - Done when: the build of this app is tracked in the app itself.
3. **Specs and GitHub linking.** Spec editor with requirement blocks, linking tasks to requirements, coverage view, and a GitHub App that links branches, commits and PRs by task ID.
   - Done when: every open task points at a requirement, and a PR naming a task shows up on it.
4. **Change tracking.** Requirement versions, stale flags, diff view, resolve flow.
   - Done when: editing a requirement flags its tasks with a diff.
5. **AI and agents.** Task generation from a spec, agent brief export, MCP server and API.
   - Done when: a coding agent picks up a task from the app and opens a PR for it.
6. **Git flow, deploys and beta.** Task status from PR events, CI on cards, preview links and shipped status, spec export by PR, Spec Kit/Kiro import, onboarding a first outside team.
   - Done when: a real team uses it for 4 weeks without moving tasks by hand.

## Decisions

| Question | Decision |
| --- | --- |
| Name | Dev-ops-tracker stays a working title for now |
| Where specs live | The app's database is the source of truth in v1. Specs export one way to a `/specs` folder in the repo as markdown, so agents and Spec Kit/Kiro can read them. Two-way sync comes later. |
| First beta team | Austin's current project team, then his class if professors are interested |
| Who's building it | Solo build for now |
| Hosting and license | Open source under AGPL, plus a hosted version. Anyone can self-host, but nobody can sell a closed hosted copy. |
| AI costs | Each team brings its own Claude API key in v1. A paid hosted plan with AI usage included comes later. |

## Sources

- [GitHub Spec Kit repo](https://github.com/github/spec-kit)
- [GitHub open sources kit for spec-driven AI development (Visual Studio Magazine)](https://visualstudiomagazine.com/articles/2025/09/03/github-open-sources-kit-for-spec-driven-ai-development.aspx)
- [From chat to specs: a deep dive into Kiro](https://kiro.dev/blog/from-chat-to-specs-deep-dive/)
