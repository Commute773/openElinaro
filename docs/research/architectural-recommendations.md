# Architectural Recommendations

These recommendations identify structural improvements to the agent platform that would reduce coupling, improve testability, and make the codebase easier to navigate as it grows. Each section describes the current state, the problem it creates, a proposed solution, and the risks or effort involved.

These are research notes, not committed plans. They may inform future work or be superseded by different directions.

## 1. Service Layer Reorganization

### Current State

The `src/services/` directory contains 162 entries (91 non-test source files, 69 test files, and 2 existing subdirectories for `finance/` and `gemini-live/`). The vast majority of services live in the top-level directory. Finding related services requires text search rather than directory browsing.

Representative samples of the current mix:

- `conversation-store.ts`, `conversation-compaction-service.ts`, `conversation-history-service.ts`, `conversation-memory-service.ts`, `conversation-state-transition-service.ts` (conversation cluster)
- `routines-service.ts`, `routines-store.ts` (routines cluster)
- `vonage-service.ts`, `communications-store.ts`, `gemini-live-phone-service.ts`, `phone-call-backends.ts`, `phone-call-prompts.ts` (communications cluster)
- `telemetry.ts`, `telemetry-store.ts`, `telemetry-query-service.ts` (monitoring cluster)

### Problem

Flat layout at this scale makes it hard to understand domain boundaries. New contributors cannot tell which services belong together, and unrelated services often develop accidental coupling because they feel nearby.

### Proposed Solution

Organize `src/services/` into domain-based subdirectories:

| Subdirectory | Key files (current names) |
|---|---|
| `core/` | `runtime-root.ts`, `runtime-platform.ts`, `feature-config-service.ts`, `secret-store-service.ts`, `deployment-version-service.ts`, `service-restart-notice-service.ts` |
| `conversation/` | `conversation-store.ts`, `conversation-compaction-service.ts`, `conversation-history-service.ts`, `conversation-memory-service.ts`, `conversation-state-transition-service.ts`, `agent-chat-service.ts` |
| `models/` | `model-service.ts`, `ai-sdk-message-service.ts`, `cache-miss-monitor.ts`, `inference-prompt-drift-monitor.ts`, `text-embedding-service.ts`, `usage-tracking-service.ts` |
| `communications/` | `vonage-service.ts`, `communications-store.ts`, `gemini-live-phone-service.ts`, `phone-call-backends.ts`, `phone-call-prompts.ts`, `email-service.ts`, `discord-response-service.ts` |
| `routines/` | `routines-service.ts`, `routines-store.ts`, `alarm-service.ts`, `alarm-notification-service.ts`, `calendar-sync-service.ts`, `calendar-sync-state-service.ts`, `autonomous-time-service.ts`, `autonomous-time-prompt-service.ts`, `autonomous-time-state-service.ts` |
| `tools/` | `tool-authorization-service.ts`, `tool-error-service.ts`, `tool-library-service.ts`, `tool-resolution-service.ts`, `tool-result-store.ts`, `tool-defaults.ts` |
| `integrations/` | `web-search-service.ts`, `web-fetch-service.ts`, `openbrowser-service.ts`, `zigbee2mqtt-service.ts`, `elinaro-tickets-service.ts`, `media-service.ts`, `python-runtime.ts` |
| `monitoring/` | `telemetry.ts`, `telemetry-store.ts`, `telemetry-query-service.ts`, `health-tracking-service.ts`, `heartbeat-service.ts`, `heartbeat-state-service.ts` |

Each subdirectory would export its public API through an `index.ts` barrel file.

### Risks and Effort

- Approximately 500+ import paths across the codebase would need updating.
- Automated tooling (e.g., `ts-morph` or IDE refactoring) is strongly recommended rather than manual search-and-replace.
- Tests should co-locate with their sources in the new subdirectories.
- This can be done incrementally: move one domain cluster at a time and update its imports before moving the next.

## 2. Dependency Injection Container

### Current State

The codebase uses three different patterns for wiring services together:

**Pattern 1: Constructor injection in `createRuntimeScope()`** (`src/app/runtime-scope.ts`). The function accepts a context object with 12+ dependencies, manually constructs 15+ services, and returns a `RuntimeScope` bag with 14 named fields. Every tool invocation receives the full scope.

**Pattern 2: Zero-arg singletons inside `ToolRegistry`** (`src/tools/tool-registry.ts`). The registry constructor receives 9 required + 9 optional services, but also internally constructs its own instances of `SecretStoreService`, `WebFetchService`, `FeatureConfigService`, `AlarmService`, `OpenBrowserService`, `TelemetryQueryService`, `DeploymentVersionService`, `ZigBee2MqttService`, and `ServiceRestartNoticeService` using `new` with no arguments.

