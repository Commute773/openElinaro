# Docs

This directory is the documentation graph for the repository. Use it for progressive disclosure: short indexes at the top, deeper detail in linked docs.

## Read Order

- Agent/runtime docs: [assistant/README.md](assistant/README.md)
- Research notes: [research/README.md](research/README.md)
- E2E CLI test suite: [../src/e2e/README.md](../src/e2e/README.md)

## Generated Inventory
<!-- docs-index:start:inventory -->
- Assistant docs index: [Assistant Docs](assistant/README.md)
- Research notes index: [Research Notes](research/README.md)
- HTTP API reference: [HTTP API](assistant/api.md)
- Coverage snapshot: 26 docs indexed.
<!-- docs-index:end:inventory -->

## Documentation Rules

- Keep docs up to date when behavior, architecture, or workflows change.
- Every doc under `docs/` must be referenced by `AGENTS.md` or by another doc under `docs/`.
- Do not leave orphan docs nodes.
- Prefer concise index pages that link to canonical detail pages.
- The nightly docs indexer maintains the generated inventory blocks and writes a machine-readable report to `~/.openelinaro/docs-index.json` when enabled.
