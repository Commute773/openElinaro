# Autonomous Time & Reflection Runtime

Use this doc when working on autonomous time, private continuity, journal writing, soul rewrites, or thread-start self-context.

## Current shape

Autonomous time, reflection, and soul rewrites are unified into a single service: `src/services/autonomous-time-service.ts`. The agent gets one autonomous-time trigger per day (currently at 4 AM local time) and decides what to do during that session.

Related files:
- `src/services/autonomous-time-service.ts` -- the unified service
- `src/services/autonomous-time-prompt-service.ts` -- loads prompt assets for autonomous time, reflection, and soul rewrite
- `src/services/autonomous-time-state-service.ts` -- tracks last trigger date, last reflection date, last soul rewrite date

Runtime paths:
- journal path: `~/.openelinaro/memory/documents/<namespace>/identity/JOURNAL.md`
- optional self-model path: `~/.openelinaro/memory/documents/<namespace>/identity/SOUL.md`
- state file: `~/.openelinaro/autonomous-time-state.json`
- authored prompt assets:
  - `~/.openelinaro/assistant_context/autonomous-time.md`
  - `~/.openelinaro/assistant_context/reflection.md`
  - `~/.openelinaro/assistant_context/reflection-mood-notes.md`
  - `~/.openelinaro/assistant_context/reflection-seeds.md`
  - `~/.openelinaro/assistant_context/soul.md` for SOUL rewrite guidance

`JOURNAL.md` is append-only and stores one timestamped entry per reflection in a stable markdown format:

```md
## 2026-03-17T20:14:00.000Z [daily]

- mood: productive
- bring_up_next_time: finance onboarding flow

I noticed...
```

The journal is private-first. Automatic reflections are durable runtime state, not user-facing messages.

## Reflection Triggers

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

`src/services/autonomous-time-service.ts` owns the reflection flow.
`src/services/autonomous-time-prompt-service.ts` loads the authored reflection prompt assets.

- recent archived conversation history is pulled from the append-only conversation store
- the last journal entries are included for self-continuity
- `SOUL.md` is read if present, but the reflection phase does not rewrite it automatically
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

`SOUL.md` is a separate durable self-model path, managed by the same autonomous-time service.

- source file: `~/.openelinaro/memory/documents/<namespace>/identity/SOUL.md`
- prose prompt: `~/.openelinaro/assistant_context/soul.md`
- cadence: best-effort weekly background rewrite, triggered after a successful daily reflection when the profile has gone at least 7 local days since the last rewrite

The rewrite path is full-file, not append-only. The current file plus recent journal history are provided to the model, and the resulting markdown replaces the previous `SOUL.md`.

## Autonomous Time Sessions

During an autonomous-time session (triggered at 4 AM local time, once per day), the agent receives a prompt that tells it this session is its own. The agent can:

- Reflect on recent conversations and write journal entries
- Review and rewrite its soul document
- Do self-directed work on active projects
- Review and plan routines
- Explore ideas or research topics

The autonomous-time prompt is loaded from `~/.openelinaro/assistant_context/autonomous-time.md` with a built-in fallback. The session runs with full tool access, memory ingestion, and compaction enabled.
