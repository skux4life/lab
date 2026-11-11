---
name: acli
description: Look up Jira work items, projects, boards, sprints, filters and Confluence pages, spaces and blogs using the Atlassian CLI (acli). Use when the user asks about Jira tickets/issues (e.g. KEY-123), JQL searches, sprints, or Confluence content.
---

# Atlassian CLI (acli)

Use `acli` for **read-only lookups** in Jira and Confluence. Prefer `--json` for output you need to parse.

## Rules

- Only run read-only commands (see below). Do not run commands that create, edit, delete, transition, assign, archive or otherwise change data unless the user explicitly asks for it. A guard extension may block or prompt for these.
- Do not run `acli auth login/logout`, `acli config`, `acli admin`, `acli guard` or `acli rovodev`.
- Avoid `[DEPRECATED]` commands (`board get`, `filter get`, `filter get-columns`, `workitem watcher list`). Use the replacement (`board view`, `filter view`, `filter list-columns`, `workitem list-watchers`).
- Run `acli <command> --help` if unsure of a flag. Every subcommand supports it.
- Work items are called "work items" in acli (not "issues"): `acli jira workitem ...`.

## Authentication

Jira and Confluence are both authenticated with an API token, separately. Check each before use:

```bash
acli jira auth status
acli confluence auth status
```

A good result shows `✓ Authenticated` with the site, email and `Authentication Type: api_token`. Do not use `acli auth status`: it only reports OAuth and shows unauthorized even when the API token works. If a service is unauthenticated, tell the user to log in themselves; do not run login commands.

## Jira (read-only)

**Default project: `CG`.** When the user asks about tickets without naming a project, or gives a bare number (e.g. "1342"), assume project `CG` and key prefix `CG-` (e.g. `CG-1342`). Scope searches with `project = CG` unless the user names another project or asks for all projects.

```bash
# Search with JQL
acli jira workitem search --jql "project = TEAM AND status != Done" --limit 50 --json
acli jira workitem search --jql "assignee = currentUser()" --fields "key,summary,status" --csv
acli jira workitem search --jql "project = TEAM" --count
acli jira workitem search --jql "project = TEAM" --paginate   # all results

# View a work item
acli jira workitem view KEY-123
acli jira workitem view KEY-123 --fields summary,comment --json
acli jira workitem view KEY-123 --fields '*all' --json

# Related data
acli jira workitem comment list --key KEY-123 --json
acli jira workitem attachment list --key KEY-123
acli jira workitem link list --key KEY-123
acli jira workitem link type
acli jira workitem list-watchers --key KEY-123

# Projects, boards, sprints, filters, dashboards
acli jira project list --paginate --json
acli jira project view --key TEAM
acli jira board search --name "team" --project TEAM --json
acli jira board list-sprints --id 6
acli jira sprint view --id 1
acli jira sprint list-workitems --sprint 1 --board 6 --json
acli jira filter list --my --json
acli jira filter search --name report --json
acli jira filter view --id 10001
acli jira dashboard search --name report --json
```

`--fields` on `view` accepts a comma-separated list, `*all`, `*navigable`, or `-field` to exclude (e.g. `*navigable,-comment`). `--web` (on `search`, `view`, `filter view`) opens a browser: do not use it.

## Confluence (read-only, limited)

acli has **no Confluence search**. Pages can only be fetched by ID.

```bash
acli confluence page view --id 123456789 --json
acli confluence page view --id 123456789 --body-format storage --include-direct-children --include-labels
acli confluence space list --json
acli confluence space list --keys ENG,OPS
acli confluence space view --id 12345 --json
acli confluence blog list --space-id 12345 --title "Release notes" --json
acli confluence blog view --id 12345 --json
```

If the user wants to find a page but gives no ID, ask for the page ID or URL (the numeric ID is in the page URL: `/pages/<id>/...`). Use `--include-direct-children` to walk down from a known page.

## Commands that change data (do NOT run without explicit user request)

- `jira workitem`: create, create-bulk, edit, assign, transition, clone, archive, unarchive, delete, comment create/update/delete, attachment delete, link create/delete, watcher remove
- `jira project`: create, update, archive, restore, delete
- `jira board` / `sprint`: create, update, delete
- `jira field`: create, update, delete, restore
- `jira filter`: add-favourite, change-owner, update, reset-columns
- `confluence`: blog create, space create/update/archive/restore
