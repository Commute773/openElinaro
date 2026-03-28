# Architecture Decisions

This is the short list of repo-level decisions that shape how new work should fit into the codebase.

## 1. Bun Plus TypeScript Is The Platform Baseline

The runtime is a Bun application written in TypeScript. New platform code should fit that stack unless there is a strong reason to carve out a separate service.

Where to look:

- `package.json`
- `src/`

## 2. Discord Is The Primary User Surface

`src/index.ts` still boots the Discord bot as the primary user-facing surface. The same process now also starts a small Bun HTTP listener for machine-to-machine webhook ingress such as Vonage voice and messaging callbacks. That HTTP listener is an integration surface, not a second product UI.

Where to look:

- `src/index.ts`
- `src/integrations/discord/`
- `src/integrations/http/`

## 3. The Runtime Uses Two Lanes

Immediate chat and routine work stay in the foreground path. Longer-running or multi-step work is handed off into background workflows.

Background coding-agent runs are wall-clock bounded only; the default timeout is one hour and there is no fixed model-step cap. New coding-agent launches start immediately as self-owned async runs instead of waiting in a scheduler queue. Planner and worker sessions are persisted step by step so a harness restart can resume an in-flight run instead of discarding it, and transient harness/provider outages or 429s move the run into `running/backoff` with automatic retry metadata instead of failing it outright. Near timeout, the runtime reserves a final handoff turn so the child agent stops work, summarizes what it accomplished, and returns that summary to the originating conversation instead of surfacing a bare abort. If the child is still hanging after the soft timeout plus a five-minute grace window, the runtime hard-times it out and reports that failure back to the parent thread. Task-level execution and verification problems are treated as run warnings first and only become terminal after the consecutive task error threshold is reached. Their completions are routed back into the originating conversation as a new follow-up turn so the foreground agent can decide what to do next instead of leaving the result as passive state. That parent decision now includes resuming the same run with `resume_agent`, steering a live run with `steer_agent`, or stopping it with `cancel_agent` instead of always launching a fresh worker. `agent_status` also surfaces when a run is actively working, backing off, or stuck because no tool or task progress has been recorded for too long.

Where to look:

- `src/app/runtime.ts`
- `src/app/runtime-scope.ts`
- `src/app/runtime-workflow.ts`
- `src/app/runtime-automation.ts`
- `src/orchestration/workflow-graph.ts`
- `src/orchestration/workflow-executor.ts`
- `src/orchestration/workflow-planner.ts`
- `src/orchestration/workflow-agent-runner.ts`

## 4. Agent Execution Is Loop-Based

Foreground chat and background subagents run as imperative tool-using loops over the model interface. The runtime keeps orchestration logic in code so agent behavior stays flexible and permission/tool policy stays outside any graph framework.

Where to look:

- `src/orchestration/`
- `src/services/agent-chat-service.ts`
- `src/connectors/`

## 5. Profiles, Projects, And Auth Are Explicit Runtime Objects

The app does not treat these as loose prompt concepts. They have schemas, services, and local single sources of truth.

Where to look:

- `~/.openelinaro/profiles/registry.json`
- `~/.openelinaro/projects/registry.json`
- `src/domain/profiles.ts`
- `src/domain/projects.ts`
- `src/services/profile-service.ts`
- `src/services/projects-service.ts`
- `src/services/access-control-service.ts`

## 6. Project Context Is Deliberately Separate From Platform Code

Project context is first-class, but `~/.openelinaro/projects/` is not the core agent system. Keep platform architecture under `src/` and repo-level docs under `docs/`; keep live project-specific README files under `~/.openelinaro/projects/<id>/` and keep long-form state, future, and milestone context in `~/.openelinaro/projects/registry.json`.

Where to look:

- [repo-layout.md](repo-layout.md)
- [projects.md](projects.md)

## 7. Prompts Stay Compact; Docs Carry The Detail

The base prompt is assembled from two collections: universal platform prompts in `system_prompt/universal/` (always included, not overridable) and operator-managed agent prompts in `~/.openelinaro/system_prompt/` (additive, agent-specific). Deeper operating guidance belongs in docs and should be pulled in progressively rather than copied wholesale into the prompt. Fast-changing runtime state should be fetched on demand through tools instead of being auto-injected into every chat turn.

Where to look:

- `src/services/system-prompt-service.ts`
- `system_prompt/universal/`
- `~/.openelinaro/system_prompt/`
- `docs/assistant/`

## 8. State Is Local-First

Operational state lives under `~/.openelinaro/` so the repo can run locally without depending on a remote control plane for basic behavior.

That includes heartbeat cadence state. The Discord notifier persists its last successful heartbeat under `~/.openelinaro/heartbeat-state.json` so a service restart does not create a spurious extra heartbeat.

That includes queryable observability state. Structured spans and events are written to `~/.openelinaro/telemetry.sqlite` through the shared telemetry service, so timing and failure analysis do not depend on scraping flat log files after the fact.

Where to look:

- `~/.openelinaro/`
- `src/services/conversation-store.ts`
- `src/services/workflow-registry.ts`
- `src/services/telemetry.ts`