**Pattern 3: God-class wiring in `OpenElinaroApp`** (`src/app/runtime.ts`, 1050 lines). The app class constructs 15+ singleton services as field initializers and passes them down through `createRuntimeScope()`.

### Problem

`RuntimeScope` is a service locator: it bundles 14 services into a single bag and passes the whole bag to consumers. Consumers can reach any service even when they only need one or two. This hides real dependencies, makes unit testing harder (you must mock the entire scope), and makes it impossible to know at a glance what a given consumer actually depends on.

The parallel `new`-with-no-args singletons inside `ToolRegistry` create duplicate instances of services that also exist at the app level (e.g., `AlarmService`, `SecretStoreService`), which can lead to stale reads if those services cache state.

### Proposed Solution

Introduce a lightweight container based on factory registration:

1. Define a `Container` class with `register<T>(token, factory)` and `resolve<T>(token)` methods.
2. Each service registers itself with a token and a factory function that declares its dependencies via `resolve()`.
3. `OpenElinaroApp` creates one container, registers all singletons, and passes the container (or individual resolved services) to consumers.
4. `ToolRegistry` stops calling `new` internally; it receives every service through the container or through explicit constructor parameters.
5. `RuntimeScope` is replaced with per-consumer constructor injection: each service declares exactly what it needs.

This does not require a DI framework. A 30-line container class with `Map<symbol, () => T>` is sufficient for the current scale.

### Risks and Effort

- Requires touching `OpenElinaroApp`, `createRuntimeScope`, `ToolRegistry`, and all their callers.
- The refactoring should be paired with the service layer reorganization (Section 1) to avoid doing two large-scale import rewrites.
- Start by eliminating the zero-arg singletons in `ToolRegistry` first (smallest change, highest value).

## 3. Tool Plugin Architecture

### Current State

`src/tools/tool-registry.ts` is 3,276 lines long. It imports 38+ service modules in its header, defines inline tool implementations for 80+ tools, and hardcodes every tool in its `buildTools()` method. The file also internally constructs 9 service instances (see Section 2).

The codebase already has a partial extraction: `src/tools/groups/` contains 12 files (`routine-tools.ts`, `filesystem-tools.ts`, `finance-tools.ts`, `shell-tools.ts`, etc.) that export `buildXTools(context)` functions. These are called from `ToolRegistry` and return arrays of tool definitions.

### Problem

Adding a new tool requires editing `tool-registry.ts`: adding imports, adding the tool to the `ROUTINE_TOOL_NAMES` array, and wiring it into the build flow. The file is large enough that it is difficult to review, and its import list couples every service module to a single file.

### Proposed Solution

Close the loop on the existing `buildXTools` pattern by making it the only way to register tools:

1. Move all remaining inline tools in `tool-registry.ts` into appropriate group files under `src/tools/groups/`.
2. Define a `ToolGroup` interface: `{ name: string; build(context: ToolBuildContext): StructuredToolInterface[] }`.
3. Each group file exports a `ToolGroup` implementation.
4. `ToolRegistry` discovers groups by scanning `src/tools/groups/` or by accepting an array of `ToolGroup` instances.
5. `ROUTINE_TOOL_NAMES` is derived from the union of all group outputs rather than maintained as a handwritten constant.

The existing `ToolBuildContext` type in `src/tools/groups/tool-group-types.ts` already provides the right shape. The remaining work is extracting the 30+ inline tools that have not yet been moved to groups.

### Risks and Effort

- The inline tools in `tool-registry.ts` include complex logic (subagent management, conversation reset, configuration management). Extracting them requires careful testing.
- Tool authorization coverage (`assertToolAuthorizationCoverage`) must still validate the full set. Deriving the name list from group outputs maintains this invariant.
- This can be done incrementally: extract 5-10 tools at a time into a new or existing group file.

## 4. Event-Driven Architecture

### Current State

Background work is managed through direct process spawning and a Unix socket sidecar:

- `SubagentSidecar` (`src/subagent/sidecar.ts`) listens on a Unix domain socket for HTTP POSTs from Claude Code hooks and Codex notify scripts.
- `TmuxManager` (`src/subagent/tmux.ts`) manages tmux windows for subagent processes.
- `SubagentTimeoutManager` (`src/subagent/timeout.ts`) tracks wall-clock timeouts.
- `SubagentRegistry` (`src/subagent/registry.ts`) maintains run state.
- Completion events flow from the sidecar through `runtime-subagent.ts` handlers back into the originating conversation.

Routine triggers, heartbeat emissions, and alarm firing use separate timer-based mechanisms in `OpenElinaroApp` with direct method calls between services.

