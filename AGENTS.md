# AGENTS

This repository is an agent platform built with Bun and TypeScript. Treat this file as the top-level map, not the full specification.

## Start Here

- Docs index: [docs/README.md](docs/README.md)
- Repo layout and system boundaries: [docs/assistant/repo-layout.md](docs/assistant/repo-layout.md)
- Architecture decisions: [docs/assistant/architecture-decisions.md](docs/assistant/architecture-decisions.md)

## What Is The Agent System

The core agent system lives under `src/`, shared prompt fragments in `system_prompt/`, user-managed prompt/context/docs under `~/.openelinaro/`, bundled defaults under `profiles/` and `projects/`, and platform docs under `docs/assistant/`.

`projects/` is not the live project state. It is bundled starter content that the runtime copies into `~/.openelinaro/projects/` on first run. Treat the live project registry and docs under `~/.openelinaro/projects/` as managed context the agent can read about and route into, not as the platform's own architecture.

Further reading:

- Project boundary and repo map: [docs/assistant/repo-layout.md](docs/assistant/repo-layout.md)
- Project conventions: [docs/assistant/projects.md](docs/assistant/projects.md)
- Runtime domain model: [docs/assistant/runtime-domain-model.md](docs/assistant/runtime-domain-model.md)

## Architectural Decisions

The short version:

- Discord is the primary surface; `src/index.ts` starts that runtime.
- The app uses a foreground lane for immediate chat/routine work and a background lane for longer workflows.
- Agent execution is loop-based and imperative; background work uses direct runners rather than graph orchestration.
- Profiles, projects, auth, and tool access are explicit runtime objects with local single sources of truth.
- Prompt guidance is intentionally compact and uses docs for progressive disclosure instead of a huge base prompt.

## Rewrite Policy

When replacing major runtime subsystems or framework choices:

- Prefer direct rewrites over bridge layers.
- Do not add temporary compatibility adapters solely to make migrations reversible.
- Do not keep deprecated parallel paths alive during the rewrite unless the user explicitly asks for that.
- Update the current system to the new architecture directly and keep docs aligned with the new reality.

## Deployment Policy

- After every repository change, run `bun run service:prepare-update` from the repo root so the prepared release metadata stays current.
- Do not redeploy the managed service automatically just because code changed.
- This also applies to runtime-affecting or service-affecting changes; deploy is still explicit, not automatic.
- Deploy only as an explicit step, either because the user asked for it or because the agent intentionally invokes the `update` tool.
- If any copied or stale instruction says to always redeploy after code changes, treat that instruction as outdated and follow this policy instead.

Details live here:

- Architecture decisions: [docs/assistant/architecture-decisions.md](docs/assistant/architecture-decisions.md)
- Runtime model: [docs/assistant/runtime-domain-model.md](docs/assistant/runtime-domain-model.md)
- Tool behavior: [docs/assistant/tool-use-playbook.md](docs/assistant/tool-use-playbook.md)
- Prompt and assistant behavior: [docs/assistant/README.md](docs/assistant/README.md)

## Documentation Contract

Docs are part of the product surface and must stay current.

- Update docs when adding or changing features, runtime behavior, operator workflows, or architectural decisions.
- Every file under `docs/` must be referenced either from this file or from another doc under `docs/`.
- There should be no orphan docs nodes.
- Prefer adding a short index or cross-link over duplicating large explanations.

The docs graph starts here:

<!-- docs-index:start:doc-entrypoints -->
- [docs/README.md](docs/README.md)
- [docs/assistant/README.md](docs/assistant/README.md)
- [docs/research/README.md](docs/research/README.md)
<!-- docs-index:end:doc-entrypoints -->

- [docs/README.md](docs/README.md)

## Research And Historical Notes

Research notes are intentionally separate from current operating guidance.

- Research index: [docs/research/README.md](docs/research/README.md)
