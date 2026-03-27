# Deployments

## 2026.03.27.17
- Released at: 2026-03-27T16:08:18Z
- Release id: 20260327T160818Z-6174678
- Previous version: 2026.03.27.16
- Trigger: ci/release workflow

- refactor: consolidate duplicate ProviderId and runtime type aliases
- remove dead mlx_batch_server.py script

## 2026.03.27.16
- Released at: 2026-03-27T15:57:15Z
- Release id: 20260327T155715Z-bd5362b
- Previous version: 2026.03.27.15
- Trigger: ci/release workflow

- refactor: extract test env setup into createIsolatedRuntimeRoot harness

## 2026.03.27.15
- Released at: 2026-03-27T15:32:52Z
- Release id: 20260327T153252Z-1b24079
- Previous version: 2026.03.27.14
- Trigger: ci/release workflow

- docs: add G2 API reference and update extension docs

## 2026.03.27.14
- Released at: 2026-03-27T15:30:09Z
- Release id: 20260327T153009Z-3f96a06
- Previous version: 2026.03.27.13
- Trigger: ci/release workflow

- feat: add full CRUD endpoints for routines and todos in G2 API

## 2026.03.27.13
- Released at: 2026-03-27T15:25:21Z
- Release id: 20260327T152521Z-b8b7e49
- Previous version: 2026.03.27.12
- Trigger: ci/release workflow

- feat: add OpenAPI 3.1 spec for G2 API discoverability
- feat: allow extensions to register HTTP routes under /api/ext/<id>/

## 2026.03.27.12
- Released at: 2026-03-27T15:23:06Z
- Release id: 20260327T152306Z-6c92d73
- Previous version: 2026.03.27.11
- Trigger: ci/release workflow

- feat: implement extension module loading with scoped ExtensionAPI

## 2026.03.27.11
- Released at: 2026-03-27T15:22:09Z
- Release id: 20260327T152209Z-1c94ab7
- Previous version: 2026.03.27.10
- Trigger: ci/release workflow

- feat: add SSE event stream endpoint for real-time push updates

## 2026.03.27.10
- Released at: 2026-03-27T15:20:25Z
- Release id: 20260327T152025Z-63a1925
- Previous version: 2026.03.27.9
- Trigger: ci/release workflow

- feat: add health, projects, and conversations read endpoints to G2 API

## 2026.03.27.9
- Released at: 2026-03-27T15:19:06Z
- Release id: 20260327T151906Z-cb84699
- Previous version: 2026.03.27.8
- Trigger: ci/release workflow

- refactor: extract JsonStateService<T> base class for all JSON state services
- refactor: unify prompt document snapshot types into shared PromptDocumentSnapshot

## 2026.03.27.8
- Released at: 2026-03-27T02:30:47Z
- Release id: 20260327T023047Z-962bdbd
- Previous version: 2026.03.27.7
- Trigger: ci/release workflow

- fix: tools now auto-adopt the running zigbee bridge

## 2026.03.27.7
- Released at: 2026-03-27T02:11:29Z
- Release id: 20260327T021129Z-14132bf
- Previous version: 2026.03.27.6
- Trigger: ci/release workflow

- feat: semantic lights_* tools with natural language color interface

## 2026.03.27.6
- Released at: 2026-03-27T02:05:27Z
- Release id: 20260327T020527Z-289648b
- Previous version: 2026.03.27.5
- Trigger: ci/release workflow