## 9. Conversation History Mutates By Append Or Explicit Rollback

Saved conversation history should follow append-only flow by default. When the runtime needs to compact or reset a thread, it should do that as an explicit rollback plus append sequence rather than as an arbitrary in-place rewrite. System-prompt snapshots only change when `reload` is called explicitly.

The runtime now keeps two conversation persistence layers on purpose:

- `~/.openelinaro/conversations.json` is the mutable snapshot used to resume active threads.
- `~/.openelinaro/conversation-history/events.<profile>.jsonl` is the append-only archive of chat traffic as it happened, including turns later removed from the active snapshot by rollback-style operations.

Where to look:

- `src/services/conversation-store.ts`
- `src/services/agent-chat-service.ts`
- `src/services/conversation-state-transition-service.ts`

## 10. Managed-Service Deploys Must Be Healthchecked And Reversible

Local deploys target a release snapshot under `~/.openelinaro/deployments/releases/` instead of running arbitrary in-place code directly. An update is only considered successful after the live agent processes a simulated healthcheck message and replies with `HEALTHCHECK_OK` within 60 seconds; otherwise the managed service should roll back to the previous release automatically.

Deployment state is recorded explicitly in `~/.openelinaro/deployments/current-release.txt` and `previous-release.txt` rather than through mutable `current` or `previous` symlinks. Release snapshots also read the shared `~/.openelinaro/` data root via environment, not by symlinking that data directory into each snapshot.

Deploy remains an explicit agent action. Editing code alone does not imply a redeploy, including runtime-affecting or service-affecting changes. The source workspace now prepares version/changelog metadata first, and the agent-facing `update` step applies that already-prepared version later.

Prepared updates stamp a deploy version in `yyyy.mm.dd` or `yyyy.mm.dd.n` form, write `VERSION.json` plus `DEPLOYMENTS.md`, and commit the current code plus metadata before the managed service is restarted. The running service still reports its exact deployed build from the release snapshot it is actually serving.

Prepared-update commits must be made from a real branch tip, not a detached `HEAD`. The prepare step now refuses detached-head runs so deployment metadata commits cannot be orphaned and lost after later cleanup.

When an update or rollback is triggered from inside the live managed-service process itself, the runtime must hand that transition off to a detached helper job first. The managed service cannot safely restart itself in-process and still finish the transition sequence. Detached updates now acknowledge the request immediately in chat, then DM the operator again once the new version finishes booting and passes healthcheck. On macOS, those helpers must run as one-shot launchd agents rather than keepalive submitted jobs so a successful transition is not replayed in a loop.

## 11. Subagents Run As External CLI Processes In tmux

Subagents are real CLI processes (Claude Code or Codex) running in individual tmux windows with isolated Git worktrees. Each profile can configure binary paths for one or both agent types via `subagentPaths` in the profile registry.

Completion tracking uses each agent's native event surface — Claude Code hooks (Stop, Notification) and Codex notify — which POST structured events to a local Unix socket sidecar. The runtime watches the event stream, not tmux pane output. tmux provides persistence across runtime restarts and manual attach for debugging.

The source workspace must be clean before forking a linked worktree. Worktrees are preserved after completion so unfinished edits or local commits remain recoverable.

Where to look:

- `src/subagent/` — sidecar, tmux manager, spawning, registry, timeouts
- `src/app/runtime-subagent.ts` — controller and completion injection
- `src/services/project-workspace-service.ts` — worktree isolation
- `src/domain/subagent-run.ts` — run domain model

Where to look:

- `src/services/deployment-version-service.ts`
- `scripts/service-install.sh`
- `scripts/service-prepare-update.sh`
- `scripts/service-update.sh`
- `scripts/service-update-detached.sh`
- `scripts/service-rollback.sh`
- `scripts/service-rollback-detached.sh`
- `scripts/service-transition-run.sh`
- `scripts/install-linux.sh`
- `src/services/agent-healthcheck-service.ts`

## 12. Unified Function Layer For Tools, API Routes, And Discord Commands

All agent capabilities are defined as `FunctionDefinition` objects using Zod schemas, authorization metadata, domain tags, and surface annotations. A central `FunctionRegistry` collects definitions from per-domain builder functions and generates agent tools, HTTP routes, Discord slash commands, and OpenAPI specs from the same source of truth.

This eliminates duplication between the tool, API, and Discord command layers. Metadata such as domains, scopes, examples, auth declarations, and behavioral flags lives alongside the handler instead of in separate inference maps or parallel registration sites.

Where to look:

- `src/functions/define-function.ts` — `FunctionDefinition` type, `defineFunction` helper, `FunctionDomainBuilder` signature
- `src/functions/function-registry.ts` — central registry that builds definitions and generates each surface
- `src/functions/domains/` — per-domain builder functions (e.g. `shell-functions.ts`, `finance-functions.ts`)
- `src/functions/generate-tools.ts` — agent tool surface generator
- `src/functions/generate-api-routes.ts` — HTTP API route generator
- `src/functions/generate-discord-commands.ts` — Discord slash command generator
- `src/functions/generate-openapi.ts` — OpenAPI spec generator
