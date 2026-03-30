# Tool Use Playbook

Use this playbook when the right tool is not already visible or when a task needs many tool calls.

## Load Libraries

Default rule:

- Treat tool visibility as three layers: user-facing commands, the agent's default-visible bundle for the current scope, and the larger latent library catalog.
- Treat the main agent and coding subagents as different scopes: the main agent keeps a broader default bundle, while coding subagents start narrower and are expected to use `load_tool_library` when they need web, service, browser, or other non-core tool families.
- Use the currently visible tools first. If the exact tool is not already visible, call `load_tool_library` before guessing.
- Ask for the capability you want, not the tool name you hope exists.
- `load_tool_library` lists the available libraries and activates one exact library id at a time.
- Load the smallest relevant library, then use those tools directly.
- For runtime settings under `~/.openelinaro/config.yaml`, prefer `config_edit` or `feature_manage` over shell-editing the file by hand.
- Discord `/update` fast-forwards the source checkout, reports the deployed version, pulled source version, and latest remote tag separately, and includes pending deployment notes when the service is behind. `confirm:true` is the actual deploy step, and it now short-circuits with a clear "nothing to deploy" message when the pulled source already matches the deployed service.
- Managed-service installs now export their configured service identity into the runtime environment so detached `/update confirm:true` helpers can reinstall the service with the same user, group, and unit metadata.
- Detached `/update confirm:true` helpers also inherit the live release root from the running service so rollback and release-state updates stay aligned even if `current-release.txt` was stale.

Common library loads:

- `planning`
- `filesystem_read`
- `filesystem_write`
- `web_research`
- `browser_automation`
- `service_ops`

Avoid:

- Guessing tool names from memory
- Calling shell commands when a dedicated tool probably exists
- Loading too many tools for a narrow task

## Stored Tool Results

- Normal tool outputs are now stored out of band and replayed into the model context as compact refs instead of full raw payloads.
- When you see a header like `[tool_result_ref ...]`, use `tool_result_read` if you actually need the original output again. Only a small set of high-volume tools spill to refs; compact structured tools should normally stay inline.
- Prefer staying on the compact ref when the metadata is enough. Reopen the stored output only when the exact text matters for the next step.
- `tool_result_read` supports three modes: `partial` for a bounded line slice, `full` for the stored payload, and `summary` for a summarizer-backed extraction over up to 10k chars of the stored content.
- In `summary` mode, pass a `goal` that says what information you need. Prefer `summary` over `full` when you only need targeted facts, a verdict, or a compact recap from a large ref.
- `tool_result_read` is the escape hatch for raw content, so repeated large reads should go through it instead of forcing every past tool result to stay in context.

## Web Ladder

Load the `web_research` library first, then use the least heavy web tool that fits:

- `web_search` for discovery and current-source lookup (requires `webSearch` feature enabled)
- `web_fetch` for reading a known URL as Crawl4AI-extracted markdown/text/html (requires `webFetch` feature enabled)
- `openbrowser` only for interactive steps, JS-heavy pages, screenshots, or coordinate/browser actions

If `web_search` finds the page and you only need the readable content, go to `web_fetch` before reaching for `openbrowser`.
If a tool is missing from the library, the corresponding feature is not enabled or configured.

## Browser Secrets

- For browser automation that needs payment cards, logins, or other operator-approved secrets, use `secret_list` to inspect available secret names and field names only.
- Add or rotate secrets with `secret_import_file` or `bun src/cli/secrets.ts`; do not paste raw secret values into chat.
- For interactive card entry from a terminal, prefer `bun run secret:import-card`, which prompts for legal name, card data, and billing address, normalizes duplicated street numbers, and imports through a temp file that is deleted on exit.
- For agent-managed login credentials, prefer `secret_generate_password`; it creates the password server-side and stores it without returning the raw password to chat.
- When calling `openbrowser`, pass secret refs like `{ "secretRef": "prepaid_card.number" }` inside action arguments so the runtime resolves them server-side.
- In a normal chat thread, `openbrowser` now reuses the same live browser session automatically. If you need a clean browser, set `resetSession: true` on that call.
- Occasionally confirm page state visually with `openbrowser` screenshots instead of relying only on DOM assumptions, especially around navigation, forms, and ambiguous UI state.
- For interactive form entry, aggressively prefer `mouse_click` on the intended coordinates plus the `type` action. Treat `evaluate` helpers that call `element.click()`, `form.submit()`, `element.value = ...`, or similar DOM mutation as fallback-only tactics when normal interaction fails.
- Prefer the `type` action over long `press` sequences when you need to enter real text into the currently focused field; it inserts the whole string and only emits one screenshot for that action.
- Do not infer that inputs are empty from `document.body.innerText`; input values are often omitted there. Check `input.value` explicitly or confirm with screenshots.
- `openbrowser` tool-use progress now prints each action in a readable list instead of collapsing nested action objects into `{n keys}` summaries.
- Each `openbrowser` step now writes a screenshot artifact for operator progress updates; Discord progress messages can attach those step images without sending them back into the agent context.
- When `openbrowser` fails, inspect the structured tool error details before retrying. They can include the failing action index/type, current page title/url, and failure screenshot path, which is usually enough to detect page-shape changes or unexpected navigation.
- Do not go looking for secret values with docs reads or web tools. The intended flow is `secret_list` -> secret refs in `openbrowser`.
- For DOM-fill JavaScript in `evaluate`, set `captureResult: false` unless you specifically need the return value in the tool result.

Example:

