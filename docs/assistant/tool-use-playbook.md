# Tool Use Playbook

Use this playbook when the right tool is not already visible or when a task needs many tool calls.

## Search First

Default rule:

- Treat tool visibility as three layers: user-facing commands, the agent's default-visible bundle for the current scope, and the larger searchable backend catalog.
- Treat the main agent and coding subagents as different scopes: the main agent keeps a broader default bundle, while coding subagents start narrower and are expected to use `tool_search` when they need web, service, todo, or other non-core tools.
- Use the currently visible tools first. If the exact tool name is not already visible, call `tool_search` before guessing.
- Ask for the capability you want, not the tool name you hope exists.
- `tool_search` matches against tool names, descriptions, tags, domains, and short example intents.
- Let `tool_search` activate a few likely tools, then use those tools directly.
- Discord `/update` now fast-forwards the source checkout and replies with the pending deployment changelog entries newer than the running version. `confirm:true` is the actual deploy step. The root-only `update_preview` tool is the non-deploying source-sync-plus-summary step, while `update` is the managed-service deploy step.
- Managed-service installs now export their configured service identity into the runtime environment so detached `/update confirm:true` helpers can reinstall the service with the same user, group, and unit metadata.
- Detached `/update confirm:true` helpers also inherit the live release root from the running service so rollback and release-state updates stay aligned even if `current-release.txt` was stale.

Good `tool_search` queries:

- `list and inspect routines`
- `search repository files and read matching code`
- `launch background coding workflow`
- `show context window usage for this conversation`
- `search web and summarize results`
- `fetch a specific docs URL as markdown`

Avoid:

- Guessing tool names from memory
- Calling shell commands when a dedicated tool probably exists
- Loading too many tools for a narrow task

## When To Use `run_tool_program`

Prefer `run_tool_program` when the task involves any of these:

- 3 or more dependent tool calls
- loops over many files, search hits, or URLs
- filtering, deduping, ranking, or aggregation
- large intermediate results that would clutter model context
- producing a compact summary plus saved artifacts

Avoid `run_tool_program` for:

- a single direct tool call
- a one-off read or lookup
- simple edits where normal tool calls are already enough

## Program Shape

Inside `run_tool_program`, the runtime exposes:

- `tools.invokeTool(name, input?, options?)`
- `tools.saveArtifact(name, content, mediaType?)`
- `tools.getAvailableTools()`
- `tools.log(value)`

Return shape:

- Prefer `return { summary: "..." }`
- You may also return additional structured fields
- Large outputs should go to artifacts, not the return payload

## Stored Tool Results

- Normal tool outputs are now stored out of band and replayed into the model context as compact refs instead of full raw payloads.
- When you see a header like `[tool_result_ref ...]`, use `tool_result_read` if you actually need the original output again. Only a small set of high-volume tools spill to refs; compact structured tools should normally stay inline.
- Prefer staying on the compact ref when the metadata is enough. Reopen the stored output only when the exact text matters for the next step.
- `tool_result_read` supports three modes: `partial` for a bounded line slice, `full` for the stored payload, and `summary` for a summarizer-backed extraction over up to 10k chars of the stored content.
- In `summary` mode, pass a `goal` that says what information you need. Prefer `summary` over `full` when you only need targeted facts, a verdict, or a compact recap from a large ref.
- `tool_result_read` is the escape hatch for raw content, so repeated large reads should go through it instead of forcing every past tool result to stay in context.

## Template: Multi-Step Research

```js
const search = await tools.invokeTool("web_search", {
  query: "latest updates on X",
  count: 5,
}, { artifactName: "web-search.json" });

const hits = Array.isArray(search?.results) ? search.results : [];
const top = hits.slice(0, 3).map((entry) => ({
  title: entry.title,
  url: entry.url,
}));

await tools.saveArtifact("top-hits.json", top, "application/json");

return {
  summary: `Collected ${hits.length} web hits and saved the top results.`,
};
```

## Web Ladder

Use the least heavy web tool that fits:

