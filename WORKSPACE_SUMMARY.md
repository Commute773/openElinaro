# openElinaro – Workspace Summary

## Tech Stack
- **Runtime:** Bun (TypeScript)
- **Frameworks:** LangChain Core, LangGraph
- **Libraries:** discord.js, Zod, @xenova/transformers, pi-ai
- **Type-checking:** TypeScript 5.9

## Key Directories
| Directory | Purpose |
|-----------|---------|
| `src/` | Application source code (entry: `src/index.ts`) |
| `scripts/` | Shell helpers for managed-service install/redeploy/rollback and Linux setup |
| `docs/` | Documentation |
| `profiles/` | Profile data |
| `projects/` | Project definitions |
| `references/` | Reference materials |
| `system_prompt/` | System prompt templates |
| `assistant_context/` | Assistant context files |
| `media/` | Media assets |

## Available npm Scripts
| Script | Command |
|--------|---------|
| `dev` | Run with --watch (`bun --watch src/index.ts`) |
| `start` | Run (`bun src/index.ts`) |
| `demo` | Run demo (`bun src/demo.ts`) |
| `check` | Type-check (`tsc --noEmit`) |
| `test` | Run tests (`bun test src/**/*.test.ts`) |
| `test:openbrowser:e2e` | OpenBrowser E2E test |
| `service:install` | Install the current platform service backend |
| `service:redeploy` | Redeploy the managed service |
