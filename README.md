# openelinaro

Bun + TypeScript scaffold for an OpenClaw-style multi-agent app.
This README stays as a quick operator-oriented overview of the current runtime.

The current repo state is intentionally minimal:

- `src/index.ts` starts the Discord surface plus the local HTTP webhook listener.
- `src/demo.ts` demonstrates the app runtime without Discord.
- `src/app/runtime.ts` owns the fast foreground lane and background workflow lane.
- `src/orchestration/app-graph.ts` routes user requests into immediate chat/todo/medication handling or async workflow handoff.
- `src/orchestration/workflow-graph.ts` runs queued task plans through LangGraph.
- `src/services/workflow-registry.ts` keeps in-memory workflow status.
- `src/integrations/discord/bot.ts` exposes the app over Discord.
- `src/integrations/http/server.ts` exposes local machine-to-machine webhook ingress for Vonage voice/messages.
- `src/services/routines-service.ts` is the native routines engine for todos, meds, deadlines, reminders, and completion state.
- `src/services/projects-service.ts` loads the live project registry from `~/.openelinaro/projects/` and seeds it from the committed starter registry under `projects/` on first run.
- `profiles/registry.json` is the committed starter profile registry; the live runtime copy is `~/.openelinaro/profiles/registry.json`.
- `src/tools/routine-tool-registry.ts` defines the shared backend tool catalog plus the separate user-facing and agent-default-visible tool subsets used by the runtime.
- `src/connectors/active-model-connector.ts` routes chat requests through whichever model is currently active.
- `src/services/model-service.ts` discovers provider models from live provider endpoints, persists the active model, and inspects context-window usage.
- `src/services/system-prompt-service.ts` compiles shared `system_prompt/*.md` plus user-managed `~/.openelinaro/system_prompt/*.md` into the per-thread system-prompt snapshot.
- `src/integrations/discord/auth-session-manager.ts` handles Codex OAuth and Claude setup-token flows in DMs.
- `src/auth/store.ts` persists provider auth in the unified secret store under `~/.openelinaro/`, scoped by profile.
- `src/domain/task-plan.ts` defines task-planning primitives.
- `docs/research/openclaw-auth-and-frameworks.md` captures the authentication and framework research from this pass.

## Commands

```bash
bun install
bun run setup
bun run setup:python
bun run start
bun run demo
bun run check
bun run test
bun run test:openbrowser:e2e
bun run benchmark:swebench:verified:difficulty
bun run service:healthcheck
bun run service:install
bun run service:prepare-update
sudo ./scripts/install-linux.sh
```

## Discord commands

- `/hello`
- `/auth provider:status`
- `/auth provider:codex`
- `/auth provider:claude`
- `/workflow action:demo`
- `/workflow action:status run_id:<id>`
- `/new`
- `/fnew`
- `/update`
- `/think input:{"level":"medium"}`
- `/extended_context input:{"enabled":true}`
- `/routine add ...`
- `/routine list`
- `/routine check`
- `/routine done id:<id>`
- `/routine undo id:<id>`
- `/routine snooze id:<id> minutes:<n>`
- `/routine skip id:<id>`
- `/routine pause id:<id>`
- `/routine resume id:<id>`
- `/todo text:...`
- `/med text:...`
- `/chat text:...`

Run `bun run setup` first. That writes `~/.openelinaro/config.yaml` and stores the Discord bot token in `~/.openelinaro/secret-store.json`.
Run auth flows in Discord DMs so provider auth stays out of channels.
Optional features are now top-level config blocks in `~/.openelinaro/config.yaml`; their tools only load when the feature is enabled and fully configured.
Use `feature_manage` from the agent to inspect, enable, or update feature config and optionally restart the managed service.
Tools without a custom Discord handler are now auto-registered as their own slash commands using the backend tool name, each with an optional `input` JSON string.

## Communications

- The runtime now has a first-class communications subsystem for Vonage phone calls and text messaging.
- Local communications state lives under `~/.openelinaro/communications/store.json`.
- The Bun HTTP listener exposes these default webhook paths:
  - `GET /webhooks/vonage/voice/answer`
  - `GET /webhooks/vonage/voice/event`
  - `GET /webhooks/vonage/voice/fallback`
  - `POST /webhooks/vonage/messages/inbound`
  - `POST /webhooks/vonage/messages/status`
- Use the root-only tools `communications_status`, `call_create`, `call_list`, `call_get`, `call_control`, `message_send`, `message_list`, and `message_get`.
- The default Vonage secret refs are `vonage.private_key` for outbound API auth and `vonage.signature_secret` for signed webhook verification.
- The main config values live in `~/.openelinaro/config.yaml` under `core.http`, `communications.publicBaseUrl`, and `communications.vonage`.

