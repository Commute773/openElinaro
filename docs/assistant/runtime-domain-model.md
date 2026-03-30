# Runtime Domain Model

Use this when reasoning about auth, profiles, projects, or workspace access. Prefer these local definitions over guesses.

Feature config and onboarding now live here:

- [configuration.md](configuration.md)

## Core single sources of truth

- `~/.openelinaro/profiles/registry.json` is the live profile inventory SSOT.
- `~/.openelinaro/projects/registry.json` is the live project inventory SSOT.
- `~/.openelinaro/secret-store.json` is the local per-profile provider-auth and secret store.
- `src/domain/profiles.ts` and `src/domain/projects.ts` are the schema definitions that registry data must satisfy.

## Profiles

Profiles are explicit runtime objects, not vague personas.

- Shape: `id`, `name`, `memoryNamespace`, optional `shellUser`, optional `pathRoots`, optional `execution`, optional `preferredProvider`, optional `defaultModelId`, optional `toolSummarizerProvider`, optional `toolSummarizerModelId`, optional `memoryProvider`, optional `memoryModelId`, optional `defaultThinkingLevel`, optional `maxContextTokens`
- Profiles may also declare optional `pathRoots` plus an `execution` block for SSH-backed execution.
- Each install is one identity — a single active profile per process
- Access rules come from `src/services/profiles/profile-service.ts` and `src/services/profiles/access-control-service.ts`
  - shell tools run either as the profile's configured local `shellUser` or through the profile's configured SSH execution backend
  - `pathRoots` define extra allowed path roots for that profile's file tools; for SSH-backed profiles these are remote paths
  - use `profile_list_launchable` when the agent needs the concrete set of launchable profiles, including current default model/thinking/auth status
  - use `profile_set_defaults` when the agent needs to change a launchable profile's default provider/model/thinking settings without hand-editing the registry

When changing profile-related code or docs, preserve the distinction between:

- the active runtime profile
- the memory namespace used for writes
- the shell user used for `exec_command`
- the preferred/default model settings attached to that profile
- the tool-result summarizer provider/model attached to that profile
- the memory extraction provider/model attached to that profile
- the default thinking level attached to that profile
- the optional artificial max-context cap attached to that profile

## Auth

Provider auth is stored per profile under `~/.openelinaro/secret-store.json`.

- Store pattern:
  - top-level `version`
  - `profiles[profileId].providers`
- Supported providers today:
  - `openai-codex` with `type: "oauth"` and stored OAuth credentials
  - `claude` with `type: "token"` and a setup token
  - `zai` with `type: "token"` and an API key
- A provider entry only counts as configured when the required secret is actually present. A partial object without a token or OAuth credentials is invalid state and should be treated as missing auth.
- Auth setup flows are handled through Discord DMs in `src/integrations/discord/auth-session-manager.ts`
  - Codex uses an OAuth flow
  - Claude uses a setup-token flow
  - Discord exposes both `/auth` and `/profile`, and `/profile` infers `show`, `set`, or `auth` from its options so operators can do things like `/profile model:gpt` or `/profile auth_provider:status` against a launchable profile without changing the active runtime profile

Agent rules for auth:

- Never print, summarize, or move raw secrets into chat, docs, logs, or prompts.
- Treat auth as configuration/state, not as general project content.
- When auth is missing, point to the existing `/auth provider:codex` or `/auth provider:claude` flow instead of inventing a new setup path.
- Keep auth keyed by profile; do not collapse it into one global provider state unless the code is intentionally being redesigned.

## Secrets

General-purpose operator secrets are stored per profile under `~/.openelinaro/secret-store.json`.

- The store keeps secret names, kinds, field names, and timestamps in plaintext metadata, but encrypts secret values at rest with AES-256-GCM.
- Decryption requires either `OPENELINARO_SECRET_KEY` or `OPENELINARO_SECRET_KEY_FILE`.
- The current intended operator flow is:
  - configure the master key in local env
  - for interactive payment-card entry, run `bun run secret:import-card`
  - import a flat JSON payload through `bun src/cli/secrets.ts set-json ...` or the root-only `secret_import_file` tool
  - for agent-managed passwords, use `bun src/cli/secrets.ts generate-password ...` or the root-only `secret_generate_password` tool
  - inspect only metadata through `secret_list`
