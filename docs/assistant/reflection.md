# Autonomous Time & Reflection

Unified system for private reflection, journal writing, soul rewrites, and self-directed work.

## Architecture

All autonomous-time behavior is unified in a single service: `src/services/autonomous-time-service.ts`. The agent gets one autonomous-time trigger per day (currently at 4 AM local time) and decides what to do during that session.

Related files:

- `src/services/autonomous-time-service.ts` -- the unified service
- `src/services/autonomous-time-prompt-service.ts` -- loads prompt assets
- `src/services/autonomous-time-state-service.ts` -- tracks last trigger, reflection, and soul rewrite dates

## Runtime Paths

- Journal: `~/.openelinaro/memory/documents/<namespace>/identity/JOURNAL.md`
- Self-model: `~/.openelinaro/memory/documents/<namespace>/identity/SOUL.md`
- State: `~/.openelinaro/autonomous-time-state.json`
- Prompt assets under `~/.openelinaro/assistant_context/`:
  - `autonomous-time.md`
  - `reflection.md`
  - `reflection-mood-notes.md`
  - `reflection-seeds.md`
  - `soul.md`

## Autonomous Time Sessions

During a session (4 AM local, once per day), the agent receives a prompt declaring the session is its own. The agent can:

- Reflect on recent conversations and write journal entries
- Review and rewrite its soul document
- Do self-directed work on active projects
- Review and plan routines
- Explore ideas or research topics

The session runs with full tool access, memory ingestion, and compaction enabled. Configuration: `autonomousTime.enabled` and `autonomousTime.promptPath` in `~/.openelinaro/config.yaml`.

## Reflection Triggers

- `daily` -- first eligible idle heartbeat after 18:00 in the routines timezone, once per local day, only when no user-facing reminder is needed
- `compaction` -- after successful conversation compaction, best-effort background
- `explicit` -- via `reflect` tool or Discord `/reflect`, optional focus string

Automatic reflections do not notify the user.

## Journal Format

`JOURNAL.md` is append-only with timestamped entries:

```md
## 2026-03-17T20:14:00.000Z [daily]

- mood: productive
- bring_up_next_time: finance onboarding flow

I noticed...
```

The model returns strict JSON: `body`, `mood`, `bring_up_next_time`. Reflection uses the memory-writing model path (`ModelService.generateMemoryText`).

## Soul Rewrites

- Source: `~/.openelinaro/memory/documents/<namespace>/identity/SOUL.md`
- Prompt: `~/.openelinaro/assistant_context/soul.md`
- Cadence: best-effort weekly, triggered after daily reflection when 7+ days since last rewrite
- Full-file rewrite (not append-only)

## Thread Bootstrap

On the first human turn of a thread, the runtime injects a private continuity block:

- Last 2-3 journal entries
- Last mood continuity
- One initiative seed from the most recent non-empty `bring_up_next_time`

The generic startup digest excludes `identity/` docs so journal content is only surfaced through the dedicated bootstrap formatter.

## Operator Surfaces

- Runtime tool: `reflect`
- Discord slash command: `/reflect`

The explicit path returns the written entry. Automatic paths only append to the journal.

## Read Next

- [Memory](memory.md)
- [Runtime Domain Model](runtime-domain-model.md)