## Routines

The app now treats routines as a first-class subsystem rather than scattered chat state.

- One item model covers todos, recurring routines, habits, meds, deadlines, and precommitments.
- Runtime state such as streaks, completion history, snoozes, skips, pause/resume, and reminder counts is stored in `~/.openelinaro/routines.json`.
- The Discord bot records the active user as the notification target and sends a proactive DM on the hour when the routines engine decides something is worth surfacing.
- Frequently changing runtime state is not auto-injected into the chat prompt. Use `context` or the relevant subsystem tools to inspect live routines, finance, health, and project state on demand.
- Finance runtime paths and seeded defaults now live in `~/.openelinaro/config.yaml` under `finance.*`, including the local database path and forecast template path.
- The backend keeps three tool layers distinct: the full searchable catalog, the smaller agent default-visible bundle for each runtime scope, and the user-facing Discord command subset.
- Every tool now has an explicit auth declaration. Some are `root`-only, while others are `anyone` but behave differently under restricted profiles by filtering projects, memory, visible tools, or filesystem paths.
- The shared backend tool set now includes `project_list` and `project_get` for listing known projects and inspecting one project's current state, workspace path, README path, and embedded long-form registry context.
- The shared tool set now includes `exec_command`, which runs commands in the configured shell, using `bash -lc` by default locally or the profile's SSH-backed execution target remotely, supports passwordless sudo when `sudo=true`, and can launch long-running commands in the background with `background=true`.
- The shared tool set also includes `exec_status` and `exec_output`, which let the agent inspect background shell jobs, read the current tail, and page through more output by line range.
- The shared tool set also includes `service_version`, which reports the stamped deploy version and current release metadata for the running runtime.
- The shared tool set also includes `service_changelog_since_version`, which reads `DEPLOYMENTS.md` and shows deployments whose version is numerically newer than a requested version. Versions use `YYYY.MM.DD` or `YYYY.MM.DD.N`, and the `.N` sequence resets each UTC day.
- The shared tool set also includes `openbrowser`, which runs local OpenBrowser automation for navigation, JavaScript evaluation, screenshots, and coordinate-based mouse movement or clicks.
- On Darwin, the shared tool set also includes `media_list`, `media_list_speakers`, `media_play`, `media_pause`, `media_stop`, `media_set_volume`, and `media_status` for tagged local playback. Linux does not expose the media subsystem.
- The shared tool set also includes `model`, `think`, `extended_context`, `model_list_provider_models`, `model_select_active`, and `context` so chat/runtime model choice, reasoning effort, extended-context budgeting, and live context-window inspection are no longer hardcoded.
- For `openai-codex/gpt-5.4`, `extended_context` keeps the configured window at 272,000 tokens when disabled and 1,050,000 tokens when enabled.
- Chat-turn usage records now track prompt-cache reuse and emit a warning when an ongoing conversation incurs a large cache miss; Discord forwards that warning to the active notification target in addition to logging it locally.
- The shared tool set also includes `reload`, which refreshes the active conversation's system-prompt snapshot from shared `system_prompt/*.md` plus user-managed `~/.openelinaro/system_prompt/*.md`.
- The shared tool set also includes `new`, which flushes durable memory from the active conversation and starts a fresh conversation with no prior messages while preserving the existing system-prompt snapshot.
- The shared tool set also includes `fnew`, which starts a fresh conversation immediately but skips compaction and any durable-memory writeback from the prior thread while preserving the existing system-prompt snapshot.
- The shared tool set also includes `benchmark`, which runs a live TTFT/TPS check on the active chat model plus an items-per-second check on the local memory embedding model.
- The shared tool set also includes the root-only `update_preview`, `update`, `service_healthcheck`, and `service_rollback` operations for repo sync and managed-service control from the agent itself.
- The Discord `/update` command is custom and now runs `git pull --ff-only` in the source workspace immediately, then summarizes deployment entries newer than the current runtime version.
- `update_preview` runs a `git pull --ff-only --dry-run` preview against the source workspace.
- `service_rollback` still uses the managed-service rollback helpers when invoked from inside the live service process.
- The shared tool set also includes `launch_coding_agent`, which lets the foreground conversation agent enqueue a goal-driven background coding worker built in LangGraph.
- The shared tool set also includes `resume_coding_agent`, which lets the foreground conversation agent send follow-up instructions back to a returned coding run on the same run id.
- The shared tool set also includes `workflow_status`, which reports the latest background workflow and coding-agent run state, task completion, and summaries.
- Background `exec_command` launches persist their logs under `~/.openelinaro/shell-tasks/<job-id>/`, and completed jobs queue a completion notification back into the originating conversation so the next agent turn can react to the tail output.
- Legacy routine imports are explicit through `routine_import_legacy`, which imports a caller-provided JSON file into `~/.openelinaro/routines.json`.
- Memory imports are explicit through `memory_import`, which copies markdown from a caller-provided directory into `~/.openelinaro/memory/documents/`.
- `memory_search` and `memory_reindex` operate only on local memory data stored under `~/.openelinaro/memory/`, using a local `Xenova/all-MiniLM-L6-v2` embedding model plus BM25 hybrid ranking.
- Memory is profile-segmented. `root` can read all namespaces; restricted profiles can only read memory under their allowed namespaces and write under their own namespace roots inside `~/.openelinaro/memory/documents/`.
- Chat sessions compact automatically when projected context usage reaches 80% of the active model window. During compaction, incoming chat messages are queued, Discord DMs receive `message queued as we are currently compacting`, durable memory extracted from the compaction pass is written to dated markdown files under `~/.openelinaro/memory/documents/compactions/`, and the conversation keeps its existing system-prompt snapshot unless `reload` is called explicitly.
- All tool results are capped at 10,000 characters before they are fed back to the agent; truncated results include an explicit truncation notice with the original length.