### Problem

These subsystems are tightly coupled through direct method calls and callback chains. Adding a new consumer of subagent completion events (e.g., a notification service, a metrics collector) requires modifying the existing handler chain. Recovery after a crash requires manually re-reading persisted state because there is no event log to replay.

### Proposed Solution

Introduce an in-process event bus for decoupling internal subsystems:

1. Define typed event channels: `subagent.completed`, `routine.triggered`, `heartbeat.emitted`, `alarm.fired`, `conversation.started`, `conversation.ended`.
2. Services publish events to named channels. Consumers subscribe to channels they care about.
3. Events are persisted to an append-only log (could use the existing `telemetry.sqlite` infrastructure) so crash recovery can replay missed events.
4. `SubagentSidecar` becomes a publisher rather than a direct callback dispatcher. `OpenElinaroApp` subscribes to events it needs for conversation injection.

The `SubagentSidecar` already has the right shape: its `onEvent` handler pattern is effectively a single-topic event bus. Generalizing this to a multi-topic typed bus is the next step.

### Risks and Effort

- Event-driven architectures can make control flow harder to trace. Keep the bus in-process (not distributed) and ensure events are strongly typed.
- The sidecar's existing handler pattern should be the starting point; do not introduce a message broker.
- Start with subagent completion events (already half-evented) and expand to routines and alarms incrementally.

## 5. Conversation Lifecycle Centralization

### Current State

Conversation lifecycle logic is spread across five locations:

1. **`AgentChatService`** (`src/services/agent-chat-service.ts`) — manages the chat execution loop, queues concurrent requests, handles compaction triggers, steering messages, and stop signals.
2. **`ConversationCompactionService`** (`src/services/conversation-compaction-service.ts`) — summarizes and truncates conversation history, extracts memories during compaction.
3. **`ConversationStateTransitionService`** (`src/services/conversation-state-transition-service.ts`) — handles starting fresh conversations, continuing existing ones, reloading system prompts, and the compaction handoff.
4. **`ConversationMemoryService`** (`src/services/conversation-memory-service.ts`) — manages memory recall on new messages and memory flush after conversations.
5. **`ToolRegistry.pendingConversationResets`** (`src/tools/tool-registry.ts`, line 1748) — the tool registry holds a `Map<string, string>` of pending conversation resets triggered by the `new_conversation` tool, which the chat service consumes after a tool call completes.

### Problem

No single service owns the full lifecycle of a conversation from start to finish. The `pendingConversationResets` map in `ToolRegistry` is particularly problematic: it means the tool layer holds conversation state that logically belongs to the conversation layer, creating a circular conceptual dependency.

Understanding what happens when a conversation starts, compacts, resets, or ends requires reading five files across two directories. Testing any lifecycle transition in isolation requires mocking the other four participants.

### Proposed Solution

Create a `ConversationLifecycleService` that owns the state machine:

1. It orchestrates the sequence: create/resume -> chat turns -> compaction check -> memory extraction -> reset/end.
2. `AgentChatService` delegates lifecycle decisions to it rather than inlining them.
3. `ConversationCompactionService` and `ConversationMemoryService` become internal strategies called by the lifecycle service.
4. The `pendingConversationResets` map moves from `ToolRegistry` into the lifecycle service. Tools request a reset through a method call; the lifecycle service decides when to execute it.
5. `ConversationStateTransitionService` either merges into the lifecycle service or becomes a lower-level utility it delegates to.

### Risks and Effort

- This is a significant refactoring because `AgentChatService` is one of the most complex services (manages per-conversation queuing, background/foreground lanes, steering, stopping).
- The conversation queuing and concurrency control in `AgentChatService` should remain separate from lifecycle concerns. The lifecycle service handles "what happens next"; the queue manager handles "who goes next."
- Recommend extracting the lifecycle state machine first as a pure-logic class with no I/O, then wiring it into the existing services.

## 6. Synchronous I/O Migration

### Current State

Three store services use synchronous `node:fs` operations (`readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync`) despite the project convention of preferring `Bun.file()`:

1. **`RoutinesStore`** (`src/services/routines-store.ts`, line 1) — `load()` and `save()` are synchronous. The TODO comment documents the reason: "called synchronously from 40+ methods in RoutinesService and cascading callers across 20+ files."

2. **`SecretStoreService`** (`src/services/secret-store-service.ts`, line 1) — All methods (`readStore`, `writeStore`, `resolveSecretRef`, `saveSecret`, etc.) are synchronous. The TODO comment: "called synchronously from auth, profile, CLI, bot startup, and feature-config callers across 20+ files."

