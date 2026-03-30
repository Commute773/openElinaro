# Memory Runtime

Durable memory system based on lightweight markdown files under `~/.openelinaro/memory/`.

## File Layout

Three complementary memory paths per profile namespace:

- `~/.openelinaro/memory/<namespace>/core/MEMORY.md` -- maintained core memory file
- `~/.openelinaro/memory/<namespace>/structured/` -- categorized entity files managed by a background agent
- `~/.openelinaro/memory/<namespace>/identity/` -- private identity continuity:
  - `identity/JOURNAL.md` -- append-only private reflection log
  - `identity/SOUL.md` -- optional read-only self-model input

No embeddings, no hybrid search, no vector store. Memory is surfaced through direct file injection into the system prompt.

## Read Path

The memory file tree is injected into the system prompt by `SystemPromptService`. The agent sees directory structure and file contents, giving access to all durable facts, structured entities, and core memory.

Thread bootstrap adds:

- Recent journal entries from `identity/JOURNAL.md`
- Last mood continuity
- One initiative seed from newest non-empty `bring_up_next_time`

The generic startup digest excludes `identity/` docs to avoid duplicating journal content.

## Write Paths

1. **Core memory**: during compact/new, the runtime extracts durable memory and merges into `core/MEMORY.md` by editing the file (not creating new notes)
2. **Structured memory**: after compaction, a background `MemoryManagementAgent` extracts categorized entities and creates/merges markdown files under `structured/<category>/<slug>.md`
3. **Reflection**: appends structured private entries to `identity/JOURNAL.md` (separate continuity path)

## Structured Memory

Organizes durable knowledge into categorized markdown files:

```
structured/
  INDEX.md
  people/<slug>.md
  projects/<slug>.md
  topics/<slug>.md
  decisions/<slug>.md
  preferences/<slug>.md
  tools/<slug>.md
  incidents/<slug>.md
```

Each entity file has frontmatter (`title`, `category`, `updated`) followed by bullet-point facts.

Categories: people, projects, topics, decisions, preferences, tools, incidents.

The `MemoryManagementAgent` runs as fire-and-forget after compaction: extracts entities as JSON, checks for existing files, merges or creates, rebuilds indexes.

Where to look: `src/services/memory/structured-memory-manager.ts`, `src/services/memory/memory-management-agent.ts`

## Profile Settings

Profiles declare explicit memory-model fields:

- `memoryProvider`
- `memoryModelId`

Falls back to tool-summarizer selection if omitted.

## Guardrails

- Memory writes are background work and must not block the main chat turn
- This is intentionally narrower than a full knowledge-graph system: targets durable facts, preferences, standing instructions, and long-lived project context

## Read Next

- [Autonomous Time & Reflection](reflection.md)
- [Runtime Domain Model](runtime-domain-model.md)