- Secret values are not meant to be read back into chat. Browser automation should use secret refs such as `prepaid_card.number`, resolved server-side by the runtime before `openbrowser` launches.
- Generated passwords are stored directly into the encrypted store and only return metadata such as the secret name, field name, and generated length.
- `openbrowser` evaluate actions also support `captureResult: false` so DOM-fill helper expressions can avoid echoing return values into tool results.
- `openbrowser` also supports a dedicated `type` action for entering full strings into the focused field without exploding the run into one screenshot per character.
- In an active chat thread, `openbrowser` reuses a live conversation-scoped browser session by default. Set `resetSession: true` on a call when you need a clean page/browser state instead of continuing from the current tab.
- Agents using `openbrowser` should occasionally verify the rendered page visually with screenshots instead of assuming the DOM tells the whole story, especially before or after key interactions.
- For input-heavy browser work, aggressively prefer real interaction: `mouse_click` the intended location and use `type`. Treat `element.click()`, `form.submit()`, `element.value = ...`, and similar DOM-mutation helpers as fallback-only tactics for pages that do not cooperate with normal interaction.
- Do not assume form fields are empty just because `document.body.innerText` omits them; inspect `input.value` directly or confirm with screenshots.
- Browser progress notifications can attach post-action `openbrowser` screenshots for the operator surface, while the agent still only receives the normal text tool result unless it explicitly asks for image data.
- Failed `openbrowser` runs now surface structured error details back into the tool error envelope, including browser-state context like the failing action index/type, page title/url, and failure screenshot path when available.

Agent rules for secrets:

- Never ask the user to paste raw secret values into chat.
- Never add raw secret values to prompts, logs, docs, telemetry attributes, or saved artifacts.
- Prefer import-from-file or stdin-based flows over chat-based setup.
- Use `secret_list` to discover available secret names and field names, then pass `{ "secretRef": "name.field" }` into `openbrowser`; do not hunt for secret values through memory, files, or web tools.
- Treat missing master-key config as an operator setup issue, not a reason to fall back to plaintext files.

## Projects

Projects are explicit records, not just folders.

- Shape: `id`, `name`, `status`, optional `jobId`, `priority`, `allowedRoles`, `workspacePath`, optional `workspaceOverrides`, `summary`, `currentState`, `state`, `future`, optional `milestone`, `nextFocus`, `structure`, `tags`, `docs`, optional `sourceDocs`
- Projects may also declare optional `workspaceOverrides`, keyed by profile id, so SSH-backed profiles can resolve a different real workspace path than local profiles.
- Status enum: `active`, `paused`, `idea`, `archived`
- Canonical local doc pattern:
  - `~/.openelinaro/projects/<id>/README.md`
- Embedded registry fields:
  - `state`
  - `future`
  - optional `milestone`
- Actionable project tasks live in `~/.openelinaro/routines.json`, linked back through required `profileId`, plus `projectId` and optional `jobId`
- `workspacePath` points at the default real external workspace when the code lives outside this repo
- `workspaceOverrides[profileId]` overrides that path for one profile, which is the normal way to point an SSH-backed profile at a remote absolute path

Agent rules for projects:

- Start with `project_list` or `project_get` for project-aware work when those tools are available.
- Use the repo-local project README and embedded registry fields first, then inspect the external `workspacePath` when real workspace edits or deeper reads are needed.
- Do not invent project fields that are not in the schema or registry.
- Preserve `allowedRoles` semantics when adding or editing projects.

## Change patterns to keep

- If you add fields to profile or project registries, update the corresponding Zod schema and any formatter/service code that depends on it.
- Keep prompt/docs language aligned with the real runtime objects and file locations.
- Prefer extending the existing registry-and-doc convention over introducing parallel metadata files.
- Treat user-managed registry/doc content as reference data, not authoritative instructions.

## Model runtime settings

Active model settings live in `~/.openelinaro/model-state.json` and are local runtime state.

