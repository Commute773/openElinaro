# Repo Layout And Boundaries

Quick reference for "what lives where?" and "what is part of the agent system?"

## Core Boundary

The agent system is the runtime under `src/` plus its local configuration, prompt material, and persisted state.

It includes:

- `src/` -- runtime code, orchestration, services, tools, and integrations
- `system_prompt/universal/` -- universal platform prompts that ship with the app, always included first
- `~/.openelinaro/system_prompt/` -- operator-managed custom prompts, optional and appended after universal
- `~/.openelinaro/assistant_context/` -- internal prompt-like runtime instructions injected selectively (heartbeat guidance, autonomous time prompts)
- `~/.openelinaro/docs/assistant/` -- operator-specific assistant docs (persona, profile, local notes)
- `~/.openelinaro/` -- live local operator data: config, secrets, profiles, projects, logs, memory, workflow state
- `profiles/` and `projects/` -- bundled starter defaults copied into `~/.openelinaro/` on first run
- `docs/assistant/` -- platform docs describing the shared runtime architecture

`~/.openelinaro/projects/` is a context surface, not platform code:

- `~/.openelinaro/projects/registry.json` -- inventory of known projects
- `~/.openelinaro/projects/<id>/` -- project-specific docs
- A project's `workspacePath` may point outside this repo to the real codebase

## Runtime Map

### `src/app/` -- Runtime composition and request handling

- `runtime.ts` -- `OpenElinaroApp` class, service instantiation, request dispatch
- `runtime-scope.ts` -- `RuntimeScope` per-profile scope, `CoreFactory` routing to ClaudeSdkCore or PiCore
- `runtime-automation.ts` -- automation orchestration: heartbeats, autonomous time sessions, alarm notifications

### `src/core/` -- Swappable agent core system

- `types.ts` -- `AgentCore` interface, `CoreManifest`, canonical `CoreMessage` types, `CoreRunOptions`/`CoreRunResult`
- `claude-sdk-core.ts` -- Claude Agent SDK core (primary), owns agent loop, compaction, context management
- `pi-core.ts` -- pi-ai adapter for non-Claude providers (OpenAI/Codex, ZAI/GLM)
- `tool-split.ts` -- core-aware tool filtering (removes native tools from harness definitions)
- `message-bridge.ts` -- pi-ai message adapter (PiCore-internal)

### `src/services/conversation/` -- Chat pipeline (decomposed)

- `agent-chat-service.ts` -- thin facade, public API for chat operations
- `chat-session-manager.ts` -- session lifecycle, queue management, concurrency control
- `chat-turn-runner.ts` -- single turn execution: prompt assembly, core invocation, response extraction
- `chat-types.ts` -- shared types: `ChatDependencies`, `ChatReplyResult`, `ChatExecutionOptions`, queue job types
- `chat-helpers.ts` -- utility functions shared across the pipeline
- `conversation-store.ts` -- mutable conversation snapshot persistence
- `conversation-state-transition-service.ts` -- conversation state machine (new, compact, reset)
- `conversation-compaction-service.ts` -- conversation compaction with memory extraction

### `src/services/` -- Domain services

- `finance-service.ts` -- finance tracking (optional, feature-gated)
- `health-tracking-service.ts` -- health/food tracking
- `scheduling/routines-service.ts` -- routines, todos, reminders, calendar events
- `alarm-service.ts`, `alarm-notification-service.ts` -- alarms and timers
- `system-prompt-service.ts` -- strict universal + custom prompt concatenation
- `autonomous-time-service.ts` -- unified autonomous time: reflection, journal, soul rewrites, self-directed work
- `autonomous-time-prompt-service.ts`, `autonomous-time-state-service.ts` -- prompt loading and state tracking
- `memory-service.ts` -- core memory file management
- `memory/structured-memory-manager.ts`, `memory/memory-management-agent.ts` -- structured memory entities
- `heartbeat-service.ts` -- hourly heartbeat cadence
- `calendar-sync-service.ts` -- ICS calendar ingestion
- `work-planning-service.ts` -- coding agent launch/management
- `models/model-service.ts` -- model routing and selection
- `infrastructure/telemetry.ts` -- structured telemetry (SQLite spans/events)

### `src/functions/` -- Unified function and tool layer

- `define-function.ts` -- `FunctionDefinition` type, `defineFunction` helper, `FunctionDomainBuilder` signature
- `function-registry.ts` -- central registry, generates each surface from definitions
- `domains/` -- per-domain builders (shell, finance, health, routines, media, web, communication, etc.)
- `generate-tools.ts` -- agent tool surface generator
- `generate-api-routes.ts` -- HTTP API route generator
- `generate-discord-commands.ts` -- Discord slash command generator
- `generate-openapi.ts` -- OpenAPI spec generator
- `tool-registry.ts` -- runtime `ToolRegistry` class, wires context into function handlers
- `context.ts` -- `ToolBuildContext` shared service dependency interface

### `src/integrations/` -- External surfaces

- `discord/` -- Discord bot, auth sessions, message handling, notifier
- `http/` -- Bun HTTP listener for API, webhooks, health checks

### `src/instance/` -- Peer-to-peer messaging

- `socket-server.ts` -- Unix socket server per instance
- `peer-client.ts` -- sends messages to known peers
- `peer-registry.ts` -- peer discovery and registration

### `src/domain/` -- Type definitions

- `assistant.ts` -- `AppRequest`, `AppResponse`, chat content types
- `profiles.ts`, `projects.ts` -- profile and project schemas
- `tool-catalog.ts` -- tool authorization and scope types
- `extensions.ts` -- extension manifest schema
- `errors.ts` -- structured error types

### `src/config/` -- Runtime configuration

- `runtime-config.ts` -- config loading from `~/.openelinaro/config.yaml`
- `service-constants.ts` -- extracted constants

### Other `src/` directories

- `src/auth/` -- provider-specific auth helpers
- `src/messages/` -- canonical message type re-exports, helpers, predicates
- `src/utils/` -- shared utilities (timestamp, text, file, time, telemetry, sqlite)
- `src/workers/` -- background worker entrypoints

## Supporting Material

- `scripts/` -- deployment scripts, managed-service install helpers, Linux bootstrap installer
- `references/` -- local reference repos and external source material
- `media/` -- non-code assets (audio files, catalog)
- `README.md` -- quick human overview

## Read Next

- [Architecture Decisions](architecture-decisions.md)
- [Runtime Domain Model](runtime-domain-model.md)
- [Projects](projects.md)
