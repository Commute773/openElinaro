# openelinaro

Bun + TypeScript agent platform with Discord as the primary surface.
This README stays as a quick operator-side overview of the current runtime.

- `src/index.ts` starts the Discord surface plus the local HTTP webhook listener.
- `src/demo.ts` demonstrates the app runtime without Discord.
- `src/app/runtime.ts` owns the foreground chat lane and background subagent lane.
- `src/app/runtime-scope.ts` and `src/app/runtime-automation.ts` cover runtime scope setup and automation logic.
- `src/app/runtime-subagent.ts` manages background subagent lifecycle: launching, resuming, steering, cancelling, and timeout recovery.
- `src/subagent/` contains the tmux-based subagent infrastructure: `sidecar.ts` (Unix socket event receiver), `tmux.ts` (session/window management), `spawn.ts` (command builders for Claude and Codex), `registry.ts` (JSON-persisted run state), `timeout.ts` (timeout manager with grace period), and `events.ts` (event normalization).
- `src/integrations/discord/bot.ts` exposes the app over Discord.
- `src/integrations/http/server.ts` exposes local machine-to-machine webhook ingress for Vonage voice/messages.
- `src/services/routines-service.ts` is the native routines engine for todos, meds, deadlines, reminders, and completion state.
- `src/services/projects-service.ts` loads the live project registry from `~/.openelinaro/projects/` and seeds it from the committed starter registry under `projects/` on first run.
- `profiles/registry.json` is the committed starter profile registry; the live runtime copy is `~/.openelinaro/profiles/registry.json`.
- `src/tools/tool-registry.ts` defines the shared backend tool catalog plus the separate user-facing and agent-default-visible tool subsets; domain-specific tool builders live in `src/tools/groups/` (routine, finance, health, communication, project, filesystem, shell, memory, and system tool groups).
- `src/connectors/active-model-connector.ts` routes chat requests through whichever model is currently active.
- `src/services/model-service.ts` discovers provider models from live provider endpoints, persists the active model, and inspects context-window usage.
- `src/services/system-prompt-service.ts` compiles universal platform prompts from `system_prompt/universal/`, operator-managed agent prompts from `~/.openelinaro/system_prompt/`, and in-code defaults for fresh installs into the per-thread system-prompt snapshot.
- `src/integrations/discord/auth-session-manager.ts` handles Codex OAuth and Claude setup-token flows in DMs.
- `src/auth/store.ts` persists provider auth in the unified secret store under `~/.openelinaro/`, scoped by profile.

## Commands

```bash
bun install
bun run setup
bun run setup:python
bun run start
bun run demo
bun run check
bun test
bun run test:openbrowser:e2e
bun run service:healthcheck
bun run service:install
sudo ./scripts/install-linux.sh
```

Versioning is automatic: merging a PR to `main` triggers CI to create a tagged version. Deploy explicitly via the `update` tool.

## Discord commands

- `/hello`
- `/auth provider:status`
- `/auth provider:codex`
- `/auth provider:claude`
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
Tools without a custom Discord handler are auto-registered as slash commands using the backend tool name, each with an optional `input` JSON string.

## Communications

- The runtime has a first-class communications subsystem for Vonage phone calls and text messaging.
- Local communications state lives under `~/.openelinaro/communications/store.json`.
- The Bun HTTP listener exposes these default webhook paths:
  - `GET /webhooks/vonage/voice/answer`
  - `GET /webhooks/vonage/voice/event`
  - `GET /webhooks/vonage/voice/fallback`
  - `POST /webhooks/vonage/messages/inbound`
  - `POST /webhooks/vonage/messages/status`
- Use the root-only tools `communications_status`, `call_create`, `call_list`, `call_get`, `call_control`, `message_send`, `message_list`, and `message_get`.

## Routines

The app treats routines as a first-class subsystem rather than scattered chat state.

- One item model covers todos, recurring routines, habits, meds, deadlines, and precommitments.
- Runtime state such as streaks, completion history, snoozes, skips, pause/resume, and reminder counts is stored in `~/.openelinaro/routines.json`.
- The Discord bot records the active user as the notification target and sends a proactive DM on the hour when the routines engine decides something is worth surfacing.
- Use `context` or the relevant subsystem tools to inspect live routines, finance, health, and project state on demand.

## Background subagents

- Background subagents are real CLI processes (Claude Code or Codex) running in tmux windows with native hook-based completion tracking via a local Unix socket sidecar.
- Subagent runs are persisted under `~/.openelinaro/subagent-runs.json`, so status survives process restarts.
- Each subagent gets an isolated git worktree to avoid conflicts with the parent workspace.
- The sidecar listens on `~/.openelinaro/subagent-sidecar.sock` and receives completion/progress events from Claude hooks or Codex notify scripts.
- Subagents have configurable wall-clock timeouts (default 1 hour) with a 30-second grace period before force-kill.
- Completed or failed subagent runs inject a completion message back into the originating conversation so the foreground agent can see what happened on the next turn.
- Use `launch_agent`, `resume_agent`, `steer_agent`, `cancel_agent`, and `agent_status` tools to manage background work.
- Multi-provider support: profiles can declare multiple subagent providers (e.g. Claude for reasoning, Codex for coding) with descriptions to help the agent choose.

## System prompt

- New conversations snapshot the concatenated contents of universal platform prompts (`system_prompt/universal/*.md`) plus operator-managed agent prompts (`~/.openelinaro/system_prompt/*.md`) as their base system prompt. Universal prompts cannot be overridden; operator prompts are additive.
- Existing conversations keep that snapshot until `reload` is called.
- The final prompt sent to the model is capped at 100,000 characters.
- Deeper platform guidance lives under `docs/assistant/`, while user-specific docs and injected assistant context live under `~/.openelinaro/docs/assistant/` and `~/.openelinaro/assistant_context/`.

## Projects

- `~/.openelinaro/projects/registry.json` is the live inventory SSOT for known projects.
- The committed `projects/registry.json` is only a starter template; live project state belongs under `~/.openelinaro/projects/`.
- Projects can declare `allowedRoles` and `workspaceOverrides` keyed by profile id.
- Each project keeps `README.md` under `~/.openelinaro/projects/<id>/`.

## Profiles

- The app launches with the active profile from `~/.openelinaro/config.yaml` at `core.profile.activeProfileId`, defaulting to `root`.
- A profile contains roles, auth state, memory namespace, preferred model defaults, and optional subagent provider paths with descriptions.
- `root` means unrestricted access and bypasses project, memory, and subagent role checks.
- SSH-backed profiles keep their private/public keypair in `~/.openelinaro/secret-store.json`.
- Subagents may launch only profiles whose roles are a subset of the caller's roles, unless the caller is `root`.

## Logging

- Structured JSONL logs are written to `~/.openelinaro/logs/app.jsonl`.
- Records include severity, attributes, trace/span ids, duration fields, and the stamped deploy version in an OTEL-style shape.
- Managed-service stdout/stderr are written to `~/.openelinaro/logs/service.stdout.log` and `~/.openelinaro/logs/service.stderr.log`.

## Deployment

- Versioning is handled by CI on merge to `main`. Do not run version preparation manually.
- `bun run service:install` installs or updates the platform backend: a submitted `launchd` job on macOS or a system `systemd` service on Linux.
- Deploy explicitly via the `update` tool or `/update confirm:true` in Discord.
- `update_preview` fast-forwards the source workspace without deploying and summarizes pending deployment entries.
- Managed-service rollback is an agent-only path via the root-only `service_rollback` tool.
- For a fresh Linux host, run `sudo ./scripts/install-linux.sh`.