## OpenBrowser runtime

- `core.python` in `~/.openelinaro/config.yaml` defines the one shared venv used by every Python-backed feature.
- Run `bun run setup:python` once to create or refresh that venv and install the consolidated Python dependency set.
- The `openbrowser` tool shells out to `scripts/openbrowser_runner.py`, which uses the shared Python runtime and now supports both one-shot runs and persistent per-conversation sessions.
- Override `openbrowser.runnerScript` in `~/.openelinaro/config.yaml` if you need a custom runner implementation.
- In an active chat thread, `openbrowser` reuses the same live browser session by default, so later calls continue on the current page/tab unless that call sets `resetSession: true`.
- Browser sessions also reuse a profile-scoped Chromium user-data directory at `~/.openelinaro/openbrowser/profiles/<profile-id>/user-data`, so cookies and local browser auth can persist across process restarts for each openElinaro profile.
- Use the `type` action for text entry when you need to insert a whole string into the currently focused field; it writes one post-action screenshot instead of one screenshot per character.
- For browser secrets, use `secret_list` to inspect available secret names and field names, then pass refs such as `{ "secretRef": "prepaid_card.number" }` in `openbrowser` action args so the runtime resolves them server-side without returning raw values.
- OpenBrowser failures now carry structured details such as the failing action index/type, current page title/url, and failure screenshot path so the agent can branch on browser-state errors instead of treating them as opaque text.
- For manual login bootstrap, run `openbrowser` with `headless: false` and a long `wait` action, complete the login in the visible browser window, then let the run exit normally so Chromium state is written back into that profile directory.
- Install or refresh that shared runtime with:

```bash
bun run setup:python
```

## Background coding agents

- Background coding runs are persisted under `~/.openelinaro/workflows.json`, so status survives process restarts even though in-flight LangGraph execution is not yet resumable.
- A coding run follows `plan -> task execution -> verification -> finalize`, with a planner subagent and task-focused coding workers that operate through the existing repo/file/shell tools.
- Task-level execution and verification errors are recorded on the run and surfaced back to the parent thread; the subagent only terminates on timeouts or after hitting the consecutive task error threshold.
- Completed coding runs write a summary back into the originating conversation history so the foreground agent can see what happened on the next turn.

## System prompt

- New conversations snapshot the concatenated contents of shared `system_prompt/*.md` plus user-managed `~/.openelinaro/system_prompt/*.md` as their base system prompt.
- Existing conversations keep that snapshot until `reload` is called, so prompt-file edits do not automatically churn active-thread cache state.
- The final prompt sent to the model is capped at 100,000 characters; Discord chat emits a warning if truncation happened.
- Deeper platform guidance lives under `docs/assistant/`, while user-specific docs and injected assistant context live under `~/.openelinaro/docs/assistant/` and `~/.openelinaro/assistant_context/`.

## Projects

