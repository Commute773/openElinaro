# Next: Migrate to Claude Agent SDK v2 Session API

## Problem

The current architecture uses the v1 `query()` API which is request-response: each user message creates a new agent turn, re-initializes the session, and loses cache warmth. There's no way to steer the agent mid-turn, and sessions break on every deploy because the SDK stores local state relative to `cwd` which changes per release.

Every message costs ~$0.10+ because the full system prompt and tool definitions are re-sent cold. The conversation feels disconnected rather than persistent.

## Solution

Replace `query()` with the v2 Session API (`unstable_v2_createSession` / `unstable_v2_resumeSession` + `send()` / `stream()`). We're on SDK v0.2.87 which includes the full v2 API.

### v2 Session API pattern

```typescript
// Create a session once (or resume an existing one)
await using session = unstable_v2_createSession({
  model: 'claude-opus-4-6',
  systemPrompt,
  mcpServers: { openelinaro: mcpServer },
  allowedTools: [...],
  permissionMode: 'bypassPermissions',
  persistSession: true,
});

// Multi-turn: send a message, stream the response
await session.send('What medications am I overdue on?');
for await (const msg of session.stream()) {
  // same SDKMessage types we already handle
}

// Next user message — same session, warm cache, full context
await session.send('Remove the standing desk todo');
for await (const msg of session.stream()) { ... }

// Resume after restart
await using session = unstable_v2_resumeSession(savedSessionId, { model: 'claude-opus-4-6' });
```

### What this gives us

1. **One persistent session** — create once, resume across turns and restarts
2. **No re-init per message** — context carries over, prompt cache stays warm, costs drop dramatically
3. **Steering** — send a new `send()` while the agent is between tool calls
4. **Native multi-turn** — no manual session ID tracking, the SDK handles it
5. **Session discovery** — `listSessions()`, `getSessionMessages()`, `forkSession()` for history

## Implementation

### Core changes (`src/core/claude-sdk-core.ts`)

- Replace the per-turn `query()` call with a long-lived session object
- `createSession()` on first message, `resumeSession()` on subsequent turns
- `send()` replaces building a prompt from the last user message
- `stream()` replaces the `for await` over `query()` — same message types
- Session object lives on the core instance, not created per `run()` call
- `cwd` set to stable `~/.openelinaro` so session files persist across deploys

### Architecture changes (`src/core/types.ts`, `src/app/runtime-scope.ts`)

- `AgentCore` interface: instead of creating a new core per turn, keep one core alive per conversation
- The core factory creates the session once; subsequent calls to `run()` reuse it
- `CoreRunOptions` gains an `isNewSession` flag or the core detects it internally

### Harness changes (`src/services/conversation/agent-chat-service.ts`)

- The chat service keeps the core instance alive across turns for the "main" conversation
- When a new message arrives during an active turn, it becomes the next `send()` call (steering)
- Session ID persistence moves from conversation store to the SDK's built-in persistence

### What stays the same

- `SDKMessage` types — identical between v1 and v2
- All event processing logic (thinking, tool_start, tool_end, etc.)
- MCP tool registration via `createSdkMcpServer`
- Hook system (PreToolUse, PostToolUse, PreCompact)
- The G2 UI, Discord integration, event bus — all consume the same `AgentStreamEvent` types

## References

- [v2 Session API demos](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/hello-world-v2)
- [SDK Changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- [npm @anthropic-ai/claude-agent-sdk v0.2.87](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [Feature Request: Real-Time Steering](https://github.com/anthropics/claude-agent-sdk-typescript/issues/70)