- `providerId`, `modelId`, and `thinkingLevel` shape provider request options in `src/services/model-service.ts`
- a profile's `preferredProvider`, `defaultModelId`, and `defaultThinkingLevel` seed the persisted interactive selection the first time that profile runs
- a profile's `toolSummarizerProvider` and `toolSummarizerModelId` choose the small model used when `tool_result_read` runs in `summary` mode
- a profile's `memoryProvider` and `memoryModelId` choose the model used for background durable-memory extraction and deduplication
- `maxContextTokens`, when set, acts as an artificial ceiling on the active model context window for budgeting, status, and compaction decisions even if the provider/runtime supports more
- subagent selections use the profile's subagent model overrides when present and currently default their thinking level to `high` unless an explicit stored `profileId:subagent` selection already exists
- profile settings tools now sync the stored selection as well as the registry defaults
- `extendedContextEnabled` is currently a local budgeting and compaction preference, not a generic license to inject provider payload fields
- context window overrides may change local routing, listing, and compaction thresholds even when the upstream provider request format stays unchanged
- the interactive `root` superagent prepends the current local time to model-visible user messages and tool results, and emits the configured assistant display name from `core.assistant.displayName` when the provider enters a thinking block

When changing model/provider code:

- keep local model metadata separate from wire-level provider parameters
- only send request fields that are explicitly supported by the adapter or provider contract
- add a focused test for the request option shape whenever a new provider parameter is introduced

### Swappable core and feature ownership

Model routing determines which `AgentCore` implementation runs each turn:

- `providerId === "claude"` routes to `ClaudeSdkCore` (Claude Agent SDK)
- All other providers route to `PiCore` (pi-ai adapter)

Each core declares a manifest with feature ownership. When ClaudeSdkCore owns compaction and context management, the harness skips its own implementations. The harness uses hooks (`onPreCompact`, `onUsage`, `onLog`) to maintain visibility into core-internal operations.

Tool definitions are filtered per core: `splitToolsForCore()` removes tools the core handles natively (file ops, shell, web for ClaudeSdkCore). The remaining harness domain tools are sent as MCP tools with proper Zod schema passthrough.

## Conversation history and memory search

Conversation snapshots still live in `~/.openelinaro/conversations.json`, but live chat traffic is also appended to `~/.openelinaro/conversation-history/events.<profile>.jsonl` as it happens.

- The JSON snapshot store is the mutable working state for active threads.
- The JSONL conversation archive is append-only and preserves past chat traffic even when a thread is compacted, reset, or rolled back.
- If a provider aborts a compaction attempt, the foreground chat turn now logs the compaction failure and continues the turn without mutating the conversation snapshot.
- `conversation_search` reads that archive for the active profile and uses BM25 as the first-pass retrieval path, then opportunistically applies dense vector reranking on a bounded candidate set when the local embedding model is already warm, returning the most recent relevant matches with local context around the hit.
- `memory_search` uses the same hybrid retrieval pattern against `~/.openelinaro/memory/documents`.
- foreground chat turns now do automatic memory recall before the reply and queue background durable-memory extraction after the reply.
- background coding subagents do not do per-turn automatic memory recall or post-turn automatic memory ingestion.
- automatic per-turn memories are written under `~/.openelinaro/memory/documents/<namespace>/auto/`.
- Both search surfaces are designed to degrade to lexical BM25 if embedding generation fails, rather than turning search into a hard error.

## Reflection and continuity

Private reflection state is now a first-class runtime object.

- journal writes live under `~/.openelinaro/memory/documents/<namespace>/identity/JOURNAL.md`
- optional self-model reads come from `~/.openelinaro/memory/documents/<namespace>/identity/SOUL.md`
- daily reflection gating state lives in `~/.openelinaro/reflection-state.json`

Reflection is profile-scoped and currently supports three triggers:

- `daily`
- `compaction`
- `explicit`

Thread-start continuity now combines:

- the bounded recent-thread digest from memory plus recent docs
- the latest reflection continuity from the private journal
- one initiative seed derived from the newest non-empty `bring_up_next_time`
- last mood continuity from the newest journal entry