- `~/.openelinaro/projects/registry.json` is the live inventory SSOT for known projects.
- The committed `projects/registry.json` is only a starter template; live project state belongs under `~/.openelinaro/projects/`.
- Projects can declare `allowedRoles`. `root` bypasses these checks; non-root profiles only see projects whose `allowedRoles` intersect their roles.
- Projects can also declare `workspaceOverrides`, keyed by profile id, when one profile needs a different real workspace root than the default `workspacePath`.
- Each project keeps `README.md` under `~/.openelinaro/projects/<id>/`; long-form state, future, and milestone context now live in `~/.openelinaro/projects/registry.json`, and structured project tasks live in `~/.openelinaro/routines.json`.
- The registry's `workspacePath` points at the real external project workspace when that project lives outside this repo.

## Profiles

- The app launches with the active profile from `~/.openelinaro/config.yaml` at `core.profile.activeProfileId`, defaulting to `root`.
- A profile contains roles, auth state, memory namespace, preferred model defaults, and optional subagent-only model defaults for background coding runs.
- Profiles may also define `pathRoots` plus an `execution` block for SSH-backed shell and filesystem access.
- The committed `profiles/registry.json` is only a starter template; live profile state belongs under `~/.openelinaro/profiles/`.
- `root` means unrestricted access and bypasses project, memory, and subagent role checks.
- Restricted profiles are optional and should be created in live config only when you need role-scoped access.
- SSH-backed profiles keep their private/public keypair in `~/.openelinaro/secret-store.json`; the runtime materializes temporary key files under `~/.openelinaro/runtime-ssh-keys/<id>/` when `ssh` or `git` needs a file path, and file-tool authorization is enforced against the remote `pathRoots` plus any matching project `workspaceOverrides`.
- Subagents may launch only profiles whose roles are a subset of the caller's roles, unless the caller is `root`.

## Logging

- Structured JSONL logs are written to `~/.openelinaro/logs/app.jsonl`.
- Records include severity, attributes, trace/span ids, duration fields, and the stamped deploy version in an OTEL-style shape for request and tool timing.
- Console verbosity is controlled by the service environment; runtime feature settings now live in `~/.openelinaro/config.yaml`.
- Cache-miss alert thresholds live in `~/.openelinaro/config.yaml` under `core.app.cacheMissMonitor`.
- Managed-service stdout/stderr are written to `~/.openelinaro/logs/service.stdout.log` and `~/.openelinaro/logs/service.stderr.log`.

## Deployment

- `bun run service:install` installs or updates the current platform backend: a submitted `launchd` job in the active macOS user session or a system `systemd` service on Linux.
- `bun run service:healthcheck` sends a simulated local message to the live main agent that says `this is a healthcheck, reply with HEALTHCHECK_OK to confirm you are up and active` and waits up to 60 seconds for `HEALTHCHECK_OK`.
- `bun run service:prepare-update` runs `bun run check`, requires a non-empty human-written change block via `--changes`, `--changes-file`, `OPENELINARO_DEPLOY_CHANGES`, or piped stdin, requires the current branch to track an upstream, then computes the next deploy version in `yyyy.mm.dd` or `yyyy.mm.dd.n` form, writes `VERSION.json` plus `DEPLOYMENTS.md` into the source workspace, commits the current code plus metadata as `update: <version>`, and pushes that branch upstream.
- Managed-service rollback is still an agent-only path. Use the root-only `service_rollback` tool instead of invoking transition scripts manually.
- `/update` now syncs the source checkout with `git pull --ff-only`; code changes still do not auto-deploy.
- The agent-facing service tools use detached helper jobs when they are invoked from inside the live managed service, so the current bot process can hand the work off to the service manager instead of terminating itself mid-command. On macOS those helpers are one-shot launchd agents so the transition runs exactly once per request.
- The managed service sets `OPENELINARO_ROOT_DIR` for code/assets and `OPENELINARO_USER_DATA_DIR` for runtime state, so the service does not depend on the caller's current working directory.
- Release snapshots copy code and shared prompt assets, inject the stamped deploy metadata, and read shared mutable state from `~/.openelinaro/` via environment so rollback restores the prior code without discarding local state.
- For a fresh Linux host, run `sudo ./scripts/install-linux.sh`. It installs base dependencies, stages the app into `/opt/openelinaro/app`, installs `openelinaro.service`, and then you finish runtime bootstrap with `bun run setup`.

## Reference material

- Local OpenClaw clone: `references/openclaw` (gitignored)
- SWE-bench main repo: `references/swe-bench`
- SWE-bench leaderboard artifacts: `references/swe-bench-experiments`
- Research note: `docs/research/openclaw-auth-and-frameworks.md`
- Research note: `docs/research/swebench-difficulty-analysis.md`
