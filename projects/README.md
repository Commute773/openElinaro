# Projects

This committed `projects/` directory is only a starter template source.

The live project inventory single source of truth is:

- `~/.openelinaro/projects/registry.json`

The runtime copies the starter registry from `projects/registry.json` into `~/.openelinaro/projects/registry.json` on first run.

Each live project should keep this shape:

- `~/.openelinaro/projects/<id>/README.md` for the stable overview and entrypoints

Long-form `state`, `future`, and optional `milestone` content live directly in `~/.openelinaro/projects/registry.json`.

Actionable project tasks live in `~/.openelinaro/routines.json` and should link back to the relevant `projectId`.

The matching `workspacePath` in the live registry points at the real working directory when the project lives outside this repo.

