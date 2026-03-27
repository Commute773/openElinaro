# Extensions

Extensions are user-installed modules that add tools, event handlers, and tool libraries to the agent runtime. The extension system is gated behind the `extensions` feature flag, which defaults to disabled.

## Current Status

The extension registry can discover and validate extensions on disk. Dynamic loading and activation via `loadAll()` are stubbed -- the method logs each valid extension but does not yet import or execute entrypoints. The lifecycle below describes the intended flow; steps marked **(stub)** are not yet implemented.

## Loading Lifecycle

On startup, when the `extensions` feature flag is enabled, the `ExtensionRegistryService` runs through these phases:

1. **Scan** -- reads `~/.openelinaro/extensions/` for subdirectories.
2. **Validate** -- for each subdirectory, checks for `extension.json` and validates it against `ExtensionManifestSchema`. Extensions are classified as `discovered` (no manifest), `valid`, or `invalid`.
3. **Load** **(stub)** -- for each valid extension, the runtime would import the entrypoint module specified in the manifest.
4. **Activate** **(stub)** -- the imported module would receive an `ExtensionAPI` instance and use it to register tools, event handlers, and libraries.

Extensions transition through these statuses: `discovered` -> `valid` -> `loaded` (or `invalid` / `error` on failure).

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

When an extension is loaded, its entrypoint receives an `ExtensionAPI` object (defined in [`src/domain/extensions.ts`](../../src/domain/extensions.ts)) with these methods:

- `registerTool(name, schema, handler)` -- Register a tool the agent can invoke. `name` is the tool name, `schema` is a Zod type for input validation, and `handler` is an async function that receives the validated input and returns the tool result.
- `registerToolLibrary(id, description, toolNames)` -- Group previously registered tools into a named library for discovery. The `toolNames` array must reference tools already registered by this extension.
- `onEvent(eventName, handler)` -- Subscribe to a named runtime event.
- `getConfig()` -- Read the extension's own config block from `~/.openelinaro/config.yaml`. Returns a `Record<string, unknown>`.

### Minimal Extension Example

```
~/.openelinaro/extensions/hello-world/
  extension.json
  index.ts
```

`extension.json`:

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "entrypoint": "index.ts"
}
```

`index.ts` (illustrative -- activation is stubbed, so this does not run yet):

```ts
import { z } from "zod";
// Import path will depend on how the runtime exposes the API to extensions
import type { ExtensionAPI } from "openelinaro/domain/extensions";

export default function activate(api: ExtensionAPI) {
  api.registerTool(
    "hello",
    z.object({ name: z.string() }),
    async (input) => ({ greeting: `Hello, ${(input as any).name}!` }),
  );
  api.registerToolLibrary("hello-lib", "Greeting tools", ["hello"]);
}
```

## Feature Flag

The `extensions` feature is listed in `FEATURE_IDS` in `src/services/feature-config-service.ts` and can be toggled in `~/.openelinaro/config.yaml`:

```yaml
extensions:
  enabled: true
```

## Discovery Flow

See [Loading Lifecycle](#loading-lifecycle) above. The implementation lives in [`src/services/extension-registry-service.ts`](../../src/services/extension-registry-service.ts).

## Read Next

- G2 API: [api.md](api.md)
- Configuration and features: [configuration.md](configuration.md)
- Runtime domain model: [runtime-domain-model.md](runtime-domain-model.md)
