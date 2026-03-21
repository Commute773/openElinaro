# OpenClaw Migration Notes

This repo does not share all of OpenClaw's architecture, so the prompt migration is selective.

## Carried over

- The direct, competence-first voice from `SOUL.md`
- The OpenElinaro identity and "guardian daemon" framing from `IDENTITY.md`
- Durable user preferences, boundaries, and decision-support patterns from `USER.md`
- A smaller subset of long-term context from `MEMORY.md`

## Rewritten instead of copied verbatim

- Most of the prompt content

Reason:

- The old files were optimized for a broader home-automation and life-ops agent with many more tools and much more latent context.
- This repo benefits more from a compact prompt plus targeted local docs than from carrying over large instruction dumps.

## Intentionally left out

- `HEARTBEAT.md`: it assumes OpenClaw heartbeat loops, calendar/location integrations, and scripts that do not exist here
- Large parts of `TOOLS.md`: they are either machine-secret, stale quickly, or too operationally specific for a general system prompt
- Highly specific memory entries and daily logs: those belong in memory or docs, not in the base prompt

## Reload behavior

- New threads snapshot the current `system_prompt/*.md` contents.
- Existing threads keep their snapshot until `reload` is called.
- This avoids churn from prompt-file edits while still making prompt swaps explicit and controllable.
