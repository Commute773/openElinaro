# OpenClaw Auth And Framework Research

Date: 2026-03-11

## 1. OpenClaw authentication findings

### OpenAI Codex

Current OpenClaw treats OpenAI Codex as a real OAuth provider.

- `models auth login --provider openai-codex` routes into `runBuiltInOpenAICodexLogin()` in `references/openclaw/src/commands/models/auth.ts`.
- That flow calls `loginOpenAICodexOAuth()` in `references/openclaw/src/commands/openai-codex-oauth.ts`.
- The OAuth helper delegates to `@mariozechner/pi-ai/oauth` and supports:
  - local browser callback on `localhost:1455`
  - remote/headless fallback where the user pastes the redirect URL back into the CLI
- Credentials are written with `writeOAuthCredentials("openai-codex", creds, ...)` in `references/openclaw/src/commands/onboard-auth.credentials.ts`.
- Profiles are stored as `type: "oauth"` and wired into config with mode `oauth`.
- Runtime refresh happens in `references/openclaw/src/agents/auth-profiles/oauth.ts`, under a file lock, with a special fallback for certain Codex refresh failures that reuses the cached access token.

### Anthropic / Claude

There are two distinct Anthropic-related paths in the repo, and they should not be conflated.

#### Anthropic provider auth

Current OpenClaw does not primarily use a browser Claude OAuth flow for the `anthropic` provider.

- `applyAuthChoiceAnthropic()` in `references/openclaw/src/commands/auth-choice.apply.anthropic.ts` maps `setup-token`, `oauth`, and `token` choices into the same practical flow:
  1. tell the user to run `claude setup-token`
  2. paste the generated token
  3. store it as `type: "token"` for provider `anthropic`
- `models auth setup-token --provider anthropic` in `references/openclaw/src/commands/models/auth.ts` does the same thing for the CLI command path.
- OpenClaw docs in `references/openclaw/docs/concepts/oauth.md` explicitly say:
  - OpenAI Codex uses OAuth
  - Anthropic subscriptions use setup-token
  - Anthropic API keys are the safer production path

#### Claude Code CLI credential reuse

OpenClaw still contains compatibility code for Claude Code CLI credentials.

- `references/openclaw/src/agents/cli-credentials.ts` reads:
  - macOS Keychain item `Claude Code-credentials`
  - Linux/Windows file `~/.claude/.credentials.json`
- Those credentials can be OAuth-shaped or token-shaped depending on what Claude Code stored.

But this path appears to be a legacy or compatibility path, not the preferred Anthropic provider onboarding path.

- `references/openclaw/src/commands/doctor-auth.ts` marks `anthropic:claude-cli` as deprecated and tells the user to use `openclaw models auth setup-token`.
- `references/openclaw/CHANGELOG.md` notes that Anthropic OAuth sign-in was removed and Anthropic subscription auth became setup-token-only in the `2026.2.26` release line.

### Practical takeaway

For our app, the clean mental model is:

- OpenAI Codex: browser OAuth with refreshable credentials
- Anthropic API provider: API key or setup-token
- Claude Code CLI auth reuse: optional compatibility path if we choose to integrate local CLI accounts

## 2. Agent framework shortlist

You clarified that the framework needs more than tool-calling. It needs an explicit task system:

- keep a plan like "tasks 1..5"
- execute one at a time when serial
- fan out parallel work to subagents when useful
- resume long-running jobs safely
- expose tool/search/memory primitives

That changes the ranking. The main discriminator is durable orchestration, not raw model support.

### Best fit: LangGraph

Why it fits:

- Low-level and relatively unopinionated
- Strongest explicit workflow model in the shortlist
- Durable execution, persistence, interrupts, memory, subgraphs, and parallel branches
- Good fit for "planner + worker agents + resumable runs"

What it gives us:

- A first-class graph/state machine for tasks
- Parallel task branches
- Human approval checkpoints
- Multi-agent composition through subgraphs

Tradeoff:

- More plumbing than higher-level SDKs
- You define more of the architecture yourself

### Best fit if we want TypeScript-native multi-agent orchestration with less plumbing: AgentKit by Inngest

Why it fits:

- TypeScript-first
- Agents, tools, state, routers, and networks are all explicit primitives
- Networks are effectively an orchestration loop with shared state
- Strong story for multi-agent routing and deterministic state-based workflows

What it gives us:

- Shared network state
- Router-driven agent selection
- Tool support and MCP support
- A clearer built-in concept of orchestrator plus worker agents than most SDKs

Tradeoff:

- Less battle-tested in the broader ecosystem than LangGraph
- "Skills" are not a core runtime abstraction in the same sense as Codex/Claude Code