- `web_search` for discovery and current-source lookup
- `web_fetch` for reading a known URL as Crawl4AI-extracted markdown/text/html
- `openbrowser` only for interactive steps, JS-heavy pages, screenshots, or coordinate/browser actions

If `web_search` finds the page and you only need the readable content, go to `web_fetch` before reaching for `openbrowser`.

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
- Do not go looking for secret values with `memory_search`, docs reads, or web tools. The intended flow is `secret_list` -> secret refs in `openbrowser`.
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

## Coding-Agent Task Lists

`todo_write` and `todo_read` are for coding agents tracking their own session work. They are not the user's real task list.

- Do not reach for them by default. Prefer visible repo/file tools first, and only use them when the work is genuinely long-horizon or branching
- Keep at most one item `in_progress`
- Mark items complete immediately as work finishes
- If the main agent needs the user's actual todos, use routines tools such as `routine_list` or `routine_check`

## Background Workflow Checks

- Chat-launched coding subagents send a completion update back into the parent conversation automatically.
- Use `workflow_status` for occasional manual spot checks or when you think a completion update was missed.
- `workflow_status` now includes elapsed runtime so you can tell whether a run is actually making progress or just sitting long-running.
- For deeper postmortems, inspect `~/.openelinaro/workflow-session-history.json` after a run finishes. It keeps archived planner/worker session progress plus per-turn model/tool/token traces, including the visible tool bundle at each turn, even after the active `~/.openelinaro/workflow-sessions.json` entry is cleared.
- Do not poll `workflow_status` every few seconds while waiting; that wastes context and tool budget without adding signal.
- If an in-flight coding run needs new instructions, use `steer_coding_agent` instead of waiting for it to finish and then resuming.
- If a pending, backing-off, or actively running coding run needs to stop, use `cancel_coding_agent`.
- If you need to investigate slowness, pair `workflow_status` with `telemetry_query` against workflow spans and events instead of guessing from chat timing alone.
- Use `usage_summary` when you need provider-reported token spend and USD cost for the active conversation or the current local day, instead of inferring pricing from raw token counts.

## Service Version Checks

- Use `service_version` when you need the running agent's stamped deploy version or release metadata.
- Prefer `service_version` over guessing from git state when the managed service may be running from a staged release snapshot.
- Prefer the native `git_status`, `git_diff`, `git_stage`, and `git_commit` tools over ad hoc shell git commands when you are working inside an allowed repo/workspace.
- `git_revert` is now a chat/direct operator tool, not a background coding-agent default. Use it only for explicit human-directed cleanup.
- Use `service_changelog_since_version` when you need the deployment entries whose version is numerically greater than a requested version instead of reading all of `DEPLOYMENTS.md`.
- Deployment versions are `YYYY.MM.DD` or `YYYY.MM.DD.N`; the `.N` sequence resets each UTC day, so compare the full version rather than only the numeric suffix.
- Deploys are explicit. Do not assume code changes should redeploy the service automatically, even when the change affects runtime or managed-service behavior.
- Use `update_preview` when you want to fast-forward the source checkout without deploying, then inspect the prepared source-root update and the changelog entries newer than the running service version.
- `bun run service:prepare-update` now requires a non-empty change block so `DEPLOYMENTS.md` captures actual release notes instead of metadata only.
- `bun run service:prepare-update` now also refuses detached `HEAD` so the prepared-update commit cannot be left orphaned outside a branch tip.
- `bun run service:prepare-update` now also requires the current branch to track an upstream and pushes the prepared update commit immediately after writing it.
- Use `update` only when you intentionally want to deploy the already prepared source version into the managed service.
- When `update` is invoked from the live managed service, the deploy runs through a detached helper so the current bot process can hand off the restart safely.
- The underlying managed-service transition scripts are internal; invoke updates and rollbacks through the root-only agent tools instead of running those scripts directly.

## Coding-Agent Workspaces

- Local `launch_coding_agent` runs now fork into isolated linked Git worktrees by default when the target cwd is inside a Git repo.
- New linked worktrees are created only from a clean source workspace. If the source repo has uncommitted changes, the launch now fails instead of silently dropping them from the child workspace.
- The workflow run keeps its linked worktree after completion or timeout so unfinished edits and local commits stay inspectable.

