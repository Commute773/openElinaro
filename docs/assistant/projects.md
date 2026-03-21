# Projects

Projects are first-class local context, but they are not the core agent system. Treat `~/.openelinaro/projects/` as live project metadata and project docs consumed by the runtime, not as the platform's own architecture. The repo-level `projects/` directory is bundled starter content copied into `~/.openelinaro/projects/` on first run.

## Inventory

- `~/.openelinaro/projects/registry.json` is the inventory single source of truth.
- It records the project id, status, summary, workspace path, embedded long-form `state`/`future`/optional `milestone` content, and source docs copied from `~/.openclaw/workspace`.
- Use `workspaceOverrides` when one profile, such as an SSH-backed profile, needs a different real workspace root than the default local `workspacePath`.
- Projects with a `jobId` are work projects; projects without a `jobId` are personal projects.

## Per-project shape

Each project should keep:

- `~/.openelinaro/projects/<id>/README.md` for the stable overview and entrypoints
- long-form `state`, `future`, and optional `milestone` content in `~/.openelinaro/projects/registry.json`

Actionable project tasks now live in `~/.openelinaro/routines.json` and should be linked with `profileId`, `projectId`, and, when relevant, `jobId`.

## Agent usage

- When the user asks about projects, start with `project_list` or `project_get` instead of guessing from memory.
- Treat `project_list scope=work` as job-linked client work and `project_list scope=personal` as personal projects.
- Use the repo-local project README first, then the embedded registry fields.
- Use the resolved workspace path when you need to inspect or edit the real project workspace.
- For SSH-backed profiles, that usually means `workspaceOverrides[profileId]` should point at the remote absolute path on the target host.
