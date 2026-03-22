# Configuration And Features

The runtime uses two local files for operator state:

- `~/.openelinaro/config.yaml` for non-secret runtime config
- `~/.openelinaro/secret-store.json` for named secrets and provider auth

Bundled repo files such as `profiles/registry.json` and `projects/registry.json` are starter templates only. The live copies the runtime reads and mutates are under `~/.openelinaro/`.

In test mode, the runtime defaults to `~/.openelinarotest/` when invoked from the repo checkout. Tests that point `OPENELINARO_ROOT_DIR` or `OPENELINARO_USER_DATA_DIR` at an isolated temp root still keep their mutable state there.

## Shape

`~/.openelinaro/config.yaml` is organized as one always-on `core` block plus optional top-level feature blocks:

- `core`
- `calendar`
- `email`
- `communications`
- `webSearch`
- `webFetch`
- `openbrowser`
- `finance`
- `tickets`
- `localVoice`
- `media`

Each optional feature has:

- `enabled`
- feature-specific config fields

`core` now also owns the shared Python runtime path for every Python-backed feature:

- `core.python.venvPath`
- `core.python.requirementsFile`

The current default happy path is a unified venv under `~/.openelinaro/python/.venv` with requirements from `python/requirements.txt`.

## Activation Rules

Optional feature tools only appear when the feature is both:

- enabled in `~/.openelinaro/config.yaml`
- sufficiently configured for that feature

The base system prompt now starts with a short runtime/config preamble before the file-based `system_prompt/*.md` content. That preamble reports core app toggles plus which optional features are enabled or disabled in config, and points the agent at `feature_manage`, `~/.openelinaro/config.yaml`, `~/.openelinaro/secret-store.json`, and `bun run setup:python` for feature enablement.

Examples:

- `email` stays hidden until the feature is enabled and its secret refs resolve
- `webSearch` stays hidden until the feature is enabled and the Brave API key secret exists
- `tickets` stays hidden until the feature is enabled and it has an endpoint plus token secret
- `webFetch`, `openbrowser`, and `localVoice` stay hidden until the shared Python runtime is prepared
- `finance` stays hidden when disabled or when `finance.dbPath` / `finance.forecastConfigPath` are blank

The `finance` feature block also owns the runtime finance paths and seeded defaults:

- `finance.dbPath`
- `finance.forecastConfigPath`
- `finance.defaults.settings`
- `finance.defaults.forecast`

## Onboarding

Bootstrap now starts with Discord bot auth outside Discord:

```bash
bun run setup
```

That stores the Discord bot token in the unified secret store and writes the initial `~/.openelinaro/config.yaml`.

Prepare the shared Python runtime once if you want any Python-backed features:

```bash
bun run setup:python
```

`bun run setup:python status` now verifies the interpreter plus the required shared modules for `webFetch`, `openbrowser`, and `localVoice`, so a stale or half-installed venv no longer reports as ready.

After the bot is online, the agent can manage optional features through the `feature_manage` tool:

- inspect status for all features
- inspect one feature's missing requirements
- apply config values
- enable or disable a feature
- prepare the shared Python venv from the agent
- request a managed-service restart so the new tool surface activates

For direct runtime-config edits, use `config_edit` instead of shell edits:

- `action=get` reads the whole file or one config path
- `action=set` and `action=unset` change a specific path such as `email.enabled`
- `action=replace` validates a whole replacement config before saving it
- `action=validate` checks either the current file or a proposed YAML payload
- restarts are only requested after schema validation succeeds

Provider auth still lives in Discord DM flows and is also stored in `~/.openelinaro/secret-store.json`.

## Secrets

The secret store now owns:

- named operator secrets such as `discord.botToken`
- provider auth material for Codex and Claude

Use the existing secret tools for importing secret JSON from local files or generating passwords. Avoid pasting raw secrets into chat.

## Read Next

- Runtime model: [runtime-domain-model.md](runtime-domain-model.md)
- Communications runtime: [communications.md](communications.md)
