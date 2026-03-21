# Unified Runtime Instrumentation

This note is now historical. The telemetry rewrite described here has been implemented.

## Current system

- Runtime observability uses `src/services/telemetry.ts` as the single entrypoint.
- Structured spans and events are stored in `~/.openelinaro/telemetry.sqlite`.
- A JSONL tail is still written to `~/.openelinaro/logs/app.jsonl`.
- Operator queries use `telemetry_query`.

## Architecture that landed

- `TelemetryService` uses `AsyncLocalStorage` for trace/span context propagation.
- Services and integrations use component-scoped telemetry children instead of importing a global logger API.
- The SQLite store has separate `spans` and `events` tables plus an FTS index and migration markers.
- Common correlation ids such as `conversationKey`, `workflowRunId`, `taskId`, `toolName`, `profileId`, `provider`, `jobId`, `entityType`, and `entityId` are indexed columns.
- The runtime includes boundary helpers for fetch, spawn, queue actions, and store writes.
- Tool-program worker telemetry is streamed back into the main timeline as structured events.

## Migration behavior

- On startup, the runtime imports legacy event-store records into `~/.openelinaro/telemetry.sqlite`.
- Legacy `.start`, `.end`, and `.error` rows are reconstructed into spans when they share `(trace_id, span_id)`.
- Legacy unmatched rows are imported as standalone events.
- The old SQLite store is archived to `~/.openelinaro/migrations/telemetry/events.legacy.sqlite`.
- The old JSONL log is rotated to `~/.openelinaro/logs/legacy/app.pre-telemetry.jsonl`.

## Operator workflow

- Use `telemetry_query` to inspect spans and events by trace, component, operation, entity ids, or free text.
- Use JSON output when another tool or script needs structured telemetry results.
- Use text output when you want a quick human-readable timeline.
- structured step progress
- artifact creation
- tool invocation inside worker loops

Artifacts can still exist on disk, but the event timeline should point to them.

## Concrete coverage gaps to fix first

The highest-value missing instrumentation is in these areas:

1. Durable stores and state machines

- `WorkflowRegistry`
- `WorkflowSessionStore`
- `RoutinesService` and `RoutinesStore`
- `AlarmService`
- `ProfileService`
- `ProjectsService`
- `auth/store.ts`

2. External boundary services

- `WebSearchService`
- `WebFetchService`
- `OpenBrowserService`
- auth session flows
- dynamic tool execution

3. Background work internals

- workflow session persistence
- queue pickup / retry / backoff decisions
- task status transitions
- verification subprocesses
- worker subprocess lifecycle

4. Cross-cutting helpers

- telemetry-aware fetch
- telemetry-aware spawn/exec
- telemetry-aware store writes
- telemetry-aware retries / backoff

## Migration plan

### Phase 1: Install the architectural foundation

- add a `TelemetryService` backed by `AsyncLocalStorage`
- keep `logEvent` / `withSpan` as wrappers so the migration is direct, not a flag-day rewrite
- extend the event store schema with first-class correlation columns
- add a redaction utility and normalized error serializer

### Phase 2: Instrument the missing infrastructure boundaries

- wrap subprocess execution, Python runners, fetch, and persistent store writes
- instrument workflow queue operations and workflow session persistence
- stream worker/subprocess lifecycle events into the central store

### Phase 3: Instrument domain state transitions

- conversation lifecycle
- routine lifecycle
- alarm lifecycle
- workflow status changes
- auth lifecycle
- profile/project selection and mutation

### Phase 4: Enforce instrumentation in new code

- create service construction helpers that require a telemetry dependency
- add a repo check that lists non-test service files with no telemetry usage
- add tests that assert representative operations emit expected spans/events
- add a short architecture doc showing the required patterns for new services and tools

## What should become hard to do wrong

Future additions should naturally do the right thing because:

- service constructors receive telemetry by default
- wrappers exist for the common side effects
- key store abstractions emit state-change events automatically
- CI points out services that perform side effects without telemetry
- tests cover event emission for major runtime paths

## Recommended implementation order

If this work starts now, the practical order is:

1. Build `TelemetryService` with context propagation and compatibility wrappers.
2. Extend the event schema and search path so richer events are worth emitting.
3. Instrument stores, queue runners, subprocesses, and network clients.
4. Instrument domain services and lifecycle transitions.
5. Add enforcement checks and docs for future contributors.

## Bottom line

openElinaro already has a decent structured logging base, but it is not yet a truly instrumented runtime.

To get to "we know whenever the system does basically anything", the repo needs to shift from optional logging calls to telemetry as infrastructure:

- automatic context propagation
- typed spans and events
- deep coverage at state and I/O boundaries
- indexed correlation fields
- centralized redaction
- enforcement so new runtime code inherits instrumentation instead of remembering it manually