## Discord File Delivery

- For `<discord-file path="...">`, use an absolute path when you already have one.
- Relative local paths are resolved against the runtime root (`OPENELINARO_ROOT_DIR`) rather than the managed-service release cwd.
- This keeps repo-relative paths such as `docs/report.md` pointing at the source workspace even when the live service is running from a staged release snapshot.
- Discord delivery unwraps `UNTRUSTED CONTENT WARNING` envelopes before posting, so channel messages show only the guarded payload content rather than the metadata wrapper.

## Routines And Alerts

- Use `routine_update` to change an existing item's title, description, priority, kind, `blockedBy` dependency list, or full schedule.
- Use `routine_delete` only for hard removal; it is not the same as closing a todo.
- Todo items now close into a dedicated completed state, so use `routine_done` for closure and `routine_undo_done` to reopen them.
- Use `set_alarm` for a named clock time and `set_timer` for a relative duration.
- `set_alarm` accepts local `HH:MM` or a future ISO timestamp.
- `set_timer` accepts `s`, `m`, `h`, and `d` suffixes such as `30s`, `10m`, `2h`, or `1d`.
- Use `alarm_list` to inspect pending, delivered, or cancelled alerts and `alarm_cancel` to stop one by id.

## Template: Repository Scan And Reduction

```js
const matches = await tools.invokeTool("grep", {
  pattern: "tool_search|run_tool_program",
  path: ".",
  include: "*.ts",
  limit: 200,
}, { artifactName: "grep-results.txt", mediaType: "text/plain" });

const files = String(matches)
  .split("\\n")
  .map((line) => line.split(":")[0]?.trim())
  .filter(Boolean);

const uniqueFiles = [...new Set(files)].slice(0, 10);
const previews = [];

for (const file of uniqueFiles) {
  const content = await tools.invokeTool("read_file", {
    path: file,
    limit: 80,
  });
  previews.push({ file, preview: String(content).slice(0, 600) });
}

await tools.saveArtifact("file-previews.json", previews, "application/json");

return {
  summary: `Scanned ${uniqueFiles.length} relevant files and saved previews.`,
};
```

## Template: Structured Routine Triage

```js
const routines = await tools.invokeTool("routine_list", {
  status: "all",
  kind: "all",
  limit: 20,
}, { artifactName: "routines.txt", mediaType: "text/plain" });

const urgent = String(routines)
  .split("\\n")
  .filter((line) => /urgent|overdue|high/i.test(line))
  .slice(0, 10);

await tools.saveArtifact("urgent-routines.txt", urgent.join("\\n"), "text/plain");

return {
  summary: `Found ${urgent.length} urgent or overdue routine items.`,
};
```

## Template: Search Then Act

Use `tool_search` first in a normal turn, then after the right tools are visible, call them directly or via `run_tool_program`.

Example sequence:

1. `tool_search` with `query="search repository files and inspect matching code"`
2. Let it activate `glob`, `grep`, `read_file`
3. If the task turns into many repeated searches/reads, switch to `run_tool_program`

## Rules Of Thumb

- Search first when unsure.
- Keep the visible bundle small.
- Use dedicated tools before shell.
- Prefer omitting arguments that already match tool defaults. Examples: `web_search` defaults to English, and coding-agent launch/resume default to a one-hour timeout.
- Use `run_tool_program` to compress many tool calls into one model-visible result.
- Save bulky intermediate data as artifacts.
- Every tool call accepts `silent: true`; treat that as an exception path for background housekeeping like heartbeat checks, not the default.
- Do not ask ordinary tools for ad hoc extraction. If a stored result comes back as `[tool_result_ref ...]`, use `tool_result_read` with `mode=\"summary\"` plus a `goal` describing what information you need instead.
- Prefer `apply_patch` for structured multi-file edits, renames, or delete/create patches. Keep `edit_file` for exact one-snippet replacements.
