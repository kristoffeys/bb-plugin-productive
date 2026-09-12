# Productive for BB

Brings each BB project's [Productive.io](https://productive.io) tasks into one
focused board — a list and kanban view, task detail with comments, status and
assignee changes, task creation, saved filter presets, `@`/`#` mentions in the
composer, and a `bb productive` CLI for agents.

Modelled on the Taskboard plugin, but single-provider: one Productive API token
serves the whole organization, and each BB project is mapped to one Productive
project.

## Install

```
bb plugin install git:https://github.com/kristoffeys/bb-plugin-productive.git
```

Needs `npm` on PATH: BB clones the repo, installs production dependencies, and
builds the server and app bundles.

## Setup

1. Create a Productive API token: **Settings → API integrations** in Productive.
2. Enter it in the Productive panel in BB, together with your organization id
   and (optionally) your Productive person id. Headless alternative:

   ```
   bb productive connect --org <organization-id> [--person <person-id>] \
                         --token-file <path-to-a-file-containing-the-token>
   ```

   A plugin CLI command runs inside the BB server, so it has no stdin to pipe a
   secret through — the token is passed as a file path so it never lands in
   argv, shell history, or an agent transcript. Delete the file afterwards.
3. Map the BB project to a Productive project in the panel's manage view, or
   from the shell:

   ```
   bb productive config --productive-project <productive-project-id>
   ```

The person id is optional because Productive has no `/me` endpoint — without it
the board works, but the "assigned to me" filter has nothing to resolve against.

The token is stored in a `0600` file under the plugin's data directory, not in
plugin settings, so changing it does not require a plugin reload.

## Mapping

| Productive | This plugin |
| --- | --- |
| Project | The external project a BB project maps to |
| Task | Board item |
| Workflow status (`category_id` 1/2/3) | Status → `todo` / `in_progress` / `done` |
| Task list | Optional lane filter within the project |
| `tag_list` | Labels |

Productive tasks have no priority field, so the board has no priority column or
filter.

## CLI

```
bb productive status
bb productive list [--query <text>] [--state todo|in_progress|done] [--cached]
bb productive show <locator>
bb productive start <locator> [--worktree]
bb productive transitions <locator>
bb productive move <locator> --status <status-id>
bb productive move-list <locator> --list <task-list-id>
bb productive comment <locator> <text>
bb productive create --title <text> [--description <text>] [--list <id>]
bb productive refresh
bb productive config [--productive-project <id>] [--folder <id>] [--list <id>]
                     [--assigned-to-me on|off] [--include-closed on|off]
bb productive connect [--org <id> [--person <id>] --token-file <path>]
bb productive disconnect
bb productive presets list
```

Every command takes `--project <proj_id>` to target another BB project and
`--json` for machine-readable output. Tasks are addressed by their Productive
task id (the `locator`), not the `#number` key — the key is only unique within
a project.

## The board

Productive's hierarchy is **Project -> Folder -> Task list -> Task**. A folder is
what Productive used to call a board, and its task lists are that board's
columns. The panel mirrors that:

- Map a BB project to a Productive project, and optionally narrow it to one
  folder.
- Kanban lanes group by **workflow status** or by **task list** — the latter
  reproduces Productive's own board layout, in Productive's column order.
- Dragging a card between lanes writes back: status lanes change the workflow
  status, task-list lanes move the task between lists.
- Filter by folder, task list, status, assignee, state, and labels, and save
  those as named presets.

## Working on a task

`bb productive start <locator>`, or the **Start thread** button on a task,
opens a new BB thread in the project the board is mapped to, with the task's
fields as context. Nothing is written back to Productive.

Add `--worktree` (or use the split button on the task detail page) to give the
thread its own git worktree off the project's default branch, so two tickets
worked in parallel never collide in one checkout.

## Attachments

Productive serves attachment files from `files.productive.io` behind a browser
session, not the API token — a token-authenticated fetch redirects to the login
page, and there is no download endpoint. The board therefore lists attachment
names, types, and sizes, and opens the file in your browser, where your
Productive session authenticates it. Images are not inlined.

## Agent safety

Task titles, descriptions, and comments are untrusted external text. Everything
this plugin hands to an agent — mention context, `bb productive show`, the
handoff prompt — is wrapped in a quoted, delimited block with an explicit
instruction not to follow anything inside it. See `formatWorkItemContext` in
`contract.ts`.

## Development

```
npm install --include=dev
npx tsc --noEmit
npx vitest run
bb plugin build
bb plugin install .
bb plugin dev          # rebuild + reload on save
```

## Layout

| File | Role |
| --- | --- |
| `contract.ts` | Wire contract: zod schemas, RPC methods, realtime channels, agent-facing formatting |
| `server.ts` | RPC handlers, background sync, CLI, mention provider, connection interaction |
| `store.ts` | SQLite cache: tasks, sync state, project mapping, board settings, filter presets |
| `productive/` | Productive.io JSON:API client, entity mapper, and typed API surface |
| `app.tsx` | Board UI: nav panel, thread panel, list, kanban, detail, create dialog, settings |
| `board-settings.ts`, `filter-presets.ts` | Per-project board view state and saved filters |
| `skills/productive/` | The skill that teaches agents to use `bb productive` |
