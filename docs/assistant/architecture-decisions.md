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

Background work runs through the core's agent loop (ClaudeSdkCore or PiCore), bounded by maxSteps. Automation (heartbeats, autonomous-time, alarms) runs as standalone orchestration functions in `runtime-automation.ts`.

Where to look:

- `src/app/runtime.ts`
- `src/app/runtime-scope.ts`
- `src/app/runtime-automation.ts`

## 4. Agent Execution Is Loop-Based

Foreground chat and background subagents run as imperative tool-using loops over the model interface. The runtime keeps orchestration logic in code so agent behavior stays flexible and permission/tool policy stays outside any graph framework.

Where to look:

- `src/services/conversation/agent-chat-service.ts`
- `src/core/`
- `src/connectors/`

## 5. Profiles, Projects, And Auth Are Explicit Runtime Objects

The app does not treat these as loose prompt concepts. They have schemas, services, and local single sources of truth.

Where to look:

- `~/.openelinaro/profiles/registry.json`
- `~/.openelinaro/projects/registry.json`
- `src/domain/profiles.ts`
- `src/domain/projects.ts`
- `src/services/profiles/profile-service.ts`
- `src/services/projects-service.ts`
- `src/services/profiles/access-control-service.ts`

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
- `src/services/conversation/conversation-store.ts`
- `src/services/infrastructure/telemetry.ts`

## 9. Conversation History Mutates By Append Or Explicit Rollback

Saved conversation history should follow append-only flow by default. When the runtime needs to compact or reset a thread, it should do that as an explicit rollback plus append sequence rather than as an arbitrary in-place rewrite. System-prompt snapshots only change when `reload` is called explicitly.

The runtime now keeps two conversation persistence layers on purpose:

- `~/.openelinaro/conversations.json` is the mutable snapshot used to resume active threads.
- `~/.openelinaro/conversation-history/events.<profile>.jsonl` is the append-only archive of chat traffic as it happened, including turns later removed from the active snapshot by rollback-style operations.

Where to look:

- `src/services/conversation/conversation-store.ts`
- `src/services/conversation/agent-chat-service.ts`
- `src/services/conversation-state-transition-service.ts`

## 10. Managed-Service Deploys Must Be Healthchecked And Reversible

Local deploys target a release snapshot under `~/.openelinaro/deployments/releases/` instead of running arbitrary in-place code directly. An update is only considered successful after the live agent processes a simulated healthcheck message and replies with `HEALTHCHECK_OK` within 60 seconds; otherwise the managed service should roll back to the previous release automatically.

Deployment state is recorded explicitly in `~/.openelinaro/deployments/current-release.txt` and `previous-release.txt` rather than through mutable `current` or `previous` symlinks. Release snapshots also read the shared `~/.openelinaro/` data root via environment, not by symlinking that data directory into each snapshot.

Deploy remains an explicit agent action. Editing code alone does not imply a redeploy, including runtime-affecting or service-affecting changes. The source workspace now prepares version/changelog metadata first, and the agent-facing `update` step applies that already-prepared version later.

Prepared updates stamp a deploy version in `yyyy.mm.dd` or `yyyy.mm.dd.n` form, write `VERSION.json` plus `DEPLOYMENTS.md`, and commit the current code plus metadata before the managed service is restarted. The running service still reports its exact deployed build from the release snapshot it is actually serving.

Prepared-update commits must be made from a real branch tip, not a detached `HEAD`. The prepare step now refuses detached-head runs so deployment metadata commits cannot be orphaned and lost after later cleanup.

When an update or rollback is triggered from inside the live managed-service process itself, the runtime must hand that transition off to a detached helper job first. The managed service cannot safely restart itself in-process and still finish the transition sequence. Detached updates now acknowledge the request immediately in chat, then DM the operator again once the new version finishes booting and passes healthcheck. On macOS, those helpers must run as one-shot launchd agents rather than keepalive submitted jobs so a successful transition is not replayed in a loop.

## 11. Swappable Core Architecture

The agent system uses a swappable `AgentCore` interface that separates the harness (Discord, profiles, tools, conversation storage) from the core (agent loop, model interaction, native tools). Each core declares a `CoreManifest` with:

- **Native tools**: tools the core handles internally (e.g., ClaudeSdkCore has Read, Write, Bash, Glob, Grep, WebSearch, WebFetch). The harness does not send these as tool definitions.
- **Feature ownership**: which features the core owns (`core_owns`), shares (`shared`), or leaves to the harness (`harness_owns`). When the core owns compaction, context management, or session persistence, the harness skips its own implementation and uses hooks for visibility.
- **Requirements**: what the core needs from the harness (system prompt, message history, tool definitions, tool execution).

Two core implementations exist:

- **ClaudeSdkCore** (primary): wraps the Claude Agent SDK. Owns the agent loop, compaction, context management, streaming, and thinking. Harness domain tools are bridged via an in-process MCP server with proper Zod schema passthrough.
- **PiCore** (adapter): wraps `@mariozechner/pi-ai` for non-Claude providers (OpenAI/Codex, ZAI/GLM). The harness owns all features; the core only runs the model loop.

Core types (`src/core/types.ts`) are the canonical message types. The `messages/types.ts` barrel re-exports core types. pi-ai types are internal to PiCore.

Where to look:

- `src/core/types.ts` — AgentCore interface, CoreManifest, canonical message types
- `src/core/claude-sdk-core.ts` — Claude Agent SDK core implementation
- `src/core/pi-core.ts` — pi-ai adapter core implementation
- `src/core/tool-split.ts` — core-aware tool filtering
- `src/core/message-bridge.ts` — pi-ai message adapter (PiCore-internal)
- `src/app/runtime-scope.ts` — CoreFactory that routes to the right core

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

Tool definitions carry their original Zod schema alongside JSON Schema parameters. When tools are sent to the core, `splitToolsForCore()` removes tools the core handles natively (based on the manifest's `nativeTools`). For ClaudeSdkCore, the Zod schema is passed through to the SDK's `tool()` function for proper parameter definitions.

Where to look:

- `src/functions/define-function.ts` — `FunctionDefinition` type, `defineFunction` helper, `FunctionDomainBuilder` signature
- `src/functions/function-registry.ts` — central registry that builds definitions and generates each surface
- `src/functions/domains/` — per-domain builder functions (e.g. `shell-functions.ts`, `finance-functions.ts`)
- `src/functions/generate-tools.ts` — agent tool surface generator
- `src/functions/generate-api-routes.ts` — HTTP API route generator
- `src/functions/generate-discord-commands.ts` — Discord slash command generator
- `src/functions/generate-openapi.ts` — OpenAPI spec generator
