# Extensions

Extensions are user-installed modules that add tools, event handlers, and tool libraries to the agent runtime. The extension system is gated behind the `extensions` feature flag, which defaults to disabled.

## Current Status

This is a scaffold. The extension registry can discover and validate extensions on disk, but dynamic loading and activation are not yet implemented. The `loadAll()` method logs a stub message for each valid extension.

## Directory Structure

Each extension lives in its own directory under `~/.openelinaro/extensions/`:

```
~/.openelinaro/extensions/
  hello-world/
    extension.json
    index.ts
    ...
  my-tools/
    extension.json
    main.ts
    ...
```

The directory name is informational. The authoritative extension ID comes from the `id` field in `extension.json`.

## Manifest Format

Every extension directory must contain an `extension.json` file:

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "description": "A sample extension",
  "author": "Jane Doe",
  "entrypoint": "index.ts"
}
```

Fields:

- `id` (required) -- Lowercase alphanumeric with hyphens. Must match `^[a-z0-9][a-z0-9-]*$`.
- `name` (required) -- Human-readable display name.
- `version` (required) -- Semver-style version string.
- `description` (optional) -- Short description of what the extension does.
- `author` (optional) -- Author name or identifier.
- `entrypoint` (required) -- Relative path to the module that the runtime will import when loading the extension.

The manifest is validated with a Zod schema (`ExtensionManifestSchema` in `src/domain/extensions.ts`).

## Extension API

When an extension is loaded, its entrypoint receives an `ExtensionAPI` object with these methods:

- `registerTool(name, schema, handler)` -- Register a tool the agent can invoke. The schema is a Zod type for input validation.
- `registerToolLibrary(id, description, toolNames)` -- Group previously registered tools into a named library for discovery.
- `onEvent(eventName, handler)` -- Subscribe to a named runtime event.
- `getConfig()` -- Read the extension's own config from the runtime config file.

## Feature Flag

The `extensions` feature is listed in `FEATURE_IDS` in `src/services/feature-config-service.ts` and can be toggled in `~/.openelinaro/config.yaml`:

```yaml
extensions:
  enabled: true
```

## Discovery Flow

On startup (when the feature is enabled), the `ExtensionRegistryService`:

1. Reads `~/.openelinaro/extensions/` for subdirectories.
2. For each subdirectory, checks for `extension.json`.
3. Validates the manifest against `ExtensionManifestSchema`.
4. Records each extension as `discovered` (no manifest), `valid`, or `invalid`.
5. Calls `loadAll()` which is currently a stub.

## Read Next

- Configuration and features: [configuration.md](configuration.md)
- Runtime domain model: [runtime-domain-model.md](runtime-domain-model.md)
