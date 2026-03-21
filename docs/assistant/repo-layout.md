# Repo Layout And Boundaries

Use this doc when you need the quick answer to "what lives where?" and "what is actually part of the agent system?"

## Core Boundary

The agent system is the runtime under `src/` plus its local configuration, prompt material, and persisted state.

It includes:

- `src/` for runtime code, orchestration, services, tools, and integrations
- `system_prompt/` for shared prompt fragments compiled into per-thread snapshots
- `~/.openelinaro/system_prompt/` for operator-specific prompt fragments that are merged with the shared prompt set
- `~/.openelinaro/assistant_context/` for internal prompt-like runtime instructions that are injected selectively, such as heartbeat guidance, rather than compiled into every thread snapshot
- `~/.openelinaro/docs/assistant/` for operator-specific assistant docs such as persona, profile, and local vision notes
- `~/.openelinaro/` for live local operator data, including config, secrets, profiles, projects, logs, memory, and workflow state
- `profiles/` and `projects/` for bundled starter defaults that are copied into `~/.openelinaro/` on first run
- `docs/assistant/` for platform docs that describe the shared runtime architecture

It does not include live project data as platform code. `~/.openelinaro/projects/` is a context surface:

- `~/.openelinaro/projects/registry.json` is the inventory of known projects
- `~/.openelinaro/projects/<id>/` holds project-specific docs copied or maintained for context
- a project's `workspacePath` may point outside this repo to the real codebase

That means `projects/` is part of the assistant's world model, but not part of the agent system architecture unless you are explicitly working on a project stored there.

## Runtime Map

- `src/index.ts`: Discord entrypoint
- `src/demo.ts`: local demo runner without Discord
- `src/app/`: runtime composition and request handling
- `src/orchestration/`: imperative background workflow runners
- `src/services/`: stateful application services, persistence, auth, model routing, tools, memory, logging, shell, and access control
- `src/tools/`: tool registry definitions exposed to the agent and to Discord
- `src/connectors/`: provider/model connectors
- `src/domain/`: schemas and runtime domain objects
- `src/auth/`: provider-specific auth helpers
- `src/integrations/`: external surfaces such as Discord and the local HTTP webhook listener
- `src/workers/`: background worker entrypoints

## Supporting Material

- `scripts/`: deployment and local runtime scripts, including managed-service install helpers, internal update/rollback transition scripts, and the Linux bootstrap installer
- `references/`: local reference repos and external source material
- `media/`: non-code assets
- `README.md`: quick human overview and command list

## Read Next

- Architecture decisions: [architecture-decisions.md](architecture-decisions.md)
- Runtime objects and SSOTs: [runtime-domain-model.md](runtime-domain-model.md)
- Project-specific conventions: [projects.md](projects.md)
- Communications runtime: [communications.md](communications.md)
