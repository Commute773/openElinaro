# Harness Smoke Tests

Use these examples to verify the assistant harness after tool or backend changes. They are intentionally small, deterministic, and safe to run in a normal repo checkout.

## `load_tool_library`

Known-good text output:

```json
{
  "library": "filesystem_read",
  "scope": "chat"
}
```

Known-good structured output:

```json
{
  "library": "filesystem_read",
  "scope": "chat",
  "format": "json"
}
```

Expected:

- Returns the selected library description and tool list.
- Text mode reports `Newly activated`, `Already visible`, and `Visible tool count after load`.
- JSON mode returns `toolNames`, `newlyActivated`, `alreadyVisible`, and `visibleAfter`.

## `list_dir`

Known-good text output:

```json
{
  "path": ".",
  "limit": 20
}
```

Known-good structured output:

```json
{
  "path": ".",
  "limit": 20,
  "format": "json"
}
```

Expected:

- Text mode lists entries under the resolved directory.
- JSON mode returns `entries`, `displayedCount`, `totalEntries`, and `truncated`.

## `stat_path`

Known-good text output:

```json
{
  "path": "README.md"
}
```

Known-good structured output:

```json
{
  "path": "README.md",
  "format": "json"
}
```

Expected:

- Text mode reports path, type, size, modified time, and created time.
- JSON mode returns `path`, `type`, `sizeBytes`, `modifiedAt`, and `createdAt`.

## `workflow_status`

Known-good text output:

```json
{
  "limit": 3
}
```

Known-good structured output:

```json
{
  "limit": 3,
  "format": "json"
}
```

Expected:

- Text mode lists the recent runs with status and summary.
- JSON mode returns `count` plus a `runs` array with task progress and latest task fields when available.

## `telemetry_query`

Known-good structured output:

```json
{
  "component": "app",
  "level": "error",
  "limit": 5,
  "format": "json"
}
```

Known-good trace lookup:

```json
{
  "traceId": "replace-with-trace-id",
  "format": "json"
  "format": "json"
}
```

Expected:

- Searches `~/.openelinaro/telemetry.sqlite` for structured spans and events.
- Supports `traceId`, `spanId`, `level`, `status`, and free-text query filters.
- JSON mode returns structured `spans` and `events`.

## `web_search`

Known-good request:

```json
{
  "query": "OpenAI API changelog",
  "count": 3,
  "ui_lang": "en-US"
}
```

Expected:

- `ui_lang` is dispatched with canonical locale casing, not forced to lowercase.
- If the backend rejects `ui_lang`, the surfaced error should name the bad value and suggest canonical locale casing.

## `media_list_speakers`

Known-good request:

```json
{}
```

Expected:

- Returns configured speakers and live output devices.
- On this machine, should surface `B06HD` when that speaker is connected.

## `media_play`

Known-good request:

```json
{
  "query": "thunder",
  "speaker": "bedroom",
  "volume": 70
}
```

Expected:

- Resolves a local thunder ambience track from the runtime `media/` library.
- Routes playback to the requested speaker.
- Returns the resolved title, speaker, kind, volume, and tags.

## Error Envelope

Known-good failure example:

```json
{
  "tool": "does_not_exist",
  "input": {}
}
```

Expected:

- Tool-facing failures return a JSON envelope with `ok: false`, `tool`, `message`, `error`, and `debug.raw`.
- `message` should be short and normalized.
- `debug.raw` should preserve the underlying failure text for debugging.

## `run_tool_program`

Known-good request:

```json
{
  "objective": "Collect the top-level repository entries as an artifact.",
  "allowedTools": ["list_dir"],
  "code": "const result = await tools.invokeTool(\"list_dir\", { path: \".\", format: \"json\" }, { artifactName: \"repo-listing.json\", mediaType: \"application/json\" }); return { summary: `Saved ${result.displayedCount} entries.`, displayedCount: result.displayedCount };"
}
```

Expected:

- Returns a compact summary.
- Saves `repo-listing.json` as an artifact.
- Keeps the full listing out of the chat transcript.