- fix: rename display name to Elinaro and change "is typing" to "is thinking" (#102)

## 2026.03.27.5
- Released at: 2026-03-27T01:19:20Z
- Release id: 20260327T011920Z-0370336
- Previous version: 2026.03.27.4
- Trigger: ci/release workflow

- feat: zigbee bridge sidecar for Bun serialport compatibility

## 2026.03.27.4
- Released at: 2026-03-27T01:11:54Z
- Release id: 20260327T011154Z-2658de7
- Previous version: 2026.03.27.3
- Trigger: ci/release workflow

- fix: make zigbee startup non-blocking to avoid healthcheck timeout

## 2026.03.27.3
- Released at: 2026-03-27T01:09:20Z
- Release id: 20260327T010920Z-b0aca3a
- Previous version: 2026.03.27.2
- Trigger: ci/release workflow

- fix: explicit adapter type for zigbee-herdsman USB discovery

## 2026.03.27.2
- Released at: 2026-03-27T00:58:31Z
- Release id: 20260327T005831Z-636b99d
- Previous version: 2026.03.27
- Trigger: ci/release workflow

- feat: replace MQTT-based zigbee2mqtt with direct zigbee-herdsman

## 2026.03.27
- Released at: 2026-03-27T00:37:21Z
- Release id: 20260327T003721Z-9faaf46
- Previous version: 2026.03.26.5
- Trigger: ci/release workflow

- feat: integrate Zigbee2MQTT device control via MQTT

## 2026.03.26.5
- Released at: 2026-03-26T16:35:11Z
- Release id: 20260326T163511Z-6fee6ca
- Previous version: 2026.03.26.4
- Trigger: ci/release workflow

- fix: harden test isolation to prevent production secret store overwrites

## 2026.03.26.4
- Released at: 2026-03-26T16:30:18Z
- Release id: 20260326T163018Z-9b4c16c
- Previous version: 2026.03.26.3
- Trigger: ci/release workflow

- fix: forward maxOutputTokens to provider in active-model-connector
- feat: add G2 simulator REST API endpoints

## 2026.03.26.3
- Released at: 2026-03-26T02:23:42Z
- Release id: 20260326T022342Z-1e0d2a6
- Previous version: 2026.03.26.2
- Trigger: ci/release workflow

- fix: make loadRegistry resilient to invalid project/job entries

## 2026.03.26.2
- Released at: 2026-03-26T01:20:10Z
- Release id: 20260326T012010Z-ab24e94
- Previous version: 2026.03.26
- Trigger: ci/release workflow

- fix: deliver alarm routine reminders without model call when heartbeat disabled (#94)

## 2026.03.26
- Released at: 2026-03-26T00:31:50Z
- Release id: 20260326T003150Z-ed9a4ce
- Previous version: 2026.03.25.7
- Trigger: ci/release workflow

- fix: gate alarm routines and deploy healthcheck behind heartbeatEnabled (#93)

## 2026.03.25.7
- Released at: 2026-03-25T23:12:46Z
- Release id: 20260325T231246Z-3d95da6
- Previous version: 2026.03.25.6
- Trigger: ci/release workflow

- feat: add dayResetHour setting to shift routine day boundary

## 2026.03.25.6
- Released at: 2026-03-25T22:40:12Z
- Release id: 20260325T224012Z-988b729
- Previous version: 2026.03.25.5
- Trigger: ci/release workflow

- fix: prevent alarm reminder runaway by enforcing maxReminders and timezone correction

## 2026.03.25.5
- Released at: 2026-03-25T17:52:43Z
- Release id: 20260325T175243Z-83eec99
- Previous version: 2026.03.25.4
- Trigger: ci/release workflow

- feat: add SSH profile e2e tests using real SSH to localhost

## 2026.03.25.4
- Released at: 2026-03-25T17:37:06Z
- Release id: 20260325T173706Z-8c065c4
- Previous version: 2026.03.25.3
- Trigger: ci/release workflow

- feat: support launching subagents on remote machines via SSH

## 2026.03.25.3
- Released at: 2026-03-25T15:53:53Z
- Release id: 20260325T155353Z-e584665
- Previous version: 2026.03.25.2
- Trigger: ci/release workflow

- feat: add phone call e2e test with real Vonage + Gemini Live pipeline

## 2026.03.25.2
- Released at: 2026-03-25T00:28:19Z
- Release id: 20260325T002819Z-1ed1d54
- Previous version: 2026.03.25
- Trigger: ci/release workflow

- docs: add bug fix reproduction policy to CLAUDE.md

## 2026.03.25
- Released at: 2026-03-25T00:19:53Z
- Release id: 20260325T001953Z-67155d8
- Previous version: 2026.03.24.24
- Trigger: ci/release workflow

- fix: handle AI SDK v3 converting image parts to file type

## 2026.03.24.24
- Released at: 2026-03-24T23:45:28Z
- Release id: 20260324T234528Z-005933f
- Previous version: 2026.03.24.23
- Trigger: ci/release workflow

- feat: compress Discord image attachments to stay under Claude's 5 MB base64 limit

## 2026.03.24.23
- Released at: 2026-03-24T23:42:37Z
- Release id: 20260324T234237Z-3f0076d
- Previous version: 2026.03.24.22
- Trigger: ci/release workflow

- fix: use quietHours timezone for routine context mode calculation

## 2026.03.24.22
- Released at: 2026-03-24T23:02:39Z
- Release id: 20260324T230239Z-007f8e7
- Previous version: 2026.03.24.21
- Trigger: ci/release workflow

- fix: fall back to URL source for images exceeding Claude's 5 MB base64 limit

## 2026.03.24.21
- Released at: 2026-03-24T22:33:50Z
- Release id: 20260324T223350Z-20a67bb
- Previous version: 2026.03.24.20
- Trigger: ci/release workflow

- feat: add heartbeatEnabled config toggle

## 2026.03.24.20
- Released at: 2026-03-24T22:24:24Z
- Release id: 20260324T222424Z-9d80de4
- Previous version: 2026.03.24.19
- Trigger: ci/release workflow

- feat: add optional weekday filter to daily routine schedules

## 2026.03.24.19
- Released at: 2026-03-24T22:18:44Z
- Release id: 20260324T221844Z-64e0d95
- Previous version: 2026.03.24.18
- Trigger: ci/release workflow

- fix: preserve image content blocks during conversation compaction

## 2026.03.24.18
- Released at: 2026-03-24T22:17:01Z
- Release id: 20260324T221701Z-568cbed
- Previous version: 2026.03.24.17
- Trigger: ci/release workflow

- fix: cap compaction and core memory output to prevent runaway token generation (#79)

## 2026.03.24.17
- Released at: 2026-03-24T18:15:10Z
- Release id: 20260324T181510Z-5dca89d
- Previous version: 2026.03.24.16
- Trigger: ci/release workflow

- fix: enforce tool auth declarations at compile time via ToolName type
- fix: add missing tool authorization declaration for restart tool
- refactor: use pi-ai context windows as source of truth, make extended context configurable

## 2026.03.24.16
- Released at: 2026-03-24T18:09:30Z
- Release id: 20260324T180930Z-0bfa3c3
- Previous version: 2026.03.24.15
- Trigger: ci/release workflow

- feat: add schema introspection action to config_edit tool (#78)

## 2026.03.24.15
- Released at: 2026-03-24T18:02:22Z
- Release id: 20260324T180222Z-bec0df3
- Previous version: 2026.03.24.14
- Trigger: ci/release workflow

- feat: separate system prompts into universal and operator collections

## 2026.03.24.14
- Released at: 2026-03-24T17:21:15Z
- Release id: 20260324T172115Z-5324b8d
- Previous version: 2026.03.24.13
- Trigger: ci/release workflow

- feat: add restart tool for manual service restart

## 2026.03.24.13
- Released at: 2026-03-24T17:16:23Z
- Release id: 20260324T171623Z-9da37f4
- Previous version: 2026.03.24.12
- Trigger: ci/release workflow

- feat: replace free-form cwd with named workspace param on launch_agent

## 2026.03.24.12
- Released at: 2026-03-24T03:21:51Z
- Release id: 20260324T032151Z-b235bd5
- Previous version: 2026.03.24.11
- Trigger: ci/release workflow

- fix: route subagent completion responses to Discord via background notifier

## 2026.03.24.11
- Released at: 2026-03-24T03:10:26Z
- Release id: 20260324T031026Z-1a51d1c
- Previous version: 2026.03.24.10
- Trigger: ci/release workflow

- fix: unify error logging — recordError now always writes to stderr

## 2026.03.24.10
- Released at: 2026-03-24T03:03:17Z
- Release id: 20260324T030317Z-0245fa2
- Previous version: 2026.03.24.9
- Trigger: ci/release workflow

- fix: add missing tool auth declaration and crash on startup errors

## 2026.03.24.9
- Released at: 2026-03-24T02:53:47Z
- Release id: 20260324T025347Z-fb25f3c
- Previous version: 2026.03.24.8
- Trigger: ci/release workflow

- fix: start healthcheck watcher before Discord gateway connects

## 2026.03.24.8
- Released at: 2026-03-24T02:39:45Z
- Release id: 20260324T023945Z-74fcce0
- Previous version: 2026.03.24.7
- Trigger: ci/release workflow

- feat: add read_agent_terminal tool and readTerminal tmux method

## 2026.03.24.7
- Released at: 2026-03-24T02:25:23Z
- Release id: 20260324T022523Z-1e98bb5
- Previous version: 2026.03.24.6
- Trigger: ci/release workflow

- fix: stop passing subagentDefaultModelId to subagent spawn commands

## 2026.03.24.6
- Released at: 2026-03-24T02:18:33Z
- Release id: 20260324T021833Z-a19f0cc
- Previous version: 2026.03.24.5
- Trigger: ci/release workflow

- fix: use absolute path for tmux binary instead of relying on PATH

## 2026.03.24.5
- Released at: 2026-03-24T02:08:37Z
- Release id: 20260324T020837Z-0d02cb0
- Previous version: 2026.03.24.4
- Trigger: ci/release workflow

- fix: /update confirm:true shows actual result when no update is needed

## 2026.03.24.4
- Released at: 2026-03-24T01:51:56Z
- Release id: 20260324T015156Z-1fa4fa0
- Previous version: 2026.03.24.3
- Trigger: ci/release workflow

- fix: make detached update tool result explicit that update is NOT complete

## 2026.03.24.3
- Released at: 2026-03-24T01:44:19Z
- Release id: 20260324T014419Z-190814a
- Previous version: 2026.03.24.2
- Trigger: ci/release workflow

- test: add TmuxManager PATH resolution tests

## 2026.03.24.2
- Released at: 2026-03-24T01:27:13Z
- Release id: 20260324T012713Z-4888ca2
- Previous version: 2026.03.24
- Trigger: ci/release workflow

- fix: pass proper PATH env to tmux subprocess calls

## 2026.03.24
- Released at: 2026-03-24T00:44:39Z
- Release id: 20260324T004439Z-63f7d8e
- Previous version: 2026.03.23.20
- Trigger: ci/release workflow

- fix: enforce append-only conversation history and eliminate heartbeat prompt drift

## 2026.03.23.20
- Released at: 2026-03-23T23:08:12Z
- Release id: 20260323T230812Z-b46fc4d
- Previous version: 2026.03.23.19
- Trigger: ci/release workflow

- fix: make subagent failure errors verbose with exit codes, output, and pane capture
- feat: add alarm flag to routines for exact-time firing

## 2026.03.23.19
- Released at: 2026-03-23T22:01:53Z
- Release id: 20260323T220153Z-f01e768
- Previous version: 2026.03.23.18
- Trigger: ci/release workflow

- fix: use profile timezone for heartbeat time prefix, deduplicate time injection, fix URL parsing

## 2026.03.23.18
- Released at: 2026-03-23T21:39:23Z
- Release id: 20260323T213923Z-4cc1630
- Previous version: 2026.03.23.17
- Trigger: ci/release workflow

- docs: auto commit/push/PR/merge after every completed feature
- fix: coerce bare string to array for email tool address fields

## 2026.03.23.17
- Released at: 2026-03-23T20:37:00Z
- Release id: 20260323T203700Z-678b038
- Previous version: 2026.03.23.16
- Trigger: ci/release workflow

- docs: add log file layout and reading guide to observability doc

## 2026.03.23.16
- Released at: 2026-03-23T20:30:50Z
- Release id: 20260323T203050Z-a39d18e
- Previous version: 2026.03.23.15
- Trigger: ci/release workflow

- fix: enrich IMAP error messages and surface raw errors in tool failures

## 2026.03.23.15
- Released at: 2026-03-23T20:23:14Z
- Release id: 20260323T202314Z-fde43ee
- Previous version: 2026.03.23.14
- Trigger: ci/release workflow

- feat: notify chat when media playback ends (ET-054)

## 2026.03.23.14
- Released at: 2026-03-23T20:22:13Z
- Release id: 20260323T202213Z-6fc2ec7
- Previous version: 2026.03.23.13
- Trigger: ci/release workflow

- add: extension system scaffold (ET-057)
- add withSqliteRetry helper for SQLITE_BUSY retry with exponential backoff
- fix: surface discord-file attachment failures to assistant context
- migrate media speaker config from ~/.openclaw to openElinaro-native path

## 2026.03.23.13
- Released at: 2026-03-23T20:07:08Z
- Release id: 20260323T200708Z-4c2a007
- Previous version: 2026.03.23.12
- Trigger: ci/release workflow

- fix: use base64 for token counting images + add image block diagnostic

## 2026.03.23.12
- Released at: 2026-03-23T19:46:33Z
- Release id: 20260323T194633Z-9b9db6d
- Previous version: 2026.03.23.11
- Trigger: ci/release workflow

- feat: add JSONL error log appender to TelemetryStore for tailable error logs
- add: CLI tail-errors command for tailing the centralized error log
- fix: log swallowed errors to telemetry in email, tickets, and conversation history services
- fix: standardize error logging in runtime and agent-chat to use recordError()
- fix: standardize routines-notifier error logging to use recordError()
- fix: use recordError() for Discord bot error catch blocks

## 2026.03.23.11
- Released at: 2026-03-23T18:43:02Z
- Release id: 20260323T184302Z-ee2258f
- Previous version: 2026.03.23.10
- Trigger: ci/release workflow

- fix: use base64 for images in Anthropic token counting instead of URL sources

## 2026.03.23.10
- Released at: 2026-03-23T18:30:03Z
- Release id: 20260323T183003Z-f6d403d
- Previous version: 2026.03.23.9
- Trigger: ci/release workflow

- fix: cap /update changelog display to 10 most recent entries

## 2026.03.23.9
- Released at: 2026-03-23T18:29:18Z
- Release id: 20260323T182918Z-5c33165
- Previous version: 2026.03.23.8
- Trigger: ci/release workflow

- fix: always use base64 image data instead of sourceUrl for LLM inference

## 2026.03.23.8
- Released at: 2026-03-23T17:47:30Z
- Release id: 20260323T174730Z-456829d
- Previous version: 2026.03.23.7
- Trigger: ci/release workflow

- fix: read service user/group from config.yaml instead of hardcoding

## 2026.03.23.7
- Released at: 2026-03-23T17:40:48Z
- Release id: 20260323T174048Z-edd0eea
- Previous version: 2026.03.23.6
- Trigger: ci/release workflow

- feat: route heartbeat to lightweight model and wire prompt drift warnings to Discord

## 2026.03.23.6
- Released at: 2026-03-23T17:31:11Z
- Release id: 20260323T173111Z-79ff629
- Previous version: 2026.03.23.5
- Trigger: ci/release workflow

- fix: show per-feature active/off status in system prompt and stop hard-coding web_search

## 2026.03.23.5
- Released at: 2026-03-23T02:08:42Z
- Release id: 20260323T020842Z-4c23169
- Previous version: 2026.03.23.4
- Trigger: ci/release workflow

- fix: resolve datetime prefix once at message creation and remove ~850 lines of dead schemas

## 2026.03.23.4
- Released at: 2026-03-23T01:38:20Z
- Release id: 20260323T013820Z-e64e40f
- Previous version: 2026.03.23.3
- Trigger: ci/release workflow

- fix: align subagent tool names and remove obsolete todo tools

## 2026.03.23.3
- Released at: 2026-03-23T01:08:05Z
- Release id: 20260323T010805Z-e2022b3
- Previous version: 2026.03.23.2
- Trigger: ci/release workflow

- fix: persist tool calls before stop check so the model can see its own invocations

## 2026.03.23.2
- Released at: 2026-03-23T00:18:41Z
- Release id: 20260323T001841Z-523be0e
- Previous version: 2026.03.23
- Trigger: ci/release workflow

- feat: improve update error messages with full version triple and verbose rollback
- feat: surface subagent provider descriptions for multi-provider profiles

## 2026.03.23
- Released at: 2026-03-23T00:04:20Z
- Release id: 20260323T000420Z-2dda8a0
- Previous version: 2026.03.22.9
- Trigger: ci/release workflow

- feat: surface subagent provider descriptions for multi-provider profiles (#33)

## 2026.03.22.9
- Released at: 2026-03-22T23:24:19Z
- Release id: 20260322T232419Z-7788e1d
- Previous version: 2026.03.22.8
- Trigger: ci/release workflow

- feat: replace in-process subagents with tmux + hooks architecture (#32)

## 2026.03.22.8
- Released at: 2026-03-22T21:13:22Z
- Release id: 20260322T211322Z-6de3a59
- Previous version: 2026.03.22.7
- Trigger: ci/release workflow

- Add autonomous time scheduling tests

## 2026.03.22.7
- Released at: 2026-03-22T21:09:31Z
- Release id: 20260322T210931Z-ea65eb2
- Previous version: 2026.03.22.6
- Trigger: ci/release workflow

- feat: prepend local time to all user messages and enforce commit-after-feature workflow

## 2026.03.22.6
- Released at: 2026-03-22T20:13:47Z
- Release id: 20260322T201347Z-54377ed
- Previous version: 2026.03.22.5
- Trigger: ci/release workflow

- fix: clarify update source vs deployed state

## 2026.03.22.5
- Released at: 2026-03-22T19:37:14Z
- Release id: 20260322T193714Z-4e65bcd
- Previous version: 2026.03.22.4
- Trigger: ci/release workflow

- fix: use remote image urls for claude attachments

## 2026.03.22.4
- Released at: 2026-03-22T19:24:28Z
- Release id: 20260322T192428Z-71cdf31
- Previous version: 2026.03.22.2
- Trigger: ci/release workflow

- fix: resolve TypeScript type errors in 13 test files to pass CI check
- fix: resolve 9 e2e test failures across 5 test files
- fix: resolve all 136 test failures from mock leaks and path mismatches
- fix: eliminate EROFS test failures with preload and mock leak fix
- test: move test fixtures out of ~/.openelinarotest into the repo
- fix: make telemetry singleton resilient to initialization failures (#25)
- fix: align deployment-version and tool-registry tests with tag-based update mechanism (#24)
- ci: add concurrency group to debounce release workflow runs
- test: add unit tests for workflow orchestration modules
- test: add unit tests for finance forecasting, import, recurring, and ledger modules
- test: add unit tests for runtime-config and feature-config-service
- test: add unit tests for security and access control modules
- test: add unit tests for finance database, budget, and helpers
- test: add unit tests for hybrid-search and memory-service
- test: add unit tests for profile-service, projects-service, and routines-store
- test: add unit tests for conversation service modules
- test: add unit tests for tool service modules
- test: add unit tests for structured-patch and file-utils
- test: add unit tests for text-utils, time-helpers, and timestamp utilities
- test: add unit tests for domain model (task-plan, errors)

## 2026.03.22.2
- Released at: 2026-03-22T17:44:05Z
- Release id: 20260322T174405Z-2875677
- Previous version: 2026.03.22
- Trigger: ci/release workflow

- test: add unit tests for ShellService and FilesystemService
- test: add unit tests for heartbeat state, alarm notification, reflection prompt, and reflection state services

## 2026.03.22
- Released at: 2026-03-22T17:31:55Z
- Release id: 20260322T173155Z-28f0923
- Previous version: 2026.03.22.25
- Trigger: ci/release workflow

- Initial release

## 2026.03.22.25
- Released at: 2026-03-22T17:18:14Z
- Release id: 20260322T171814Z-4b766ed
- Previous version: 2026.03.22.24
- Trigger: managed service update

docs: update all documentation to match current codebase — fix stale file references (app-graph.ts, routine-tool-registry.ts), add missing directory entries (tools/groups, utils, config, services/finance, services/gemini-live), update doc indexes, and reflect orchestration/runtime decomposition across README, WORKSPACE_SUMMARY, repo-layout, architecture-decisions, communications, runtime-domain-model, observability, and research docs

## 2026.03.22.24
- Released at: 2026-03-22T15:44:13Z
- Release id: 20260322T154413Z-e2034ad
- Previous version: 2026.03.22.23
- Trigger: managed service update

Refactor the tool surface around libraries and shell/file primitives.
- remove git wrapper tools and the non-Gemini call_create tool
- collapse model controls into a single model tool
- replace tool_search with load_tool_library and library-driven prompt/runtime guidance
- rename new/fnew to new_chat with force=true for the fast reset path
- derive Discord direct tool commands from the runtime tool registry

## 2026.03.22.23
- Released at: 2026-03-22T15:19:11Z
- Release id: 20260322T151911Z-f2336e9
- Previous version: 2026.03.22.22
- Trigger: managed service update

Add managed-service restart notices so interrupted coding agents resume with a continuation message after restart.
Make feature_manage apply restart the managed service by default, cover feature status/apply/restart behavior in tests, and fix workflow e2e isolation by pinning OPENELINARO_ROOT_DIR.

## 2026.03.22.22
- Released at: 2026-03-22T15:17:12Z
- Release id: 20260322T151712Z-e946662
- Previous version: 2026.03.22.21
- Trigger: managed service update

## Cleanup
- decouple bundled service asset resolution from OPENELINARO_ROOT_DIR so isolated test roots still load packaged profiles and projects
- make update_preview a true dry-run preview and align user-facing Discord/tool copy with the non-mutating behavior

## 2026.03.22.21
- Released at: 2026-03-22T15:15:33Z
- Release id: 20260322T151533Z-2160610
- Previous version: 2026.03.22.20
- Trigger: managed service update

Add validated config_edit tool for runtime config updates and restart gating

## 2026.03.22.20
- Released at: 2026-03-22T15:13:56Z
- Release id: 20260322T151356Z-eb68564
- Previous version: 2026.03.22.19
- Trigger: managed service update

Add validated config_edit tool for runtime config updates and restart gating

## 2026.03.22.19
- Released at: 2026-03-22T15:09:35Z
- Release id: 20260322T150935Z-dab1124
- Previous version: 2026.03.22.18
- Trigger: managed service update

Add a built-in runtime/config preamble ahead of file-based system prompts.
Document enabled and disabled feature flags in the prompt and point feature enablement at feature_manage, config.yaml, secret-store.json, and setup:python.

## 2026.03.22.18
- Released at: 2026-03-22T02:09:03Z
- Release id: 20260322T020903Z-619e5f7
- Previous version: 2026.03.22.17
- Trigger: managed service update

- Fix Discord image attachment ingestion by detecting the actual image MIME type from downloaded bytes instead of trusting attachment metadata.
- Add a Discord regression test for mismatched WebP-labelled PNG uploads and document the behavior in the tool-use playbook.

## 2026.03.22.17
- Released at: 2026-03-22T02:00:00Z
- Release id: 20260322T020000Z-069d54f
- Previous version: 2026.03.22.16
- Trigger: managed service update

Minor README wording cleanup for the /update deployment description.
This is a fresh prepared version for exercising the real Discord slash-command handler on krysalstis with simulated /update and /update confirm:true interactions.

## 2026.03.22.16
- Released at: 2026-03-22T01:14:11Z
- Release id: 20260322T011411Z-aae6721
- Previous version: 2026.03.22.15
- Trigger: managed service update

Minor README wording cleanup for the /update deployment description.
This is a fresh prepared version for manually validating the real .15 -> .16 update path on krysalstis after the sudo env fix.

## 2026.03.22.15
- Released at: 2026-03-22T01:11:46Z
- Release id: 20260322T011147Z-f1faa40
- Previous version: 2026.03.22.14
- Trigger: managed service update

Inline the managed-service metadata in the /update deploy command so sudo does not strip the live release root, service user, or unit path.
This fixes bot-triggered /update confirm:true on krysalstis, where the helper must inherit the live service environment explicitly.

## 2026.03.22.14
- Released at: 2026-03-22T01:01:19Z
- Release id: 20260322T010119Z-e731885
- Previous version: 2026.03.22.13
- Trigger: managed service update

Document that detached update helpers also inherit the live release root from the running service.
This is a docs-only follow-up release after re-validating the real /update flow on krysalstis.

## 2026.03.22.13
- Released at: 2026-03-22T00:58:43Z
- Release id: 20260322T005843Z-b55d9b2
- Previous version: 2026.03.22.12
- Trigger: managed service update

Minor README wording cleanup for the /update deployment description.
This is a fresh prepared version for re-testing the real bot-triggered update flow after the stale live-release pointer fix.

## 2026.03.22.12
- Released at: 2026-03-22T00:56:23Z
- Release id: 20260322T005623Z-cfb12f6
- Previous version: 2026.03.22.11
- Trigger: managed service update

Pass the live managed-service root through detached update helpers and prefer it over stale release-pointer files when determining the current deployment.
This fixes bot-triggered /update failures after overlapping helper jobs leave current-release.txt behind the actual running release.

## 2026.03.22.11
- Released at: 2026-03-22T00:44:45Z
- Release id: 20260322T004445Z-868b95f
- Previous version: 2026.03.22.10
- Trigger: managed service update

Document that detached managed-service updates inherit the installed service identity from the live unit metadata.
This is a docs-only follow-up release after validating the real /update confirm:true flow on krysalstis.

## 2026.03.22.10
- Released at: 2026-03-22T00:41:22Z
- Release id: 20260322T004122Z-4234728
- Previous version: 2026.03.22.9
- Trigger: managed service update

Minor README wording cleanup for the /update deployment note.
This is a fresh prepared version for validating the real detached update flow after the service identity propagation fix.

## 2026.03.22.9
- Released at: 2026-03-22T00:39:04Z
- Release id: 20260322T003905Z-4246d6a
- Previous version: 2026.03.22.8
- Trigger: managed service update

Preserve the managed service identity across self-updates by exporting the service user, group, and unit metadata from the installed service definition.
This fixes detached /update confirm:true runs on hosts like krysalstis where the service intentionally runs as root instead of the default openelinaro user.

## 2026.03.22.8
- Released at: 2026-03-22T00:26:29Z
- Release id: 20260322T002629Z-1d6240d
- Previous version: 2026.03.22.7
- Trigger: managed service update

Minor README wording cleanup for the /update deploy description.
No runtime behavior changes in this release; this is a fresh prepared version for testing after the krysalstis 2026.03.22.7 force deploy.

## 2026.03.22.7
- Released at: 2026-03-22T00:23:51Z
- Release id: 20260322T002351Z-c83915c
- Previous version: 2026.03.22.6
- Trigger: managed service update

Fix detached update helpers to preserve service user/group overrides and related service-install env.
Also fix detached helper status files to record the real nonzero exit code on update failures.
This repairs /update confirm:true on krysalstis, where installs must keep using the root service identity.

## 2026.03.22.6
- Released at: 2026-03-22T00:18:23Z
- Release id: 20260322T001823Z-9100f70
- Previous version: 2026.03.22.5
- Trigger: managed service update

Trivial README wording cleanup after deploying krysalstis to 2026.03.22.5.
No runtime behavior changes in this release; this is just the next prepared version for testing.

## 2026.03.22.5
- Released at: 2026-03-22T00:17:05Z
- Release id: 20260322T001705Z-ce19b74
- Previous version: 2026.03.22.4
- Trigger: managed service update

Fix detached managed-service transition helpers to propagate HOME and OPENELINARO_USER_DATA_DIR.
This repairs update/rollback helper runs on systemd hosts like krysalstis, where the helper previously failed before switching releases.

## 2026.03.22.4
- Released at: 2026-03-22T00:13:54Z
- Release id: 20260322T001354Z-24dadce
- Previous version: 2026.03.22.3
- Trigger: managed service update

Make /update confirm:true reply with a short updating notice instead of the raw detached-helper transcript.
The detached completion DM still delivers the final `update complete` message when the deploy finishes.

## 2026.03.22.3
- Released at: 2026-03-22T00:08:18Z
- Release id: 20260322T000818Z-77f2952
- Previous version: 2026.03.22.2
- Trigger: managed service update

Fix release-snapshot bootstrapping to skip optional repo entries that are not present, such as media/.
This unblocks first-time managed-service release bootstraps on hosts like krysalstis.

## 2026.03.22.2
- Released at: 2026-03-22T00:07:41Z
- Release id: 20260322T000741Z-7b5e388
- Previous version: 2026.03.22
- Trigger: managed service update

Fix managed-service installs to bootstrap an initial release snapshot instead of binding the live service directly to the mutable source checkout.
This preserves the distinction between running version and prepared source version, which /update relies on for changelog previews and deploy checks.

## 2026.03.22
- Released at: 2026-03-22T00:03:47Z
- Release id: 20260322T000347Z-80f078e
- Previous version: 2026.03.21.40
- Trigger: managed service update

Trivial README wording cleanup.
No runtime behavior changes in this release; this is just a fresh prepared update after confirming krysalstis is already deployed on 2026.03.21.40.

## 2026.03.21.40
- Released at: 2026-03-21T23:51:19Z
- Release id: 20260321T235119Z-ba4cff0
- Previous version: 2026.03.21.39
- Trigger: managed service update

Trivial README wording cleanup to create a fresh prepared update for live /update verification on krysalstis.
No runtime behavior changes in this release.

## 2026.03.21.39
- Released at: 2026-03-21T23:50:40Z
- Release id: 20260321T235040Z-0c21ac6
- Previous version: 2026.03.21.38
- Trigger: managed service update

/update now fast-forwards the source checkout before showing deploy notes newer than the running version.
/update confirm:true now runs the managed-service deploy step instead of another git pull.
Updated the Discord flow, backend service tools, tests, and operator docs to match the source-sync then deploy-confirm workflow.

## 2026.03.21.38
- Released at: 2026-03-21T23:42:12Z
- Release id: 20260321T234212Z-de87c15
- Previous version: 2026.03.21.37
- Trigger: managed service update

Trivial README wording cleanup.
No runtime behavior changes in this release; this version exists so the Discord /update flow on krysalstis has a fresh prepared update to pull.

## 2026.03.21.37
- Released at: 2026-03-21T23:41:02Z
- Release id: 20260321T234102Z-6d3092c
- Previous version: 2026.03.21.36
- Trigger: managed service update

/update is now preview-only by default in Discord and requires confirm:true to apply changes.
The slash command now exposes a confirm boolean option and shows an explicit no-changes-applied prompt on preview runs.
Added Discord e2e coverage and updated operator docs for the gated update flow.

## 2026.03.21.36
- Released at: 2026-03-21T23:38:56Z
- Release id: 20260321T233856Z-16e9a18
- Previous version: 2026.03.21.35
- Trigger: managed service update

/update now pulls before showing deployments since the current runtime version.
Successful updates return the deployment changelog instead of raw git pull output.
Added coverage for the new success-path behavior and documented the operator-facing change.

## 2026.03.21.35
- Released at: 2026-03-21T23:34:59Z
- Release id: 20260321T233459Z-bc46e80
- Previous version: 2026.03.21.34
- Trigger: managed service update

Make prepare-update push upstream after committing.
- Require the current branch to track an upstream before preparing.
- Push the prepared update commit after writing VERSION.json and DEPLOYMENTS.md.
- Cover the new push behavior with a tracked-upstream test.

## 2026.03.21.34
- Released at: 2026-03-21T23:33:24Z
- Release id: 20260321T233324Z-1d7151a
- Previous version: 2026.03.21.33
- Trigger: managed service update

Trivial README touch to exercise the prepare-update flow.
- Add a short operator-oriented overview note.

## 2026.03.21.33
- Released at: 2026-03-21T23:01:00Z
- Release id: 20260321T230100Z-c2486b1
- Previous version: 2026.03.21.32
- Trigger: managed service update

- move finance paths and seeded defaults into the finance config block
- gate finance tools and runtime context through feature activation
- add coverage for config-backed finance defaults and disabled finance tools

## 2026.03.21.32
- Released at: 2026-03-21T22:52:14Z
- Release id: 20260321T225214Z-a2ac5eb
- Previous version: 2026.03.21.31
- Trigger: managed service update

Rewrite /update to run git pull --ff-only instead of the managed-service apply flow, and update the Discord command/tests/docs to match.
Scrub public-facing finance defaults/examples and remove the real-looking test email before publishing.

## 2026.03.21.31
- Released at: 2026-03-21T22:45:19Z
- Release id: 20260321T224519Z-cb90c9b
- Previous version: 2026.03.21.30
- Trigger: managed service update

Scrub public-facing finance defaults and README examples to remove user-specific spreadsheet and deduction data.
Replace the real-looking test email with example data and decouple finance tests from private defaults.

## 2026.03.21.30
- Released at: 2026-03-21T22:34:29Z
- Release id: 20260321T223429Z-9f74fc8
- Previous version: 2026.03.21.29
- Trigger: managed service update

Stop default test user-data fallback from creating repo-local .openelinarotest state.
Set recent-thread-context tests to use an isolated runtime root explicitly, and remove the stray repo-local .openelinarotest cache.

## 2026.03.21.29
- Released at: 2026-03-21T22:10:19Z
- Release id: 20260321T221019Z-0174f62
- Previous version: 2026.03.21.28
- Trigger: managed service update

Treat blank runnerScript config values as unset so web_fetch and openbrowser fall back to bundled runner scripts.
Fix the live web_fetch execution path after deploy now that the tool is visible again.

## 2026.03.21.28
- Released at: 2026-03-21T22:04:36Z
- Release id: 20260321T220436Z-39ff17b
- Previous version: 2026.03.21.27
- Trigger: managed service update

Include python/ in managed-service release snapshots so shared-runtime feature readiness works after deploy.
Restore web_fetch and other shared-Python tools in live releases by packaging python/requirements.txt with the service snapshot.

## 2026.03.21.27
- Released at: 2026-03-21T21:47:05Z
- Release id: 20260321T214705Z-893f9e0
- Previous version: 2026.03.21.26
- Trigger: managed service update

Restrict tool_result_ref spillover to explicit high-volume tools like file, shell, web-fetch, and search readers.
Keep tool_search and other compact structured tool outputs inline so agents can inspect them directly.

## 2026.03.21.26
- Released at: 2026-03-21T21:20:38Z
- Release id: 20260321T212038Z-decde0f
- Previous version: 2026.03.21.25
- Trigger: managed service update

Move user-specific prompt, assistant-context, and persona docs out of the repo and into ~/.openelinaro.
Stop bundling repo-local assistant_context, remove checkout-local project artifacts, and update docs to describe the new home-root ownership split.

## 2026.03.21.25
- Released at: 2026-03-21T21:16:44Z
- Release id: 20260321T211644Z-9f4adb1
- Previous version: 2026.03.21.24
- Trigger: managed service update

Improve tool_search exact-name ranking so web_fetch surfaces first for direct queries.
Make shared-Python test fixtures deterministic so openbrowser/web_fetch visibility no longer depends on host-installed modules.

## 2026.03.21.24
- Released at: 2026-03-21T20:48:46Z
- Release id: 20260321T204846Z-193310d
- Previous version: 2026.03.21.23
- Trigger: managed service update

Stabilize runtime-root tests by snapshotting env in beforeEach
Keep the test tree clean after updating ~/.openelinarotest live-state references

## 2026.03.21.23
- Released at: 2026-03-21T20:48:13Z
- Release id: 20260321T204813Z-742807f
- Previous version: 2026.03.21.22
- Trigger: managed service update

Point machine-local live test state at ~/.openelinarotest instead of the repo checkout
Keep isolated temp-root tests local to their temp runtime roots
Update test/docs references so repo-local .openelinarotest is no longer assumed

## 2026.03.21.22
- Released at: 2026-03-21T20:43:42Z
- Release id: 20260321T204342Z-6595329
- Previous version: 2026.03.21.21
- Trigger: managed service update

Move default user data roots to ~/.openelinaro and ~/.openelinarotest
Update service/runtime path handling and docs to stop using repo-local state
Remove committed .openelinarotest scaffolding from the repository

## 2026.03.21.21
- Released at: 2026-03-21T20:32:18Z
- Release id: 20260321T203218Z-dd84142
- Previous version: 2026.03.21.20
- Trigger: managed service update

- replace deployment state symlinks with explicit release pointer files
- move remaining runtime writes off legacy .data paths
- rebuild and verify the unified shared Python venv for web_fetch/openbrowser/localVoice

## 2026.03.21.20
- Released at: 2026-03-21T19:03:10Z
- Release id: 20260321T190310Z-5d727b3
- Previous version: 2026.03.21.19
- Trigger: managed service update

- remove deprecated tool aliases and compatibility-only profile/routine entrypoints
- remove legacy memory bootstrap and old runtime path translation
- remove telemetry legacy import/jsonl mirror and update docs/tests

## 2026.03.21.19
- Released at: 2026-03-21T18:34:46Z
- Release id: 20260321T183446Z-e58e9e2
- Previous version: 2026.03.21.18
- Trigger: managed service update

Remove the nested .data runtime directory from live and test state roots.
Migrate service logs, deployments, memory, workflow, finance, and Python paths to resolve directly under ~/.openelinaro and ~/.openelinarotest.
Update access control so allowed project docs remain reachable under the unified user-data root.

## 2026.03.21.18
- Released at: 2026-03-21T18:26:33Z
- Release id: 20260321T182633Z-143236d
- Previous version: 2026.03.21.17
- Trigger: managed service update

Remove the final stale .env.local reference from .gitignore so the repo no longer documents or expects that path.

## 2026.03.21.17
- Released at: 2026-03-21T18:26:01Z
- Release id: 20260321T182601Z-c0c7f56
- Previous version: 2026.03.21.16
- Trigger: managed service update

Remove .env.local and repo-root runtime state; migrate live auth/secrets into ~/.openelinaro/secret-store.json; add committed ~/.openelinarotest scaffolding; move test fixtures and e2e harnesses onto ~/.openelinarotest; replace remaining user-facing env config references with config.yaml paths.

## 2026.03.21.16
- Released at: 2026-03-21T17:45:49Z
- Release id: 20260321T174549Z-8b4abaf
- Previous version: 2026.03.21.15
- Trigger: managed service update

Preserve current live profiles and projects under ~/.openelinaro while converting committed profiles/ and projects/ into starter templates. Remove committed user-specific project docs and personal generated docs, scrub hardcoded local paths from scripts and docs, drop dead SSH env exports, and make email opt-in with no real account default.

## 2026.03.21.15
- Released at: 2026-03-21T17:31:41Z
- Release id: 20260321T173141Z-4921d94
- Previous version: 2026.03.21.14
- Trigger: managed service update

Move SSH profile keypairs into the unified secret store and materialize runtime key files on demand. Align project-doc access control with live ~/.openelinaro project docs. Update profile tests, README, and system prompt to match the secret-backed SSH key architecture.

## 2026.03.21.14
- Released at: 2026-03-21T17:22:50Z
- Release id: 20260321T172251Z-7ea7ebf
- Previous version: 2026.03.21.13
- Trigger: managed service update

Consolidate live runtime data under ~/.openelinaro. Move config, profiles, projects, secrets, logs, memory, and deployment state under one user-data root. Update managed-service scripts, runtime path resolution, optional feature/docs references, and related tests for the new layout.

## 2026.03.21.13
- Released at: 2026-03-21T17:05:27Z
- Release id: 20260321T170527Z-1bf6393
- Previous version: 2026.03.21.12
- Trigger: managed service update

Consolidate Python-backed features onto one shared core.python venv and setup flow. Add bun run setup:python, central python requirements, shared runtime path helpers, feature_manage preparePython support, and Python feature readiness checks. Update docs, bootstrap guidance, and test harness coverage for the shared runtime.

## 2026.03.21.12
- Released at: 2026-03-21T16:50:40Z
- Release id: 20260321T165040Z-323cb92
- Previous version: 2026.03.21.11
- Trigger: managed service update

Refactor runtime setup around config.yaml and a unified secret store
Add feature-based optional tool activation and feature_manage flow
Add Discord bootstrap setup path and update docs

## 2026.03.21.11
- Released at: 2026-03-21T02:18:46Z
- Release id: 20260321T021846Z-5a03be6
- Previous version: 2026.03.21.10
- Trigger: managed service update

Remove the entire local speech transcription stack and its kokoro-whisper phone backend. Delete the Whisper/SimulStreaming bridge, benchmark, vendored runtime, and docs/tooling references so phone calls use Gemini Live only.

## 2026.03.21.10
- Released at: 2026-03-21T02:09:11Z
- Release id: 20260321T020911Z-4cc050a
- Previous version: 2026.03.21.9
- Trigger: managed service update

Vendor SimulStreaming for the local phone transcriber, enforce streaming-only transcription, and harden the bridge against non-JSON sidecar output.
Tune the default ASR path to tiny.en with 300 ms streaming chunks and prefer the repo-local .venv-voice interpreter when available.
Benchmark the local phone stack and keep the lower-latency configuration as the new default.

## 2026.03.21.9
- Released at: 2026-03-21T02:01:59Z
- Release id: 20260321T020159Z-2707138
- Previous version: 2026.03.21.8
- Trigger: managed service update

Replace the local phone transcriber bridge with vendored SimulStreaming and reject non-streaming backends.
Update the benchmark, dependency list, and operator docs for the streaming-only ASR path.

## 2026.03.21.8
- Released at: 2026-03-21T01:46:04Z
- Release id: 20260321T014604Z-3f1e88f
- Previous version: 2026.03.21.7
- Trigger: managed service update

Lower the live kokoro-whisper default ASR to mlx-whisper base.en with a 400ms online chunk, add real runtime per-turn latency logging and session averages for ASR-to-MLX-to-Kokoro handoff, and keep the synthetic benchmark aligned with the new live defaults.

## 2026.03.21.7
- Released at: 2026-03-21T01:26:21Z
- Release id: 20260321T012621Z-f937835
- Previous version: 2026.03.21.6
- Trigger: managed service update

Switch the local phone ASR path to the standard WhisperStreaming-style online processor loop, prefer mlx-whisper medium.en on Apple Silicon, add ASR backend warmup, rename the streaming knob to OPENELINARO_WHISPER_STREAMING_ONLINE_CHUNK_MS, and extend the synthetic benchmark with speech-start/stop chain latency metrics.

## 2026.03.21.6
- Released at: 2026-03-21T01:08:19Z
- Release id: 20260321T010820Z-fd5b03b
- Previous version: 2026.03.21.5
- Trigger: managed service update

Replace segment-gated Whisper ASR with an online local-agreement Whisper decoder, rename the tuning knob to OPENELINARO_WHISPER_STREAMING_ONLINE_CHUNK_MS, and tune the default online chunk cadence to 320ms to avoid self-queued decode backlog while preserving in-speech partials.

## 2026.03.21.5
- Released at: 2026-03-21T01:01:47Z
- Release id: 20260321T010147Z-e9eeea4
- Previous version: 2026.03.21.4
- Trigger: managed service update

Reduce local phone latency defaults: disable Whisper partial retranscribes by default, switch to tiny.en, lower Silero silence to 120ms, speak Qwen output in shorter chunks, and add a single-run benchmark lock to prevent duplicate MLX/Kokoro launches.

## 2026.03.21.4
- Released at: 2026-03-21T00:49:57Z
- Release id: 20260321T004957Z-1fe7c17
- Previous version: 2026.03.21.3
- Trigger: managed service update

Remove accidental Python bytecode output from the prepared update after adding the detailed Kokoro/Whisper/Silero latency instrumentation.

## 2026.03.21.3
- Released at: 2026-03-21T00:49:31Z
- Release id: 20260321T004931Z-11df9c5
- Previous version: 2026.03.21.2
- Trigger: managed service update

Instrument the local Kokoro/Whisper/Silero benchmark and bridge with audio-clock, wall-clock, backlog, and transcription timing metrics so latency can be broken down into feed overhead, VAD lag, queue backlog, and Whisper compute.

## 2026.03.21.2
- Released at: 2026-03-21T00:39:47Z
- Release id: 20260321T003947Z-f2a73cd
- Previous version: 2026.03.21
- Trigger: managed service update

Remove accidental Python bytecode artifacts from the prepared update after adding persistent local voice sidecars, benchmark sidecar reuse, and the streaming Whisper fixes.

## 2026.03.21
- Released at: 2026-03-21T00:39:12Z
- Release id: 20260321T003912Z-e3d8517
- Previous version: 2026.03.20.34
- Trigger: managed service update

Persist warm local voice sidecars in the managed service, reuse healthy MLX/Kokoro servers in the local benchmark, stabilize streaming Whisper by fixing Silero input typing and loosening the default partial transcription cadence, and switch the default phone backend back to Gemini while keeping local sidecars enabled.

## 2026.03.20.34
- Released at: 2026-03-20T23:45:47Z
- Release id: 20260320T234547Z-4dc717d
- Previous version: 2026.03.20.33
- Trigger: managed service update

Fix Kokoro benchmark bootstrap by using phonemizer-fork/espeakng_loader, separate benchmark Python envs for MLX and Kokoro, and surface Kokoro startup logs on fallback.

## 2026.03.20.33
- Released at: 2026-03-20T23:35:50Z
- Release id: 20260320T233550Z-c5b1151
- Previous version: 2026.03.20.32
- Trigger: managed service update

Removed accidental Python __pycache__ artifacts from the prepared update.
Kept the synthetic local phone benchmark and local latency changes only.

## 2026.03.20.32
- Released at: 2026-03-20T23:35:20Z
- Release id: 20260320T233520Z-6addc86
- Previous version: 2026.03.20.31
- Trigger: managed service update

Added a synthetic local phone benchmark that generates TTS audio, drives streaming Whisper ASR, and compares buffered versus streamed local Qwen response latency.
Reduced local cascaded phone latency by streaming local Qwen output into early segmented speech and tightening the local Whisper defaults.
Updated MLX and Kokoro requirements/docs for the first-class local voice stack and benchmark path.

## 2026.03.20.31
- Released at: 2026-03-20T23:09:17Z
- Release id: 20260320T230917Z-c0cdf25
- Previous version: 2026.03.20.30
- Trigger: managed service update

Added a first-class local Qwen 3.5 35B A3B MLX cache server under scripts/ and repo-owned MLX requirements.
Switched the kokoro-whisper phone backend from Gemini text generation to the local OpenAI-compatible MLX cache server.
Updated communications docs and runtime-domain docs for the repo-owned local LLM voice stack.

## 2026.03.20.30
- Released at: 2026-03-20T23:03:07Z
- Release id: 20260320T230307Z-f60deb0
- Previous version: 2026.03.20.29
- Trigger: managed service update

Add a first-class local phone backend in openElinaro with Kokoro TTS, a repo-owned streaming Whisper + Silero VAD sidecar, and backend selection for make_phone_call.
Share the phone-call prompt contract across voice backends and document the new local voice runtime and env surface.

## 2026.03.20.29
- Released at: 2026-03-20T22:44:11Z
- Release id: 20260320T224411Z-eecc97f
- Previous version: 2026.03.20.28
- Trigger: managed service update

Add generation vs audio-output latency breakdown for Gemini live calls
- record caller-to-first-assistant-transcript as a generation proxy
- record assistant-transcript-to-first-audio as speech-output latency
- surface the full endpointing/recognition/generation/output split in live-call summaries

## 2026.03.20.28
- Released at: 2026-03-20T22:39:55Z
- Release id: 20260320T223955Z-18fe642
- Previous version: 2026.03.20.27
- Trigger: managed service update

Tune Gemini live endpointing to 20/100 and add input-latency breakdown
- lower live-call prefix padding to 20ms and silence duration to 100ms
- estimate per-turn endpointing delay versus residual recognition delay
- surface the new breakdown metrics in session summaries and live-call logs

## 2026.03.20.27
- Released at: 2026-03-20T22:34:00Z
- Release id: 20260320T223400Z-6327c27
- Previous version: 2026.03.20.26
- Trigger: managed service update

Tighten Gemini live call closing behavior
- end calls when assistant transcript includes plain "bye" even without a final transcript flag
- include the exact closing trigger phrases in the Gemini live system prompt
- document the trigger-based auto-hangup behavior for operators

## 2026.03.20.26
- Released at: 2026-03-20T22:31:10Z
- Release id: 20260320T223111Z-c22fd88
- Previous version: 2026.03.20.25
- Trigger: managed service update

Reduce Gemini live phone latency and prove local buffering stays near zero
- disable Gemini thinking for live phone calls and tighten server-side endpointing
- record chunk-size and pending-queue metrics in live-call latency logs
- surface queue and chunk metrics in session summaries for easier debugging

## 2026.03.20.25
- Released at: 2026-03-20T22:22:28Z
- Release id: 20260320T222228Z-446f564
- Previous version: 2026.03.20.24
- Trigger: managed service update

Improve Gemini live call startup and turn timing
- replace the fixed first-turn prompt with a prompt-driven start signal
- gate caller latency turns on speech-like inbound audio instead of every packet
- replace unsupported Gemini hangup tool calls with local auto-hangup on closing phrases

## 2026.03.20.24
- Released at: 2026-03-20T22:12:50Z
- Release id: 20260320T221250Z-7cfa349
- Previous version: 2026.03.20.23
- Trigger: managed service update

Set the Gemini Live default system prompt to the human-like phone prompt, force first-turn speech on answer, and add an internal end_call tool that hangs up the Vonage call.

## 2026.03.20.23
- Released at: 2026-03-20T22:08:29Z
- Release id: 20260320T220830Z-21b8185
- Previous version: 2026.03.20.22
- Trigger: managed service update

Add live phone-call latency profiling for setup milestones, turn timing, and audio stream health in Gemini/Vonage voice sessions.

## 2026.03.20.22
- Released at: 2026-03-20T21:11:21Z
- Release id: 20260320T211121Z-7d6d796
- Previous version: 2026.03.20.21
- Trigger: managed service update

Track Gemini live-call session status from Vonage voice-event webhooks so failed PSTN legs mark the session failed even if the media websocket never opens.

## 2026.03.20.21
- Released at: 2026-03-20T21:08:14Z
- Release id: 20260320T210814Z-2229a0b
- Previous version: 2026.03.20.20
- Trigger: managed service update

Add Gemini 2.5 Flash Live phone-call bridge, make_phone_call tool, live transcript logging, and websocket ingress for Vonage voice.

## 2026.03.20.20
- Released at: 2026-03-20T20:37:03Z
- Release id: 20260320T203703Z-9c0e392
- Previous version: 2026.03.20.19
- Trigger: managed service update

- add first-class Vonage communications runtime for calls and text messaging\n- expose Bun webhook ingress, call/message tools, and communications docs

## 2026.03.20.19
- Released at: 2026-03-20T19:54:50Z
- Release id: 20260320T195450Z-af577eb
- Previous version: 2026.03.20.18
- Trigger: managed service update

- Heartbeat guidance now requires checking unread email on every heartbeat before deciding whether to notify the user.
- Added fallback/test coverage so heartbeat email checks stay enforced even if the heartbeat context file is missing.

## 2026.03.20.18
- Released at: 2026-03-20T19:52:36Z
- Release id: 20260320T195236Z-ca06684
- Previous version: 2026.03.20.17
- Trigger: managed service update

- Replaced the old SSH/Maildir email backend with direct Purelymail IMAP/SMTP send and receive.
- Added outbound email support to the root email tool and updated runtime docs.

## 2026.03.20.17
- Released at: 2026-03-20T19:48:06Z
- Release id: 20260320T194806Z-c99416a
- Previous version: 2026.03.20.16
- Trigger: managed service update

Improve openbrowser resilience and guidance for interactive forms.
- Accept stringified openbrowser action arrays at tool-validation time.
- Strengthen agent guidance to prefer mouse_click plus type over DOM click/value mutation.
- Document that body.innerText omits input values, so field state should be verified via input.value or screenshots.

## 2026.03.20.16
- Released at: 2026-03-20T19:22:10Z
- Release id: 20260320T192210Z-1be3b3c
- Previous version: 2026.03.20.15
- Trigger: managed service update

Updated openbrowser guidance for agent prompts and docs.
- Tell agents to occasionally verify browser state visually with screenshots.
- Prefer coordinate-based clicking and the type action over direct DOM manipulation for input when practical.

## 2026.03.20.15
- Released at: 2026-03-20T19:03:47Z
- Release id: 20260320T190347Z-013efc4
- Previous version: 2026.03.20.14
- Trigger: managed service update

- add a dedicated openbrowser type action for focused text entry with one post-action screenshot
- propagate structured openbrowser failure details into tool error envelopes so agents can branch on page-state failures
- add tests and docs for the new typing and error-propagation behavior

## 2026.03.20.14
- Released at: 2026-03-20T18:36:33Z
- Release id: 20260320T183633Z-ae28799
- Previous version: 2026.03.20.13
- Trigger: managed service update

- fix macOS detached update and rollback helpers to run as one-shot launchd agents instead of keepalive submitted jobs
- remove the launchd install status dependency on rg so transition logs stay clean under launchd PATH defaults
- document the one-shot helper requirement for managed-service transitions

## 2026.03.20.13
- Released at: 2026-03-20T18:29:30Z
- Release id: 20260320T182930Z-8706557
- Previous version: 2026.03.20.12
- Trigger: managed service update

Improve openbrowser progress output for operators.
- Render openbrowser actions as readable step lists in tool-use notifications.
- Capture post-action browser screenshots and attach them to Discord progress updates without sending them into agent context.

## 2026.03.20.12
- Released at: 2026-03-20T18:09:10Z
- Release id: 20260320T180910Z-4490f78
- Previous version: 2026.03.20.11
- Trigger: managed service update

Fix managed-service /update on macOS launchd by running the detached transition through the Node/Bun wrapper instead of launching repo shell scripts directly.
Capture detached helper stdout/stderr, keep status tracking and Discord completion notifications, and add a regression test for wrapper argument forwarding.

## 2026.03.20.11
- Released at: 2026-03-20T17:59:15Z
- Release id: 20260320T175916Z-527f666
- Previous version: 2026.03.20.10
- Trigger: managed service update

Fix persistent openbrowser sessions when the runner emits non-JSON stdout noise.
Add regression coverage for DEBUG lines before JSON responses in session mode.

## 2026.03.20.10
- Released at: 2026-03-20T17:45:22Z
- Release id: 20260320T174522Z-448469a
- Previous version: 2026.03.20.9
- Trigger: managed service update

- Make openbrowser reuse a conversation-scoped live browser session so later tool calls continue on the current page/tab instead of restarting at about:blank.
- Make the secret-store flow more explicit in the prompt, tool descriptions, and docs by directing agents to secret_list and secretRef usage with openbrowser.
- Add tests covering persistent openbrowser sessions, conversation-key session injection, and the updated openbrowser agent harness.

## 2026.03.20.9
- Released at: 2026-03-20T17:35:01Z
- Release id: 20260320T173501Z-136ab38
- Previous version: 2026.03.20.8
- Trigger: managed service update

- simplify managed-service update chat confirmation to a short in-progress notice
- send a Discord DM when a detached update finishes with the deployed version
- document the detached update notification flow

## 2026.03.20.8
- Released at: 2026-03-20T17:28:11Z
- Release id: 20260320T172812Z-a73e15a
- Previous version: 2026.03.20.7
- Trigger: managed service update

- Isolate local coding subagents into linked git worktrees so they cannot mutate the shared checkout.
- Refuse coding-agent launches from dirty local git workspaces to avoid silently dropping uncommitted changes.
- Remove git_revert from coding planner/worker defaults and refuse prepare-update on detached HEAD.
- Add regression coverage for linked-worktree launches, managed-worktree access, and detached-HEAD prepare-update guards.

## 2026.03.20.7
- Released at: 2026-03-20T17:26:40Z
- Release id: 20260320T172641Z-5b7016d
- Previous version: 2026.03.20.6
- Trigger: managed service update

Isolated hourly heartbeat runs from parent-thread history to prevent prompt replay.
Recorded user-facing heartbeat replies back into the main conversation thread so the main agent sees them as assistant output.
Added heartbeat prompt and main-thread handoff telemetry, and adjusted notifier/tests to avoid duplicate heartbeat conversation writes.

## 2026.03.20.6
- Released at: 2026-03-20T17:17:05Z
- Release id: 20260320T171705Z-757b848
- Previous version: 2026.03.20.5
- Trigger: managed service update

Added a root-only secret_generate_password tool and matching CLI command to generate strong passwords server-side and store them directly in the encrypted secret store.
Extended the secret store with a password kind and password-generation logic that preserves existing fields while rotating or creating password entries.
Updated docs and tests for the new password-generation workflow without exposing raw passwords in chat.

## 2026.03.20.5
- Released at: 2026-03-20T17:05:32Z
- Release id: 20260320T170532Z-dce4732
- Previous version: 2026.03.20.4
- Trigger: managed service update

/profile now supports direct shorthand updates without subcommands, including /profile model:gpt and /profile model:opus.
Profile model updates now auto-detect the provider from the target profile's configured provider catalogs when provider is omitted, while auth and show flows remain available through the flattened /profile options.

## 2026.03.20.4
- Released at: 2026-03-20T16:59:17Z
- Release id: 20260320T165917Z-c9e2eaa
- Previous version: 2026.03.20.3
- Trigger: managed service update

Normalized the interactive card importer so duplicated street numbers are cleaned up before storing billing addresses.
Corrected the existing prepaid_card address fields in the encrypted secret store so addressLine1 and fullBillingAddress no longer duplicate the street number.
Updated operator docs to note the street-number normalization behavior.

## 2026.03.20.3
- Released at: 2026-03-20T16:36:56Z
- Release id: 20260320T163656Z-7fa512f
- Previous version: 2026.03.20.2
- Trigger: managed service update

Added an interactive terminal script for importing payment cards with legal name and full billing address fields.
Added a package shortcut for the card-import script and documented the operator workflow.
Kept the encrypted secret-store and browser secret-ref flow as the underlying storage path.

## 2026.03.20.2
- Released at: 2026-03-20T16:30:12Z
- Release id: 20260320T163012Z-fb515fa
- Previous version: 2026.03.20
- Trigger: managed service update

Added an encrypted root-profile secret store for operator-approved browser secrets.
Added root-only secret management tools and a CLI import/list/delete flow that avoids putting secret values in chat.
Updated openbrowser to resolve secret refs server-side and added docs/tests for the new secrets path.

## 2026.03.20
- Released at: 2026-03-20T16:09:07Z
- Release id: 20260320T160907Z-c1e8a52
- Previous version: 2026.03.19.3
- Trigger: managed service update

Persist OpenBrowser browser state per profile.
- derive a stable user-data directory under .data/openbrowser/profiles/<profile>/user-data
- pass that directory into the Python OpenBrowser runner
- document the manual visible-browser login bootstrap flow and cover the payload path in tests

## 2026.03.19.3
- Released at: 2026-03-19T17:01:52Z
- Release id: 20260319T170152Z-5cd757b
- Previous version: 2026.03.19.2
- Trigger: managed service update

- Added a regression test that keeps `update` and `service_rollback` shell output unwrapped, so Discord does not resurface `UNTRUSTED CONTENT WARNING` envelopes for service-control failures.

## 2026.03.19.2
- Released at: 2026-03-19T16:59:07Z
- Release id: 20260319T165907Z-91473bb
- Previous version: 2026.03.19
- Trigger: managed service update

Rework workflow registry for immediate coding-agent launch without queued pickup delays.
Add per-run retry/backoff and stuck-state visibility to workflow_status, including 429 retry handling.
Expand workflow registry and runtime e2e coverage for restart recovery, rate-limit retry, and stuck detection.

## 2026.03.19
- Released at: 2026-03-19T00:05:45Z
- Release id: 20260319T000545Z-1d307e9
- Previous version: 2026.03.18.14
- Trigger: managed service redeploy

- Added docs index services plus `bun run docs:index` to refresh managed doc-reference inventories from repo state.
- Added structured multi-file `apply_patch` editing support across local and SSH filesystem backends and exposed it as a native tool.

## 2026.03.18.14
- Released at: 2026-03-18T23:44:45Z
- Release id: 20260318T234445Z-ed7ecdd
- Previous version: 2026.03.18.13
- Trigger: managed service redeploy

- Improved workflow execution plumbing with stored tool results, better tool-output handling, and new SWE-bench difficulty analysis tooling and docs.
- Removed automatic post-turn conversation memory extraction so foreground chat no longer writes durable memory after every reply.

## 2026.03.18.13
- Released at: 2026-03-18T19:49:02Z
- Release id: 20260318T194902Z-0f15971
- Previous version: 2026.03.18.12
- Trigger: managed service redeploy

- Fixed shell-side deploy version comparison so dotted versions like `YYYY.MM.DD.N` sort numerically during prepare/update checks.

## 2026.03.18.12
- Released at: 2026-03-18T19:48:24Z
- Release id: 20260318T194824Z-e6501b6
- Previous version: 2026.03.18.11
- Trigger: managed service redeploy

- Added the prepared-update deployment flow with `VERSION.json` and `DEPLOYMENTS.md`, plus `update_preview`, `update`, service healthcheck, and detached update scripts.
- Added `/update` Discord support, active-model connector selection, and recorded usage tracking for deploy-aware runtime operations.
- Tightened routines persistence and reminder behavior around completed todos, manual backlog items, and store updates.

## 2026.03.18.11
- Released at: 2026-03-18T18:54:39Z
- Release id: 20260318T185439Z-c6195ac
- Previous version: 2026.03.18.10
- Trigger: managed service redeploy

- Improved deployment changelog previews with entry counts, explicit version-format guidance, and release-id explanations.
- Added tests and docs for numerical version comparison behavior in `service_changelog_since_version`.

## 2026.03.18.10
- Released at: 2026-03-18T18:41:57Z
- Release id: 20260318T184157Z-e462ad5
- Previous version: 2026.03.18.9
- Trigger: managed service redeploy

- Made chat compaction failure non-fatal for the current turn: the agent now logs the failure and continues replying without compaction.
- Added end-to-end compaction coverage for summary insertion, memory merge, telemetry, and fallback behavior.

## 2026.03.18.9
- Released at: 2026-03-18T18:37:26Z
- Release id: 20260318T183726Z-19f9469
- Previous version: 2026.03.18.8
- Trigger: managed service redeploy

- Added SQLite telemetry audit tooling and observability docs for structured runtime spans and events.
- Expanded runtime telemetry around agent and chat execution so investigations can use queryable traces instead of raw log tailing.

## 2026.03.18.8
- Released at: 2026-03-18T18:28:30Z
- Release id: 20260318T182830Z-50d94ce
- Previous version: 2026.03.18.7
- Trigger: managed service redeploy

- Added email service coverage for unread and recent listing plus read flows.
- Tightened email tool wiring and docs so mailbox behavior is exercised through the runtime registry instead of left implicit.

## 2026.03.18.7
- Released at: 2026-03-18T18:26:14Z
- Release id: 20260318T182614Z-b28a37b
- Previous version: 2026.03.18.6
- Trigger: managed service redeploy

- Added Elinaro Tickets runtime integration with list/get/create/update tools and SSH-tunneled private API support.
- Added a root email tool and service for mailbox status, listing, reading, and mark-read flows.

## 2026.03.18.6
- Released at: 2026-03-18T18:02:55Z
- Release id: 20260318T180255Z-3ea015a
- Previous version: 2026.03.18.5
- Trigger: managed service redeploy

- Added read-only ICS calendar sync with cached state and backoff, storing normalized calendar events alongside routines data.
- Synced calendar context into heartbeat runs so upcoming transit-relevant events can surface in reminders.

## 2026.03.18.5
- Released at: 2026-03-18T17:54:24Z
- Release id: 20260318T175424Z-bba9c3c
- Previous version: 2026.03.18.4
- Trigger: managed service redeploy

- Added richer reflection prompt assets, initiative seeds, and scheduled or explicit `SOUL.md` rewrite support for longer-lived identity continuity.
- Added an explicit `reflect` tool plus improved `context` output modes (`brief`, `verbose`, `full`) and thread-start continuity hooks.

## 2026.03.18.4
- Released at: 2026-03-18T17:02:34Z
- Release id: 20260318T170234Z-cae6aad
- Previous version: 2026.03.18.3
- Trigger: managed service redeploy

- Made `service_changelog_since_version` compare versions numerically instead of requiring an exact stamped version match.
- Added clearer tests and docs for `YYYY.MM.DD[.N]` deployment version semantics.

## 2026.03.18.3
- Released at: 2026-03-18T16:48:51Z
- Release id: 20260318T164851Z-a59ee6f
- Previous version: 2026.03.18.2
- Trigger: managed service redeploy

- Added repo-local openElinaro todo planning docs and linked them into operator guidance.
- Tightened profile and access-control coverage plus tool-use docs around restricted runtime surfaces.

## 2026.03.18.2
- Released at: 2026-03-18T16:38:12Z
- Release id: 20260318T163812Z-50836aa
- Previous version: 2026.03.18
- Trigger: managed service redeploy

- Added model-authored alarm and timer notifications with dedicated assistant context instead of raw field dumps.
- Reworked notifier scheduling and chat execution so alarm and heartbeat responses can use thread context while persisting only final assistant messages.

## 2026.03.18
- Released at: 2026-03-18T00:00:51Z
- Release id: 20260318T000051Z-4520b07
- Previous version: 2026.03.17.23
- Trigger: managed service redeploy

- Added the private reflection runtime with journal and state persistence, daily/compaction/explicit triggers, and thread-start continuity injection.
- Improved heartbeat and routine assessment with required vs optional reminder candidates, failure backoff state, and local-time-aware payloads.
- Added recent-thread context retrieval so reflection and heartbeat flows can bootstrap from bounded prior conversation state.

## 2026.03.17.23
- Released at: 2026-03-17T23:48:58Z
- Release id: 20260317T234858Z-e58cfe8
- Previous version: 2026.03.17.22
- Trigger: managed service redeploy

## 2026.03.17.22
- Released at: 2026-03-17T21:39:59Z
- Release id: 20260317T213959Z-13799fb
- Previous version: 2026.03.17.21
- Trigger: managed service redeploy

## 2026.03.17.21
- Released at: 2026-03-17T21:39:11Z
- Release id: 20260317T213911Z-523e3ea
- Previous version: 2026.03.17.20
- Trigger: managed service redeploy

## 2026.03.17.20
- Released at: 2026-03-17T21:30:13Z
- Release id: 20260317T213013Z-3657551
- Previous version: 2026.03.17.19
- Trigger: managed service redeploy

## 2026.03.17.19
- Released at: 2026-03-17T21:28:58Z
- Release id: 20260317T212858Z-daeb54f
- Previous version: 2026.03.17.18
- Trigger: managed service redeploy

## 2026.03.17.18
- Released at: 2026-03-17T21:28:12Z
- Release id: 20260317T212812Z-5a1026c
- Previous version: 2026.03.17.17
- Trigger: managed service redeploy

## 2026.03.17.17
- Released at: 2026-03-17T21:18:06Z
- Release id: 20260317T211806Z-7404388
- Previous version: 2026.03.17.16
- Trigger: managed service redeploy

## 2026.03.17.16
- Released at: 2026-03-17T21:10:10Z
- Release id: 20260317T211010Z-d58cccf
- Previous version: 2026.03.17.15
- Trigger: managed service redeploy

## 2026.03.17.15
- Released at: 2026-03-17T21:06:25Z
- Release id: 20260317T210625Z-ce8b257
- Previous version: 2026.03.17.14
- Trigger: managed service redeploy

## 2026.03.17.14
- Released at: 2026-03-17T20:52:13Z
- Release id: 20260317T205213Z-d00d45b
- Previous version: 2026.03.17.13
- Trigger: managed service redeploy

## 2026.03.17.13
- Released at: 2026-03-17T19:18:20Z
- Release id: 20260317T191820Z-b2d782d
- Previous version: 2026.03.17.12
- Trigger: managed service redeploy

## 2026.03.17.12
- Released at: 2026-03-17T19:07:25Z
- Release id: 20260317T190725Z-6149c26
- Previous version: 2026.03.17.11
- Trigger: managed service redeploy

## 2026.03.17.11
- Released at: 2026-03-17T19:05:56Z
- Release id: 20260317T190556Z-81d154d
- Previous version: 2026.03.17.10
- Trigger: managed service redeploy

## 2026.03.17.10
- Released at: 2026-03-17T19:03:55Z
- Release id: 20260317T190355Z-35c12ee
- Previous version: 2026.03.17.9
- Trigger: managed service redeploy

## 2026.03.17.9
- Released at: 2026-03-17T19:02:26Z
- Release id: 20260317T190226Z-fb08f75
- Previous version: 2026.03.17.8
- Trigger: managed service redeploy

## 2026.03.17.8
- Released at: 2026-03-17T18:53:26Z
- Release id: 20260317T185326Z-49edfd8
- Previous version: 2026.03.17.7
- Trigger: managed service redeploy

## 2026.03.17.7
- Released at: 2026-03-17T18:46:37Z
- Release id: 20260317T184637Z-45bbc5c
- Previous version: 2026.03.17.6
- Trigger: managed service redeploy

## 2026.03.17.6
- Released at: 2026-03-17T18:29:09Z
- Release id: 20260317T182909Z-c1b6791
- Previous version: 2026.03.17.5
- Trigger: managed service redeploy

## 2026.03.17.5
- Released at: 2026-03-17T18:23:54Z
- Release id: 20260317T182354Z-2724161
- Previous version: 2026.03.17.4
- Trigger: managed service redeploy

## 2026.03.17.4
- Released at: 2026-03-17T18:18:58Z
- Release id: 20260317T181858Z-9f84e77
- Previous version: 2026.03.17.3
- Trigger: managed service redeploy

## 2026.03.17.3
- Released at: 2026-03-17T17:04:14Z
- Release id: 20260317T170414Z-3f3013c
- Previous version: 2026.03.17.2
- Trigger: managed service redeploy

## 2026.03.17.2
- Released at: 2026-03-17T15:07:09Z
- Release id: 20260317T150709Z-42abbe4
- Previous version: 2026.03.17
- Trigger: managed service redeploy

## 2026.03.17
- Released at: 2026-03-17T02:35:26Z
- Release id: 20260317T023526Z-81fda60
- Previous version: 2026.03.16.14
- Trigger: managed service redeploy

## 2026.03.16.14
- Released at: 2026-03-16T22:52:04Z
- Release id: 20260316T225204Z-430e66d
- Previous version: 2026.03.16.13
- Trigger: managed service redeploy

## 2026.03.16.13
- Released at: 2026-03-16T21:59:48Z
- Release id: 20260316T215948Z-6361862
- Previous version: 2026.03.16.12
- Trigger: managed service redeploy

## 2026.03.16.12
- Released at: 2026-03-16T19:26:32Z
- Release id: 20260316T192632Z-737bb05
- Previous version: 2026.03.16.11
- Trigger: managed service redeploy

## 2026.03.16.11
- Released at: 2026-03-16T19:17:21Z
- Release id: 20260316T191721Z-aee4240
- Previous version: 2026.03.16.10
- Trigger: managed service redeploy

## 2026.03.16.10
- Released at: 2026-03-16T19:16:27Z
- Release id: 20260316T191627Z-f398ea9
- Previous version: 2026.03.16.9
- Trigger: managed service redeploy

## 2026.03.16.9
- Released at: 2026-03-16T18:05:47Z
- Release id: 20260316T180547Z-f2cc6a2
- Previous version: 2026.03.16.8
- Trigger: managed service redeploy

## 2026.03.16.8
- Released at: 2026-03-16T18:05:12Z
- Release id: 20260316T180512Z-19de65d
- Previous version: 2026.03.16.7
- Trigger: managed service redeploy

## 2026.03.16.7
- Released at: 2026-03-16T18:00:12Z
- Release id: 20260316T180012Z-e0ff702
- Previous version: 2026.03.16.6
- Trigger: managed service redeploy

## 2026.03.16.6
- Released at: 2026-03-16T17:48:52Z
- Release id: 20260316T174852Z-bc633e9
- Previous version: 2026.03.16.5
- Trigger: managed service redeploy

## 2026.03.16.5
- Released at: 2026-03-16T17:44:00Z
- Release id: 20260316T174400Z-620f744
- Previous version: 2026.03.16.4
- Trigger: managed service redeploy

## 2026.03.16.4
- Released at: 2026-03-16T17:04:26Z
- Release id: 20260316T170426Z-38c229c
- Previous version: 2026.03.16.3
- Trigger: managed service redeploy

## 2026.03.16.3
- Released at: 2026-03-16T16:44:24Z
- Release id: 20260316T164424Z-a4737f4
- Previous version: 2026.03.16.2
- Trigger: managed service redeploy

## 2026.03.16.2
- Released at: 2026-03-16T15:48:00Z
- Release id: 20260316T154800Z-1098649
- Previous version: 2026.03.16
- Trigger: managed service redeploy

## 2026.03.16
- Released at: 2026-03-16T15:46:56Z
- Release id: 20260316T154656Z-e87e01d
- Previous version: 2026.03.15
- Trigger: managed service redeploy

## 2026.03.15
- Released at: 2026-03-15T23:04:50Z
- Release id: 20260315T230450Z-7b82490
- Previous version: none
- Trigger: managed service redeploy
