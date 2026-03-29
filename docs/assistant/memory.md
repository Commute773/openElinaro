# Memory Runtime

Use this doc when working on durable memory, semantic recall, or legacy-memory imports.

## Current shape

OpenElinaro now has four complementary memory paths:

- imported and operator-written markdown memory under `~/.openelinaro/memory/documents/<namespace>/`
- maintained core memory file under `~/.openelinaro/memory/documents/<namespace>/core/MEMORY.md`
- **structured memory** under `~/.openelinaro/memory/documents/<namespace>/structured/` — categorized entity files managed by an autonomous background agent
- private identity continuity files under `~/.openelinaro/memory/documents/<namespace>/identity/`

Today the identity path is used for:

- `identity/JOURNAL.md` as the append-only private reflection log
- optional `identity/SOUL.md` as a read-only self-model input for reflection

The retriever is still local hybrid retrieval:

- dense embeddings from `src/services/text-embedding-service.ts`
- lexical BM25 scoring from `src/services/hybrid-search.ts`
- reciprocal-rank fusion inside `src/services/memory-service.ts`

## Read path

Before a chat turn is sent to the model, the runtime now:

1. builds a short retrieval query from the current user message plus minimal recent context when needed
2. searches a curated local memory subset first (`core/` plus a few high-signal profile docs) instead of the whole imported note pile
3. injects the top relevant memories as a tagged `<recalled_memory>` block prepended to the same outgoing user request, but only when the turn looks like a real user turn and the top match clears a stronger confidence gate

Important:

- the tagged memory block is transient model input, not canonical conversation history
- the stored conversation keeps the raw user message, without recalled-memory text mixed into it
- internal automation turns such as healthchecks, heartbeats, alarms, and timers should skip recall entirely
- recall telemetry should record when a memory block was actually injected plus its approximate size, so operators can audit token cost without replaying conversations

The hot path stays local so warm recall latency remains in the low-millisecond range for the current corpus size.

Separate from retrieval, fresh threads now also get a bounded startup continuity block assembled from:

- recent journal entries from `identity/JOURNAL.md`
- last mood continuity
- one initiative seed from the newest non-empty `bring_up_next_time`
- the existing recent-thread memory/doc digest

The generic startup digest intentionally excludes `identity/` docs so private reflection content is only surfaced through the dedicated bootstrap formatter.

## Write path

There are now three write paths:

- during `compact` / `new`, the runtime extracts durable memory and merges it into `core/MEMORY.md` by editing that file instead of writing a fresh searchable compaction note every time
- **structured memory management**: after compaction, a background `MemoryManagementAgent` extracts categorized entities (people, projects, topics, decisions, preferences, tools, incidents) and creates or merges them into individual markdown files under `structured/<category>/<slug>.md`
- reflection writes append structured private entries to `identity/JOURNAL.md`; this is a separate continuity path, not normal memory recall output

This is intentionally narrower than a full knowledge-graph memory system:

- it targets durable facts, preferences, standing instructions, and long-lived project context
- it does not try to preserve every transient turn
- raw compaction artifacts should not be the default recall substrate

## Structured memory

The structured memory system organizes durable knowledge into categorized markdown files managed by an autonomous background agent.

### File layout

```
~/.openelinaro/memory/documents/<namespace>/structured/
  INDEX.md                    # Top-level index of all categories
  people/
    INDEX.md                  # Category index
    <slug>.md                 # One file per person
  projects/
    INDEX.md
    <slug>.md
  topics/
    INDEX.md
    <slug>.md
  decisions/
    INDEX.md
    <slug>.md
  preferences/
    INDEX.md
    <slug>.md
  tools/
    INDEX.md
    <slug>.md
  incidents/
    INDEX.md
    <slug>.md
```

Each entity file has frontmatter (`title`, `category`, `updated`) followed by bullet-point facts.

### Categories

| Category | What goes here |
|---|---|
| `people` | Individuals the user mentions — role, relationship, preferences, notable facts |
| `projects` | Named repos, initiatives — purpose, status, tech stack, key decisions |
| `topics` | Recurring themes, domains — what the user cares about, key insights |
| `decisions` | Significant choices — what was decided, why, alternatives considered |
| `preferences` | Workflow habits, tool choices — how the user likes to work |
| `tools` | Specific tools, services, technologies — usage, config, gotchas |
| `incidents` | Bugs, outages, problems — what happened, root cause, resolution |

### Trigger

The `MemoryManagementAgent` runs as a fire-and-forget background task after every compaction event. It:

1. Receives the compaction summary
2. Calls the memory model to extract structured entities as JSON
3. For each entity, checks if a file with that slug already exists
4. If yes: uses the memory model to merge new facts into the existing body
5. If no: creates a new entry with the extracted facts
6. Rebuilds category and top-level indexes

### Recall integration

Structured memory files are included in the recall search path with a +0.015 score bonus (between core memory at +0.025 and profile docs at +0.01). This means the hybrid retriever will surface relevant people, project, or topic entries when the user's message matches.

### Implementation

- `src/services/memory/structured-memory-manager.ts` — CRUD for categorized entries, index management
- `src/services/memory/memory-management-agent.ts` — LLM-driven extraction and merge loop
- Wired via `ChatDependencies.structuredMemory` in `AgentChatService`
- Registered in `runtime-scope.ts` (skipped for subagents and when memory is disabled)

## Profile settings

Profiles now have explicit memory-model fields:

- `memoryProvider`
- `memoryModelId`

If those are omitted in code, the runtime falls back to the tool-summarizer selection. In the checked-in registry, every profile should declare them explicitly.

## Legacy import

The old OpenClaw memory import path remains markdown-first.

- use `memory_import` or `MemoryService.importFromDirectory()` for directory imports
- import `~/.openclaw/workspace/memory/` first
- import `MEMORY.md` and `USER.md` separately as profile-level documents when needed
- treat `~/.openclaw/memory/main.sqlite` as verification/provenance, not the primary import source

## Guardrails

- Memory writes are background work and must not block the main chat turn.
- Memory retrieval should stay bounded; inject only a short memory block, not whole documents.
- Prefer updating the current architecture directly over adding a parallel memory subsystem.
- If a recall search does not find a confident curated hit, inject nothing.

## Benchmarking

For low-cost external comparison, the repo now includes a retrieval-only LongMemEval harness:

- entrypoint: `bun run benchmark:memory:longmemeval`
- implementation: `src/services/longmemeval-benchmark-service.ts`
- default dataset: `longmemeval_s_cleaned`
- default sample size: `8` balanced non-abstention questions
- default mode: session-level retrieval only, using the official `answer_session_ids` labels

This deliberately avoids the benchmark's judge-model QA pass, which normally uses an OpenAI evaluator model and would add recurring API cost. The harness downloads the official dataset on demand into `~/.openelinaro/benchmarks/longmemeval/data/`, runs retrieval locally, and writes results under `~/.openelinaro/benchmarks/longmemeval/results/`.
