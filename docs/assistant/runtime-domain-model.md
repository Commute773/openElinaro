# Runtime Domain Model

Reference for core types, profiles, auth, projects, and runtime state. Prefer these definitions over guesses.

Feature config and onboarding: [configuration.md](configuration.md)

## AppRequest And AppResponse

`AppRequest` is chat-only. No request kinds, no routing by type.

```ts
interface AppRequest {
  id: string;
  text: string;
  conversationKey?: string;
  chatContent?: ChatPromptContent;  // string | (text | image)[]
}

interface AppResponse {
  requestId: string;
  mode: "immediate" | "accepted";
  message: string;
  warnings?: string[];
  attachmentErrors?: string[];
  attachments?: AppResponseAttachment[];
}
```

Where to look: `src/domain/assistant.ts`

## AgentCore And CoreManifest

The swappable core abstraction. Each core declares what it handles natively.

```ts
interface AgentCore {
  readonly manifest: CoreManifest;
  run(options: CoreRunOptions): Promise<CoreRunResult>;
}

interface CoreManifest {
  id: string;
  nativeTools: NativeToolMapping[];
  nativeFeatures: CoreFeatureDeclaration[];
  requires: CoreRequirements;
}
```

Core message types (`CoreUserMessage`, `CoreAssistantMessage`, `CoreToolResultMessage`) are the canonical message format. Content blocks: `CoreTextContent`, `CoreThinkingContent`, `CoreImageContent`, `CoreToolCall`.

Where to look: `src/core/types.ts`

## Profiles

Profiles are explicit runtime objects, not vague personas.

- Shape: `id`, `name`, `memoryNamespace`, optional `shellUser`, `pathRoots`, `execution`, `preferredProvider`, `defaultModelId`, `toolSummarizerProvider`, `toolSummarizerModelId`, `memoryProvider`, `memoryModelId`, `defaultThinkingLevel`, `maxContextTokens`
- Each install is one identity -- single active profile per process
- Access rules: `src/services/profiles/profile-service.ts`, `src/services/profiles/access-control-service.ts`

SSOTs:
- `~/.openelinaro/profiles/registry.json` -- live profile inventory
- `src/domain/profiles.ts` -- schema definition

## Auth

Provider auth stored per profile in `~/.openelinaro/secret-store.json`.

- `profiles[profileId].providers` with supported providers: `openai-codex` (OAuth), `claude` (setup token), `zai` (API key)
- Auth setup flows through Discord DMs in `src/integrations/discord/auth-session-manager.ts`
- Never print raw secrets into chat, docs, logs, or prompts

## Secrets

General-purpose encrypted secrets per profile in `~/.openelinaro/secret-store.json`.

- AES-256-GCM encryption at rest, requires `OPENELINARO_SECRET_KEY` or `OPENELINARO_SECRET_KEY_FILE`
- Import via `bun src/cli/secrets.ts set-json`, `secret_import_file`, `bun run secret:import-card`
- Agent-managed passwords via `secret_generate_password`
- Browser automation uses secret refs like `{ "secretRef": "prepaid_card.number" }` resolved server-side

## Projects

Projects are explicit records with schemas and services.

- Shape: `id`, `name`, `status`, optional `jobId`, `priority`, `allowedRoles`, `workspacePath`, optional `workspaceOverrides`, `summary`, `currentState`, `state`, `future`, optional `milestone`, `nextFocus`, `structure`, `tags`, `docs`, optional `sourceDocs`
- Status: `active`, `paused`, `idea`, `archived`
- SSOT: `~/.openelinaro/projects/registry.json`
- Per-project doc: `~/.openelinaro/projects/<id>/README.md`
- Actionable tasks in `~/.openelinaro/routines.json`, linked via `profileId`, `projectId`, optional `jobId`

## Model Runtime Settings

Active model settings in `~/.openelinaro/model-state.json`.

- `providerId`, `modelId`, `thinkingLevel` shape provider requests
- Profile fields seed initial selection: `preferredProvider`, `defaultModelId`, `defaultThinkingLevel`
- `toolSummarizerProvider`/`toolSummarizerModelId` for tool result summaries
- `memoryProvider`/`memoryModelId` for background memory extraction
- `maxContextTokens` acts as an artificial ceiling on context window
- `providerId === "claude"` routes to ClaudeSdkCore; all other providers route to PiCore

## Conversation History

- `~/.openelinaro/conversations.json` -- mutable snapshot for active threads
- `~/.openelinaro/conversation-history/events.<profile>.jsonl` -- append-only archive
- Aborted compaction does not mutate the snapshot
- Compaction extracts durable memory to `~/.openelinaro/memory/<namespace>/core/MEMORY.md`

## Routines, Alarms, And Timers

- Routines: `~/.openelinaro/routines.json`
- Calendar sync: `~/.openelinaro/calendar-sync-state.json`
- Heartbeat cadence: `~/.openelinaro/heartbeat-state.json`
- Alarms/timers: `~/.openelinaro/alarms.sqlite`
- Heartbeats run as isolated automation turns, not appended to main conversation
- Alarm notifications use the same isolated path

## Inter-Instance Messaging

Multiple instances communicate peer-to-peer over Unix sockets.

- `InstanceSocketServer` on `~/.openelinaro/instance.sock`
- `PeerClient` sends to known peers via `PeerRegistry`
- Tools: `send_message`, `instance_status`, `instance_list`

Where to look: `src/instance/`

## Change Patterns

- Update Zod schemas when adding fields to registries
- Keep prompt/docs language aligned with runtime objects and file locations
- Extend the registry-and-doc convention rather than introducing parallel metadata files

## Read Next

- [Configuration](configuration.md)
- [Autonomous Time & Reflection](reflection.md)
- [Memory](memory.md)
