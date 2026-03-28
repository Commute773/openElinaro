# NEXT

## Replace Vercel AI SDK + LangChain with Pi

Collapse the current Frankenstein stack (LangChain message types → Vercel AI SDK `generateText()` → `@mariozechner/pi-ai` model calls) to just Pi.

### Dependencies to remove

- `@langchain/core` — message types, tool wrappers (39 files)
- `ai` (Vercel AI SDK v6) — `generateText()`, `stepCountIs()` (4 files)
- `@ai-sdk/provider` / `@ai-sdk/provider-utils` — `LanguageModelV3` interface (11 files)

### Dependencies to add

- `@mariozechner/pi-coding-agent` — built-in tools, `AgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`

### What Pi replaces

| Component | Current | After |
|-----------|---------|-------|
| Agent loop | `generateText()` from Vercel AI SDK | `AgentSession.prompt()` from Pi |
| Message types | LangChain `BaseMessage` classes | Pi `Message` plain JSON objects |
| Tool definitions | LangChain `StructuredToolInterface` + Zod | Pi `ToolDefinition` + TypeBox |
| Built-in coding tools | Custom `buildShellFunctions`, `buildFilesystemFunctions`, `buildWebFunctions` | Pi's `bashTool`, `readTool`, `writeTool`, `editTool`, `grepTool`, `findTool`, `lsTool` |
| Conversation store | Custom JSON `ConversationStore` | Pi `SessionManager` (JSONL) |
| Model connector | `ActiveModelConnector` implementing `LanguageModelV3` | Pi `ModelRegistry` + `AuthStorage` + `stream()` |
| Compaction | Custom `ConversationCompactionService` + `generateText()` | `AgentSession.compact()` |
| Steering | Custom `PendingSteeringMessage` queue | `AgentSession.steer()` / `.followUp()` |

### What stays unchanged

- **Subagents**: tmux-based process spawning (works well, unchanged)
- **Domain tools**: routines, finance, health, comms, projects, memory, system, media, config, service, zigbee, dashboard, agent-api, notifications — become Pi `customTools`
- **Discord/HTTP integrations**: unchanged
- **System prompts**: file-based, composable (passed to Pi as string)

### Phases

1. Install `pi-coding-agent`, define canonical message types + transition bridge
2. Replace `ConversationStore` with `SessionManager`
3. Replace tool definitions (LangChain → Pi `ToolDefinition`)
4. Replace agent loop (`generateText()` → `AgentSession.prompt()`)
5. Clean up `ModelService` → Pi `ModelRegistry` + `AuthStorage`
6. Update `RuntimeScope` + `createRuntimeScope()` composition root
7. Remove all LangChain + Vercel AI SDK remnants

### Key files

- `src/services/conversation/agent-chat-service.ts` — main agent loop (rewrite)
- `src/connectors/active-model-connector.ts` — delete (Pi handles model calls)
- `src/connectors/provider-connector.ts` — delete
- `src/services/ai-sdk-message-service.ts` — delete (bridge layer)
- `src/tools/tool-registry.ts` — rewrite tool types
- `src/tools/tool-output-pipeline.ts` — rewrite tool wrapping
- `src/tools/define-tool.ts` — rewrite
- `src/functions/generate-tools.ts` — rewrite
- `src/services/conversation/conversation-store.ts` — rewrite → SessionManager
- `src/services/models/model-service.ts` — refactor → ModelRegistry
- `src/app/runtime-scope.ts` — refactor composition root

Full plan: `~/.claude/plans/stateless-humming-flamingo.md`
