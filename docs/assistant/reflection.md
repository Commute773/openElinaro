# Reflection Runtime

Use this doc when working on private continuity, journal writing, or thread-start self-context.

## Current shape

Reflection is a private, profile-scoped runtime subsystem.

- journal path: `~/.openelinaro/memory/documents/<namespace>/identity/JOURNAL.md`
- optional self-model path: `~/.openelinaro/memory/documents/<namespace>/identity/SOUL.md`
- daily reflection state: `~/.openelinaro/reflection-state.json`
- authored prompt assets:
  - `~/.openelinaro/assistant_context/reflection.md`
  - `~/.openelinaro/assistant_context/reflection-mood-notes.md`
  - `~/.openelinaro/assistant_context/reflection-seeds.md`
  - `~/.openelinaro/assistant_context/soul.md` for the future SOUL rewrite path

`JOURNAL.md` is append-only and stores one timestamped entry per reflection in a stable markdown format:

```md
## 2026-03-17T20:14:00.000Z [daily]

- mood: productive
- bring_up_next_time: finance onboarding flow

I noticed...
```

The journal is private-first. Automatic reflections are durable runtime state, not user-facing messages.

## Triggers

Current reflection triggers are:

- `daily`
  - first eligible idle heartbeat after `18:00` in the routines timezone
  - only once per local day
  - only queued when the heartbeat does not need to send a user-facing reminder
- `compaction`
  - queued after successful conversation compaction
  - best-effort background work; failures must not fail the user turn
- `explicit`
  - invoked through the `reflect` runtime tool or Discord `/reflect`
  - may include an optional focus string

Automatic daily and compaction reflections do not notify the user.

## Generation path

`src/services/reflection-service.ts` owns the reflection flow.
`src/services/reflection-prompt-service.ts` loads the authored reflection prompt assets.

- recent archived conversation history is pulled from the append-only conversation store
- the last journal entries are included for self-continuity
- `SOUL.md` is read if present, but this phase does not rewrite it automatically
- `src/services/soul-service.ts` owns periodic full-file rewrites of `identity/SOUL.md`
- the reflection system prompt is assembled from the markdown files under `~/.openelinaro/assistant_context/`
- runtime code still owns the strict JSON contract so prose authors only control voice and introspection guidance
- the model returns strict JSON with:
  - `body`
  - `mood`
  - `bring_up_next_time`

Reflection generation uses the memory-writing model path (`ModelService.generateMemoryText(...)`) rather than the normal foreground chat path.

## Thread bootstrap

On the first human turn of a thread, the runtime injects a private continuity block built from the latest journal entries.

That bootstrap currently includes:

- the last 2-3 journal entries
- last mood continuity
- one initiative seed from the most recent non-empty `bring_up_next_time`

This reflection continuity is combined with the existing recent-thread digest. The generic digest intentionally excludes `identity/` documents so raw journal content is not duplicated.

## Operator-facing surfaces

Manual reflection is available through:

- runtime tool: `reflect`
- Discord slash command: `/reflect`

The explicit path returns the written entry so it is inspectable on demand. Automatic paths only append to the journal.

## SOUL Rewrites

`SOUL.md` is now a separate durable self-model path.

- source file: `~/.openelinaro/memory/documents/<namespace>/identity/SOUL.md`
- prose prompt: `~/.openelinaro/assistant_context/soul.md`
- rewrite service: `src/services/soul-service.ts`
- cadence: best-effort weekly background rewrite, triggered after a successful daily reflection when the profile has gone at least 7 local days since the last rewrite

The rewrite path is full-file, not append-only. The current file plus recent journal history are provided to the model, and the resulting markdown replaces the previous `SOUL.md`.