```json
{
  "actions": [
    {
      "type": "evaluate",
      "expression": "(card) => { fillCheckout(card); return null; }",
      "args": [
        {
          "number": { "secretRef": "prepaid_card.number" },
          "expMonth": { "secretRef": "prepaid_card.expMonth" },
          "expYear": { "secretRef": "prepaid_card.expYear" },
          "cvc": { "secretRef": "prepaid_card.cvc" }
        }
      ],
      "captureResult": false
    }
  ]
}
```

## Background Agent Checks

- Chat-launched coding subagents send a completion update back into the parent conversation automatically.
- Use `agent_status` for occasional manual spot checks or when you think a completion update was missed.
- `agent_status` includes elapsed runtime so you can tell whether a run is actually making progress or just sitting long-running.
- Do not poll `agent_status` every few seconds while waiting; that wastes context and tool budget without adding signal.
- If an in-flight coding run needs new instructions, use `steer_agent` instead of waiting for it to finish and then resuming.
- If a running coding run needs to stop, use `cancel_agent`.
- If you need to investigate slowness, pair `agent_status` with `telemetry_query` against workflow spans and events instead of guessing from chat timing alone.
- Use `usage_summary` when you need provider-reported token spend and USD cost for the active conversation or the current local day, instead of inferring pricing from raw token counts.

## Service Version Checks

- Use `service_version` when you need the running agent's stamped deploy version or release metadata.
- Prefer `service_version` over guessing from git state when the managed service may be running from a staged release snapshot.
- Use `exec_command` for git operations when shell access is appropriate instead of expecting dedicated git wrapper tools.
- Use `service_changelog_since_version` when you need the deployment entries whose version is numerically greater than a requested version instead of reading all of `DEPLOYMENTS.md`.
- Deployment versions are `YYYY.MM.DD` or `YYYY.MM.DD.N`; the `.N` sequence resets each UTC day, so compare the full version rather than only the numeric suffix.
- Deploys are explicit. Do not assume code changes should redeploy the service automatically, even when the change affects runtime or managed-service behavior.
- Use `update_preview` when you want to fast-forward the source checkout without deploying, then inspect whether the source is current with the latest remote tag and whether the deployed service is still behind that pulled source version.
- `bun run service:prepare-update` now requires a non-empty change block so `DEPLOYMENTS.md` captures actual release notes instead of metadata only.
- `bun run service:prepare-update` now also refuses detached `HEAD` so the prepared-update commit cannot be left orphaned outside a branch tip.
- `bun run service:prepare-update` now also requires the current branch to track an upstream and pushes the prepared update commit immediately after writing it.
- Use `update` only when you intentionally want to deploy the already prepared source version into the managed service.
- When `update` is invoked from the live managed service, the deploy runs through a detached helper so the current bot process can hand off the restart safely.
- The underlying managed-service transition scripts are internal; invoke updates and rollbacks through the root-only agent tools instead of running those scripts directly.

## Coding-Agent Workspaces

- Local `launch_agent` runs now fork into isolated linked Git worktrees by default when the target cwd is inside a Git repo.
- New linked worktrees are created only from a clean source workspace. If the source repo has uncommitted changes, the launch now fails instead of silently dropping them from the child workspace.
- The workflow run keeps its linked worktree after completion or timeout so unfinished edits and local commits stay inspectable.

## Discord File Delivery

- For `<discord-file path="...">`, use an absolute path when you already have one.
- Relative local paths are resolved against the runtime root (`OPENELINARO_ROOT_DIR`) rather than the managed-service release cwd.
- This keeps repo-relative paths such as `docs/report.md` pointing at the source workspace even when the live service is running from a staged release snapshot.
- Discord delivery unwraps `UNTRUSTED CONTENT WARNING` envelopes before posting, so channel messages show only the guarded payload content rather than the metadata wrapper.
- Discord image ingestion now prefers the downloaded file signature over Discord attachment MIME metadata, because uploaded images can arrive with mismatched metadata (for example WebP-labelled PNG bytes).

## Routines And Alerts

- Use `routine_update` to change an existing item's title, description, priority, kind, `blockedBy` dependency list, or full schedule.
- Use `routine_delete` only for hard removal; it is not the same as closing a todo.
- Todo items now close into a dedicated completed state, so use `routine_done` for closure and `routine_undo_done` to reopen them.
- Use `set_alarm` for a named clock time and `set_timer` for a relative duration.
- `set_alarm` accepts local `HH:MM` or a future ISO timestamp.
- `set_timer` accepts `s`, `m`, `h`, and `d` suffixes such as `30s`, `10m`, `2h`, or `1d`.
- Use `alarm_list` to inspect pending, delivered, or cancelled alerts and `alarm_cancel` to stop one by id.

## Template: Load Then Act

Use `load_tool_library` first in a normal turn when the needed tool family is not already visible, then call the tools directly.

Example sequence:

1. `load_tool_library` with `library="filesystem_read"`
2. Use `glob`, `grep`, `read_file`

## Rules Of Thumb

- Search first when unsure.
- Keep the visible bundle small.
- Use dedicated tools before shell.
- Prefer omitting arguments that already match tool defaults. Example: coding-agent launch/resume defaults to a one-hour timeout.
- Save bulky intermediate data as artifacts.
- Every tool call accepts `silent: true`; treat that as an exception path for background housekeeping like heartbeat checks, not the default.
- Do not ask ordinary tools for ad hoc extraction. If a stored result comes back as `[tool_result_ref ...]`, use `tool_result_read` with `mode=\"summary\"` plus a `goal` describing what information you need instead.
- Prefer `apply_patch` for structured multi-file edits, renames, or delete/create patches. Keep `edit_file` for exact one-snippet replacements.