### Good fit if we want batteries included and can accept more framework opinion: Mastra

Why it fits:

- Agents, workflows, memory, MCP, observability, and human-in-the-loop in one stack
- Workflows support suspend/resume
- Agent networks now exist, which matters for parallel specialists

What it gives us:

- Fastest path to a full product surface
- Strong TypeScript ergonomics
- Better built-in app surface than LangGraph

Tradeoff:

- Less minimal and less unopinionated than LangGraph or AgentKit
- Higher chance of framework-shaped architecture

### Good model/runtime layer, weaker task-orchestration layer: OpenAI Agents SDK

Why it is still interesting:

- Strong tools story
- Built-in web search, file search, code interpreter, tool search, MCP, handoffs, sessions
- Can expose agents as tools and connect MCP servers in parallel

Why it is not the best primary orchestration layer for us:

- It is excellent for agent loops, tool use, and delegation
- It is not the strongest choice for a durable "task board" runtime with explicit queued workflow state

If we choose it, we should pair it with a real task engine.

### Good app SDK, but not enough by itself for our task runtime: Vercel AI SDK

Why it is still relevant:

- Very clean TS DX
- ToolLoopAgent, subagents, MCP, memory options
- Easy to embed in a web product

Why it is not enough alone:

- Its workflow guidance is more pattern-oriented than durable-runtime-oriented
- Subagents and tool loops are useful, but a Codex-like task executor still needs a stronger backend task system

## 3. Task-system conclusion

If "Codex / Claude Code style task execution" is the core product requirement, I would not treat the agent SDK and the task runtime as the same thing unless we pick LangGraph or AgentKit.

### Option A: LangGraph-first

Use when:

- we want maximum control
- we want explicit plan state and deterministic orchestration
- we are fine building our own app shell around it

Recommended stack:

- Bun + TypeScript app
- LangGraph for orchestration
- MCP for external tools
- provider adapters for Codex/OpenAI and Anthropic

### Option B: AgentKit-first

Use when:

- we want explicit multi-agent coordination in TypeScript
- we want routers/state/networks without building everything from scratch

Recommended stack:

- Bun + TypeScript app
- AgentKit by Inngest for planner/router/network behavior
- MCP for tools
- optional Inngest or Trigger.dev style background execution if we outgrow in-process runs

### Option C: OpenAI Agents SDK or AI SDK plus dedicated task engine

Use when:

- we want the nicest tool/model integration layer
- we are willing to separate task runtime from agent runtime

Recommended pairings:

- OpenAI Agents SDK + Trigger.dev
- AI SDK + Trigger.dev

This is the cleanest split when the app wants:

- durable background runs
- queueing and retries
- resumable waits
- subtask fan-out
- strong frontend streaming

## 4. Recommendation for this repo

Current recommendation:

1. Keep the app scaffold lightweight.
2. Design the domain around explicit `TaskPlan`, `Task`, `AgentAssignment`, and `Run`.
3. Prototype the orchestration layer with LangGraph first.
4. If LangGraph feels too low-level for product velocity, switch the orchestration core to AgentKit.
5. Treat "skills" as versioned prompt + tool bundles rather than searching for a framework that already has a perfect built-in skill abstraction.

## 5. Official docs used

- OpenAI Agents SDK: https://openai.github.io/openai-agents-js/
- LangGraph JS overview: https://docs.langchain.com/oss/javascript/langgraph/overview
- LangGraph durable execution: https://docs.langchain.com/oss/javascript/langgraph/durable-execution
- LangGraph workflows and agents: https://docs.langchain.com/oss/javascript/langgraph/workflows-agents
- AgentKit by Inngest overview: https://agentkit.inngest.com/
- AgentKit networks: https://agentkit.inngest.com/concepts/networks
- AgentKit state: https://agentkit.inngest.com/concepts/state
- AgentKit routers: https://agentkit.inngest.com/concepts/routers
- AgentKit tools: https://agentkit.inngest.com/concepts/tools
- Mastra workflows overview: https://mastra.ai/docs/workflows/overview
- Mastra agents overview: https://mastra.ai/agents
- AI SDK agents overview: https://ai-sdk.dev/docs/agents/overview
- AI SDK subagents: https://ai-sdk.dev/docs/agents/subagents
- AI SDK memory: https://ai-sdk.dev/docs/agents/memory
- AI SDK MCP tools: https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
- Trigger.dev introduction: https://trigger.dev/docs/introduction
- Trigger.dev wait: https://trigger.dev/docs/wait
- Trigger.dev concurrency and queues: https://trigger.dev/docs/queue-concurrency
