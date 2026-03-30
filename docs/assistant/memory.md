# Memory Runtime

Use this doc when working on durable memory or the structured memory system.

## Current shape

OpenElinaro has three complementary memory paths:

- maintained core memory file under `~/.openelinaro/memory/<namespace>/core/MEMORY.md`
- **structured memory** under `~/.openelinaro/memory/<namespace>/structured/` — categorized entity files managed by an autonomous background agent
- private identity continuity files under `~/.openelinaro/memory/<namespace>/identity/`

Today the identity path is used for:

- `identity/JOURNAL.md` as the append-only private reflection log
- optional `identity/SOUL.md` as a read-only self-model input for reflection

Memory is surfaced to the agent via the system prompt: the memory file tree is injected directly so the agent can reference durable facts without search tools.

## Read path

The memory file tree is injected into the system prompt by `SystemPromptService`. The agent sees the directory structure and file contents of the memory namespace, giving it access to all durable facts, structured entities, and core memory content.

Fresh threads also get a bounded startup continuity block assembled from:

- recent journal entries from `identity/JOURNAL.md`
- last mood continuity
- one initiative seed from the newest non-empty `bring_up_next_time`

The generic startup digest intentionally excludes `identity/` docs so private reflection content is only surfaced through the dedicated bootstrap formatter.

## Write path

There are three write paths:

- during `compact` / `new`, the runtime extracts durable memory and merges it into `core/MEMORY.md` by editing that file instead of writing a fresh note every time
- **structured memory management**: after compaction, a background `MemoryManagementAgent` extracts categorized entities (people, projects, topics, decisions, preferences, tools, incidents) and creates or merges them into individual markdown files under `structured/<category>/<slug>.md`
- reflection writes append structured private entries to `identity/JOURNAL.md`; this is a separate continuity path

This is intentionally narrower than a full knowledge-graph memory system:

- it targets durable facts, preferences, standing instructions, and long-lived project context
- it does not try to preserve every transient turn
- raw compaction artifacts should not be the default recall substrate

## Structured memory

The structured memory system organizes durable knowledge into categorized markdown files managed by an autonomous background agent.

### File layout

```
~/.openelinaro/memory/<namespace>/structured/
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

## Guardrails

- Memory writes are background work and must not block the main chat turn.
- Prefer updating the current architecture directly over adding a parallel memory subsystem.
