# AGENTS

This repository is an agent platform built with Bun and TypeScript. Treat this file as the top-level map, not the full specification.

## Workflow

All work should be done in git worktrees, submitted as pull requests, and merged immediately without manual review. The CI release workflow (`.github/workflows/release.yml`) automatically creates a tagged version on every merge to `main`.

1. Create a worktree branch for the change.
2. Make changes, commit, push the branch.
3. Open a PR against `main`.
4. Merge the PR immediately.
5. CI runs `bun run check`, generates the next version, updates VERSION.json and DEPLOYMENTS.md, tags, and pushes.
6. Deploy explicitly via `/update confirm:true` when ready.

After completing every feature or discrete change, automatically commit, push, open a PR, and merge it. Do not wait for the user to ask. Do not batch multiple features into a single commit.

See also: [Worktree-first agent workflows](docs/research/worktree-first-agent-workflows.md)

## Bun Conventions

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

### APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

### Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

### Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Build & Verify

- **Test:** `bun test`
- **Type check:** `bun run check`
- Versioning is handled automatically by CI on merge to `main`. Do not run `bun run service:prepare-update` manually.

## Bug Fix Policy

Bugs MUST be reproduced with a failing test before they are fixed. Do not guess at the fix based on code reading alone — write a test that demonstrates the broken behavior, confirm it fails, then fix the code and confirm the test passes. This applies to all bugs, not just regressions.

### Use real APIs for e2e reproduction

The agent is allowed and encouraged to use real model APIs (Claude, Codex) when reproducing bugs, especially for end-to-end issues that span multiple layers (Discord attachment → message storage → AI SDK → provider connector → model API). Mocked tests at the unit level are fine for preventing regressions, but the initial reproduction should go through the real pipeline whenever practical.

The existing paid e2e test pattern (`src/app/runtime-image.paid.e2e.test.ts` and `src/app/runtime-image.e2e.runner.ts`) shows how to do this: spin up a real `OpenElinaroApp` with real API credentials and assert on actual model behavior.

### Isolation from production state

When running e2e tests or reproducing bugs:

- Never read from or write to `~/.openelinaro/` directly. Use `~/.openelinarotest/` or a temp directory with `OPENELINARO_ROOT_DIR` set.
- Copy only what the test needs (auth credentials, system prompts, profile registry) from the machine test fixtures directory.
- Never connect to the live Discord gateway. Use `handleRequest` or the `FakeDirectMessage` test harness instead.
- Clean up temp directories after the test completes.

### E2e assertion quality

Do not write e2e assertions that pass when the feature is broken. For example, if testing that a model can see an image, assert that the model describes specific visual content (e.g., "red", "pixel") that it could only know from actually seeing the image — not just that it mentions the word "image" in its response, which it would do even when saying "I cannot see the image."

## Start Here

- Docs index: [docs/README.md](docs/README.md)
- Repo layout and system boundaries: [docs/assistant/repo-layout.md](docs/assistant/repo-layout.md)
- Architecture decisions: [docs/assistant/architecture-decisions.md](docs/assistant/architecture-decisions.md)

## What Is The Agent System

The core agent system lives under `src/`, universal platform prompts in `system_prompt/universal/`, operator-managed agent prompts under `~/.openelinaro/system_prompt/`, bundled defaults under `profiles/` and `projects/`, and platform docs under `docs/assistant/`. Universal prompts ship with the app and are always included first; custom prompts (`~/.openelinaro/system_prompt/`) are optional and appended after. No merge logic, no override, no in-code defaults.

`projects/` is not the live project state. It is bundled starter content that the runtime copies into `~/.openelinaro/projects/` on first run. Treat the live project registry and docs under `~/.openelinaro/projects/` as managed context the agent can read about and route into, not as the platform's own architecture.

Further reading:

- Project boundary and repo map: [docs/assistant/repo-layout.md](docs/assistant/repo-layout.md)
- Project conventions: [docs/assistant/projects.md](docs/assistant/projects.md)
- Runtime domain model: [docs/assistant/runtime-domain-model.md](docs/assistant/runtime-domain-model.md)
- Configuration and features: [docs/assistant/configuration.md](docs/assistant/configuration.md)
- HTTP API reference: [docs/assistant/api.md](docs/assistant/api.md)