3. **`CommunicationsStore`** (`src/services/communications-store.ts`, line 1) — `loadStore()` and `saveStore()` are synchronous. The TODO comment: "called synchronously from VonageService and other callers."

### Problem

Synchronous file I/O blocks the event loop. On a busy runtime handling multiple concurrent conversations, a slow disk write in `RoutinesStore.save()` or `SecretStoreService.writeStore()` stalls all concurrent work. This is especially impactful for `RoutinesStore`, which is called from 40+ code paths.

The Bun runtime provides `Bun.file()` which returns async-capable file handles, but switching requires every caller in the chain to become async.

### Proposed Solution

Migrate incrementally using a parallel-method strategy:

1. **Phase 1**: Add async versions of the store methods (e.g., `loadAsync()`, `saveAsync()`) using `Bun.file()`. Keep the sync versions unchanged.
2. **Phase 2**: Migrate callers one file at a time from sync to async methods. Start with leaf callers that are already async (tool handlers, HTTP endpoints) and work inward.
3. **Phase 3**: Once all callers use async methods, remove the sync versions and rename async methods to the original names.

For `RoutinesStore`, the migration order would be:
- Tool handlers in `src/tools/groups/routine-tools.ts` (already async)
- `RoutinesService` methods called from async contexts (alarm processing, routine checks)
- `RoutinesService` methods called from sync contexts (the hardest part, requiring callers to become async)

### Risks and Effort

- `RoutinesStore` is the most difficult because of 40+ synchronous callers across 20+ files.
- `SecretStoreService` is called during startup paths that are currently synchronous. Making startup async is straightforward in Bun (top-level await) but requires testing.
- `CommunicationsStore` has the smallest caller surface and is the best candidate to migrate first as a proof of concept.
- Each phase is independently shippable. The parallel-method approach means no big-bang switchover.

## 7. RuntimeConfig Schema Splitting

### Current State

`src/config/runtime-config.ts` is a 417-line file that defines a single `RuntimeConfigSchema` Zod object containing 16 top-level config domains:

- `core` (with nested `profile`, `assistant`, `discord`, `onboarding`, `python`, `app`, `http` — 7 sub-domains)
- `calendar`, `email`, `communications` (with nested `vonage`, `geminiLive`)
- `webSearch`, `webFetch`, `openbrowser`
- `finance`, `tickets`, `localVoice` (with nested `localLlm`, `kokoro`)
- `media`, `extensions`, `zigbee2mqtt`, `autonomousTime`, `models`, `service`

The file also contains 16 `DEFAULT_*` constant blocks, config read/write/validation functions, and dot-path accessor utilities.

### Problem

Every config consumer imports from the same file, which means changing the Vonage webhook path schema requires TypeScript to re-check the calendar sync schema. Adding a new integration means editing a 417-line file that mixes unrelated domains. The defaults, schema, and accessor utilities are all entangled.

### Proposed Solution

Split the schema into domain-scoped modules composed at the top level:

1. Create `src/config/schemas/` with one file per domain: `core.ts`, `calendar.ts`, `email.ts`, `communications.ts`, `web.ts`, `finance.ts`, `integrations.ts`, `models.ts`, `service.ts`.
2. Each file exports its own Zod schema and default values.
3. `src/config/runtime-config.ts` imports all domain schemas and composes them with `z.object({ core: CoreConfigSchema, calendar: CalendarConfigSchema, ... })`.
4. The accessor utilities (`getRuntimeConfigValue`, `setRuntimeConfigValue`) and file I/O functions remain in the top-level file.

Example for `src/config/schemas/communications.ts`:

```ts
import { z } from "zod";

export const DEFAULT_COMMUNICATIONS_VONAGE = { /* ... */ };
export const DEFAULT_COMMUNICATIONS_GEMINI = { /* ... */ };
export const DEFAULT_COMMUNICATIONS = { /* ... */ };

export const CommunicationsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  publicBaseUrl: z.string().default(""),
  vonage: z.object({ /* ... */ }).default(DEFAULT_COMMUNICATIONS_VONAGE),
  geminiLive: z.object({ /* ... */ }).default(DEFAULT_COMMUNICATIONS_GEMINI),
}).default(DEFAULT_COMMUNICATIONS);
```

### Risks and Effort

- This is a low-risk refactoring because the top-level `RuntimeConfigSchema` type does not change. Consumers that import `RuntimeConfig` or use `getRuntimeConfig()` are unaffected.
- The `FinanceConfigSchema` is already extracted into `src/config/finance-config.ts`, proving the pattern works.
- Effort is moderate: extract schemas, update imports in `runtime-config.ts`, verify types still compose correctly.
- The config migration logic in `src/config/config-migrations.ts` needs no changes because it operates on the parsed YAML object, not the Zod schemas.
