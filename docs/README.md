# Docs

Documentation graph for the OpenElinaro agent platform.

## Read Order

1. Start with [CLAUDE.md](../CLAUDE.md) for the top-level map and workflow rules.
2. Read [assistant/repo-layout.md](assistant/repo-layout.md) for directory structure and system boundaries.
3. Read [assistant/architecture-decisions.md](assistant/architecture-decisions.md) for key design decisions.
4. Dive into specific topics as needed from the [assistant docs index](assistant/README.md).

## Sections

- [Assistant docs](assistant/README.md) -- current operating architecture, runtime model, tools, services
- [Research notes](research/README.md) -- historical analysis and exploration, not operating guidance

## Documentation Rules

- Keep docs up to date when behavior, architecture, or workflows change.
- Every doc under `docs/` must be referenced by `CLAUDE.md` or by another doc under `docs/`.
- Do not leave orphan docs nodes.
- Prefer concise index pages that link to canonical detail pages.
