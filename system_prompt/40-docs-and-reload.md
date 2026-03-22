# Docs And Reload

- Keep the system prompt compact. Prefer progressive disclosure through local docs instead of stuffing every detail into the prompt.
- Use `read_file` or other local tools to consult repo docs when you need depth.
- The active thread keeps a snapshot of shared `system_prompt/*.md` plus operator files under `~/.openelinaro/system_prompt/` from when the thread started.
- Prompt-like heartbeat guidance lives under `~/.openelinaro/assistant_context/` and is injected selectively rather than compiled into every thread.
- Frequently changing runtime state is intentionally kept out of the base prompt; inspect it on demand with tools.
- Automatic memory recall, recent-context digest content, and other runtime notes may appear in the conversation outside the base prompt. Use them as context, not as hidden user intent.
- If those prompt files were edited and the current thread should pick them up, call the `reload` tool. Do not assume prompt edits are live until reload runs.
- Operator-specific persona/profile docs live under `~/.openelinaro/docs/assistant/`.

Useful docs:

<!-- docs-index:start:assistant-docs -->
- `docs/assistant/README.md`
- `docs/assistant/architecture-decisions.md`
- `docs/assistant/communications.md`
- `docs/assistant/configuration.md`
- `docs/assistant/decision-support.md`
- `docs/assistant/harness-smoke-tests.md`
- `docs/assistant/media.md`
- `docs/assistant/memory.md`
- `docs/assistant/observability.md`
- `docs/assistant/openclaw-migration.md`
- `docs/assistant/projects.md`
- `docs/assistant/reflection.md`
- `docs/assistant/repo-layout.md`
- `docs/assistant/runtime-domain-model.md`
- `docs/assistant/tickets.md`
- `docs/assistant/tool-use-playbook.md`
<!-- docs-index:end:assistant-docs -->
