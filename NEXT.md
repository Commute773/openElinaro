# NEXT

## Replace Vercel AI SDK + LangChain with Pi — DONE

The Frankenstein stack (LangChain message types → Vercel AI SDK `generateText()` → `@mariozechner/pi-ai` model calls) has been collapsed to just Pi.

### What was removed

- `@langchain/core` — message types, tool wrappers
- `ai` (Vercel AI SDK v6) — `generateText()`, `stepCountIs()`
- `@ai-sdk/provider` / `@ai-sdk/provider-utils` — `LanguageModelV3` interface
- `src/connectors/active-model-connector.ts` — deleted (pi-ai called directly)
- `src/connectors/provider-connector.ts` — deleted
- `src/services/ai-sdk-message-service.ts` — deleted (bridge layer)
- `src/messages/convert.ts` — deleted (transition bridge)
- `src/tools/define-tool.ts` — deleted (LangChain tool wrapper)
- `src/tools/groups/conversation-lifecycle-tools.ts` — deleted (migrated to function layer)
- `src/tools/groups/subagent-tools.ts` — deleted (migrated to function layer)

### What replaced what

| Component | Before | After |
|-----------|--------|-------|
| Agent loop | `generateText()` from Vercel AI SDK | `runAgentLoop()` using pi-ai `complete()` directly |
| Message types | LangChain `BaseMessage` classes | Pi `Message` plain JSON objects (from `@mariozechner/pi-ai`) |
| Tool definitions | LangChain `StructuredToolInterface` + Zod | Pi `Tool` (JSON Schema parameters) via `PiToolEntry` |
| Domain tools | Zod → LangChain `tool()` wrapper | Zod → `z.toJSONSchema()` → pi-ai `Tool` |
| Model connector | `ActiveModelConnector` implementing `LanguageModelV3` | `ModelService.resolveModelForPurpose()` + pi-ai `complete()` |
| Compaction | `ConversationCompactionService` + `generateText()` | `ConversationCompactionService` + pi-ai `complete()` |
| Conversation storage | LangChain `StoredMessage[]` via `mapChatMessagesToStoredMessages` | Pi `Message[]` stored directly as JSON |

### What stayed unchanged

- **Subagents**: tmux-based process spawning
- **Domain tools**: 127 functions across 19 domains (Zod schemas preserved, converted to JSON Schema at generation time)
- **Discord/HTTP integrations**: unchanged
- **System prompts**: file-based, composable
- **Queue management**: AgentChatService queue, steering, background jobs
- **Custom compaction**: durable memory extraction pipeline
