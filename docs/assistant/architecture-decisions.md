# Architecture Decisions

Key decisions that shape how new work fits into the codebase.

## 1. Bun Plus TypeScript

The runtime is a Bun application in TypeScript. See `package.json` and `src/`.

## 2. Discord Is The Primary Surface

`src/index.ts` boots the Discord bot as the primary user-facing surface. The same process starts a Bun HTTP listener for machine-to-machine webhook ingress (Vonage voice/messaging) and the JSON API.

Where to look: `src/index.ts`, `src/integrations/discord/`, `src/integrations/http/`

## 3. Everything Is Chat

All user interactions are chat messages. `AppRequest` has four fields: `id`, `text`, `conversationKey`, and optional `chatContent`. There are no request kinds, no todo routing, no medication routing. The model decides what to do based on the message content and available tools.

Where to look: `src/domain/assistant.ts`

## 4. Swappable AgentCore

The agent system uses a swappable `AgentCore` interface that separates the harness (Discord, profiles, tools, conversation storage) from the core (agent loop, model interaction, native tools).

Each core declares a `CoreManifest` with:

- **Native tools**: tools the core handles internally (e.g., ClaudeSdkCore has Read, Write, Bash, Glob, Grep, WebSearch, WebFetch). The harness does not send these as tool definitions.
- **Feature ownership**: `core_owns`, `shared`, or `harness_owns`. When the core owns compaction/context management, the harness skips its own implementation.
- **Requirements**: what the core needs from the harness (system prompt, message history, tool definitions, tool execution).

Two implementations:

- **ClaudeSdkCore** (primary): wraps Claude Agent SDK. Owns agent loop, compaction, context management, streaming, thinking. Domain tools bridged via MCP with Zod schema passthrough.
- **PiCore** (adapter): wraps `@mariozechner/pi-ai` for non-Claude providers (OpenAI/Codex, ZAI/GLM). Harness owns all features; core only runs the model loop.

Where to look: `src/core/types.ts`, `src/core/claude-sdk-core.ts`, `src/core/pi-core.ts`, `src/core/tool-split.ts`, `src/app/runtime-scope.ts`

## 5. AgentChatService Decomposed

The chat pipeline is decomposed into focused modules:

- **AgentChatService** (`agent-chat-service.ts`): thin facade, public API only
- **ChatSessionManager** (`chat-session-manager.ts`): session lifecycle, queue management, concurrency
- **ChatTurnRunner** (`chat-turn-runner.ts`): single turn execution -- prompt assembly, core invocation, response extraction
- **chat-types.ts**: shared types (`ChatDependencies`, `ChatReplyResult`, queue jobs)
- **chat-helpers.ts**: utility functions shared across the pipeline

Where to look: `src/services/conversation/`

## 6. Unified FunctionDefinition

All agent capabilities are defined as `FunctionDefinition` objects with Zod schemas, authorization metadata, domain tags, and surface annotations. A central `FunctionRegistry` generates agent tools, HTTP routes, Discord slash commands, and OpenAPI specs from the same source of truth.

Three surfaces: `api`, `discord`, `agent`. Each function declares which surfaces it appears on. Tool definitions carry their original Zod schema alongside JSON Schema for proper core passthrough.

Where to look: `src/functions/define-function.ts`, `src/functions/function-registry.ts`, `src/functions/domains/`

## 7. Finance Optionally Decoupled

`FinanceService` is optional in `ToolBuildContext` (`finance?: FinanceService`). Finance tools only appear when the `finance` feature is enabled and configured. The rest of the system does not depend on finance.

Where to look: `src/functions/context.ts`, `src/functions/domains/finance-functions.ts`

## 8. System Prompts: Strict Universal + Custom

The system prompt is assembled from two layers with no merge logic, no override, no in-code defaults:

1. **Universal** (`system_prompt/universal/`): platform prompts that ship with the app, sorted by filename, always included first.
2. **Custom** (`~/.openelinaro/system_prompt/`): operator-managed prompts, sorted by filename, appended after universal.

Where to look: `src/services/system-prompt-service.ts`, `system_prompt/universal/`

## 9. Autonomous Time Unifies Reflection And Soul

Private reflection, journal writing, soul document rewrites, and self-directed work are unified into a single autonomous time service. One trigger per day (4 AM local time). The agent decides what to do during the session.

Where to look: `src/services/autonomous-time-service.ts`, `src/services/autonomous-time-prompt-service.ts`

## 10. Single Identity Per Install

Each install is one identity -- a single active profile per process. No multi-profile in one process. Separate installs for different profiles.

Where to look: `src/services/profiles/profile-service.ts`

## 11. Two-Lane Execution

Immediate chat and routine work in the foreground. Longer multi-step work handed off to background workflows. Automation (heartbeats, autonomous time, alarms) runs as standalone orchestration in `runtime-automation.ts`.

Where to look: `src/app/runtime.ts`, `src/app/runtime-automation.ts`

## 12. Profiles, Projects, Auth Are Explicit Runtime Objects

Not loose prompt concepts. They have schemas, services, and local single sources of truth.

Where to look: `src/domain/profiles.ts`, `src/domain/projects.ts`, `src/services/profiles/`

## 13. State Is Local-First

Operational state lives under `~/.openelinaro/`. Telemetry in `telemetry.sqlite`. Conversations in `conversations.json`. No remote control plane dependency for basic behavior.

## 14. Managed-Service Deploys Are Healthchecked And Reversible

Updates target release snapshots under `~/.openelinaro/deployments/releases/`. Healthcheck required within 60 seconds. Automatic rollback on failure. Deploy is always an explicit action.

Where to look: `src/services/deployment-version-service.ts`, `scripts/service-*.sh`

## Read Next

- [Repo Layout](repo-layout.md)
- [Runtime Domain Model](runtime-domain-model.md)
- [Tool Use Playbook](tool-use-playbook.md)
