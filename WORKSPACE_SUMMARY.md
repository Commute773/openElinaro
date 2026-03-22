# openElinaro – Workspace Summary

## Tech Stack
- **Runtime:** Bun (TypeScript)
- **Frameworks:** LangChain Core, Vercel AI SDK
- **Libraries:** discord.js, Zod, @xenova/transformers, pi-ai, recharts
- **Type-checking:** TypeScript 5.9

## Key Directories
| Directory | Purpose |
|-----------|---------|
| `src/` | Application source code (entry: `src/index.ts`) |
| `src/config/` | Runtime configuration, environment, and identity settings |
| `src/utils/` | Shared utility helpers (file, text, time, SQLite, telemetry) |
| `src/tools/groups/` | Tool group definitions (communication, filesystem, finance, etc.) |
| `src/services/finance/` | Finance sub-service modules (ledger, budgets, forecasting, import) |
| `src/services/gemini-live/` | Gemini Live audio/phone streaming subsystem |
| `scripts/` | Shell helpers for managed-service install/redeploy/rollback and Linux setup |
| `docs/` | Documentation |
| `profiles/` | Profile data |
| `projects/` | Project definitions |
| `system_prompt/` | System prompt templates |
| `web/` | Web front-ends (e.g. `web/finance/` finance dashboard) |
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
| `service:prepare-update` | Prepare a service update |
| `service:update` | Update the managed service |
| `service:rollback` | Rollback the managed service |
| `service:healthcheck` | Run service health check (`bun src/cli/healthcheck.ts`) |
| `finance:api` | Start the finance API server |
| `finance:dev` | Run the finance front-end in dev mode |
