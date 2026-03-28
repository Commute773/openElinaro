# E2E CLI Test Suite

End-to-end tests that run the real agent with real model APIs through a CLI
interface instead of Discord.

## Architecture

```
Connector (interface)
├── DirectConnector — calls handleRequest in-process (used by tests + CLI)
└── (future) DiscordConnector — goes through FakeDirectMessage
```

The connector abstraction decouples test cases from transport. The same
`E2eTestCase` definitions can run through any connector.

## Files

| File | Purpose |
|------|---------|
| `connector.ts` | `Connector` interface + `DirectConnector` implementation |
| `test-case.ts` | Test case types and assertion runner |
| `test-cases.ts` | Declarative test case definitions |
| `runner.ts` | Sequential runner (all cases in one process) |
| `run-case.ts` | Single-case runner (one process per case, for parallel execution) |
| `e2e-cli.paid.e2e.test.ts` | Bun test wrapper |

## Usage

### Run all cases in parallel via bash

```bash
./scripts/e2e-cli.sh
```

### Run specific case(s)

```bash
./scripts/e2e-cli.sh basic-chat-greeting todo-add
```

### Run by tag

```bash
./scripts/e2e-cli.sh --tag todo
```

### Run sequentially

```bash
./scripts/e2e-cli.sh --sequential
```

### Run via bun test

```bash
bun test src/e2e/e2e-cli.paid.e2e.test.ts
```

### Interactive CLI

```bash
./scripts/elinaro "what time is it?"
./scripts/elinaro --session_id="test-1" --json "add a todo: buy milk"
```

### List available cases

```bash
./scripts/e2e-cli.sh --list
```

## Adding test cases

Add entries to `test-cases.ts`. Each case needs:
- `name` — unique identifier
- `prompt` — what to send to the agent
- `assertions` — what to check (response contains, tool called, etc.)
- `tags` — optional, for filtering

## Isolation

Each test case gets its own:
- Temp directory as `OPENELINARO_ROOT_DIR`
- Fresh module imports (cache-busted)
- Separate conversation key
- Cleanup on completion

No test reads from or writes to `~/.openelinaro/`.