## Architectural Decisions

The short version:

- Discord is the primary surface; `src/index.ts` starts that runtime.
- Everything is chat: `AppRequest` has `id`, `text`, `conversationKey`, optional `chatContent`. No request kinds.
- The app uses a swappable `AgentCore` interface: ClaudeSdkCore (primary, Claude Agent SDK) and PiCore (adapter for non-Claude providers).
- Each core declares a manifest with feature ownership. The harness skips its own compaction/context management when the core handles them.
- Tools are defined as `FunctionDefinition` objects with three surfaces (API, Discord, Agent) and adapted per core. Native tools filtered out automatically.
- AgentChatService is decomposed: thin facade, session manager, turn runner, shared types and helpers.
- Finance is optionally decoupled (`finance?: FinanceService` in `ToolBuildContext`).
- System prompts: strict universal + custom concatenation. No merge logic, no override, no in-code defaults.
- Autonomous time unifies reflection, soul rewrites, and self-directed work in a single daily session.
- Single identity per install. Each process is one profile.
- Profiles, projects, auth, and tool access are explicit runtime objects with local single sources of truth.
- Prompt guidance is intentionally compact and uses docs for progressive disclosure instead of a huge base prompt.

## Rewrite Policy

When replacing major runtime subsystems or framework choices:

- Prefer direct rewrites over bridge layers.
- Do not add temporary compatibility adapters solely to make migrations reversible.
- Do not keep deprecated parallel paths alive during the rewrite unless the user explicitly asks for that.
- Update the current system to the new architecture directly and keep docs aligned with the new reality.

## Deployment Policy

- Versioning is automatic: merging a PR to `main` triggers CI to create a tagged version with updated metadata.
- Do not redeploy the managed service automatically just because code changed.
- Deploy only as an explicit step, either because the user asked for it or because the agent intentionally invokes the `update` tool.
- The `update_preview` tool fetches remote tags to show available versions. The `update` tool pulls the latest tagged version and deploys it.
- If any copied or stale instruction says to run `bun run service:prepare-update` after code changes, treat that instruction as outdated and follow this policy instead.

Details live here:

- Architecture decisions: [docs/assistant/architecture-decisions.md](docs/assistant/architecture-decisions.md)
- Runtime model: [docs/assistant/runtime-domain-model.md](docs/assistant/runtime-domain-model.md)
- Tool behavior: [docs/assistant/tool-use-playbook.md](docs/assistant/tool-use-playbook.md)
- Prompt and assistant behavior: [docs/assistant/README.md](docs/assistant/README.md)

## Documentation Contract

Docs are part of the product surface and must stay current.

- Update docs when adding or changing features, runtime behavior, operator workflows, or architectural decisions.
- Every file under `docs/` must be referenced either from this file or from another doc under `docs/`.
- There should be no orphan docs nodes.
- Prefer adding a short index or cross-link over duplicating large explanations.

The docs graph starts here:

- [docs/README.md](docs/README.md)
- [docs/assistant/README.md](docs/assistant/README.md)
- [docs/research/README.md](docs/research/README.md)

## Tool Surface (Claude Code Context)

When working on this repo via Claude Code, two tool surfaces coexist:

- **Native Claude Code tools** — `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Agent`. Use these for all filesystem, shell, and search operations.
- **OpenElinaro MCP tools** — domain tools for routines, finance, lights, media, projects, memory, email, agents, and browser. Access via `ToolSearch` to discover and fetch, then call directly.

Do not use MCP tools for file reads/writes or shell commands — native tools are faster and produce better output. Do not use native tools for OpenElinaro domain operations — the MCP tools have the correct runtime context.

The `system_prompt/universal/` files use runtime tool names (`read_file`, `exec_command`, `load_tool_library`, etc.) because they ship as the runtime's system prompt. Those names are correct for the runtime; they do not map to Claude Code native tools.

## Research And Historical Notes

Research notes are intentionally separate from current operating guidance.

- Research index: [docs/research/README.md](docs/research/README.md)