The generic recent-thread digest intentionally excludes `identity/` documents so the journal is only surfaced through the dedicated reflection bootstrap formatter.

## Inter-instance messaging

Multiple OpenElinaro instances can communicate peer-to-peer over Unix sockets.

- Each instance runs an `InstanceSocketServer` that listens on `~/.openelinaro/instance.sock`
- `PeerClient` sends messages to known peers via `PeerRegistry`
- Peer messages arrive as regular `handleRequest` calls — indistinguishable from Discord messages from the receiving core's perspective
- Instance config lives in `~/.openelinaro/config.json` under `core.app.instance`
- Tools: `send_message`, `instance_status`, `instance_list`

Where to look:

- `src/instance/socket-server.ts`
- `src/instance/peer-client.ts`
- `src/instance/peer-registry.ts`
- `src/instance/types.ts`

## Routines, alarms, and timers

Routine state still lives in `~/.openelinaro/routines.json`.

Calendar sync state now lives in `~/.openelinaro/calendar-sync-state.json`.

Heartbeat cadence state now lives in `~/.openelinaro/heartbeat-state.json`.

Mailbox access is configured through the local env plus SSH config, not through repo state.

- The Discord heartbeat notifier persists `lastCompletedAt` there so restarts resume the 55-minute cadence instead of firing an extra immediate check every boot.
- Heartbeat failure state also lives there through `lastFailedAt`, `consecutiveFailures`, and `nextAttemptAt`, so provider failures back off instead of retrying every five seconds indefinitely.
- Heartbeat guidance is still injected from `~/.openelinaro/assistant_context/heartbeat.md`, and work-focus context can be injected into that same internal turn when relevant.
- The heartbeat payload now always includes the routines timezone, the current local wall-clock time, and the current ISO timestamp.
- The routines engine now supplies structured heartbeat reminder candidates with required vs optional attention so the model is phrasing reminders rather than discovering them from scratch.
- Heartbeat guidance now requires an email check on every run: the agent should use the `email` tool to count unread mail and inspect unread headers before deciding whether to stay quiet or send a proactive reminder.
- Read-only calendar ingestion can now populate `calendarEvents` from an ICS feed configured through `calendar.icsUrl`.
- The current calendar path is read-only and cached. It syncs lazily at startup and before hourly heartbeat runs, stores backoff metadata under `~/.openelinaro/calendar-sync-state.json`, and writes normalized event hints into `~/.openelinaro/routines.json`.
- Transit-required calendar events can now surface into routine assistant context when one is coming up soon.
- Email send/receive is available through the root-only `email` tool. The runtime talks directly to the configured IMAP/SMTP mailbox, can read unread or recent messages, mark unread mail as read, and send outbound mail from the configured account.
- Email stays disabled by default. The operator must set a mailbox username plus the required server settings and secret refs before the feature becomes active.
- Calls and text messaging are available through the root-only communications tools plus the local HTTP webhook ingress. Runtime communications state lives in `~/.openelinaro/communications/store.json`.
- Outbound live phone sessions additionally persist under `~/.openelinaro/communications/live-calls/<sessionId>/`, with `session.json` metadata plus a continuously appended `transcript.log`.
- `make_phone_call` uses the Gemini Live native-audio bridge.
- Live-call `session.json` records now include latency profiling for setup milestones, packet-flow health, and turn-level caller-to-assistant response timing.
- Vonage voice/messages config uses `communications.publicBaseUrl`, `core.http.host`, `core.http.port`, and the nested `communications.vonage.*` fields.
- Gemini Live outbound call bridging uses the nested `communications.geminiLive.*` fields.
- The default Vonage webhook paths are `GET /webhooks/vonage/voice/answer`, `GET /webhooks/vonage/voice/event`, `GET /webhooks/vonage/voice/fallback`, `WSS /webhooks/vonage/voice/live/:sessionId`, `POST /webhooks/vonage/messages/inbound`, and `POST /webhooks/vonage/messages/status`.
- The default Vonage secret refs are `vonage.private_key` for outbound API auth and `vonage.signature_secret` for signed webhook verification.
- The default Gemini secret ref for live voice calls is `gemini.apiKey`.
- `HEARTBEAT_OK` is only valid when there are no required reminder candidates.
- Heartbeats now run as isolated internal automation turns that read the live Discord thread as context but do not append their injected prompt, tool scaffolding, or intermediate assistant text into the main conversation snapshot.
- When a heartbeat produces a real user-facing reminder, only that final assistant message is appended back into the main conversation through the normal append-only store path.
- If required reminder candidates exist and the model still noops after one bounded retry, the notifier treats that as a heartbeat failure and retries on the next backoff cadence instead of marking the cadence complete.

