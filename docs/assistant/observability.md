# Observability

The runtime telemetry entrypoint is [`src/services/telemetry.ts`](../../src/services/telemetry.ts). It is still the local structured telemetry layer, but it is now the single place to shape future OpenTelemetry-compatible behavior.

## Current defaults

- Use `telemetry.child({ component })` for component-scoped events and spans.
- Use boundary helpers for side effects:
  - `instrumentFetch(...)`
  - `instrumentSpawn(...)`
  - `instrumentStoreWrite(...)`
  - `instrumentQueueAction(...)`
- Use `instrumentMethods(instance, { component })` at composition roots so public service methods get entry spans even when the service file does not declare `traceSpan(...)` locally.

## How auto instrumentation works

- `instrumentMethods(...)` returns a proxy that wraps public prototype methods in spans.
- Internal method-to-method calls inside the same instance are not intercepted; explicit `traceSpan(...)` is still the right choice for long-running internal phases and important sub-steps.
- The runtime applies this at its composition root — now spread across [`src/app/runtime.ts`](../../src/app/runtime.ts), [`src/app/runtime-scope.ts`](../../src/app/runtime-scope.ts), [`src/app/runtime-workflow.ts`](../../src/app/runtime-workflow.ts), and [`src/app/runtime-automation.ts`](../../src/app/runtime-automation.ts) — for services that previously had weak or inconsistent span coverage.

## Coverage rule

New runtime code should satisfy at least one of these:

- explicit telemetry in the module itself
- auto instrumentation at the composition root

Pure helpers can stay uninstrumented if they have no meaningful runtime side effects and are always called from an already-instrumented boundary.

## Audit

Run:

```sh
bun scripts/telemetry-audit.ts
```

Use `--strict` to make the audit fail when exported runtime classes are neither explicitly instrumented nor covered by composition-root auto instrumentation.

## Future OTEL path

If the repo moves to full OpenTelemetry export, keep `TelemetryService` as the local API boundary and swap its storage/export behavior underneath it rather than rewriting every caller directly to vendor APIs.

## Model usage ledger

Per-request model usage is also written to `~/.openelinaro/model-usage.jsonl` through [`src/services/usage-tracking-service.ts`](../../src/services/usage-tracking-service.ts).

The ledger now persists provider-reported USD cost alongside token counts, scoped by active profile id. Agents can inspect that data through the `usage_summary` tool for both per-thread totals and local-day totals in the routines timezone.

Each record still keeps the exact provider-reported token totals, and chat-style requests routed through [`src/connectors/active-model-connector.ts`](../../src/connectors/active-model-connector.ts) now also persist prompt diagnostics for later debugging:

- approximate prompt breakdown by category
- prompt message counts by role
- visible tool count and tool names
- top token contributors across system prompt, messages, and tool definitions
- approximation delta versus the provider-reported input total

Treat the prompt diagnostics as a debugging estimate, not billing truth. The exact usage numbers remain the top-level `inputTokens`, `outputTokens`, and `totalTokens` fields from the provider response.

## Heartbeat instrumentation

Hourly heartbeat turns are intentionally isolated from the parent chat thread's historical conversation so automation checks do not replay the full user thread on every cadence tick.

The runtime now emits:

- `app.heartbeat.prompt_prepared` with prompt-size and reminder-count metadata for each heartbeat attempt
- `app.heartbeat.main_thread_handoff` when a user-facing heartbeat reply is written back into the main conversation thread
- `app.heartbeat.main_thread_handoff_error` if that write-back fails

This keeps heartbeat token accounting on the automation conversation key while still letting the main chat agent see delivered heartbeat replies in its own thread history.