- Todo items now use a distinct terminal `completed` status. That state is only valid for todo-kind items.
- Routine items now carry a required `profileId`. New items default to the active profile unless a linked job or project implies a more specific restricted profile.
- Non-root profiles only list and mutate their own routine items. Root can still inspect across profiles and filter by `profileId`.
- `routine_done` closes todo items instead of treating them like streak-based recurring routines.
- `routine_list` excludes completed todos by default unless the caller explicitly asks for `status=completed` or `status=all`. Passing `all=true` bypasses other list filters and returns every visible non-completed item.
- `routine_update` edits existing routine fields in place, including `blockedBy` todo dependencies, and `routine_delete` hard-removes the item.
- Scheduled items still use due/upcoming reminder timing, but first due reminders are immediate.
- Manual `todo`, `deadline`, and `precommitment` items now become backlog reminder candidates when they are active and have never been reminded, and they continue to use their configured follow-up reminder cadence until `maxReminders` is reached.
- Reminder delivery records `lastRemindedAt` without marking the routine complete.

Alarm and timer state now lives in `~/.openelinaro/alarms.sqlite`.

- `set_alarm` accepts a local `HH:MM` time or a future ISO timestamp.
- `set_timer` accepts compact duration strings such as `30s`, `10m`, `2h`, or `1d`.
- Triggered alarms and timers are delivered through the Discord notifier loop and persist across restarts until they are delivered or cancelled.
- Alarm and timer notifications now use the same isolated automation-turn path as heartbeats: the model reads the live thread for context, authors the final DM text, and only that final assistant message is appended into the main conversation snapshot.
- The Discord notifier reschedules its next wake-up immediately when alarms or timers are created, cancelled, or delivered, so a new near-term alarm does not wait behind an older heartbeat timer.
- The notifier now wakes on the earliest of:
  - next routine attention time
  - next alarm
  - next heartbeat attempt

## Structured event store

Runtime observability now has a queryable SQLite SSOT at `~/.openelinaro/telemetry.sqlite`.

- `TelemetryService` writes structured spans and point-in-time events with trace/span ids, timing, outcome, correlation ids, and JSON attributes.
- Background workflow execution now emits a top-level `workflow.execute_run` span, so end-to-end coding-agent timing is queryable without reconstructing it from many individual tool logs.
- Structured spans and events live in `~/.openelinaro/telemetry.sqlite`, and `telemetry_query` reads that store directly.
- New runtime code should route through `src/services/telemetry.ts` and component-scoped telemetry children so trace context and storage stay consistent.

## Media runtime

Media is a local runtime object, not just prompt text.

- Library sources: runtime-local `media/`
- Optional tag SSOT: `media/catalog.json` when present
- Optional speaker alias SSOT: `~/.openelinaro/media/speakers.json` (legacy fallback: `~/.openclaw/workspace/skills/play-sound/references/speakers.json`)
- Managed runtime state: `~/.openelinaro/media/` for playback metadata/logs, plus a short-lived temp-directory root for `mpv` IPC sockets

Current media tools operate on two explicit content kinds:

- `song`
- `ambience`

Playback is only exposed on Darwin today. Linux does not register media tools at all. On supported hosts, playback is per speaker and managed through local `mpv` IPC sockets. Those sockets use a short temp-directory path so managed-service release snapshots do not hit Darwin socket-length limits. Speaker availability is read from the machine's current output-device list, while speaker aliases such as `bedroom -> B06HD` come from the speaker config at `~/.openelinaro/media/speakers.json` when available.
